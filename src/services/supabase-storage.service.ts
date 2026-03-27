import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import { config } from '../config';

// ─── Singleton Supabase Client ────────────────────────────────────────────────
let _supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!_supabase) {
    _supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false },
    });
  }
  return _supabase;
}

// ─── Bucket Names ─────────────────────────────────────────────────────────────
export const BUCKETS = {
  AUDIO: 'audio',    // mp3 files
  VIDEO: 'video',    // raw + edited mp4 files
  CAPTIONS: 'captions', // srt files
} as const;

// ─── Upload from file path ────────────────────────────────────────────────────
export async function uploadToStorage(
  filePath: string,
  storagePath: string,       // e.g. "raw/job_id.mp4"
  bucket: string,
  contentType: string
): Promise<string> {
  const supabase = getSupabase();
  const fileBuffer = fs.readFileSync(filePath);

  const { error } = await supabase.storage
    .from(bucket)
    .upload(storagePath, fileBuffer, {
      contentType,
      upsert: true,          // overwrite if re-running same job
      cacheControl: '31536000', // 1 year immutable
    });

  if (error) throw new Error(`Supabase upload failed [${bucket}/${storagePath}]: ${error.message}`);

  return getPublicUrl(bucket, storagePath);
}

// ─── Upload from Buffer ───────────────────────────────────────────────────────
export async function uploadBufferToStorage(
  buffer: Buffer,
  storagePath: string,
  bucket: string,
  contentType: string
): Promise<string> {
  const supabase = getSupabase();

  const { error } = await supabase.storage
    .from(bucket)
    .upload(storagePath, buffer, {
      contentType,
      upsert: true,
      cacheControl: '31536000',
    });

  if (error) throw new Error(`Supabase upload failed [${bucket}/${storagePath}]: ${error.message}`);

  return getPublicUrl(bucket, storagePath);
}

// ─── Get public CDN URL ────────────────────────────────────────────────────────
export function getPublicUrl(bucket: string, storagePath: string): string {
  const supabase = getSupabase();
  const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);
  return data.publicUrl;
}

// ─── Get signed URL (for private buckets) ────────────────────────────────────
export async function getSignedUrl(
  bucket: string,
  storagePath: string,
  expiresInSec = 3600
): Promise<string> {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(storagePath, expiresInSec);

  if (error || !data?.signedUrl) {
    throw new Error(`Failed to create signed URL: ${error?.message}`);
  }
  return data.signedUrl;
}

// ─── Delete file ─────────────────────────────────────────────────────────────
export async function deleteFromStorage(bucket: string, storagePath: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.storage.from(bucket).remove([storagePath]);
  if (error) throw new Error(`Supabase delete failed: ${error.message}`);
}

// ─── Ensure buckets exist (run once on startup) ───────────────────────────────
export async function ensureBucketsExist(): Promise<void> {
  const supabase = getSupabase();
  const { data: existing } = await supabase.storage.listBuckets();
  const existingNames = existing?.map((b) => b.name) ?? [];

  for (const bucket of Object.values(BUCKETS)) {
    if (!existingNames.includes(bucket)) {
      const { error } = await supabase.storage.createBucket(bucket, {
        public: true,
        fileSizeLimit: 52428800, // 50MB — safe for Supabase free tier
        allowedMimeTypes: bucket === BUCKETS.AUDIO
          ? ['audio/mpeg', 'audio/mp3', 'audio/wav']
          : bucket === BUCKETS.VIDEO
          ? ['video/mp4', 'video/quicktime']
          : ['text/plain', 'text/vtt'],
      });
      if (error && !error.message.includes('already exists')) {
        throw new Error(`Could not create bucket "${bucket}": ${error.message}`);
      }
      console.log(`✅ Supabase bucket created: ${bucket}`);
    }
  }
}
