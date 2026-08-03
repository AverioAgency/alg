import { type NextFunction, type Request, type Response } from "express"
import { isOriginAllowed, parseAllowedOrigins } from "@alg/shared"

/**
 * CORS for browser callers.
 *
 * Hand-written rather than the `cors` package, for two reasons. It is about
 * twenty lines, and the package's defaults reflect the request rather than an
 * allowlist - the shape that makes a stray configuration reflect any origin at
 * all. Here the allowlist is the only path to an allow header.
 *
 * The default is empty, meaning no browser may call this API. That is correct:
 * ALG serves lead data under GDPR, and the intended caller is the Nexoro PHP
 * backend, server to server, where CORS plays no part.
 */

export interface CorsOptions {
  /** ALG_CORS_ORIGINS, comma-separated. Empty disables browser access entirely. */
  origins: string
}

/** Headers a browser client legitimately needs to send. */
const ALLOWED_HEADERS = [
  "authorization",
  "content-type",
  "x-workspace-id",
  "x-workspace-slug",
  "x-request-id",
  "idempotency-key",
  "last-event-id",
]

/** Headers worth exposing back: the ones a client reads to behave well. */
const EXPOSED_HEADERS = [
  "x-request-id",
  "retry-after",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
]

export function createCorsMiddleware(options: CorsOptions) {
  const allowed = parseAllowedOrigins(options.origins)

  return function cors(req: Request, res: Response, next: NextFunction): void {
    const origin = req.header("origin")

    // No Origin means a server-to-server call - curl, the PHP backend, a health
    // probe. CORS does not apply and adding headers would only confuse caches.
    if (!origin) {
      next()
      return
    }

    if (!isOriginAllowed(origin, allowed)) {
      // Deliberately no allow header, and no error either: the request proceeds
      // and the browser blocks the *response*. Returning 403 here would break
      // server-side callers that happen to send an Origin, and would tell a
      // prober which origins are configured.
      next()
      return
    }

    // Echo the exact origin rather than "*": credentials are involved, and a
    // wildcard is refused by browsers in that case anyway.
    res.setHeader("access-control-allow-origin", origin)
    res.setHeader("access-control-allow-credentials", "true")
    // The response body depends on the origin, so caches must key on it -
    // otherwise one client's allow header is served to another origin.
    res.appendHeader("vary", "Origin")
    res.setHeader("access-control-expose-headers", EXPOSED_HEADERS.join(", "))

    if (req.method === "OPTIONS") {
      res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
      res.setHeader("access-control-allow-headers", ALLOWED_HEADERS.join(", "))
      res.setHeader("access-control-max-age", "600")
      res.status(204).end()
      return
    }

    next()
  }
}
