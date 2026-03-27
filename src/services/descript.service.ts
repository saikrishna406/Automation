import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { config } from '../config';
import { EditResult, WordTimestamp } from '../types';
import { uploadToStorage, BUCKETS } from './supabase-storage.service';

const BASE_URL = 'https://api.descript.com/v1';

const descriptClient = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `Bearer ${config.descript.apiKey}`,
    'Content-Type': 'application/json',
  },
  timeout: 60000,
});

// ─── Main Edit Function ───────────────────────────────────────────────────────
export async function editVideo(
  videoUrl: string,
  scriptText: string,
  wordTimestamps: WordTimestamp[],
  jobId: string
): Promise<EditResult> {
  try {
    // ── Try Descript API ──────────────────────────────────────────────────────
    return await editWithDescriptApi(videoUrl, scriptText, wordTimestamps, jobId);
  } catch (err: any) {
    // ── Fallback: FFmpeg + Whisper-based processing ───────────────────────────
    console.warn(`[Descript] API failed (${err.message}), falling back to FFmpeg pipeline`);
    return await editWithFfmpegFallback(videoUrl, wordTimestamps, jobId);
  }
}

// ─── Descript API Path ────────────────────────────────────────────────────────
async function editWithDescriptApi(
  videoUrl: string,
  scriptText: string,
  wordTimestamps: WordTimestamp[],
  jobId: string
): Promise<EditResult> {
  // 1. Create project
  const projectRes = await descriptClient.post('/projects', {
    title: `AutoEdit_${jobId}`,
    description: 'AI-generated video — auto-edited',
  });
  const projectId: string = projectRes.data.id;

  // 2. Import media
  await descriptClient.post(`/projects/${projectId}/media`, {
    url: videoUrl,
    type: 'video',
  });

  // 3. Apply captions from word timestamps
  const captions = buildCaptionBlocks(wordTimestamps);
  await descriptClient.post(`/projects/${projectId}/captions`, { captions });

  // 4. Trigger export
  const exportRes = await descriptClient.post(`/projects/${projectId}/export`, {
    format: 'mp4',
    resolution: '1080p',
    include_captions: true,
    burn_captions: false, // separate SRT file
  });
  const exportId: string = exportRes.data.export_id;

  // 5. Poll for export completion
  const downloadUrl = await pollDescriptExport(projectId, exportId);

  // 6. Download and store
  return await downloadAndStoreEdit(downloadUrl, wordTimestamps, jobId, projectId);
}

async function pollDescriptExport(projectId: string, exportId: string): Promise<string> {
  const maxAttempts = 40; // 40 × 15s = 10 min max
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(15000);
    const res = await descriptClient.get(`/projects/${projectId}/exports/${exportId}`);
    const { status, download_url } = res.data;
    if (status === 'completed' && download_url) return download_url;
    if (status === 'failed') throw new Error('Descript export failed');
  }
  throw new Error('Descript export timed out');
}

// ─── FFmpeg Fallback ──────────────────────────────────────────────────────────
async function editWithFfmpegFallback(
  videoUrl: string,
  wordTimestamps: WordTimestamp[],
  jobId: string
): Promise<EditResult> {
  const { execSync } = require('child_process');
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `input_${jobId}.mp4`);
  const srtPath = path.join(tmpDir, `captions_${jobId}.srt`);
  const outputPath = path.join(tmpDir, `edited_${jobId}.mp4`);

  // Download input video
  const res = await axios.get(videoUrl, { responseType: 'arraybuffer' });
  fs.writeFileSync(inputPath, Buffer.from(res.data));

  // Generate SRT captions from word timestamps
  const srtContent = generateSRT(wordTimestamps);
  fs.writeFileSync(srtPath, srtContent);

  // FFmpeg: copy video + embed SRT as subtitle track (no re-encode = fast)
  execSync(
    `ffmpeg -i "${inputPath}" -i "${srtPath}" -c copy -c:s mov_text "${outputPath}" -y`,
    { stdio: 'pipe' }
  );

  // Upload edited video to Supabase Storage
  const editedPath = `edited/${jobId}.mp4`;
  const cdnUrl = await uploadToStorage(outputPath, editedPath, BUCKETS.VIDEO, 'video/mp4');

  // Upload SRT
  const srtPath2 = `${jobId}.srt`;
  const captionUrl = await uploadToStorage(srtPath, srtPath2, BUCKETS.CAPTIONS, 'text/plain');

  // Cleanup
  [inputPath, srtPath, outputPath].forEach((f) => { try { fs.unlinkSync(f); } catch {} });

  const chapters = buildChapters(wordTimestamps);
  const lastTimestamp = wordTimestamps[wordTimestamps.length - 1];

  return {
    s3Key: editedPath,
    cdnUrl,
    captionFileUrl: captionUrl,
    chapters,
    finalDurationSec: lastTimestamp?.end ?? 0,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function downloadAndStoreEdit(
  downloadUrl: string,
  wordTimestamps: WordTimestamp[],
  jobId: string,
  projectId?: string
): Promise<EditResult> {
  const tmpPath = path.join(os.tmpdir(), `edited_${jobId}.mp4`);
  const res = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
  fs.writeFileSync(tmpPath, Buffer.from(res.data));

  const storagePath = `edited/${jobId}.mp4`;
  const cdnUrl = await uploadToStorage(tmpPath, storagePath, BUCKETS.VIDEO, 'video/mp4');
  fs.unlinkSync(tmpPath);

  const chapters = buildChapters(wordTimestamps);
  const lastTs = wordTimestamps[wordTimestamps.length - 1];

  return {
    s3Key: storagePath,
    cdnUrl,
    chapters,
    descriptProjectId: projectId,
    finalDurationSec: lastTs?.end ?? 0,
  };
}

function buildCaptionBlocks(timestamps: WordTimestamp[]) {
  // Group words into ~5-word caption blocks
  const blocks = [];
  for (let i = 0; i < timestamps.length; i += 5) {
    const chunk = timestamps.slice(i, i + 5);
    blocks.push({
      text: chunk.map((w) => w.word).join(' '),
      start_time: chunk[0].start,
      end_time: chunk[chunk.length - 1].end,
    });
  }
  return blocks;
}

function generateSRT(timestamps: WordTimestamp[]): string {
  const WORDS_PER_LINE = 7;
  let srt = '';
  let index = 1;

  for (let i = 0; i < timestamps.length; i += WORDS_PER_LINE) {
    const chunk = timestamps.slice(i, i + WORDS_PER_LINE);
    const start = formatSRTTime(chunk[0].start);
    const end = formatSRTTime(chunk[chunk.length - 1].end);
    const text = chunk.map((w) => w.word).join(' ');
    srt += `${index}\n${start} --> ${end}\n${text}\n\n`;
    index++;
  }

  return srt;
}

function formatSRTTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${padMs(ms)}`;
}

function buildChapters(timestamps: WordTimestamp[]) {
  // Simple: one chapter per 30 seconds of content
  const chapters = [{ title: 'Intro', startSec: 0 }];
  const lastTs = timestamps[timestamps.length - 1];
  if (lastTs && lastTs.end > 30) {
    chapters.push({ title: 'Main Content', startSec: 30 });
  }
  return chapters;
}

function pad(n: number) { return String(n).padStart(2, '0'); }
function padMs(n: number) { return String(n).padStart(3, '0'); }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
