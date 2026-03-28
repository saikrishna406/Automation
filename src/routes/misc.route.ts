import { FastifyInstance } from 'fastify';
import { getAuthUrl, exchangeCodeForTokens } from '../services/gdrive.service';
import { cloneVoice, listVoices } from '../services/elevenlabs.service';
import { listAvatars } from '../services/heygen.service';
import { prisma } from '../db/client';
import { z } from 'zod';

export async function miscRoutes(app: FastifyInstance) {
  // ─── Google OAuth ─────────────────────────────────────────────────────────
  app.get('/auth/google', async (request, reply) => {
    const userId = (request as any).user?.id;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const url = getAuthUrl(userId);
    return reply.redirect(url);
  });

  app.get('/auth/google/callback', async (request, reply) => {
    const { code, state: userId } = request.query as { code: string; state: string };
    if (!code || !userId) return reply.code(400).send({ error: 'Missing code or state' });

    const tokens = await exchangeCodeForTokens(code);
    await prisma.user.update({
      where: { id: userId },
      data: { googleTokens: tokens as any },
    });

    return reply.send({ message: 'Google Drive connected successfully' });
  });

  // ─── Dev Auth ─────────────────────────────────────────────────────────────
  app.post('/auth/token', async (request, reply) => {
    // Ensure the mock user exists in the database to prevent foreign key errors
    await prisma.user.upsert({
      where: { id: 'dev_user_123' },
      update: {},
      create: {
        id: 'dev_user_123',
        email: 'dev@example.com',
        displayName: 'Developer',
      },
    });

    // Generate a valid token for the mock user
    const token = await reply.jwtSign({ id: 'dev_user_123', role: 'admin' });
    return reply.send({ token });
  });

  // ─── Voices ───────────────────────────────────────────────────────────────
  app.get('/voices', async (request, reply) => {
    const userId = (request as any).user?.id;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const voices = await prisma.voice.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    return reply.send({ voices });
  });

  const cloneSchema = z.object({
    label: z.string().min(1).max(100),
    sampleUrl: z.string().url(),
  });

  app.post('/voices/clone', async (request, reply) => {
    const userId = (request as any).user?.id;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const parsed = cloneSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });

    const elevenLabsVoiceId = await cloneVoice(parsed.data.label, parsed.data.sampleUrl);

    const voice = await prisma.voice.create({
      data: {
        userId,
        label: parsed.data.label,
        elevenLabsVoiceId,
        status: 'ready', // ElevenLabs cloning is near-instant
        sampleUrl: parsed.data.sampleUrl,
      },
    });

    return reply.code(201).send({ voice });
  });

  // ─── Avatars (from HeyGen) ────────────────────────────────────────────────
  app.get('/avatars', async (request, reply) => {
    const avatars = await listAvatars();
    return reply.send({ avatars });
  });

  // ─── Health ───────────────────────────────────────────────────────────────
  app.get('/health', async (_request, reply) => {
    return reply.send({ status: 'ok', timestamp: new Date().toISOString() });
  });
}
