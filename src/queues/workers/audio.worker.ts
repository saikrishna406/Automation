import { Worker, Job } from 'bullmq';
import { redisConnection, videoQueue } from '../../queues';
import { QUEUES, JobStatus, JobInput, ScriptResult, AudioResult } from '../../types';
import { prisma } from '../../db/client';
import { generateAudio } from '../../services/elevenlabs.service';
import { logJobEvent, transitionJob } from './shared';

export function startAudioWorker() {
  const worker = new Worker(
    QUEUES.AUDIO,
    async (job: Job<{ jobId: string }>) => {
      const { jobId } = job.data;

      const dbJob = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      const input = dbJob.input as unknown as JobInput;
      const scriptResult = dbJob.scriptResult as unknown as ScriptResult;

      if (!scriptResult?.fullText) {
        throw new Error('Script result missing — cannot generate audio');
      }

      await transitionJob(jobId, JobStatus.AUDIO_GENERATING);

      // ── Generate Audio via ElevenLabs ─────────────────────────────────────
      const audioResult: AudioResult = await generateAudio(
        scriptResult.fullText,
        input.voiceId,
        jobId
      );

      await transitionJob(jobId, JobStatus.AUDIO_READY, {
        audioResult: audioResult as any,
      });

      await logJobEvent(jobId, 'audio_generated', {
        durationSec: audioResult.durationSec,
        fileSizeBytes: audioResult.fileSizeBytes,
        wordTimestampCount: audioResult.wordTimestamps.length,
      });

      // ── Advance to Video Generation ────────────────────────────────────────
      await videoQueue.add(
        `video:${jobId}`,
        { jobId },
        { jobId: `video:${jobId}`, priority: 5 }
      );

      return { status: 'audio_ready', durationSec: audioResult.durationSec };
    },
    {
      connection: redisConnection,
      concurrency: 10, // ElevenLabs rate limits
    }
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    const { jobId } = job.data;
    console.error(`[AudioWorker] Job ${jobId} failed:`, err.message);
    await transitionJob(jobId, JobStatus.FAILED, {
      errorInfo: { stage: 'audio', code: 'AUDIO_GENERATION_FAILED', message: err.message },
    });
    await logJobEvent(jobId, 'failed', { stage: 'audio', error: err.message });
  });

  console.log('✅ Audio Worker started');
  return worker;
}
