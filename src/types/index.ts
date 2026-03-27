// ─── Job Status ───────────────────────────────────────────────────────────────
export const JobStatus = {
  QUEUED: 'queued',
  SCRIPT_GENERATING: 'script_generating',
  SCRIPT_READY: 'script_ready',
  AUDIO_GENERATING: 'audio_generating',
  AUDIO_READY: 'audio_ready',
  VIDEO_GENERATING: 'video_generating',
  VIDEO_PROCESSING: 'video_processing', // waiting for HeyGen (poll/webhook)
  VIDEO_READY: 'video_ready',
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EDITING: 'editing',
  EDITED: 'edited',
  UPLOADING: 'uploading',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type JobStatusType = (typeof JobStatus)[keyof typeof JobStatus];

// ─── Queue Names ─────────────────────────────────────────────────────────────
export const QUEUES = {
  SCRIPT: 'pipeline-script',
  AUDIO: 'pipeline-audio',
  VIDEO: 'pipeline-video',
  APPROVAL: 'pipeline-approval',
  EDIT: 'pipeline-edit',
  STORAGE: 'pipeline-storage',
  NOTIFY: 'pipeline-notify',
} as const;

// ─── Job Input / Results ─────────────────────────────────────────────────────
export interface JobInput {
  topic: string;
  tone: 'professional' | 'casual' | 'motivational' | 'educational';
  avatarId: string;
  voiceId: string; // ElevenLabs voice_id
  aspectRatio: '16:9' | '9:16' | '1:1';
  durationTargetSec?: number;
  brandVoice?: string;
  cta?: string;
  approvalMode?: 'auto' | 'manual';
}

export interface ScriptResult {
  fullText: string;
  sections: Array<{
    type: 'hook' | 'body' | 'cta' | 'intro' | 'outro';
    text: string;
    approxSec: number;
  }>;
  wordCount: number;
  estimatedDurationSec: number;
  tokensUsed: number;
  promptVersion: string;
}

export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

export interface AudioResult {
  s3Key: string;
  cdnUrl: string;
  durationSec: number;
  fileSizeBytes: number;
  wordTimestamps: WordTimestamp[];
  elevenLabsCharacters: number;
}

export interface VideoResult {
  heygenVideoId: string;
  heygenStatus: string;
  s3Key: string;
  cdnUrl: string;
  durationSec: number;
  fileSizeBytes: number;
  thumbnailUrl?: string;
}

export interface EditResult {
  s3Key: string;
  cdnUrl: string;
  captionFileUrl?: string;
  chapters: Array<{ title: string; startSec: number }>;
  descriptProjectId?: string;
  finalDurationSec: number;
}

export interface StorageResult {
  driveFileId: string;
  driveUrl: string;
  driveFolderPath: string;
}

export interface QAScore {
  overall: number; // 0–1
  audioDurationMatch: boolean;
  videoRenderComplete: boolean;
  minimumResolution: boolean;
  flags: string[];
}
