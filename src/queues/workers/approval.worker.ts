import { Worker, Job as BullJob } from 'bullmq';
import { redisConnection, editQueue } from '../../queues';
import { QUEUES, JobStatus, JobInput, AudioResult, VideoResult, QAScore } from '../../types';
import { prisma } from '../../db/client';
import { logJobEvent, transitionJob } from './shared';
import { config } from '../../config';

export function startApprovalWorker(): Worker {
  const worker = new Worker(
    QUEUES.APPROVAL,
    async (job: BullJob<{ jobId: string }>) => {
      const { jobId } = job.data;

      const dbJob = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      const input = dbJob.input as unknown as JobInput;
      const audioResult = dbJob.audioResult as unknown as AudioResult;
      const videoResult = dbJob.videoResult as unknown as VideoResult;
      const approvalMode = (input.approvalMode ?? dbJob.approvalMode) as 'auto' | 'manual';

      // ── Run QA Scoring ─────────────────────────────────────────────────────
      const qaScore = computeQAScore(audioResult, videoResult, input);

      await transitionJob(jobId, JobStatus.PENDING_APPROVAL, {
        autoScore: qaScore.overall,
      });

      await logJobEvent(jobId, 'qa_scored', {
        score: qaScore.overall,
        flags: qaScore.flags,
        mode: approvalMode,
      });

      if (approvalMode === 'auto') {
        if (qaScore.overall >= config.pipeline.autoApprovalThreshold) {
          // ── Auto Approve ───────────────────────────────────────────────────
          await transitionJob(jobId, JobStatus.APPROVED);
          await logJobEvent(jobId, 'auto_approved', { score: qaScore.overall });

          await editQueue.add(
            `edit:${jobId}`,
            { jobId },
            { jobId: `edit:${jobId}` }
          );
        } else {
          // ── QA failed — escalate to manual review ─────────────────────────
          await prisma.job.update({
            where: { id: jobId },
            data: {
              approvalMode: 'manual',
              updatedAt: new Date(),
            },
          });
          await logJobEvent(jobId, 'auto_approval_failed', {
            score: qaScore.overall,
            flags: qaScore.flags,
            escalatedToManual: true,
          });
          // Stays in PENDING_APPROVAL — human must call /jobs/:id/approve
        }
      } else {
        // ── Manual mode — just wait, reviewer calls the approve API ───────────
        await logJobEvent(jobId, 'awaiting_manual_approval', { score: qaScore.overall });
      }

      return { status: 'pending_approval', score: qaScore.overall, mode: approvalMode };
    },
    {
      connection: redisConnection,
      concurrency: 50, // Fast — mostly computation, no external calls
    }
  );

  worker.on('failed', async (job: BullJob<{ jobId: string }> | undefined, err: Error) => {
    if (!job) return;
    console.error(`[ApprovalWorker] ${job.data.jobId} failed:`, err.message);
  });

  console.log('✅ Approval Worker started');
  return worker;
}

// ─── QA Scoring Logic ─────────────────────────────────────────────────────────
function computeQAScore(
  audio: AudioResult,
  video: VideoResult,
  input: JobInput
): QAScore {
  const flags: string[] = [];
  let score = 1.0;

  // Check 1: Duration match (audio vs video should be within 10%)
  if (audio?.durationSec && video?.durationSec) {
    const diff = Math.abs(audio.durationSec - video.durationSec) / audio.durationSec;
    if (diff > 0.1) {
      flags.push('DURATION_MISMATCH');
      score -= 0.2;
    }
  } else {
    flags.push('MISSING_DURATION');
    score -= 0.3;
  }

  // Check 2: Video file exists with reasonable size (>100KB)
  if (!video?.fileSizeBytes || video.fileSizeBytes < 100_000) {
    flags.push('VIDEO_TOO_SMALL');
    score -= 0.4;
  }

  // Check 3: CDN URLs present
  if (!video?.cdnUrl) {
    flags.push('MISSING_VIDEO_URL');
    score -= 0.5;
  }
  if (!audio?.cdnUrl) {
    flags.push('MISSING_AUDIO_URL');
    score -= 0.3;
  }

  // Check 4: Word timestamps present (needed for Descript)
  if (!audio?.wordTimestamps?.length) {
    flags.push('MISSING_TIMESTAMPS');
    score -= 0.1; // Non-critical, Descript can still work
  }

  return {
    overall: Math.max(0, Math.min(1, score)),
    audioDurationMatch: !flags.includes('DURATION_MISMATCH'),
    videoRenderComplete: !flags.includes('MISSING_VIDEO_URL'),
    minimumResolution: true, // would need metadata from HeyGen response
    flags,
  };
}
