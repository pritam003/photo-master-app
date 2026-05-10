/**
 * In-memory job store for async video generation jobs.
 * Jobs are ephemeral — they expire 1 hour after creation.
 * No DB persistence: the shareable link is a time-limited Azure Blob SAS URL.
 */

export type VideoJobStatus = "pending" | "processing" | "complete" | "error";

export interface VideoJob {
  jobId: string;
  userId: string;
  status: VideoJobStatus;
  videoUrl?: string;
  errorMessage?: string;
  createdAt: Date;
}

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour

const jobs = new Map<string, VideoJob>();

/** Periodically remove expired jobs (called on each write to keep the map lean). */
function pruneExpired(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt.getTime() < cutoff) {
      jobs.delete(id);
    }
  }
}

export function createJob(jobId: string, userId: string): VideoJob {
  pruneExpired();
  const job: VideoJob = {
    jobId,
    userId,
    status: "pending",
    createdAt: new Date(),
  };
  jobs.set(jobId, job);
  return job;
}

export function getJob(jobId: string): VideoJob | undefined {
  return jobs.get(jobId);
}

export function updateJob(
  jobId: string,
  patch: Partial<Pick<VideoJob, "status" | "videoUrl" | "errorMessage">>,
): void {
  const job = jobs.get(jobId);
  if (job) {
    Object.assign(job, patch);
  }
}
