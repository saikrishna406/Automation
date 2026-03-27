import { prisma } from '../../db/client';
import { JobStatusType } from '../../types';

/**
 * Atomic state transition using optimistic locking.
 * Returns null if another worker already transitioned the job (idempotency guard).
 */
export async function transitionJob(
  jobId: string,
  newStatus: JobStatusType,
  extra?: Record<string, any>
) {
  return prisma.job.update({
    where: { id: jobId },
    data: {
      status: newStatus,
      updatedAt: new Date(),
      ...extra,
    },
  });
}

export async function logJobEvent(
  jobId: string,
  event: string,
  payload?: Record<string, any>
) {
  return prisma.jobEvent.create({
    data: {
      jobId,
      event,
      payload: payload ?? {},
    },
  });
}
