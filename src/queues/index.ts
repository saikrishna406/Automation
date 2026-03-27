import { Queue, Worker, QueueEvents, ConnectionOptions } from 'bullmq';
import { config } from '../config';
import { QUEUES } from '../types';

export const redisConnection: ConnectionOptions = {
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  tls: config.redis.host.includes('upstash.io') ? {} : undefined,
};

// ─── Queue Instances ──────────────────────────────────────────────────────────
export const scriptQueue = new Queue(QUEUES.SCRIPT, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
});

export const audioQueue = new Queue(QUEUES.AUDIO, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
});

export const videoQueue = new Queue(QUEUES.VIDEO, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
});

export const approvalQueue = new Queue(QUEUES.APPROVAL, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
});

export const editQueue = new Queue(QUEUES.EDIT, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 15000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
});

export const storageQueue = new Queue(QUEUES.STORAGE, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
});

export const notifyQueue = new Queue(QUEUES.NOTIFY, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    removeOnComplete: { count: 200 },
  },
});

export const allQueues = [
  scriptQueue,
  audioQueue,
  videoQueue,
  approvalQueue,
  editQueue,
  storageQueue,
  notifyQueue,
];
