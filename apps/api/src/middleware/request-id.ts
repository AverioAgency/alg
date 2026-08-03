import { randomUUID } from "node:crypto"
import { type NextFunction, type Request, type Response } from "express"

/**
 * Assigns a correlation id before anything else can fail, so even a 401 carries one
 * and support can trace it. An inbound x-request-id is honoured (Traefik and the
 * frontend both set one) but never trusted for anything but correlation.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header("x-request-id")
  const id = inbound && /^[\w.:-]{1,128}$/.test(inbound) ? inbound : randomUUID()
  res.setHeader("x-request-id", id)
  // The auth middleware copies this onto req.ctx once the user is known.
  req.headers["x-request-id"] = id
  next()
}
