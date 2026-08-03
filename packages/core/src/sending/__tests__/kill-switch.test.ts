import { describe, expect, it } from "vitest"
import { PROBLEM_TYPES } from "@alg/shared"
import { assertSendingEnabled, isSendingEnabled, SendingDisabledError } from "../kill-switch.js"

describe("sending kill switch", () => {
  it("throws when sending is globally disabled", () => {
    expect(() => assertSendingEnabled({ enabled: false }, "smtp")).toThrow(SendingDisabledError)
  })

  it("throws during a dry run even when sending is enabled", () => {
    expect(() => assertSendingEnabled({ enabled: true, dryRun: true }, "smtp")).toThrow(
      SendingDisabledError
    )
  })

  it("permits sending only when enabled and not dry running", () => {
    expect(() => assertSendingEnabled({ enabled: true })).not.toThrow()
    expect(() => assertSendingEnabled({ enabled: true, dryRun: false })).not.toThrow()
  })

  it("surfaces as a 503 problem with a stable slug", () => {
    try {
      assertSendingEnabled({ enabled: false }, "twilio")
      expect.unreachable("should have thrown")
    } catch (error) {
      const err = error as SendingDisabledError
      expect(err.slug).toBe(PROBLEM_TYPES.SENDING_DISABLED)
      expect(err.status).toBe(503)
      expect(err.message).toContain("twilio")
    }
  })

  it("isSendingEnabled mirrors the assertion", () => {
    expect(isSendingEnabled({ enabled: true })).toBe(true)
    expect(isSendingEnabled({ enabled: false })).toBe(false)
    expect(isSendingEnabled({ enabled: true, dryRun: true })).toBe(false)
  })
})
