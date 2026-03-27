import { Worker, Job } from 'bullmq';
import { redisConnection } from '../../queues';
import { QUEUES, JobStatus, EditResult, StorageResult } from '../../types';
import { prisma } from '../../db/client';
import { uploadToDrive } from '../../services/gdrive.service';
import { logJobEvent, transitionJob } from './shared';

export function startStorageWorker() {
  const worker = new Worker(
    QUEUES.STORAGE,
    async (job: Job<{ jobId: string }>) => {
      const { jobId } = job.data;

      const dbJob = await prisma.job.findUniqueOrThrow({
        where: { id: jobId },
        include: { user: true },
      });

      const editResult = dbJob.editResult as unknown as EditResult;

      if (!editResult?.cdnUrl) throw new Error('Edited video URL missing');
      if (!dbJob.user.googleTokens) {
        throw new Error('User has not connected Google Drive. Please authenticate via /auth/google');
      }

      await transitionJob(jobId, JobStatus.UPLOADING);

      const scriptResult = dbJob.scriptResult as any;
      const topic = (dbJob.input as any)?.topic ?? 'video';
      const dateStr = new Date().toISOString().split('T')[0];
      const fileName = `${dateStr}_${topic.slice(0, 40).replace(/[^a-z0-9]/gi, '_')}_${jobId.slice(0, 8)}.mp4`;

      // ── Upload to Google Drive ─────────────────────────────────────────────
      const storageResult: StorageResult = await uploadToDrive(
        editResult.cdnUrl,
        fileName,
        jobId,
        dbJob.user.googleTokens
      );

      // ── Mark COMPLETED + Save Video record ────────────────────────────────
      await prisma.$transaction([
        prisma.job.update({
          where: { id: jobId },
          data: {
            status: JobStatus.COMPLETED,
            storageResult: storageResult as any,
            completedAt: new Date(),
            updatedAt: new Date(),
          },
        }),
        prisma.video.create({
          data: {
            jobId,
            userId: dbJob.userId!,
            title: topic,
            scriptText: scriptResult?.fullText ?? '',
            videoUrl: editResult.cdnUrl,
            driveFileId: storageResult.driveFileId,
            driveUrl: storageResult.driveUrl,
            durationSec: editResult.finalDurationSec,
            aspectRatio: (dbJob.input as any)?.aspectRatio,
            metadata: {
              chapters: editResult.chapters,
              captionUrl: editResult.captionFileUrl,
            },
          },
        }),
      ]);

      await logJobEvent(jobId, 'completed', {
        driveUrl: storageResult.driveUrl,
        driveFileId: storageResult.driveFileId,
        driveFolderPath: storageResult.driveFolderPath,
      });

      return { status: 'completed', driveUrl: storageResult.driveUrl };
    },
    {
      connection: redisConnection,
      concurrency: 10,
    }
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    const { jobId } = job.data;
    console.error(`[StorageWorker] Job ${jobId} failed:`, err.message);
    await transitionJob(jobId, JobStatus.FAILED, {
      errorInfo: { stage: 'storage', code: 'DRIVE_UPLOAD_FAILED', message: err.message },
    });
    await logJobEvent(jobId, 'failed', { stage: 'storage', error: err.message });
  });

  console.log('✅ Storage Worker started');
  return worker;
}
