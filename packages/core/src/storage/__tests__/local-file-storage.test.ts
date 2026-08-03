import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type Database } from "@alg/db"
import { LocalFileStorage } from "../local-file-storage.js"
import { FileNotFoundError } from "../file-storage.js"

/**
 * Filesystem behaviour is tested against a real temp directory; the database is a
 * small in-memory stand-in so this suite needs no Docker and stays fast. The
 * Postgres-backed integration test lives with the testcontainers suites.
 */

const WORKSPACE = "11111111-2222-3333-4444-555555555555"

interface Row {
  id: string
  workspaceId: string
  kind: string
  relativePath: string
  mime: string
  sizeBytes: number
  checksum: string
  expiresAt: Date | null
  createdAt: Date
}

/** Records inserts and answers the three selects LocalFileStorage performs. */
function fakeDb(rows: Row[]): Database {
  const api = {
    insert: () => ({
      values: (row: Row) => {
        rows.push({ ...row, createdAt: new Date() })
        return Promise.resolve()
      },
    }),
    select: (projection?: Record<string, unknown>) => ({
      from: () => {
        const chain = {
          where: () => chain,
          limit: () => Promise.resolve(rows.slice(0, 1)),
          then: (resolve: (value: unknown) => void) =>
            resolve(projection ? rows.map((r) => ({ sizeBytes: r.sizeBytes })) : rows),
        }
        return chain
      },
    }),
    delete: () => ({
      where: () => {
        rows.length = 0
        return Promise.resolve()
      },
    }),
  }
  return api as unknown as Database
}

let root: string
let rows: Row[]
let storage: LocalFileStorage

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alg-storage-"))
  rows = []
  storage = new LocalFileStorage({
    root,
    maxBytes: 1024 * 1024,
    db: fakeDb(rows),
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("LocalFileStorage.put", () => {
  it("writes a buffer to the documented layout and records it", async () => {
    const ref = await storage.put({
      workspaceId: WORKSPACE,
      kind: "report",
      ext: "pdf",
      data: Buffer.from("hello report"),
    })

    expect(ref.relativePath).toMatch(
      new RegExp(`^${WORKSPACE}/report/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.pdf$`)
    )
    expect(await readFile(join(root, ref.relativePath), "utf8")).toBe("hello report")
    expect(rows).toHaveLength(1)
  })

  it("accepts a stream and computes size and checksum from it", async () => {
    const ref = await storage.put({
      workspaceId: WORKSPACE,
      kind: "export",
      ext: "csv",
      data: Readable.from([Buffer.from("a,b\n"), Buffer.from("1,2\n")]),
    })

    expect(ref.sizeBytes).toBe(8)
    // sha256 of "a,b\n1,2\n"
    expect(ref.checksum).toHaveLength(64)
    expect(await readFile(join(root, ref.relativePath), "utf8")).toBe("a,b\n1,2\n")
  })

  it("leaves no staging file behind after a successful write", async () => {
    await storage.put({
      workspaceId: WORKSPACE,
      kind: "screenshot",
      ext: "png",
      data: Buffer.from("png-bytes"),
    })

    await expect(stat(join(root, ".tmp"))).resolves.toBeDefined()
    const { readdir } = await import("node:fs/promises")
    expect(await readdir(join(root, ".tmp"))).toStrictEqual([])
  })

  it("applies the per-kind default retention", async () => {
    const screenshot = await storage.put({
      workspaceId: WORKSPACE,
      kind: "screenshot",
      ext: "png",
      data: Buffer.from("x"),
    })
    const report = await storage.put({
      workspaceId: WORKSPACE,
      kind: "report",
      ext: "pdf",
      data: Buffer.from("x"),
    })

    const days = (iso: string | null | undefined) =>
      Math.round((new Date(iso ?? 0).getTime() - Date.now()) / 86_400_000)

    expect(days(screenshot.expiresAt)).toBe(90)
    expect(days(report.expiresAt)).toBe(365)
  })

  it("honours an explicit null expiry as keep-forever", async () => {
    const ref = await storage.put({
      workspaceId: WORKSPACE,
      kind: "report",
      ext: "pdf",
      data: Buffer.from("x"),
      expiresAt: null,
    })

    expect(ref.expiresAt).toBeNull()
  })

  it("refuses a workspace id that is not a uuid", async () => {
    await expect(
      storage.put({
        workspaceId: "../../etc",
        kind: "report",
        ext: "pdf",
        data: Buffer.from("x"),
      })
    ).rejects.toThrow()

    expect(rows).toHaveLength(0)
  })

  it("refuses an extension carrying a traversal sequence", async () => {
    await expect(
      storage.put({
        workspaceId: WORKSPACE,
        kind: "report",
        ext: "../../../etc/passwd",
        data: Buffer.from("x"),
      })
    ).rejects.toThrow()
  })
})

describe("LocalFileStorage.get", () => {
  it("streams a stored file back", async () => {
    const ref = await storage.put({
      workspaceId: WORKSPACE,
      kind: "report",
      ext: "pdf",
      data: Buffer.from("contents"),
    })

    const stream = await storage.get(ref.id)
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))

    expect(Buffer.concat(chunks).toString("utf8")).toBe("contents")
  })

  it("reports a missing file rather than throwing a raw fs error", async () => {
    const ref = await storage.put({
      workspaceId: WORKSPACE,
      kind: "report",
      ext: "pdf",
      data: Buffer.from("x"),
    })

    await rm(join(root, ref.relativePath))

    await expect(storage.get(ref.id)).rejects.toBeInstanceOf(FileNotFoundError)
  })

  it("throws when the id is unknown", async () => {
    rows.length = 0
    await expect(storage.get("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).rejects.toBeInstanceOf(
      FileNotFoundError
    )
  })

  it("refuses to read a row whose stored path escapes the root", async () => {
    // Simulates a corrupted or maliciously written row: the path check is defence
    // in depth behind the write-time validation.
    await mkdir(join(root, "..", "outside"), { recursive: true })
    await writeFile(join(root, "..", "outside", "secret.txt"), "secret")

    rows.push({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      workspaceId: WORKSPACE,
      kind: "report",
      relativePath: "../outside/secret.txt",
      mime: "text/plain",
      sizeBytes: 6,
      checksum: "x",
      expiresAt: null,
      createdAt: new Date(),
    })

    await expect(storage.get("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).rejects.toThrow()
  })
})

describe("LocalFileStorage.usage", () => {
  it("reports fill level against the soft limit", async () => {
    await storage.put({
      workspaceId: WORKSPACE,
      kind: "report",
      ext: "pdf",
      data: Buffer.alloc(1000),
    })

    const usage = await storage.usage()
    expect(usage.usedBytes).toBe(1000)
    expect(usage.maxBytes).toBe(1024 * 1024)
    expect(usage.overSoftLimit).toBe(false)
  })

  it("flags exceeding the soft limit so screenshot jobs can pause", async () => {
    const small = new LocalFileStorage({ root, maxBytes: 10, db: fakeDb(rows) })
    await small.put({
      workspaceId: WORKSPACE,
      kind: "screenshot",
      ext: "png",
      data: Buffer.alloc(500),
    })

    const usage = await small.usage()
    expect(usage.overSoftLimit).toBe(true)
    await expect(small.assertCapacity()).rejects.toThrow()
  })
})
