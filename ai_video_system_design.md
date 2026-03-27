# 🎬 AI Video Generation System — Production Architecture

> **Author POV:** Staff Engineer + Senior Product Architect + Principal UX Designer
> **Stack Assumption:** HeyGen (video), async-first, cloud-native
> **Date:** 2026-03-26

---

## 1. 🧠 SYSTEM ARCHITECTURE

### Why Hybrid Microservices over Pure Monolith or Full Serverless

**Monolith** → Fails at scale. One failing service (video polling) blocks unrelated features (voice management).  
**Full Serverless** → Cold starts on Lambda = unacceptable for queue workers. Cost unpredictable at scale.  
**Hybrid Microservices** → Domain-separated services sharing an event bus, horizontally scalable workers, simple ops.

```
┌────────────────────────────────────────────────────────────────────┐
│                          CLIENT LAYER                              │
│          Web App (Next.js)  ←→  Mobile (React Native, future)     │
└───────────────────────────────────┬────────────────────────────────┘
                                    │ HTTPS / WebSocket
┌───────────────────────────────────▼────────────────────────────────┐
│                        API GATEWAY (Kong / NGINX)                  │
│   Rate Limiting · JWT Auth · Request Routing · TLS Termination     │
└────┬──────────────┬───────────────┬──────────────┬─────────────────┘
     │              │               │              │
┌────▼───┐  ┌───────▼──┐   ┌───────▼──┐   ┌──────▼────────┐
│  User  │  │  Voice   │   │  Video   │   │  Webhook      │
│  Svc   │  │  Service │   │  Gen Svc │   │  Handler Svc  │
│        │  │          │   │          │   │  (HeyGen CB)  │
└────────┘  └──────────┘   └────┬─────┘   └──────┬────────┘
                                │                 │
                    ┌───────────▼─────────────────▼──────┐
                    │        MESSAGE BUS (BullMQ / Redis) │
                    │   Queues: video.generate            │
                    │           video.poll                │
                    │           video.notify              │
                    └─────────────────┬──────────────────┘
                                      │
                    ┌─────────────────▼──────────────────┐
                    │       WORKER FLEET (Autoscaled)     │
                    │  VideoWorker × N  (horizontal)      │
                    │  PollWorker × N                     │
                    └─────────────────┬──────────────────┘
                                      │
          ┌───────────────────────────▼────────────────────────┐
          │                   STORAGE LAYER                     │
          │  PostgreSQL (primary DB)  ·  Redis (cache/queue)    │
          │  S3-compatible (video files)  ·  CloudFront (CDN)   │
          └────────────────────────────────────────────────────┘
```

### Failure Handling at Architecture Level

| Concern        | Strategy                                                                 |
|----------------|--------------------------------------------------------------------------|
| Retries        | BullMQ exponential backoff: `attempts: 5, backoff: { type: 'exponential', delay: 3000 }` |
| Idempotency    | `idempotency_key = SHA256(user_id + script_hash + avatar_id)`; DB unique constraint prevents duplicate jobs |
| Rate Limits    | Per-user token bucket in Redis; HeyGen API calls throttled via a dedicated `heygen-rate-limiter` queue |
| Failures       | Dead Letter Queue (DLQ); alerts to PagerDuty; job marked `failed` with error metadata |
| Webhook loss   | Fallback polling worker activates after 5 min if webhook not received    |

---

## 2. ⚙️ BACKEND DESIGN

### Tech Stack Justification

| Component         | Choice                     | Why                                                        |
|-------------------|----------------------------|------------------------------------------------------------|
| API Runtime       | Node.js + Fastify          | Non-blocking I/O, fastest HTTP framework, native async     |
| Queue             | BullMQ + Redis             | Battle-tested, job priorities, repeatable jobs, Redis pub/sub for live updates |
| Database          | PostgreSQL 15              | ACID guarantees, JSONB for metadata, pg_partitioning for job_logs at scale |
| ORM               | Prisma (typed) / Drizzle   | Type safety; Drizzle preferred for raw SQL proximity at scale |
| Object Storage    | AWS S3 / Cloudflare R2     | R2 = zero egress cost, better CDN economics                |
| Cache             | Redis (ElastiCache)        | Query cache, rate limit counters, job dedup                |
| Observability     | OpenTelemetry + Grafana    | Distributed tracing across worker hops                     |

---

### Service Contracts

#### Voice Service

```
POST /api/v1/voices/clone
Body:  { audio_sample_url: string, label: string }
Resp:  { voice_id: string, status: "processing" | "ready" }

GET  /api/v1/voices
Resp: { voices: [ { id, label, status, created_at } ] }

DELETE /api/v1/voices/:voice_id
```

**Internal:** Calls HeyGen Voice Clone API, stores `voice_id` in DB, marks status async via webhook.

---

#### Video Generation Service

```
POST /api/v1/videos/generate
Body:
{
  script: string,           // max 5000 chars
  voice_id: string,         // required — pre-cloned
  avatar_id: string,        // HeyGen avatar ID
  aspect_ratio: "16:9"|"9:16"|"1:1",
  idempotency_key?: string  // client-provided dedup key
}
Resp (202 Accepted):
{
  job_id: string,
  status: "queued",
  estimated_wait_seconds: number,
  poll_url: "/api/v1/jobs/:job_id"
}

GET /api/v1/jobs/:job_id
Resp:
{
  job_id, status, progress_pct,
  video_url?, thumbnail_url?,
  error?, created_at, updated_at
}

POST /api/v1/videos/bulk
Body: { items: [ { script, voice_id, avatar_id } ] }   // max 50 per batch
Resp: { batch_id, job_ids: string[] }
```

**Design Decision:** Always 202. Never block on HeyGen. The client polls or subscribes via WebSocket.

---

### Job State Machine

```
[QUEUED] ──── worker picks up ──→ [PROCESSING]
                                       │
                       ┌───────────────┼────────────────┐
                       ▼               ▼                ▼
                  [COMPLETED]      [FAILED]        [RETRYING]
                       │               │                │
                   store URL      alert + DLQ    backoff → [PROCESSING]
```

State transitions are **atomic** using PostgreSQL UPDATE with optimistic locking:
```sql
UPDATE jobs SET status = 'processing', worker_id = $1, updated_at = NOW()
WHERE id = $2 AND status = 'queued'
RETURNING *;
```
If 0 rows returned → another worker claimed it. Skip. This is your idempotency guard.

---

## 3. 🧩 DATABASE DESIGN

### Schema

```sql
-- Users
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  plan          TEXT DEFAULT 'free',   -- free | pro | enterprise
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Voices
CREATE TABLE voices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  heygen_voice_id TEXT UNIQUE NOT NULL,   -- HeyGen's external ID
  status        TEXT DEFAULT 'processing', -- processing | ready | failed
  sample_url    TEXT,
  metadata      JSONB,                     -- future: language, accent, emotion config
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_voices_user_id ON voices(user_id);
CREATE INDEX idx_voices_status  ON voices(status);

-- Jobs (core)
CREATE TABLE jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key  TEXT UNIQUE,         -- SHA256(user+script+avatar)
  type             TEXT DEFAULT 'video_generate',
  status           TEXT DEFAULT 'queued',   -- queued|processing|polling|completed|failed
  priority         INT DEFAULT 5,           -- 1=highest, 10=lowest
  attempts         INT DEFAULT 0,
  max_attempts     INT DEFAULT 5,
  worker_id        TEXT,                    -- which pod/worker claimed it
  heygen_video_id  TEXT,                    -- HeyGen's job ID (for polling)
  payload          JSONB NOT NULL,          -- { script, voice_id, avatar_id, aspect_ratio }
  result           JSONB,                   -- { video_url, thumbnail_url, duration_sec }
  error            JSONB,                   -- { code, message, heygen_raw }
  scheduled_at     TIMESTAMPTZ DEFAULT NOW(),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_jobs_user_id    ON jobs(user_id);
CREATE INDEX idx_jobs_status     ON jobs(status);
CREATE INDEX idx_jobs_priority   ON jobs(priority, scheduled_at) WHERE status = 'queued';
CREATE INDEX idx_jobs_heygen_id  ON jobs(heygen_video_id) WHERE heygen_video_id IS NOT NULL;

-- Videos
CREATE TABLE videos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID UNIQUE REFERENCES jobs(id),
  user_id       UUID REFERENCES users(id),
  voice_id      UUID REFERENCES voices(id),
  title         TEXT,
  script_text   TEXT NOT NULL,
  video_url     TEXT NOT NULL,          -- CDN URL (CloudFront)
  thumbnail_url TEXT,
  raw_s3_key    TEXT,                   -- internal S3 path
  duration_sec  INT,
  aspect_ratio  TEXT,
  size_bytes    BIGINT,
  view_count    BIGINT DEFAULT 0,
  is_deleted    BOOLEAN DEFAULT FALSE,  -- soft delete
  metadata      JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_videos_user_id ON videos(user_id) WHERE is_deleted = FALSE;

-- Job Audit Log (append-only, partition by month)
CREATE TABLE job_events (
  id         BIGSERIAL,
  job_id     UUID NOT NULL,
  event      TEXT NOT NULL,   -- status_change | retry | webhook_received
  payload    JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- Webhook Log
CREATE TABLE webhook_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source       TEXT DEFAULT 'heygen',
  raw_payload  JSONB NOT NULL,
  processed    BOOLEAN DEFAULT FALSE,
  error        TEXT,
  received_at  TIMESTAMPTZ DEFAULT NOW()
);
```

### Indexing Strategy Summary

| Index                                | Purpose                                          |
|--------------------------------------|--------------------------------------------------|
| `jobs(status)`                       | Worker fetches queued jobs                       |
| `jobs(priority, scheduled_at) WHERE status='queued'` | Priority-ordered job pickup    |
| `jobs(heygen_video_id)`              | Webhook handler matches callback to job          |
| `voices(user_id)`                    | Voice list per user                              |
| `videos(user_id) WHERE NOT deleted`  | Partial index — skips soft-deleted rows          |

### Multi-Tenancy Future-Proofing

Add `org_id UUID` to all tables. Row-Level Security (RLS) in PostgreSQL ensures tenants never see each other's data:
```sql
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON jobs USING (org_id = current_setting('app.org_id')::UUID);
```

---

## 4. 🔄 VIDEO GENERATION PIPELINE

### Full End-to-End Flow

```
USER SUBMITS SCRIPT
       │
       ▼
[API: POST /videos/generate]
  1. Validate JWT → extract user_id
  2. Fetch voice_id from DB (must be status=ready)
  3. Compute idempotency_key = SHA256(user_id+script+avatar_id)
  4. Check jobs table for existing key → if found, return existing job_id (dedup)
  5. INSERT job (status=queued, payload={script,voice_id,avatar_id})
  6. ENQUEUE to BullMQ queue "video.generate" with job_id
  7. Return 202 { job_id, status:"queued" }
       │
       ▼
[BullMQ WORKER picks job]
  8. UPDATE jobs SET status='processing', worker_id=pod_id, started_at=NOW()
  9. Call HeyGen API:
     POST https://api.heygen.com/v2/video/generate
     { script, voice_id, avatar_id, aspect_ratio }
  10. HeyGen responds → { video_id: "hey_xxx" }
  11. UPDATE jobs SET heygen_video_id='hey_xxx', status='polling'
       │
       ▼
[WEBHOOK HANDLER — preferred path]
  12. HeyGen POSTs to /webhooks/heygen with { video_id, status, url }
  13. Lookup job by heygen_video_id
  14. If completed:
      a. Download video from HeyGen URL (presigned)
      b. Upload to S3: s3://bucket/videos/{user_id}/{job_id}.mp4
      c. Generate CloudFront URL
      d. INSERT into videos table
      e. UPDATE jobs SET status='completed', result={video_url, ...}
      f. ENQUEUE "video.notify" → send WebSocket push or email
  15. If failed: mark job failed, log error, trigger retry or DLQ

[FALLBACK — Poll Worker — activates 5 min after status=polling with no webhook]
  12b. Poll GET /video/status/{heygen_video_id} every 30 sec
  13b. Same completion logic as above
```

### Sync vs Async Decisions

| Action                    | Mode  | Reason                                             |
|---------------------------|-------|----------------------------------------------------|
| Script validation         | Sync  | Instant, client needs to know if input is invalid  |
| voice_id lookup           | Sync  | DB read, <10ms                                     |
| Idempotency check         | Sync  | Critical — must happen before enqueue              |
| HeyGen API call           | Async | Can take 30–300 sec; never block HTTP thread       |
| Video download + S3 upload| Async | Large binary transfer inside worker                |
| User notification         | Async | Secondary concern, separate queue                  |

### Latency Optimization

- **Queue Priority**: Pro users get priority=1, free users priority=5
- **Pre-warming**: Keep 1–2 HeyGen concurrent jobs running at all times (reduces cold allocation)
- **Concurrency caps**: BullMQ `concurrency: 10` per worker pod; HeyGen rate limit = 5 concurrent/API key → rotate across N API keys
- **CDN Pre-signing**: CloudFront signed URL generated at completion time, cached in `videos.video_url`

---

## 5. 🎨 FRONTEND UX

### Design Philosophy: Creator-First, Zero Friction

> The mental model: **Script → Voice → Generate → Done.** Every extra click is engineering failure.

---

### Page: Script Input + Generate

```
┌──────────────────────────────────────────────────────┐
│  ✍️  New Video                                        │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │  Script (5000 chars max)                       │  │
│  │                                                │  │
│  │  [Rich textarea with char count + AI assist]  │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  Voice:   [▼ My Voice — "Sai Clone" (ready) ✅]     │
│  Avatar:  [▼ Professional Male (HeyGen) ▾]          │
│  Format:  [16:9] [9:16] [1:1]                        │
│                                                      │
│  [  ⚡ Generate Video  ]     [+ Add to Batch]        │
└──────────────────────────────────────────────────────┘
```

**UX decisions:**
- Voice selector only shows `status=ready` voices → no invalid state
- "Add to Batch" accumulates items before single bulk submit → reduces API calls
- Real-time char counter with color warning at 4500/5000
- AI Assist button → optional GPT call to improve script tone/length

---

### Page: Video Status Dashboard

```
┌─────────────────────────────────────────────────────────┐
│  📽 My Videos                    [Filter ▼] [Bulk ▼]    │
├─────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────┐  │
│  │ 🔄 "Product Launch Script"         PROCESSING     │  │
│  │    Estimated: ~2 min  ████████░░░░ 65%            │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │ ✅ "Welcome Series Ep1"             COMPLETED     │  │
│  │   [▶ Preview]  [⬇ Download]  [🔗 Copy CDN URL]   │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │ ❌ "Brand Story Draft"               FAILED       │  │
│  │   Error: HeyGen voice_id invalid                  │  │
│  │   [🔁 Retry]  [✏ Edit Script]  [🔍 See Details]  │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

**Real-time updates** via WebSocket (or SSE fallback):
```
ws://api.yourdomain.com/ws?token=JWT
Server pushes: { type: "job_update", job_id, status, progress_pct, video_url? }
```
Client subscribes per job_id — no polling needed.

---

### Page: Voice Management

```
┌──────────────────────────────────────────────────────┐
│  🎙 Voice Library                [+ Clone New Voice] │
├──────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────┐  │
│  │  "Sai Clone"     ✅ Ready   [▶ Preview] [🗑]   │  │
│  │  Created: March 15, 2026                       │  │
│  └────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────┐  │
│  │  "Pitch Voice"   ⏳ Processing...              │  │
│  │  Cloning from your uploaded sample             │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

Clone flow: Upload audio → confirm sample quality score → clone → webhook marks ready.

---

### Bulk Generation UX

```
Batch Builder:
  [Add Row] × 50

  Row 1: script: [__________] voice: [Sai ▾]  avatar: [Pro ▾]  [🗑]
  Row 2: script: [__________] voice: [Sai ▾]  avatar: [Pro ▾]  [🗑]

  [Generate All 12 Videos →]
  → Single POST /videos/bulk, returns 12 job_ids
  → All tracked in dashboard with batch grouping
```

---

## 6. ⚡ SCALABILITY & PERFORMANCE

### Scaling Tiers

| Users       | Architecture                                                        |
|-------------|---------------------------------------------------------------------|
| 10–100      | Single Node.js server, BullMQ + Redis on same host, RDS micro       |
| 100–1,000   | API behind load balancer, Redis Cluster, RDS r6g.large, 3 workers   |
| 1,000–10,000| K8s autoscaling workers (HPA on queue depth), Redis Sentinel, RDS Multi-AZ, CDN |
| 10,000+     | Dedicated HeyGen API keys rotated per tenant, Global Redis, Postgres read replicas, SQS for inter-service |

### Queue Scaling Strategy (Critical)

```
BullMQ Queue Depth Monitoring (via Bull Board / custom metrics):
  - queue.waiting > 50  → scale up workers (k8s HPA trigger)
  - queue.waiting < 5   → scale down after 10-min cooldown
  - Worker min: 2 (always warm), max: 50

HeyGen API key rotation:
  keys = [key_a, key_b, key_c, ...]
  Pick key = keys[job_id.crc32() % keys.length]   // deterministic + balanced
```

### Caching Strategy

| Data                  | Cache Layer     | TTL       | Reason                        |
|-----------------------|-----------------|-----------|-------------------------------|
| voice list per user   | Redis           | 5 min     | Rarely changes                |
| video metadata        | Redis           | 1 hr      | Frequently read in dashboard  |
| HeyGen avatar list    | Redis           | 24 hr     | Static catalog                |
| CDN video delivery    | CloudFront      | Immutable | Videos never change post-gen  |

### CDN Delivery

```
S3 Raw Storage → CloudFront Distribution
  - Origin: s3://ai-videos-prod/videos/{user_id}/{job_id}.mp4
  - CDN URL: https://cdn.yourdomain.com/videos/{job_id}.mp4
  - Signed URLs for private videos (CloudFront key pair)
  - Cache-Control: max-age=31536000, immutable
```

---

## 7. 🔐 SECURITY & ABUSE PREVENTION

### Auth Strategy

- **JWT (RS256)** — private key signs tokens, public key verifies at API gateway
- **Access Token:** 15-min TTL
- **Refresh Token:** 7-day, stored in httpOnly cookie, rotated on use
- **Scopes:** `video:generate`, `voice:clone`, `admin:*`

### Voice Cloning Misuse Prevention

| Layer            | Control                                                         |
|------------------|-----------------------------------------------------------------|
| Consent Gate     | User must check "I confirm this is my own voice" before clone   |
| Abuse Reporting  | Report endpoint; flagged voices are frozen and reviewed         |
| Rate Limit       | Max 3 voice clones per account per month (configurable by plan) |
| Watermarking     | Embed inaudible audio fingerprint (SteamMark / ACRCloud)        |
| DMCA Process     | Documented takedown pipeline; auto-disable on valid claim       |

### API Rate Limiting

Via Redis Token Bucket (implemented at API Gateway layer):

```
Free Plan:   5 video generates / day
Pro Plan:    50 video generates / day
Enterprise:  Negotiated limit + dedicated API keys

Rate limit headers:
  X-RateLimit-Limit: 50
  X-RateLimit-Remaining: 47
  X-RateLimit-Reset: 1711477200
```

### General Security

- All endpoints: input validation (Zod schemas), SQL injection prevention (parameterized queries)
- Webhook endpoint: verify HeyGen HMAC signature `X-Heygen-Signature` before processing
- S3 bucket: no public access, all reads via signed URLs or CloudFront OAC
- Secrets: AWS Secrets Manager / Doppler — never in `.env` in production

---

## 8. 💸 COST OPTIMIZATION

### HeyGen API Cost Reduction

| Strategy              | Detail                                                         |
|-----------------------|----------------------------------------------------------------|
| Deduplication         | `idempotency_key` prevents re-submitting identical jobs        |
| Bulk Batching         | Users encouraged to batch (UI), reducing per-request overhead  |
| Script Caching        | Hash-based: if same script+voice+avatar was rendered in 7 days, serve cached video |
| Failure Fast          | Validate voice_id exists + is ready BEFORE calling HeyGen; saves failed API credits |
| Preview Mode          | Offer 10-sec preview generation (cheaper HeyGen tier) before full render |

### Storage Cost Reduction

| Strategy              | Detail                                                          |
|-----------------------|-----------------------------------------------------------------|
| Cloudflare R2         | Zero egress fees vs S3's $0.09/GB. Game-changer at scale       |
| Tiered Storage        | Videos not accessed in 30d → S3 Glacier / R2 Infrequent Access |
| Compression           | Re-encode with FFmpeg (H.265/HEVC) → ~40% smaller at same quality |
| Soft Delete + Purge   | `is_deleted=true` → 30-day grace period → purge from storage   |
| Thumbnail Lazy Gen    | Generate thumbnail at request time via CloudFront Lambda@Edge, cache permanently |

---

## 9. 🚧 EDGE CASES

### 1. `voice_id` Missing or Not Ready

**Scenario:** User submits job but their voice clone is still `status=processing`.

**Handling:**
```
→ API returns 422 Unprocessable Entity:
  { error: "VOICE_NOT_READY", message: "Voice clone is still processing. Try again in a few minutes." }
→ Frontend: show banner "Your voice is being cloned — we'll notify you when ready."
→ Alternative: allow job to queue with status=waiting_for_voice, re-check every 60s
```

---

### 2. HeyGen API Timeout / 5xx

**Scenario:** HeyGen takes >30s or returns 503.

**Handling:**
```
→ Worker catches HTTP error
→ Job status = 'retrying', attempts++
→ BullMQ exponential backoff: 3s → 9s → 27s → 81s → 243s
→ After 5 attempts: status='failed', error logged, DLQ entry
→ Admin alert: if >10 failures/min → PagerDuty P1 alert (HeyGen outage)
```

---

### 3. Webhook Never Arrives (Silent Failure)

**Scenario:** HeyGen generated video but webhook delivery failed (network issue).

**Handling:**
```
→ All jobs in status='polling' are monitored by PollWorker
→ PollWorker: every 30s, query jobs WHERE status='polling' AND updated_at < NOW() - INTERVAL '5 minutes'
→ Calls HeyGen GET /video/status/{heygen_video_id}
→ Completes job if done, continues polling if still processing
→ Max poll duration: 30 min → mark failed if exceeded
```

---

### 4. Partial Video Generation / Corrupt File

**Scenario:** S3 upload interrupted, video URL is broken.

**Handling:**
```
→ After download from HeyGen: verify file integrity (content-length check + MD5 hash)
→ Use S3 multipart upload for files >50MB → resumable on failure
→ If integrity check fails: delete partial, retry full download
→ videos.video_url only populated AFTER successful integrity verification
```

---

### 5. Duplicate Requests (User Spams "Generate")

**Scenario:** User clicks Generate 5 times quickly; frontend debounce fails.

**Handling:**
```
→ Frontend: disable button for 5s after click (optimistic lock)
→ API: idempotency_key check — returns existing job_id if duplicate detected within 1hr
→ DB: UNIQUE constraint on idempotency_key → any race condition caught at DB level
→ BullMQ: jobId set to idempotency_key → Bull deduplicates queue entries
```

---

### 6. User Spamming API (Burst Abuse)

**Scenario:** Script kiddie hits `/videos/generate` in a loop.

**Handling:**
```
→ API Gateway: 429 Too Many Requests after plan limit exceeded
→ Suspicious burst (>20 req/min): temporary 1-hour account flag + email warning
→ >3 flags: account suspended for manual review
→ IP-level rate limiting: 100 req/min per IP regardless of auth
```

---

### 7. Worker Crash Mid-Job (Zombie Jobs)

**Scenario:** Worker pod crashes after `status=processing` but before completion.

**Handling:**
```
→ BullMQ jobs have `lockDuration: 30000` (30s lock)
→ If worker doesn't renew lock → job becomes "stalled"
→ BullMQ automatically re-queues stalled jobs (stalledInterval check)
→ `worker_id` column allows tracing which pod last claimed the job for forensics
```

---

## 10. 🔮 FUTURE-PROOFING

### Multi-Voice Per User

- `voices` table already has `user_id` FK (1:many)
- Video generation payload supports `voice_id` selection per job
- UI voice selector becomes a multi-voice library
- Add `voice_tags` (e.g., `["casual", "english", "pitch-high"]`) for smart selection

---

### Real-Time Video Preview

- Enable 10-second preview renders in HeyGen (if supported via API tier)
- Stream preview directly: use HLS chunked streaming, not full download
- Preview player embeds in dashboard before committing to full render
- Cache previews with 7-day TTL (cheap storage, high UX value)

---

### AI Script Generation Pipeline

```
User Input → [LLM (GPT-4o / Gemini 2.0 Flash)] → Polished Script → Review → Generate
              ↑
         Brand Context (stored per user):
         - brand voice doc
         - product descriptions
         - target audience profile
```

- Store user's brand context in `user_profiles.brand_context JSONB`
- Script gen = RAG over brand context + user input prompt
- Script history saved → reusable templates

---

### Social Auto-Posting System

```
POST /api/v1/social/schedule
{
  video_id: string,
  platforms: ["instagram_reel", "youtube_short", "tiktok"],
  scheduled_at: "2026-04-01T09:00:00Z",
  caption: string,
  hashtags: string[]
}
```

- Integrate: Buffer API / Zapier webhooks / native OAuth per platform
- Add `scheduled_posts` table with retry logic for platform posting failures
- Queue: `social.post` — exact same BullMQ pattern as video generation

---

## 📊 Architecture Decision Log

| Decision                        | Choice Made          | Alternative Rejected | Reason                                              |
|---------------------------------|----------------------|-----------------------|-----------------------------------------------------|
| Queue                           | BullMQ + Redis       | AWS SQS              | BullMQ has priorities, repeatable jobs, UI dashboard (Bull Board) |
| DB                              | PostgreSQL            | MongoDB              | ACID, complex joins for reporting, RLS for multi-tenancy |
| Webhook vs Poll                 | Both (webhook primary, poll fallback) | Poll only | Webhook = instant; poll as safety net |
| CDN                             | CloudFront / R2      | S3 public            | Security + performance + cost                        |
| Auth                            | JWT RS256            | Session-based        | Stateless, scales across microservices              |
| Video Storage Format            | Original MP4 → H.265 transcode | Raw only  | 40% storage savings at scale                        |

---

*This document is a living architecture spec. Version as the system evolves.*
