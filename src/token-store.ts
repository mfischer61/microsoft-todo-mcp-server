// Where OAuth tokens actually live on disk, made safe to point at a mounted
// Cloud Storage bucket.
//
// On Cloud Run this directory is a GCS bucket mounted as a filesystem via
// Cloud Run's native Cloud Storage FUSE volume support (see deploy/README.md)
// -- not the @google-cloud/storage SDK. That's a deliberate choice: it means
// none of this file (or token-manager.ts) needs to know it's talking to GCS
// at all. It just reads and writes a JSON file at a path. The only thing
// that changes between "run locally" and "run on Cloud Run" is what
// MSTODO_TOKEN_FILE points at.
//
// The one thing a network filesystem does NOT give you for free is atomicity
// of a single write -- a reader could observe a partially-written file if a
// writer is killed mid-write, or (on gcsfuse specifically) see stale content
// briefly after a write due to how the FUSE layer stages uploads. writeFile
// below avoids the "partial write" half of that by writing to a temp file in
// the same directory and renaming it into place -- rename is atomic on a
// single filesystem (including gcsfuse), so a reader only ever sees the
// old file or the fully-written new one, never a half-written one.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs"
import { homedir } from "os"
import { dirname, join } from "path"

export interface StoredTokenData {
  accessToken: string
  refreshToken: string
  expiresAt: number
  clientId?: string
  clientSecret?: string
  tenantId?: string
}

export interface TokenStore {
  read(): StoredTokenData | null
  write(tokens: StoredTokenData): void
}

/**
 * Resolves the token cache file path.
 *
 * MSTODO_TOKEN_FILE is the existing override this repo already supported for
 * a local custom path; on Cloud Run it's set to a path under the mounted
 * Cloud Storage volume (e.g. /mnt/token-cache/tokens.json). No new env var
 * was introduced for the cloud case on purpose -- reusing the one that
 * already existed keeps local dev, Docker, and Cloud Run all going through
 * the same code path.
 */
export function resolveTokenFilePath(): string {
  if (process.env.MSTODO_TOKEN_FILE) {
    return process.env.MSTODO_TOKEN_FILE
  }

  const configDir =
    process.platform === "win32"
      ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "microsoft-todo-mcp")
      : join(homedir(), ".config", "microsoft-todo-mcp")

  return join(configDir, "tokens.json")
}

export class FileTokenStore implements TokenStore {
  constructor(private readonly filePath: string) {}

  read(): StoredTokenData | null {
    if (!existsSync(this.filePath)) {
      return null
    }

    try {
      const raw = readFileSync(this.filePath, "utf8")
      return JSON.parse(raw) as StoredTokenData
    } catch (error) {
      console.error(`Error reading token file at ${this.filePath}:`, error)
      return null
    }
  }

  write(tokens: StoredTokenData): void {
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) {
      // On a mounted GCS volume this directory already exists (it's the
      // mount point); this only actually creates anything in the local /
      // Docker case.
      mkdirSync(dir, { recursive: true })
    }

    const tmpPath = join(dir, `.tokens.json.tmp-${process.pid}-${Date.now()}`)
    writeFileSync(tmpPath, JSON.stringify(tokens, null, 2), "utf8")
    try {
      renameSync(tmpPath, this.filePath)
    } catch (error) {
      // Best-effort cleanup so a failed rename doesn't leave litter behind on
      // the mounted volume; the original write() behavior (a direct,
      // non-atomic write) is still better than losing the tokens entirely.
      try {
        unlinkSync(tmpPath)
      } catch {
        // ignore
      }
      console.error(`Atomic rename failed for token file at ${this.filePath}, falling back to direct write:`, error)
      writeFileSync(this.filePath, JSON.stringify(tokens, null, 2), "utf8")
    }
  }
}
