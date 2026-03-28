import { Worker, Job } from 'bullmq';
import { redisConnection, approvalQueue } from '../../queues';
import { QUEUES, JobStatus, JobInput, AudioResult, VideoResult } from '../../types';
import { prisma } from '../../db/client';
import {
  generateVideo,
  pollUntilComplete,
  downloadAndStore,
  getVideoStatus,
  HeyGenStatusResult,
} from '../../services/heygen.service';
import { logJobEvent, transitionJob } from './shared';

export function startVideoWorker() {
  const worker = new Worker(
    QUEUES.VIDEO,
    async (job: Job<{ jobId: string; heygenVideoId?: string }>) => {
      const { jobId, heygenVideoId } = job.data;

      const dbJob = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      const input = dbJob.input as unknown as JobInput;
      const audioResult = dbJob.audioResult as unknown as AudioResult;

      if (!audioResult?.cdnUrl) {
        throw new Error('Audio result missing — cannot generate video');
      }

      let videoResult: VideoResult;

      if (heygenVideoId) {
        // ── Resume from polling (job was re-queued by webhook/poll handler) ──
        const status = await getVideoStatus(heygenVideoId);
        if (status.status !== 'completed') {
          throw new Error(`HeyGen video not ready yet: ${status.status}`);
        }
        videoResult = await downloadAndStore(heygenVideoId, status, jobId);
      } else {
        // ── Start fresh HeyGen job ──────────────────────────────────────────
        await transitionJob(jobId, JobStatus.VIDEO_GENERATING);

        const newHeygenVideoId = await generateVideo(
          input.avatarId,
          audioResult.cdnUrl,
          input.aspectRatio
        );

        await transitionJob(jobId, JobStatus.VIDEO_PROCESSING, {
          videoResult: { heygenVideoId: newHeygenVideoId } as any,
        });

        await logJobEvent(jobId, 'heygen_job_created', { heygenVideoId: newHeygenVideoId });

        // ── Poll until done (webhook is the preferred path but poll as fallback)
        videoResult = await pollUntilComplete(
          newHeygenVideoId,
          jobId,
          async (status: HeyGenStatusResult) => {
            console.log(`[VideoWorker] ${jobId} → HeyGen status: ${status.status}`);
          }
        );
      }

      await transitionJob(jobId, JobStatus.VIDEO_READY, {
        videoResult: videoResult as any,
      });

      await logJobEvent(jobId, 'video_ready', {
        durationSec: videoResult.durationSec,
        fileSizeBytes: videoResult.fileSizeBytes,
      });

      // ── Advance to Approval ────────────────────────────────────────────────
      await approvalQueue.add(
        `approval-${jobId}`,
        { jobId },
        { jobId: `approval-${jobId}` }
      );

      return { status: 'video_ready', durationSec: videoResult.durationSec };
    },
    {
      connection: redisConnection,
      concurrency: 5, // HeyGen concurrent limits
    }
  );

  worker.on('failed', async (job: Job<{ jobId: string; heygenVideoId?: string }> | undefined, err: Error) => {
    if (!job) return;
    const { jobId } = job.data;
    console.error(`[VideoWorker] Job ${jobId} failed:`, err.message);
    await transitionJob(jobId, JobStatus.FAILED, {
      errorInfo: { stage: 'video', code: 'VIDEO_GENERATION_FAILED', message: err.message },
    });
    await logJobEvent(jobId, 'failed', { stage: 'video', error: err.message });
  });

  console.log('✅ Video Worker started');
  return worker;
}
