import { Worker, Job } from 'bullmq';
import { redisConnection, storageQueue } from '../../queues';
import { QUEUES, JobStatus, AudioResult, VideoResult, EditResult } from '../../types';
import { prisma } from '../../db/client';
import { editVideo } from '../../services/descript.service';
import { logJobEvent, transitionJob } from './shared';

export function startEditWorker() {
  const worker = new Worker(
    QUEUES.EDIT,
    async (job: Job<{ jobId: string }>) => {
      const { jobId } = job.data;

      const dbJob = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      const audioResult = dbJob.audioResult as unknown as AudioResult;
      const videoResult = dbJob.videoResult as unknown as VideoResult;
      const scriptResult = dbJob.scriptResult as any;

      if (!videoResult?.cdnUrl) throw new Error('Video URL missing for editing');

      await transitionJob(jobId, JobStatus.EDITING);

      // ── Call Descript (with FFmpeg fallback built in) ──────────────────────
      const editResult: EditResult = await editVideo(
        videoResult.cdnUrl,
        scriptResult?.fullText ?? '',
        audioResult?.wordTimestamps ?? [],
        jobId
      );

      await transitionJob(jobId, JobStatus.EDITED, {
        editResult: editResult as any,
      });

      await logJobEvent(jobId, 'editing_complete', {
        finalDurationSec: editResult.finalDurationSec,
        hasCaptions: !!editResult.captionFileUrl,
        chapterCount: editResult.chapters.length,
        usedDescript: !!editResult.descriptProjectId,
      });

      // ── Advance to Drive Upload ────────────────────────────────────────────
      await storageQueue.add(
        `storage:${jobId}`,
        { jobId },
        { jobId: `storage:${jobId}` }
      );

      return { status: 'edited', finalDurationSec: editResult.finalDurationSec };
    },
    {
      connection: redisConnection,
      concurrency: 3, // Descript is rate-limited
    }
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    const { jobId } = job.data;
    console.error(`[EditWorker] Job ${jobId} failed:`, err.message);
    await transitionJob(jobId, JobStatus.FAILED, {
      errorInfo: { stage: 'edit', code: 'EDITING_FAILED', message: err.message },
    });
    await logJobEvent(jobId, 'failed', { stage: 'edit', error: err.message });
  });

  console.log('✅ Edit Worker started');
  return worker;
}
