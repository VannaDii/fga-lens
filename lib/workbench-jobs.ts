import { OperationFailure } from "./workbench-errors";

/** One cancellable long-running request and the units observed by its caller. */
type Job = {
  controller: AbortController;
  completed: number;
  total: number | null;
  cancelled: boolean;
  activeCase: boolean;
};

/** Jobs are local to the Next.js server and their originating request lifetime. */
const jobs = new Map<string, Job>();

/** Run a job with a cancellation signal and release its progress record on every exit. */
export async function runJob<A>(
  id: string, request: AbortSignal, work: (job: Job, signal: AbortSignal) => Promise<A>,
) {
  if (jobs.has(id)) throw new OperationFailure("conflict");
  const job: Job = { controller: new AbortController(), completed: 0, total: null, cancelled: false, activeCase: false };
  jobs.set(id, job);
  try {
    return await work(job, AbortSignal.any([request, job.controller.signal]));
  } finally {
    jobs.delete(id);
  }
}

/** Read only non-sensitive progress values, without returning job inputs. */
export function jobProgress(id: string) {
  const job = jobs.get(id);
  return { active: Boolean(job), completed: job?.completed ?? 0, total: job?.total ?? null };
}

/** Abort evidence or fetch immediately, or allow the current batch case to finish. */
export function cancelJob(id: string) {
  const job = jobs.get(id);
  if (!job) return { cancelled: false };
  job.cancelled = true;
  if (!job.activeCase) job.controller.abort();
  return { cancelled: true };
}
