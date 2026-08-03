import { z } from "zod"

/**
 * Stable error slugs. These become the `type` URI suffix in problem+json and are
 * part of the public API contract - the frontend branches on them. Never rename
 * one without a deprecation cycle; add a new slug instead.
 */
export const PROBLEM_TYPES = {
  VALIDATION_FAILED: "validation-failed",
  UNAUTHENTICATED: "unauthenticated",
  FORBIDDEN: "forbidden",
  WORKSPACE_REQUIRED: "workspace-required",
  NOT_FOUND: "not-found",
  CONFLICT: "conflict",
  IDEMPOTENCY_KEY_REUSED: "idempotency-key-reused",
  RATE_LIMITED: "rate-limited",
  PAYLOAD_TOO_LARGE: "payload-too-large",
  UNSUPPORTED_MEDIA_TYPE: "unsupported-media-type",
  SENDING_DISABLED: "sending-disabled",
  STORAGE_LIMIT_EXCEEDED: "storage-limit-exceeded",
  STORAGE_OBJECT_MISSING: "storage-object-missing",
  INVALID_SIGNED_TOKEN: "invalid-signed-token",
  UPSTREAM_UNAVAILABLE: "upstream-unavailable",
  BUDGET_EXCEEDED: "budget-exceeded",
  INTERNAL: "internal-error",
} as const

export type ProblemTypeSlug = (typeof PROBLEM_TYPES)[keyof typeof PROBLEM_TYPES]

export const PROBLEM_TYPE_BASE_URI = "https://errors.alg.averio.agency"

export const ProblemDetailsSchema = z.object({
  /** Absolute URI built from PROBLEM_TYPE_BASE_URI + slug. */
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  /** Correlation id, also returned as the x-request-id header. */
  requestId: z.string().optional(),
  /** Field-level issues for VALIDATION_FAILED. */
  errors: z
    .array(
      z.object({
        path: z.string(),
        message: z.string(),
        code: z.string().optional(),
      })
    )
    .optional(),
})

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>

const DEFAULT_STATUS: Record<ProblemTypeSlug, number> = {
  [PROBLEM_TYPES.VALIDATION_FAILED]: 400,
  [PROBLEM_TYPES.UNAUTHENTICATED]: 401,
  [PROBLEM_TYPES.FORBIDDEN]: 403,
  [PROBLEM_TYPES.WORKSPACE_REQUIRED]: 400,
  [PROBLEM_TYPES.NOT_FOUND]: 404,
  [PROBLEM_TYPES.CONFLICT]: 409,
  [PROBLEM_TYPES.IDEMPOTENCY_KEY_REUSED]: 409,
  [PROBLEM_TYPES.RATE_LIMITED]: 429,
  [PROBLEM_TYPES.PAYLOAD_TOO_LARGE]: 413,
  [PROBLEM_TYPES.UNSUPPORTED_MEDIA_TYPE]: 415,
  [PROBLEM_TYPES.SENDING_DISABLED]: 503,
  [PROBLEM_TYPES.STORAGE_LIMIT_EXCEEDED]: 507,
  [PROBLEM_TYPES.STORAGE_OBJECT_MISSING]: 404,
  [PROBLEM_TYPES.INVALID_SIGNED_TOKEN]: 403,
  [PROBLEM_TYPES.UPSTREAM_UNAVAILABLE]: 502,
  [PROBLEM_TYPES.BUDGET_EXCEEDED]: 402,
  [PROBLEM_TYPES.INTERNAL]: 500,
}

export interface AppErrorOptions {
  /** i18n key for the user-visible title; resolved by the error middleware. */
  titleKey?: string
  detail?: string
  status?: number
  errors?: ProblemDetails["errors"]
  cause?: unknown
}

/**
 * The one error type the API throws. The error middleware turns it into
 * problem+json; anything else becomes an opaque 500 so internals never leak.
 */
export class AppError extends Error {
  readonly slug: ProblemTypeSlug
  readonly status: number
  readonly titleKey: string
  readonly detail?: string
  readonly errors?: ProblemDetails["errors"]

  constructor(slug: ProblemTypeSlug, options: AppErrorOptions = {}) {
    super(options.detail ?? slug, options.cause ? { cause: options.cause } : undefined)
    this.name = "AppError"
    this.slug = slug
    this.status = options.status ?? DEFAULT_STATUS[slug]
    this.titleKey = options.titleKey ?? `error.${slug}`
    this.detail = options.detail
    this.errors = options.errors
  }

  static notFound(detail?: string): AppError {
    return new AppError(PROBLEM_TYPES.NOT_FOUND, { detail })
  }

  static forbidden(detail?: string): AppError {
    return new AppError(PROBLEM_TYPES.FORBIDDEN, { detail })
  }

  static unauthenticated(detail?: string): AppError {
    return new AppError(PROBLEM_TYPES.UNAUTHENTICATED, { detail })
  }
}

export function problemTypeUri(slug: ProblemTypeSlug): string {
  return `${PROBLEM_TYPE_BASE_URI}/${slug}`
}

export function defaultStatusFor(slug: ProblemTypeSlug): number {
  return DEFAULT_STATUS[slug]
}
