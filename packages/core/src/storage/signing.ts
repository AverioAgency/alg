import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Signed, expiring tokens for public report links (GET /v1/r/:token).
 *
 * The token carries the file id and an expiry, never a path. Even a forged payload
 * therefore cannot address anything outside the files table, and a valid token
 * stops working on its own.
 */

export interface SignedFileToken {
  fileId: string
  /** Unix seconds. */
  exp: number
}

export class InvalidTokenError extends Error {
  constructor(reason: string) {
    super(`Invalid signed token: ${reason}`)
    this.name = "InvalidTokenError"
  }
}

function base64url(input: Buffer): string {
  return input.toString("base64url")
}

function sign(payload: string, secret: string): string {
  return base64url(createHmac("sha256", secret).update(payload).digest())
}

export interface SignFileTokenInput {
  fileId: string
  secret: string
  /** Lifetime in seconds. Report links default to 30 days. */
  ttlSeconds?: number
  now?: () => Date
}

export function signFileToken(input: SignFileTokenInput): string {
  const now = input.now ?? (() => new Date())
  const ttl = input.ttlSeconds ?? 30 * 24 * 60 * 60
  const claims: SignedFileToken = {
    fileId: input.fileId,
    exp: Math.floor(now().getTime() / 1000) + ttl,
  }
  const payload = base64url(Buffer.from(JSON.stringify(claims), "utf8"))
  return `${payload}.${sign(payload, input.secret)}`
}

export interface VerifyFileTokenInput {
  token: string
  secret: string
  now?: () => Date
}

export function verifyFileToken(input: VerifyFileTokenInput): SignedFileToken {
  const now = input.now ?? (() => new Date())

  const parts = input.token.split(".")
  if (parts.length !== 2) {
    throw new InvalidTokenError("malformed")
  }
  const [payload, signature] = parts as [string, string]

  const expected = sign(payload, input.secret)
  const expectedBuf = Buffer.from(expected, "utf8")
  const actualBuf = Buffer.from(signature, "utf8")

  // Length check first: timingSafeEqual throws on a mismatch rather than returning false.
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new InvalidTokenError("signature mismatch")
  }

  let claims: SignedFileToken
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      typeof (decoded as { fileId?: unknown }).fileId !== "string" ||
      typeof (decoded as { exp?: unknown }).exp !== "number"
    ) {
      throw new InvalidTokenError("payload shape")
    }
    // eslint-disable-next-line no-restricted-syntax -- fileId and exp both type-checked immediately above
    claims = decoded as SignedFileToken
  } catch (error) {
    if (error instanceof InvalidTokenError) throw error
    throw new InvalidTokenError("payload not decodable")
  }

  if (claims.exp * 1000 <= now().getTime()) {
    throw new InvalidTokenError("expired")
  }

  return claims
}
