import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000'),
  HOST: z.string().default('0.0.0.0'),

  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('15m'),

  DATABASE_URL: z.string().url(),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string().default('6379'),
  REDIS_PASSWORD: z.string().optional(),

  // ── Supabase (replaces AWS S3 + separate PostgreSQL) ─────────────────────
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(10),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10),

  OPENAI_API_KEY: z.string().startsWith('sk-'),
  ELEVENLABS_API_KEY: z.string(),
  ELEVENLABS_MODEL_ID: z.string().default('eleven_turbo_v2_5'),

  HEYGEN_API_KEY: z.string(),
  HEYGEN_WEBHOOK_SECRET: z.string(),

  DESCRIPT_API_KEY: z.string(),

  GOOGLE_CLIENT_ID: z.string(),
  GOOGLE_CLIENT_SECRET: z.string(),
  GOOGLE_REDIRECT_URI: z.string(),
  GOOGLE_DRIVE_FOLDER_ID: z.string(),

  AUTO_APPROVAL_THRESHOLD: z.string().default('0.85'),
  MAX_SCRIPT_CHARS: z.string().default('5000'),
  HEYGEN_POLL_INTERVAL_MS: z.string().default('30000'),
  HEYGEN_MAX_POLL_MINUTES: z.string().default('30'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid environment variables:\n', parsed.error.format());
  process.exit(1);
}

export const config = {
  env: parsed.data.NODE_ENV,
  port: parseInt(parsed.data.PORT),
  host: parsed.data.HOST,

  jwt: {
    secret: parsed.data.JWT_SECRET,
    expiresIn: parsed.data.JWT_EXPIRES_IN,
  },

  db: {
    url: parsed.data.DATABASE_URL,
  },

  redis: {
    host: parsed.data.REDIS_HOST,
    port: parseInt(parsed.data.REDIS_PORT),
    password: parsed.data.REDIS_PASSWORD,
  },

  // ── Supabase (DB + Storage) ───────────────────────────────────────────────
  supabase: {
    url: parsed.data.SUPABASE_URL,
    anonKey: parsed.data.SUPABASE_ANON_KEY,
    serviceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
  },

  openai: {
    apiKey: parsed.data.OPENAI_API_KEY,
  },

  elevenlabs: {
    apiKey: parsed.data.ELEVENLABS_API_KEY,
    modelId: parsed.data.ELEVENLABS_MODEL_ID,
  },

  heygen: {
    apiKey: parsed.data.HEYGEN_API_KEY,
    webhookSecret: parsed.data.HEYGEN_WEBHOOK_SECRET,
    pollIntervalMs: parseInt(parsed.data.HEYGEN_POLL_INTERVAL_MS),
    maxPollMinutes: parseInt(parsed.data.HEYGEN_MAX_POLL_MINUTES),
  },

  descript: {
    apiKey: parsed.data.DESCRIPT_API_KEY,
  },

  google: {
    clientId: parsed.data.GOOGLE_CLIENT_ID,
    clientSecret: parsed.data.GOOGLE_CLIENT_SECRET,
    redirectUri: parsed.data.GOOGLE_REDIRECT_URI,
    driveFolderId: parsed.data.GOOGLE_DRIVE_FOLDER_ID,
  },

  pipeline: {
    autoApprovalThreshold: parseFloat(parsed.data.AUTO_APPROVAL_THRESHOLD),
    maxScriptChars: parseInt(parsed.data.MAX_SCRIPT_CHARS),
  },
} as const;
