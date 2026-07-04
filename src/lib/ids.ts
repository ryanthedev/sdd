/**
 * Job id generation. Kept in its own module so the id scheme is a single,
 * swappable seam (the JobStore never hard-codes a format). Ids are process-local
 * and only need to be unique within one server session (job state is in-memory,
 * session-scoped — see the plan's "no disk persistence in v1").
 */
import { randomUUID } from "node:crypto";

/**
 * Mint a fresh, collision-free job id. The `job-` prefix keeps it recognizable
 * in logs; the UUID body guarantees uniqueness even for back-to-back dispatches.
 */
export function newJobId(): string {
  return `job-${randomUUID()}`;
}
