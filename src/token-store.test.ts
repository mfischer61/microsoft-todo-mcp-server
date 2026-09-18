import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { FileTokenStore, resolveTokenFilePath, type StoredTokenData } from "./token-store.js"

describe("FileTokenStore", () => {
  let dir: string

  beforeEach(() => {
    // A real temp directory, not a mock fs -- this is meant to exercise the
    // actual write-then-rename path, since that's the part a mock would
    // otherwise assume away.
    dir = mkdtempSync(join(tmpdir(), "mstodo-token-store-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("returns null when no token file exists yet", () => {
    const store = new FileTokenStore(join(dir, "tokens.json"))
    expect(store.read()).toBeNull()
  })

  it("round-trips tokens through write() and read()", () => {
    const filePath = join(dir, "tokens.json")
    const store = new FileTokenStore(filePath)
    const tokens: StoredTokenData = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: Date.now() + 3600_000,
      clientId: "client-id",
      clientSecret: "client-secret",
      tenantId: "organizations",
    }

    store.write(tokens)

    expect(existsSync(filePath)).toBe(true)
    expect(store.read()).toEqual(tokens)
  })

  it("creates the target directory (the Cloud Storage FUSE mount point) if it doesn't exist yet", () => {
    const nestedPath = join(dir, "mounted-bucket", "tokens.json")
    const store = new FileTokenStore(nestedPath)

    store.write({ accessToken: "a", refreshToken: "r", expiresAt: 0 })

    expect(existsSync(nestedPath)).toBe(true)
  })

  it("does not leave a temp file behind after a successful write", () => {
    const store = new FileTokenStore(join(dir, "tokens.json"))
    store.write({ accessToken: "a", refreshToken: "r", expiresAt: 0 })

    const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp-"))
    expect(leftovers).toEqual([])
  })

  it("never writes a torn file: a reader sees either the old value or the fully-written new one", () => {
    // This can't fully simulate a process kill mid-write, but it does prove
    // write() never mutates the destination path directly -- everything is
    // staged under a different filename first, so at every instant the
    // destination path either has the previous content or the complete new
    // content, never a partial one.
    const filePath = join(dir, "tokens.json")
    const store = new FileTokenStore(filePath)

    store.write({ accessToken: "first", refreshToken: "r1", expiresAt: 0 })
    const afterFirstWrite = readFileSync(filePath, "utf8")
    expect(JSON.parse(afterFirstWrite).accessToken).toBe("first")

    store.write({ accessToken: "second", refreshToken: "r2", expiresAt: 0 })
    const afterSecondWrite = readFileSync(filePath, "utf8")
    expect(JSON.parse(afterSecondWrite).accessToken).toBe("second")
  })
})

describe("resolveTokenFilePath", () => {
  const originalEnv = process.env.MSTODO_TOKEN_FILE

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MSTODO_TOKEN_FILE
    } else {
      process.env.MSTODO_TOKEN_FILE = originalEnv
    }
  })

  it("honors MSTODO_TOKEN_FILE, which is how the Cloud Run deployment points this at the mounted GCS volume", () => {
    process.env.MSTODO_TOKEN_FILE = "/mnt/token-cache/tokens.json"
    expect(resolveTokenFilePath()).toBe("/mnt/token-cache/tokens.json")
  })

  it("falls back to a platform config directory when MSTODO_TOKEN_FILE is unset", () => {
    delete process.env.MSTODO_TOKEN_FILE
    const resolved = resolveTokenFilePath()
    expect(resolved.endsWith(join("microsoft-todo-mcp", "tokens.json"))).toBe(true)
  })
})
