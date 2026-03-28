import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../db/client';
import { scriptQueue } from '../queues';
import { editQueue } from '../queues';
import { JobStatus, JobInput } from '../types';
import { logJobEvent, transitionJob } from '../queues/workers/shared';

const generateSchema = z.object({
  topic: z.string().min(3).max(500),
  tone: z.enum(['professional', 'casual', 'motivational', 'educational']).default('professional'),
  avatarId: z.string().min(1),
  voiceId: z.string().min(1),
  aspectRatio: z.enum(['16:9', '9:16', '1:1']).default('16:9'),
  durationTargetSec: z.number().min(15).max(600).optional(),
  brandVoice: z.string().max(500).optional(),
  cta: z.string().max(200).optional(),
  approvalMode: z.enum(['auto', 'manual']).default('auto'),
  idempotencyKey: z.string().max(128).optional(),
});

const bulkSchema = z.object({
  items: z.array(generateSchema).min(1).max(50),
});

export async function jobsRoutes(app: FastifyInstance) {
  // ── POST /generate ─────────────────────────────────────────────────────────
  app.post('/generate', async (request, reply) => {
    const userId = (request as any).user?.id;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const parsed = generateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid input', details: parsed.error.format() });
    }

    const input: JobInput = parsed.data;
    const idempotencyKey =
      parsed.data.idempotencyKey ??
      crypto
        .createHash('sha256')
        .update(`${userId}:${input.topic}:${input.avatarId}:${input.voiceId}`)
        .digest('hex');

    // ── Idempotency check ──────────────────────────────────────────────────
    const existing = await prisma.job.findUnique({ where: { idempotencyKey } });
    if (existing) {
      return reply.code(200).send({
        jobId: existing.id,
        status: existing.status,
        message: 'Duplicate request — returning existing job',
      });
    }

    // ── Create job ─────────────────────────────────────────────────────────
    const job = await prisma.job.create({
      data: {
        userId,
        idempotencyKey,
        status: JobStatus.QUEUED,
        approvalMode: input.approvalMode ?? 'auto',
        input: input as any,
        scheduledAt: new Date(),
      },
    });

    // ── Enqueue script generation ──────────────────────────────────────────
    await scriptQueue.add(`script-${job.id}`, { jobId: job.id }, { jobId: `script-${job.id}` });

    await logJobEvent(job.id, 'job_created', { userId, topic: input.topic });

    return reply.code(202).send({
      jobId: job.id,
      status: 'queued',
      estimatedWaitSeconds: 120,
      pollUrl: `/api/v1/jobs/${job.id}`,
    });
  });

  // ── POST /bulk ─────────────────────────────────────────────────────────────
  app.post('/bulk', async (request, reply) => {
    const userId = (request as any).user?.id;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const parsed = bulkSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid input', details: parsed.error.format() });
    }

    const jobIds: string[] = [];

    for (const item of parsed.data.items) {
      const idempotencyKey = crypto
        .createHash('sha256')
        .update(`${userId}:${item.topic}:${item.avatarId}:${item.voiceId}:bulk`)
        .digest('hex');

      const existing = await prisma.job.findUnique({ where: { idempotencyKey } });
      if (existing) {
        jobIds.push(existing.id);
        continue;
      }

      const job = await prisma.job.create({
        data: {
          userId,
          idempotencyKey,
          status: JobStatus.QUEUED,
          approvalMode: item.approvalMode ?? 'auto',
          input: item as any,
          scheduledAt: new Date(),
        },
      });

      await scriptQueue.add(`script-${job.id}`, { jobId: job.id }, { jobId: `script-${job.id}` });
      jobIds.push(job.id);
    }

    return reply.code(202).send({ jobIds, total: jobIds.length });
  });

  // ── GET /:jobId ────────────────────────────────────────────────────────────
  app.get('/:jobId', async (request, reply) => {
    const userId = (request as any).user?.id;
    const { jobId } = request.params as { jobId: string };

    const job = await prisma.job.findFirst({
      where: { id: jobId, userId },
      include: { video: true },
    });

    if (!job) return reply.code(404).send({ error: 'Job not found' });

    return reply.send({
      jobId: job.id,
      status: job.status,
      approvalMode: job.approvalMode,
      autoScore: job.autoScore,
      input: job.input,
      scriptResult: job.scriptResult,
      audioResult: job.audioResult
        ? { durationSec: (job.audioResult as any).durationSec }
        : null,
      videoResult: job.videoResult
        ? {
            cdnUrl: (job.videoResult as any).cdnUrl,
            thumbnailUrl: (job.videoResult as any).thumbnailUrl,
            durationSec: (job.videoResult as any).durationSec,
          }
        : null,
      editResult: job.editResult
        ? {
            cdnUrl: (job.editResult as any).cdnUrl,
            captionFileUrl: (job.editResult as any).captionFileUrl,
            chapters: (job.editResult as any).chapters,
          }
        : null,
      storageResult: job.storageResult,
      error: job.errorInfo,
      video: job.video
        ? {
            id: job.video.id,
            driveUrl: job.video.driveUrl,
            durationSec: job.video.durationSec,
          }
        : null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
    });
  });

  // ── GET / (list user's jobs) ───────────────────────────────────────────────
  app.get('/', async (request, reply) => {
    const userId = (request as any).user?.id;
    const { status, limit = '20', offset = '0' } = request.query as any;

    const jobs = await prisma.job.findMany({
      where: { userId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit), 100),
      skip: parseInt(offset),
      select: {
        id: true,
        status: true,
        approvalMode: true,
        autoScore: true,
        input: true,
        createdAt: true,
        updatedAt: true,
        completedAt: true,
      },
    });

    return reply.send({ jobs, total: jobs.length });
  });

  // ── POST /:jobId/approve (manual approval) ─────────────────────────────────
  app.post('/:jobId/approve', async (request, reply) => {
    const userId = (request as any).user?.id;
    const { jobId } = request.params as { jobId: string };
    const { action, reason } = request.body as { action: 'approve' | 'reject'; reason?: string };

    const job = await prisma.job.findFirst({
      where: { id: jobId, userId, status: JobStatus.PENDING_APPROVAL },
    });

    if (!job) {
      return reply.code(404).send({ error: 'Job not found or not pending approval' });
    }

    if (action === 'approve') {
      await transitionJob(jobId, JobStatus.APPROVED);
      await logJobEvent(jobId, 'manually_approved', { userId });
      await editQueue.add(`edit-${jobId}`, { jobId }, { jobId: `edit-${jobId}` });
      return reply.send({ message: 'Approved — video editing started', jobId });
    }

    if (action === 'reject') {
      await transitionJob(jobId, JobStatus.REJECTED, { rejectionReason: reason });
      await logJobEvent(jobId, 'manually_rejected', { userId, reason });
      return reply.send({ message: 'Rejected', jobId });
    }

    return reply.code(400).send({ error: 'action must be "approve" or "reject"' });
  });

  // ── GET /:jobId/events (audit trail) ──────────────────────────────────────
  app.get('/:jobId/events', async (request, reply) => {
    const userId = (request as any).user?.id;
    const { jobId } = request.params as { jobId: string };

    const job = await prisma.job.findFirst({ where: { id: jobId, userId } });
    if (!job) return reply.code(404).send({ error: 'Job not found' });

    const events = await prisma.jobEvent.findMany({
      where: { jobId },
      orderBy: { createdAt: 'asc' },
    });

    return reply.send({ events });
  });
}
