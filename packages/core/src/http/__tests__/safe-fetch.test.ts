import { describe, expect, it } from "vitest"
import { assertPublicHost, isBlockedAddress, SsrfBlockedError } from "../safe-fetch.js"

/**
 * These cases are the reason the module exists. Each blocked range corresponds to
 * something an attacker could otherwise reach by getting ALG to fetch a URL.
 */

describe("isBlockedAddress", () => {
  it("blocks the cloud metadata endpoint", () => {
    // The single most valuable SSRF target on any hosted machine.
    expect(isBlockedAddress("169.254.169.254")).toBe(true)
  })

  it("blocks loopback", () => {
    for (const ip of ["127.0.0.1", "127.1.2.3", "::1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true)
    }
  })

  it("blocks RFC1918 private ranges", () => {
    for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true)
    }
  })

  it("allows public addresses just outside the private ranges", () => {
    // Off-by-one errors here would block legitimate traffic.
    for (const ip of ["172.15.255.255", "172.32.0.1", "11.0.0.1", "192.167.1.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(false)
    }
  })

  it("blocks link-local, CGNAT, multicast and reserved space", () => {
    for (const ip of ["169.254.1.1", "100.64.0.1", "224.0.0.1", "255.255.255.255", "0.0.0.0"]) {
      expect(isBlockedAddress(ip), ip).toBe(true)
    }
  })

  it("blocks IPv6 private and link-local ranges", () => {
    for (const ip of ["fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::"]) {
      expect(isBlockedAddress(ip), ip).toBe(true)
    }
  })

  it("blocks IPv4-mapped IPv6 that hides a private address", () => {
    // ::ffff:127.0.0.1 is a classic bypass for naive string checks.
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true)
    expect(isBlockedAddress("::ffff:10.0.0.1")).toBe(true)
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true)
  })

  it("allows ordinary public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) {
      expect(isBlockedAddress(ip), ip).toBe(false)
    }
  })

  it("refuses anything that is not a parsable address", () => {
    for (const value of ["", "not-an-ip", "999.999.999.999", "10.0.0"]) {
      expect(isBlockedAddress(value), value).toBe(true)
    }
  })
})

describe("assertPublicHost", () => {
  const resolvesTo = (addresses: string[]) => async () => addresses

  it("accepts a host that resolves to a public address", async () => {
    await expect(
      assertPublicHost("overpass-api.de", resolvesTo(["178.63.11.215"]))
    ).resolves.toBeUndefined()
  })

  it("rejects localhost by name", async () => {
    await expect(assertPublicHost("localhost", resolvesTo(["1.1.1.1"]))).rejects.toBeInstanceOf(
      SsrfBlockedError
    )
  })

  it("rejects single-label docker service names", async () => {
    // "redis", "postgres" and "scraper" all resolve inside the compose network.
    for (const host of ["redis", "postgres", "scraper", "api"]) {
      await expect(assertPublicHost(host, resolvesTo(["1.1.1.1"]))).rejects.toBeInstanceOf(
        SsrfBlockedError
      )
    }
  })

  it("rejects a public name that resolves into a private range", async () => {
    // DNS rebinding: the name looks fine, the answer does not.
    await expect(
      assertPublicHost("evil.example.com", resolvesTo(["10.0.0.5"]))
    ).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it("rejects when any one of several answers is private", async () => {
    // A round-robin record that mixes public and private must not slip through.
    await expect(
      assertPublicHost("mixed.example.com", resolvesTo(["8.8.8.8", "169.254.169.254"]))
    ).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it("rejects a host that does not resolve", async () => {
    await expect(
      assertPublicHost("nx.example.com", async () => {
        throw new Error("ENOTFOUND")
      })
    ).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it("rejects a host that resolves to nothing", async () => {
    await expect(assertPublicHost("empty.example.com", resolvesTo([]))).rejects.toBeInstanceOf(
      SsrfBlockedError
    )
  })

  it("checks literal IPs without a lookup", async () => {
    await expect(
      assertPublicHost("127.0.0.1", async () => {
        throw new Error("should not be called")
      })
    ).rejects.toBeInstanceOf(SsrfBlockedError)
  })
})
