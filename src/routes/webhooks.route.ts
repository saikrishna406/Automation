import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { prisma } from '../db/client';
import { videoQueue, approvalQueue } from '../queues';
import { JobStatus, VideoResult } from '../types';
import { downloadAndStore } from '../services/heygen.service';
import { logJobEvent, transitionJob } from '../queues/workers/shared';
import { config } from '../config';

export async function webhooksRoute(app: FastifyInstance) {
  // ── POST /webhooks/heygen ───────────────────────────────────────────────────
  // HeyGen calls this when video generation completes or fails
  app.post('/heygen', {
    config: { rawBody: true }, // needed for HMAC verification
  }, async (request, reply) => {
    // ── 1. Verify HMAC signature ───────────────────────────────────────────
    const signature = request.headers['x-heygen-signature'] as string;
    const rawBody = (request as any).rawBody as Buffer;

    if (signature && rawBody) {
      const expected = crypto
        .createHmac('sha256', config.heygen.webhookSecret)
        .update(rawBody)
        .digest('hex');

      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        return reply.code(401).send({ error: 'Invalid webhook signature' });
      }
    }

    const payload = request.body as any;

    // ── 2. Log raw webhook ─────────────────────────────────────────────────
    await prisma.webhookLog.create({
      data: { source: 'heygen', rawPayload: payload },
    });

    const heygenVideoId = payload?.event_data?.video_id ?? payload?.video_id;
    const heygenStatus = payload?.event_data?.status ?? payload?.status;
    const videoUrl = payload?.event_data?.video_url ?? payload?.video_url;
    const thumbnailUrl = payload?.event_data?.thumbnail_url;

    if (!heygenVideoId) {
      return reply.code(400).send({ error: 'Missing video_id in webhook payload' });
    }

    // ── 3. Find the job by heygen_video_id ─────────────────────────────────
    const job = await prisma.job.findFirst({
      where: {
        videoResult: {
          path: ['heygenVideoId'],
          equals: heygenVideoId,
        },
      },
    });

    if (!job) {
      console.warn(`[Webhook] No job found for heygenVideoId=${heygenVideoId}`);
      return reply.code(200).send({ received: true, matched: false });
    }

    await logJobEvent(job.id, 'webhook_received', {
      heygenVideoId,
      heygenStatus,
      hasVideoUrl: !!videoUrl,
    });

    // ── 4. Handle status ───────────────────────────────────────────────────
    if (heygenStatus === 'completed' && videoUrl) {
      try {
        const videoResult: VideoResult = await downloadAndStore(
          heygenVideoId,
          { status: 'completed', videoUrl, thumbnailUrl },
          job.id
        );

        await transitionJob(job.id, JobStatus.VIDEO_READY, {
          videoResult: videoResult as any,
        });

        // Advance to approval
        await approvalQueue.add(
          `approval-${job.id}`,
          { jobId: job.id },
          { jobId: `approval-${job.id}` }
        );

        await prisma.webhookLog.updateMany({
          where: {
            rawPayload: { path: ['event_data', 'video_id'], equals: heygenVideoId },
          },
          data: { processed: true },
        });
      } catch (err: any) {
        await prisma.webhookLog.updateMany({
          where: {
            rawPayload: { path: ['event_data', 'video_id'], equals: heygenVideoId },
          },
          data: { processed: false, error: err.message },
        });
      }
    } else if (heygenStatus === 'failed') {
      const errorMsg = payload?.event_data?.error ?? 'HeyGen generation failed';
      await transitionJob(job.id, JobStatus.FAILED, {
        errorInfo: { stage: 'video', code: 'HEYGEN_FAILED', message: errorMsg },
      });
      await logJobEvent(job.id, 'heygen_failed', { error: errorMsg });
    }

    // Always 200 to HeyGen — never return errors that cause retry storms
    return reply.code(200).send({ received: true });
  });
}
