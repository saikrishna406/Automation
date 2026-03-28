import { Worker, Job } from 'bullmq';
import { redisConnection, audioQueue } from '../../queues';
import { QUEUES, JobStatus, JobInput, ScriptResult } from '../../types';
import { prisma } from '../../db/client';
import { generateScript } from '../../services/openai.service';
import { logJobEvent, transitionJob } from './shared';

export function startScriptWorker() {
  const worker = new Worker(
    QUEUES.SCRIPT,
    async (job: Job<{ jobId: string }>) => {
      const { jobId } = job.data;

      // Fetch job from DB
      const dbJob = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      const input = dbJob.input as unknown as JobInput;

      // Mark as generating
      await transitionJob(jobId, JobStatus.SCRIPT_GENERATING, {
        workerId: job.id,
        startedAt: new Date(),
      });

      // Call OpenAI
      const scriptResult: ScriptResult = await generateScript(input);

      // Save result + advance state
      await transitionJob(jobId, JobStatus.SCRIPT_READY, {
        scriptResult: scriptResult as any,
      });

      await logJobEvent(jobId, 'script_generated', {
        wordCount: scriptResult.wordCount,
        estimatedDurationSec: scriptResult.estimatedDurationSec,
        tokensUsed: scriptResult.tokensUsed,
      });

      // ── Advance to next stage: Audio Generation ────────────────────────────
      await audioQueue.add(
        `audio-${jobId}`,
        { jobId },
        { jobId: `audio-${jobId}`, priority: 5 }
      );

      return { status: 'script_ready', wordCount: scriptResult.wordCount };
    },
    {
      connection: redisConnection,
      concurrency: 20,
    }
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    const { jobId } = job.data;
    console.error(`[ScriptWorker] Job ${jobId} failed:`, err.message);
    await transitionJob(jobId, JobStatus.FAILED, {
      errorInfo: { stage: 'script', code: 'SCRIPT_GENERATION_FAILED', message: err.message },
    });
    await logJobEvent(jobId, 'failed', { stage: 'script', error: err.message });
  });

  console.log('✅ Script Worker started');
  return worker;
}
