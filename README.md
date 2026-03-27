# 🎬 AI Video Automation Pipeline (V1-Production)

A high-performance, 7-stage automated video generation system that transforms text prompts into fully edited, avatar-based AI videos with consistent voice cloning. 

Built with **Node.js, TypeScript, BullMQ, PostgreSQL, Supabase, and React.**

---

## 🚀 The 7-Stage Pipeline
The system is architected as a series of decoupled, resilient micro-workers managed by **BullMQ** and backed by **Upstash Redis**.

1.  **Script Service (OpenAI):** GPT-4o generates high-converting scripts with structured JSON sections (Hook, Body, CTA).
2.  **Audio Service (ElevenLabs):** Converts scripts into ultra-realistic speech using consistent voice clones with word-level alignment timestamps.
3.  **Video Service (HeyGen):** Generates audio-driven "Talking Photo" or "Avatar" videos with perfect lip-sync.
4.  **Approval Layer:** Automated QA scoring (file size/duration checks) with a manual override interface for human review.
5.  **Editing Service (Descript/FFmpeg):** Automatically stitches captions, overlays, and applies professional cuts.
6.  **Storage Service (Supabase):** Manages raw and edited assets via a high-speed global CDN.
7.  **Delivery (Google Drive):** Final outputs are automatically organized and uploaded to a specific Google Drive folder.

---

## 🛠️ Tech Stack
- **Backend:** Fastify (API), BullMQ (Background Jobs), Prisma (ORM), TypeScript.
- **Database:** Supabase (PostgreSQL), Upstash (Serverless Redis).
- **Storage:** Supabase Storage (S3-compatible) & Google Drive API.
- **Frontend:** React (Vite), CSS3 Variables (Custom Design System).
- **Video/AI Ops:** OpenAI API, ElevenLabs API, HeyGen API, Descript API, FFmpeg.

---

## 📦 Getting Started

### 1. Environment Configuration
Create a `.env` file in the root directory and populate it with your keys:
```bash
# Core
DATABASE_URL="postgresql://..."
REDIS_HOST="obliging-filly-86128.upstash.io"
REDIS_PASSWORD="..."

# AI Keys
OPENAI_API_KEY="sk-..."
ELEVENLABS_API_KEY="..."
HEYGEN_API_KEY="..."
HEYGEN_WEBHOOK_SECRET="..."
DESCRIPT_API_KEY="..."

# Storage & Auth
SUPABASE_URL="..."
SUPABASE_SERVICE_ROLE_KEY="..."
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
GOOGLE_DRIVE_FOLDER_ID="..."
```

### 2. Database Migration
Sync the schema to your Supabase instance:
```bash
npx prisma db push
```

### 3. Start the Engines
You need two primary processes running simultaneously:

**API Server:**
```bash
npm run dev
```

**Worker Fleet (The Pipeline):**
```bash
npm run worker
```

**Frontend Dashboard:**
```bash
cd frontend
npm run dev
```

---

## 🎨 Dashboard Overview
The dashboard provides total visibility into your pipeline:
- **Pipeline Visualizer:** Real-time progress tracking of every job.
- **QA Scoreboard:** Automated quality checks for visual/audio sync.
- **Manual Approval Flow:** Reject or Approve videos before final editing.
- **Drive Integration:** Direct links to final files in your Google Drive.

---

## 🏗️ Project Structure
- `/src/app.ts` - Fastify server & security config.
- `/src/worker.ts` - Entry point for the BullMQ worker fleet.
- `/src/services` - Modular integrations (OpenAI, HeyGen, etc.).
- `/src/queues` - Queue definitions and failure/retry logic.
- `/frontend` - Vite + React dashboard.

---

## 🛡️ Security & Scalability
- **HMAC Verification:** HeyGen webhooks are verified using SHA-256 HMAC signatures.
- **Idempotency:** Automatic job deduplication to prevent accidental double-billing.
- **Concurrency:** Workers can be scaled horizontally to handle thousands of concurrent video renders.
