/**
 * Queue names are a shared contract between whoever enqueues (the API) and whoever
 * consumes (this service). Keeping them in one place stops the two sides from
 * drifting apart on a typo.
 */
export const QUEUE_NAMES = {
  DISCOVERY: "discovery",
  ENRICHMENT: "enrichment",
  SCORING: "scoring",
  OUTREACH: "outreach",
  INBOX: "inbox",
  MAINTENANCE: "maintenance",
} as const

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]

export const JOB_NAMES = {
  STORAGE_CLEANUP: "storage.cleanup",
  IDEMPOTENCY_CLEANUP: "idempotency.cleanup",
} as const

/** Sensible retry posture for the queues added in later milestones. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
}
