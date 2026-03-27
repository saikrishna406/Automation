import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { config } from '../config';
import { VideoResult } from '../types';
import { uploadToStorage, BUCKETS } from './supabase-storage.service';

const BASE_URL = 'https://api.heygen.com';

const heygenClient: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  headers: {
    'X-Api-Key': config.heygen.apiKey,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

// ─── Generate Video (audio-driven lip-sync) ───────────────────────────────────
export async function generateVideo(
  avatarId: string,
  audioUrl: string,
  aspectRatio: '16:9' | '9:16' | '1:1',
  callbackUrl?: string
): Promise<string> {
  const payload: any = {
    video_inputs: [
      {
        character: {
          type: 'avatar',
          avatar_id: avatarId,
          avatar_style: 'normal',
        },
        voice: {
          type: 'audio',          // ← audio-driven, uses YOUR cloned voice
          audio_url: audioUrl,
        },
      },
    ],
    aspect_ratio: aspectRatio,
    test: config.env !== 'production', // use test mode in dev (no credit cost)
  };

  if (callbackUrl) {
    payload.callback_id = callbackUrl;
  }

  const response = await heygenClient.post('/v2/video/generate', payload);

  const videoId = response.data?.data?.video_id;
  if (!videoId) {
    throw new Error(`HeyGen did not return video_id. Response: ${JSON.stringify(response.data)}`);
  }

  return videoId;
}

// ─── Poll Video Status ────────────────────────────────────────────────────────
export type HeyGenVideoStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface HeyGenStatusResult {
  status: HeyGenVideoStatus;
  videoUrl?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  error?: string;
}

export async function getVideoStatus(videoId: string): Promise<HeyGenStatusResult> {
  const response = await heygenClient.get(`/v1/video_status.get?video_id=${videoId}`);
  const data = response.data?.data;

  return {
    status: data?.status ?? 'pending',
    videoUrl: data?.video_url,
    thumbnailUrl: data?.thumbnail_url,
    durationSec: data?.duration,
    error: data?.error,
  };
}

// ─── Poll Until Done (fallback if no webhook) ─────────────────────────────────
export async function pollUntilComplete(
  heygenVideoId: string,
  jobId: string,
  onProgress?: (status: HeyGenStatusResult) => void
): Promise<VideoResult> {
  const maxMs = config.heygen.maxPollMinutes * 60 * 1000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxMs) {
    await sleep(config.heygen.pollIntervalMs);

    const statusResult = await getVideoStatus(heygenVideoId);
    onProgress?.(statusResult);

    if (statusResult.status === 'failed') {
      throw new Error(`HeyGen video generation failed: ${statusResult.error}`);
    }

    if (statusResult.status === 'completed' && statusResult.videoUrl) {
      return await downloadAndStore(heygenVideoId, statusResult, jobId);
    }
  }

  throw new Error(`HeyGen video did not complete within ${config.heygen.maxPollMinutes} minutes`);
}

// ─── Download + Upload to S3 ──────────────────────────────────────────────────
export async function downloadAndStore(
  heygenVideoId: string,
  statusResult: HeyGenStatusResult,
  jobId: string
): Promise<VideoResult> {
  const videoUrl = statusResult.videoUrl!;

  // Download video to temp file
  const tmpPath = path.join(os.tmpdir(), `video_${jobId}.mp4`);
  const writer = fs.createWriteStream(tmpPath);

  const downloadRes = await axios.get(videoUrl, { responseType: 'stream' });
  await new Promise<void>((resolve, reject) => {
    downloadRes.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  const stats = fs.statSync(tmpPath);

  // Upload to Supabase Storage
  const storagePath = `raw/${jobId}.mp4`;
  const cdnUrl = await uploadToStorage(tmpPath, storagePath, BUCKETS.VIDEO, 'video/mp4');

  fs.unlinkSync(tmpPath);

  return {
    heygenVideoId,
    heygenStatus: 'completed',
    s3Key: storagePath,
    cdnUrl,
    durationSec: statusResult.durationSec ?? 0,
    fileSizeBytes: stats.size,
    thumbnailUrl: statusResult.thumbnailUrl,
  };
}

// ─── List Avatars ─────────────────────────────────────────────────────────────
export async function listAvatars() {
  const response = await heygenClient.get('/v2/avatars');
  return response.data?.data?.avatars ?? [];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
