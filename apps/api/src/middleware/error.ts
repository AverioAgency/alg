import { type NextFunction, type Request, type Response } from "express"
import { ZodError } from "zod"
import {
  AppError,
  PROBLEM_TYPES,
  problemTypeUri,
  t,
  type ProblemDetails,
  type ProblemTypeSlug,
} from "@alg/shared"
import { type Logger } from "../logger.js"

/**
 * Terminal error handler. Everything leaves the API as application/problem+json
 * with a stable `type` slug the frontend can branch on.
 *
 * Unknown errors become an opaque 500: the message of an arbitrary thrown value
 * may contain a connection string or a row of contact data.
 */

export const PROBLEM_CONTENT_TYPE = "application/problem+json"

export function createErrorHandler(logger: Logger) {
  return function handleError(
    error: unknown,
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    if (res.headersSent) {
      next(error)
      return
    }

    const requestId = req.ctx?.requestId ?? req.header("x-request-id") ?? undefined
    const problem = toProblem(error, req, requestId)

    if (problem.status >= 500) {
      logger.error({ err: error, requestId, path: req.path }, "request failed")
    } else {
      logger.warn(
        { type: problem.type, status: problem.status, requestId, path: req.path },
        "request rejected"
      )
    }

    res.status(problem.status).type(PROBLEM_CONTENT_TYPE).json(problem)
  }
}

function toProblem(error: unknown, req: Request, requestId?: string): ProblemDetails {
  const instance = req.originalUrl

  if (error instanceof ZodError) {
    return {
      type: problemTypeUri(PROBLEM_TYPES.VALIDATION_FAILED),
      title: t(`error.${PROBLEM_TYPES.VALIDATION_FAILED}`),
      status: 400,
      instance,
      requestId,
      errors: error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
        code: issue.code,
      })),
    }
  }

  if (error instanceof AppError) {
    return {
      type: problemTypeUri(error.slug),
      title: t(error.titleKey),
      status: error.status,
      ...(error.detail ? { detail: error.detail } : {}),
      instance,
      requestId,
      ...(error.errors ? { errors: error.errors } : {}),
    }
  }

  // Express 5 raises these for malformed JSON bodies and oversized payloads.
  const bodyParserStatus = getBodyParserStatus(error)
  if (bodyParserStatus) {
    const slug: ProblemTypeSlug =
      bodyParserStatus === 413
        ? PROBLEM_TYPES.PAYLOAD_TOO_LARGE
        : bodyParserStatus === 415
          ? PROBLEM_TYPES.UNSUPPORTED_MEDIA_TYPE
          : PROBLEM_TYPES.VALIDATION_FAILED
    return {
      type: problemTypeUri(slug),
      title: t(`error.${slug}`),
      status: bodyParserStatus,
      instance,
      requestId,
    }
  }

  return {
    type: problemTypeUri(PROBLEM_TYPES.INTERNAL),
    title: t(`error.${PROBLEM_TYPES.INTERNAL}`),
    status: 500,
    instance,
    requestId,
  }
}

function getBodyParserStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null
  const candidate = error as { status?: unknown; statusCode?: unknown; type?: unknown }
  const status = candidate.status ?? candidate.statusCode
  if (typeof status !== "number") return null
  if (status === 400 || status === 413 || status === 415) return status
  return null
}

/** 404 fallback so unmatched routes also return problem+json. */
export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(PROBLEM_TYPES.NOT_FOUND, { detail: "No route matches this path." }))
}
