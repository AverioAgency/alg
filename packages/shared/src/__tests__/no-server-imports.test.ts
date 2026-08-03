import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * @alg/shared is bundled into the Next.js frontend. A single `node:crypto` import
 * anywhere in it breaks that build, and it breaks it in the consuming repo rather
 * than here - which is exactly the kind of failure that costs an afternoon. The
 * ESLint rule covers this too; this test makes it fail in CI even if someone runs
 * with lint disabled.
 */

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..")

const FORBIDDEN_PATTERNS = [
  /from\s+["']node:/,
  /from\s+["'](fs|path|crypto|os|child_process|net|http|https|stream)["']/,
  /from\s+["']drizzle-orm/,
  /from\s+["'](pg|postgres|ioredis|bullmq|express|pino|nodemailer|imapflow|playwright)["']/,
  /from\s+["']@alg\/(db|core)["']/,
  /require\s*\(/,
]

const FORBIDDEN_GLOBALS = [/\bBuffer\s*\./, /\bprocess\.(?!env\b)/, /__dirname/, /__filename/]

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue
      yield* sourceFiles(full)
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      yield full
    }
  }
}

describe("@alg/shared stays frontend-safe", () => {
  it("imports nothing that only exists on a server", async () => {
    const violations: string[] = []

    for await (const file of sourceFiles(SRC)) {
      const content = await readFile(file, "utf8")
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(`${file.replace(SRC, "")}: matches ${pattern}`)
        }
      }
    }

    expect(violations).toStrictEqual([])
  })

  it("uses no Node-only globals outside process.env", async () => {
    const violations: string[] = []

    for await (const file of sourceFiles(SRC)) {
      const content = await readFile(file, "utf8")
      for (const pattern of FORBIDDEN_GLOBALS) {
        if (pattern.test(content)) {
          violations.push(`${file.replace(SRC, "")}: matches ${pattern}`)
        }
      }
    }

    expect(violations).toStrictEqual([])
  })
})
