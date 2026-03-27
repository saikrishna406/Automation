import { PrismaClient } from '@prisma/client';
import { config } from '../config';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

// Prevent multiple instances in dev (hot reload)
const prisma = global.__prisma ?? new PrismaClient({
  log: config.env === 'development' ? ['query', 'warn', 'error'] : ['warn', 'error'],
});

if (config.env !== 'production') {
  global.__prisma = prisma;
}

export { prisma };
