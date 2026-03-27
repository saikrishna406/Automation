import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { config } from '../config';
import { AudioResult, WordTimestamp } from '../types';
import { uploadToStorage, BUCKETS } from './supabase-storage.service';

const BASE_URL = 'https://api.elevenlabs.io/v1';

const headers = {
  'xi-api-key': config.elevenlabs.apiKey,
  'Content-Type': 'application/json',
};

export async function generateAudio(
  scriptText: string,
  voiceId: string,
  jobId: string
): Promise<AudioResult> {
  // ── 1. Generate audio with timestamps ──────────────────────────────────────
  const response = await axios.post(
    `${BASE_URL}/text-to-speech/${voiceId}/with-timestamps`,
    {
      text: scriptText,
      model_id: config.elevenlabs.modelId,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.85,
        speed: 1.0,
      },
    },
    {
      headers,
      responseType: 'json',
    }
  );

  const { audio_base64, alignment } = response.data;

  if (!audio_base64) {
    throw new Error('ElevenLabs returned no audio data');
  }

  // ── 2. Decode base64 audio → temp file ─────────────────────────────────────
  const audioBuffer = Buffer.from(audio_base64, 'base64');
  const tmpPath = path.join(os.tmpdir(), `audio_${jobId}.mp3`);
  fs.writeFileSync(tmpPath, audioBuffer);

  // ── 3. Parse word timestamps ───────────────────────────────────────────────
  const wordTimestamps: WordTimestamp[] = parseAlignment(alignment);

  // ── 4. Calculate duration from last timestamp ──────────────────────────────
  const durationSec =
    wordTimestamps.length > 0
      ? wordTimestamps[wordTimestamps.length - 1].end
      : audioBuffer.length / (128 * 1024 / 8); // rough estimate from 128kbps

  // ── 5. Upload to Supabase Storage ──────────────────────────────────────────
  const storagePath = `${jobId}.mp3`;
  const cdnUrl = await uploadToStorage(tmpPath, storagePath, BUCKETS.AUDIO, 'audio/mpeg');

  // Cleanup temp file
  fs.unlinkSync(tmpPath);

  return {
    s3Key: storagePath,
    cdnUrl,
    durationSec: Math.round(durationSec * 10) / 10,
    fileSizeBytes: audioBuffer.length,
    wordTimestamps,
    elevenLabsCharacters: scriptText.length,
  };
}

function parseAlignment(alignment: any): WordTimestamp[] {
  if (!alignment || !alignment.characters) return [];

  // ElevenLabs returns character-level alignment; group into words
  const timestamps: WordTimestamp[] = [];
  let wordStart: number | null = null;
  let currentWord = '';

  for (let i = 0; i < alignment.characters.length; i++) {
    const char = alignment.characters[i];
    const startTime = alignment.character_start_times_seconds?.[i] ?? 0;
    const endTime = alignment.character_end_times_seconds?.[i] ?? 0;

    if (char === ' ' || i === alignment.characters.length - 1) {
      if (char !== ' ') {
        currentWord += char;
      }
      if (currentWord.trim() && wordStart !== null) {
        timestamps.push({
          word: currentWord.trim(),
          start: Math.round(wordStart * 1000) / 1000,
          end: Math.round(endTime * 1000) / 1000,
        });
      }
      currentWord = '';
      wordStart = null;
    } else {
      if (wordStart === null) wordStart = startTime;
      currentWord += char;
    }
  }

  return timestamps;
}

export async function listVoices() {
  const response = await axios.get(`${BASE_URL}/voices`, { headers });
  return response.data.voices;
}

export async function cloneVoice(name: string, audioFileUrl: string): Promise<string> {
  const FormData = (await import('form-data')).default;
  const form = new FormData();
  form.append('name', name);

  // Download sample and attach
  const audioRes = await axios.get(audioFileUrl, { responseType: 'arraybuffer' });
  form.append('files', Buffer.from(audioRes.data), {
    filename: 'sample.mp3',
    contentType: 'audio/mpeg',
  });

  const response = await axios.post(`${BASE_URL}/voices/add`, form, {
    headers: {
      ...form.getHeaders(),
      'xi-api-key': config.elevenlabs.apiKey,
    },
  });

  return response.data.voice_id;
}
