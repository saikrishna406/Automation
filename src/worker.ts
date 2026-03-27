import 'dotenv/config';
import { startScriptWorker } from './queues/workers/script.worker';
import { startAudioWorker } from './queues/workers/audio.worker';
import { startVideoWorker } from './queues/workers/video.worker';
import { startApprovalWorker } from './queues/workers/approval.worker';
import { startEditWorker } from './queues/workers/edit.worker';
import { startStorageWorker } from './queues/workers/storage.worker';

console.log('\n🏭 Starting Video Automation Worker Fleet...\n');

// Start all pipeline workers
const workers = [
  startScriptWorker(),
  startAudioWorker(),
  startVideoWorker(),
  startApprovalWorker(),
  startEditWorker(),
  startStorageWorker(),
];

console.log(`\n✅ ${workers.length} workers active. Listening for jobs...\n`);

// Graceful shutdown
async function shutdown() {
  console.log('\n⚡ Shutting down workers gracefully...');
  await Promise.all(workers.map((w) => w.close()));
  console.log('✅ All workers stopped');
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
