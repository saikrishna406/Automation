import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import rawBody from 'fastify-raw-body';
import { config } from './config';
import { jobsRoutes } from './routes/jobs.route';
import { webhooksRoute } from './routes/webhooks.route';
import { miscRoutes } from './routes/misc.route';

const app = Fastify({
  logger: {
    level: config.env === 'development' ? 'info' : 'warn',
    transport:
      config.env === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
  // Capture raw body for HMAC webhook verification
  bodyLimit: 10 * 1024 * 1024, // 10MB
});

// ─── Plugins ──────────────────────────────────────────────────────────────────
async function registerPlugins() {
  await app.register(cors, {
    origin: config.env === 'development' ? true : ['https://yourdomain.com'],
    credentials: true,
  });

  await app.register(helmet, { contentSecurityPolicy: false });

  await app.register(rawBody, {
    field: 'rawBody',
    global: false, // only for our webhook route
    encoding: false, // keep as buffer
    runFirst: true,
  });

  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    // In-memory store for dev. For prod multi-instance, pass an ioredis instance here.
    keyGenerator: (req) => {
      return (req as any).user?.id ?? req.ip;
    },
    errorResponseBuilder: () => ({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests. Please slow down.',
    }),
  });

  await app.register(jwt, {
    secret: config.jwt.secret,
    sign: { expiresIn: config.jwt.expiresIn },
  });
}

// ─── Auth decorator ────────────────────────────────────────────────────────────
app.addHook('onRequest', async (request, reply) => {
  // Allow health + webhooks without auth
  const publicPaths = ['/health', '/webhooks/', '/auth/'];
  const isPublic = publicPaths.some((p) => request.url.includes(p));
  if (isPublic) return;

  try {
    await request.jwtVerify();
  } catch (err) {
    return reply.code(401).send({ error: 'Unauthorized', message: 'Valid JWT required' });
  }
});

// ─── Routes ───────────────────────────────────────────────────────────────────
async function registerRoutes() {
  await app.register(jobsRoutes, { prefix: '/api/v1/jobs' });
  await app.register(webhooksRoute, { prefix: '/webhooks' });
  await app.register(miscRoutes, { prefix: '/api/v1' });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function start() {
  try {
    await registerPlugins();
    await registerRoutes();

    // ── Ensure Supabase storage buckets exist ──────────────────────────────
    const { ensureBucketsExist } = await import('./services/supabase-storage.service');
    await ensureBucketsExist();

    await app.listen({ port: config.port, host: config.host });
    console.log(`\n🚀 Video Automation API running at http://${config.host}:${config.port}`);
    console.log(`   Environment: ${config.env}`);
    console.log(`   API Base:    /api/v1`);
    console.log(`   Webhooks:    /webhooks/heygen\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();

export { app };
