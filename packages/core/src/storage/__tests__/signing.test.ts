import { describe, expect, it } from "vitest"
import { InvalidTokenError, signFileToken, verifyFileToken } from "../signing.js"

const SECRET = "s".repeat(48)
const OTHER_SECRET = "o".repeat(48)
const FILE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

describe("signed file tokens", () => {
  it("round-trips a file id", () => {
    const token = signFileToken({ fileId: FILE_ID, secret: SECRET })
    expect(verifyFileToken({ token, secret: SECRET }).fileId).toBe(FILE_ID)
  })

  it("never embeds a path", () => {
    const token = signFileToken({ fileId: FILE_ID, secret: SECRET })
    const payload = Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8")

    expect(payload).not.toContain("/")
    expect(JSON.parse(payload)).toStrictEqual({ fileId: FILE_ID, exp: expect.any(Number) })
  })

  it("rejects a token signed with a different secret", () => {
    const token = signFileToken({ fileId: FILE_ID, secret: OTHER_SECRET })
    expect(() => verifyFileToken({ token, secret: SECRET })).toThrow(InvalidTokenError)
  })

  it("rejects a tampered payload", () => {
    const token = signFileToken({ fileId: FILE_ID, secret: SECRET })
    const signature = token.split(".")[1]
    const forged = Buffer.from(
      JSON.stringify({ fileId: "ffffffff-ffff-ffff-ffff-ffffffffffff", exp: 4102444800 }),
      "utf8"
    ).toString("base64url")

    expect(() => verifyFileToken({ token: `${forged}.${signature}`, secret: SECRET })).toThrow(
      InvalidTokenError
    )
  })

  it("rejects an expired token", () => {
    const token = signFileToken({
      fileId: FILE_ID,
      secret: SECRET,
      ttlSeconds: 60,
      now: () => new Date("2026-01-01T00:00:00Z"),
    })

    expect(() =>
      verifyFileToken({ token, secret: SECRET, now: () => new Date("2026-01-01T00:02:00Z") })
    ).toThrow(InvalidTokenError)
  })

  it("accepts a token that has not expired yet", () => {
    const token = signFileToken({
      fileId: FILE_ID,
      secret: SECRET,
      ttlSeconds: 3600,
      now: () => new Date("2026-01-01T00:00:00Z"),
    })

    expect(
      verifyFileToken({ token, secret: SECRET, now: () => new Date("2026-01-01T00:30:00Z") }).fileId
    ).toBe(FILE_ID)
  })

  it("rejects malformed tokens", () => {
    for (const token of ["", "nodot", "a.b.c", "...", "!!!.???"]) {
      expect(() => verifyFileToken({ token, secret: SECRET })).toThrow(InvalidTokenError)
    }
  })
})
