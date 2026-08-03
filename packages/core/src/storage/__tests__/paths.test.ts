import { describe, expect, it } from "vitest"
import { buildRelativePath, resolveWithinRoot, UnsafePathError, mimeForExt } from "../paths.js"

const WORKSPACE = "11111111-2222-3333-4444-555555555555"
const FILE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const ROOT = "/data/alg/storage"

describe("buildRelativePath", () => {
  it("builds the documented layout from validated components", () => {
    const path = buildRelativePath({
      workspaceId: WORKSPACE,
      kind: "screenshot",
      fileId: FILE_ID,
      ext: "png",
      at: new Date("2026-03-09T12:00:00Z"),
    })

    expect(path).toBe(`${WORKSPACE}/screenshot/2026/03/${FILE_ID}.png`)
  })

  it("zero-pads the month", () => {
    const path = buildRelativePath({
      workspaceId: WORKSPACE,
      kind: "report",
      fileId: FILE_ID,
      ext: "pdf",
      at: new Date("2026-01-05T00:00:00Z"),
    })

    expect(path).toContain("/2026/01/")
  })

  it("normalizes a leading dot and uppercase in the extension", () => {
    const path = buildRelativePath({
      workspaceId: WORKSPACE,
      kind: "export",
      fileId: FILE_ID,
      ext: ".CSV",
      at: new Date("2026-03-09T12:00:00Z"),
    })

    expect(path.endsWith(".csv")).toBe(true)
  })

  describe("rejects traversal attempts in every component", () => {
    const traversalWorkspaceIds = [
      "../../../etc",
      "..",
      "../" + WORKSPACE,
      `${WORKSPACE}/../..`,
      "/etc/passwd",
      "..\\..\\windows",
      `${WORKSPACE}\0`,
      "%2e%2e%2f",
      "",
    ]

    for (const workspaceId of traversalWorkspaceIds) {
      it(`workspaceId ${JSON.stringify(workspaceId)}`, () => {
        expect(() =>
          buildRelativePath({ workspaceId, kind: "screenshot", fileId: FILE_ID, ext: "png" })
        ).toThrow(UnsafePathError)
      })
    }

    const traversalFileIds = [
      "../../secret",
      "..",
      `${FILE_ID}/../../../etc/passwd`,
      `${FILE_ID}\0`,
    ]

    for (const fileId of traversalFileIds) {
      it(`fileId ${JSON.stringify(fileId)}`, () => {
        expect(() =>
          buildRelativePath({ workspaceId: WORKSPACE, kind: "screenshot", fileId, ext: "png" })
        ).toThrow(UnsafePathError)
      })
    }

    const traversalExts = [
      "../../etc/passwd",
      "png/../../..",
      "p n g",
      "png\0",
      "",
      "toolongextension",
    ]

    for (const ext of traversalExts) {
      it(`ext ${JSON.stringify(ext)}`, () => {
        expect(() =>
          buildRelativePath({ workspaceId: WORKSPACE, kind: "screenshot", fileId: FILE_ID, ext })
        ).toThrow(UnsafePathError)
      })
    }
  })

  it("rejects an unknown file kind", () => {
    expect(() =>
      buildRelativePath({
        workspaceId: WORKSPACE,
        // Simulates an unvalidated value reaching the builder.
        kind: "../../etc" as never,
        fileId: FILE_ID,
        ext: "png",
      })
    ).toThrow(UnsafePathError)
  })
})

describe("resolveWithinRoot", () => {
  it("resolves a legitimate stored path under the root", () => {
    const relative = `${WORKSPACE}/report/2026/03/${FILE_ID}.pdf`
    expect(resolveWithinRoot(ROOT, relative)).toBe(`${ROOT}/${relative}`)
  })

  const escapes = [
    "../../../etc/passwd",
    "..",
    "../outside.txt",
    `${WORKSPACE}/../../../etc/shadow`,
    "/etc/passwd",
    "/",
    "C:\\Windows\\System32",
    "\\\\server\\share",
    "foo/\0/bar",
    `${WORKSPACE}/report/../../../../root/.ssh/id_rsa`,
  ]

  for (const candidate of escapes) {
    it(`rejects ${JSON.stringify(candidate)}`, () => {
      expect(() => resolveWithinRoot(ROOT, candidate)).toThrow(UnsafePathError)
    })
  }

  it("rejects a path that normalizes back out of the root", () => {
    expect(() => resolveWithinRoot(ROOT, "a/b/../../../../etc/passwd")).toThrow(UnsafePathError)
  })

  it("does not confuse a sibling directory with a prefix match", () => {
    // "/data/alg/storage-other" shares a string prefix with the root but is outside it.
    expect(() => resolveWithinRoot(ROOT, "../storage-other/file.png")).toThrow(UnsafePathError)
  })
})

describe("mimeForExt", () => {
  it("maps known extensions", () => {
    expect(mimeForExt("pdf")).toBe("application/pdf")
    expect(mimeForExt(".PNG")).toBe("image/png")
  })

  it("falls back to octet-stream", () => {
    expect(mimeForExt("unknown")).toBe("application/octet-stream")
  })
})
