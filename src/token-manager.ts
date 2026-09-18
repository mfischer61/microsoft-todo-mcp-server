// src/token-manager.ts
import { existsSync, readFileSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"

import { FileTokenStore, resolveTokenFilePath, type StoredTokenData, type TokenStore } from "./token-store.js"

interface TokenData {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export class TokenManager {
  private readonly tokenFilePath: string
  private readonly store: TokenStore
  private currentTokens: StoredTokenData | null = null

  // Serializes concurrent refreshes. Microsoft's v2 token endpoint rotates
  // the refresh token on every use: if two callers both read the same
  // (still-valid-looking) refresh token and both POST it to the token
  // endpoint before either write lands, the second request is presenting a
  // refresh token that the first request's response already invalidated, and
  // fails. That race is exactly what "seamless" token refresh promises not
  // to do. On a single Node process, the async operations here are
  // interleaved but never run in parallel, so a plain in-memory "is a
  // refresh already in flight" flag is enough to close it -- no external
  // lock is needed, which is also why the deployment is pinned to exactly
  // one Cloud Run instance (see deploy/README.md): that flag only protects
  // this one process, not a second instance racing it.
  private refreshInFlight: Promise<TokenData | null> | null = null

  constructor(store?: TokenStore) {
    this.tokenFilePath = resolveTokenFilePath()
    this.store = store ?? new FileTokenStore(this.tokenFilePath)
    console.error(`Token file path: ${this.tokenFilePath}`)
  }

  // Try to get tokens from multiple sources
  async getTokens(): Promise<TokenData | null> {
    // 1. Check environment variables first (for backward compatibility)
    if (process.env.MS_TODO_ACCESS_TOKEN && process.env.MS_TODO_REFRESH_TOKEN) {
      const envTokens: TokenData = {
        accessToken: process.env.MS_TODO_ACCESS_TOKEN,
        refreshToken: process.env.MS_TODO_REFRESH_TOKEN,
        expiresAt: Date.now() + 3600 * 1000, // Assume 1 hour if not specified
      }

      // Check if expired
      if (Date.now() > envTokens.expiresAt) {
        // Try to refresh
        const refreshed = await this.refreshToken(envTokens.refreshToken)
        if (refreshed) {
          return refreshed
        }
      }
      return envTokens
    }

    // 2. Check the token store (a local file, or a file on a mounted Cloud
    // Storage volume -- see token-store.ts)
    const stored = this.store.read()
    if (stored) {
      this.currentTokens = stored

      // Check if expired
      if (Date.now() > stored.expiresAt) {
        // Try to refresh
        const refreshed = await this.refreshToken(stored.refreshToken)
        if (refreshed) {
          return refreshed
        }
      }
      return stored
    }

    // 3. Check legacy token file location
    const legacyPath = join(process.cwd(), "tokens.json")
    if (existsSync(legacyPath)) {
      try {
        const data = readFileSync(legacyPath, "utf8")
        const tokens = JSON.parse(data)

        // Migrate to new location
        this.saveTokens(tokens)

        return tokens
      } catch (error) {
        console.error("Error reading legacy token file:", error)
      }
    }

    return null
  }

  async refreshToken(refreshToken: string): Promise<TokenData | null> {
    // Join an in-flight refresh instead of starting a second one. See the
    // comment on refreshInFlight above for why this matters.
    if (this.refreshInFlight) {
      console.error("Refresh already in flight, joining it instead of starting a second one")
      return this.refreshInFlight
    }

    this.refreshInFlight = this.doRefreshToken(refreshToken)
    try {
      return await this.refreshInFlight
    } finally {
      this.refreshInFlight = null
    }
  }

  private async doRefreshToken(refreshToken: string): Promise<TokenData | null> {
    try {
      // Get client credentials from stored tokens or environment
      const clientId = this.currentTokens?.clientId || process.env.CLIENT_ID
      const clientSecret = this.currentTokens?.clientSecret || process.env.CLIENT_SECRET
      const tenantId = this.currentTokens?.tenantId || process.env.TENANT_ID || "organizations"

      if (!clientId || !clientSecret) {
        console.error("Missing client credentials for token refresh")
        return null
      }

      const tokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`

      const formData = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        scope: "offline_access Tasks.Read Tasks.ReadWrite Tasks.Read.Shared Tasks.ReadWrite.Shared User.Read",
      })

      const response = await fetch(tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formData,
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.error(`Token refresh failed: ${errorText}`)

        // If refresh fails, prompt for re-authentication
        this.promptForReauth()
        return null
      }

      const data = await response.json()

      const newTokens: StoredTokenData = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000, // 5 min buffer
        clientId,
        clientSecret,
        tenantId,
      }

      // Save the refreshed tokens
      this.saveTokens(newTokens)

      // Also update Claude config if possible
      await this.updateClaudeConfig(newTokens)

      return newTokens
    } catch (error) {
      console.error("Error refreshing token:", error)
      this.promptForReauth()
      return null
    }
  }

  saveTokens(tokens: StoredTokenData): void {
    this.currentTokens = tokens
    this.store.write(tokens)
  }

  // Update Claude config automatically
  async updateClaudeConfig(tokens: TokenData): Promise<void> {
    try {
      const claudeConfigPath =
        process.platform === "win32"
          ? join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json")
          : process.platform === "darwin"
            ? join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
            : join(homedir(), ".config", "Claude", "claude_desktop_config.json")

      if (!existsSync(claudeConfigPath)) {
        return
      }

      const config = JSON.parse(readFileSync(claudeConfigPath, "utf8"))

      // Update the microsoft-todo server config
      if (config.mcpServers && config.mcpServers["microsoft-todo"]) {
        config.mcpServers["microsoft-todo"].env = {
          ...config.mcpServers["microsoft-todo"].env,
          MS_TODO_ACCESS_TOKEN: tokens.accessToken,
          MS_TODO_REFRESH_TOKEN: tokens.refreshToken,
        }

        // Write back the updated config
        writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2), "utf8")
        console.error("Updated Claude config with new tokens")
      }
    } catch (error) {
      console.error("Could not update Claude config:", error)
    }
  }

  promptForReauth(): void {
    console.error(`
=================================================================
TOKEN REFRESH FAILED - REAUTHENTICATION REQUIRED

Your Microsoft To Do tokens have expired and could not be refreshed.

To fix this:
1. Open a new terminal
2. Navigate to the microsoft-todo-mcp-server directory
3. Run: pnpm run auth
4. Complete the authentication in your browser
5. Restart Claude Desktop to use the new tokens

Your tokens are stored in: ${this.tokenFilePath}
=================================================================
    `)
  }

  // Store client credentials with tokens for future refreshes
  async storeCredentials(clientId: string, clientSecret: string, tenantId: string): Promise<void> {
    if (this.currentTokens) {
      this.currentTokens.clientId = clientId
      this.currentTokens.clientSecret = clientSecret
      this.currentTokens.tenantId = tenantId
      this.saveTokens(this.currentTokens)
    }
  }
}

export const tokenManager = new TokenManager()
