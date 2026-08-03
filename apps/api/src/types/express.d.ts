import type { RequestContext } from "@alg/shared"

/**
 * Attaches the authenticated context to Express's Request.
 *
 * This lives in its own ambient declaration file rather than inside the auth
 * middleware so that every module sees it. A `declare module` inside a regular
 * module only applies where that module is imported, which silently leaves
 * `req.ctx` untyped elsewhere.
 */
declare module "express-serve-static-core" {
  interface Request {
    ctx?: RequestContext
  }
}
