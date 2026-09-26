// Stateless Streamable HTTP transport for the MCP server.
//
// Why stateless: this transport is meant to run on Cloud Run (see
// deploy/README.md), where any request can land on any instance and multiple
// requests can run concurrently on the same instance. The MCP Streamable HTTP
// spec supports an optional session ID that lets a server keep per-connection
// state (SSE resumability, etc.) between requests. We deliberately opt out of
// that (`sessionIdGenerator: undefined`) and instead give every single
// request its own McpServer + StreamableHTTPServerTransport pair that is
// created, used once, and thrown away. Nothing about a request depends on
// anything left behind by a previous one, so:
//   - two concurrent requests on the same instance never share transport
//     state and can't cross-talk
//   - it doesn't matter which Cloud Run instance (or how many of them)
//     handles a given request
// The only state that legitimately needs to survive across requests and
// instances is the OAuth token cache, which is handled separately by
// token-store.ts, not by anything in this file.
//
// Why a shared secret: Cloud Run is deployed --allow-unauthenticated so that
// hosted agents (claude.ai custom connectors) can reach it without Google IAM
// credentials. Without a gate, anyone who learned the *.run.app URL could
// read, create, and delete tasks as the token owner. Every /mcp request must
// therefore present MCP_SHARED_SECRET, either as an `Authorization: Bearer`
// header or -- for connector UIs that can't set headers -- by calling the
// endpoint under an unguessable path prefix, /<MCP_SECRET_PATH>/mcp.
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { createHash, timingSafeEqual } from "crypto"
import express, { type Express, type NextFunction, type Request, type Response, Router } from "express"
import type { Server as HttpServer } from "http"

import { createTodoServer } from "./todo-index.js"

// Minimum length for either secret; short values are guessable by brute force.
const MIN_SECRET_LENGTH = 16

export interface HttpAuthOptions {
  // Accepted as `Authorization: Bearer <sharedSecret>` on /mcp.
  sharedSecret?: string
  // If set, /<secretPath>/mcp is also served and the path itself authenticates.
  secretPath?: string
}

function authOptionsFromEnv(): HttpAuthOptions {
  return {
    sharedSecret: process.env.MCP_SHARED_SECRET || undefined,
    secretPath: (process.env.MCP_SECRET_PATH || "").replace(/^\/+|\/+$/g, "") || undefined,
  }
}

function validateAuthOptions({ sharedSecret, secretPath }: HttpAuthOptions): void {
  if (!sharedSecret && !secretPath) {
    // Fail closed: refusing to start is better than silently serving an open
    // endpoint that controls someone's task list.
    throw new Error("HTTP transport requires MCP_SHARED_SECRET and/or MCP_SECRET_PATH to be set")
  }
  for (const [name, value] of [
    ["MCP_SHARED_SECRET", sharedSecret],
    ["MCP_SECRET_PATH", secretPath],
  ] as const) {
    if (value !== undefined && value.length < MIN_SECRET_LENGTH) {
      throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters`)
    }
  }
}

// Hashing both sides first gives equal-length buffers, so timingSafeEqual
// never throws and the comparison time doesn't leak the secret's length.
function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest()
  const b = createHash("sha256").update(expected).digest()
  return timingSafeEqual(a, b)
}

function requireBearer(sharedSecret: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header("authorization") || ""
    const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : ""
    if (sharedSecret && presented && secretsMatch(presented, sharedSecret)) {
      next()
      return
    }
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    })
  }
}

function methodNotAllowed(_req: Request, res: Response): void {
  // Stateless mode has no server-initiated stream and no session to resume,
  // so GET (open a stream) and DELETE (end a session) never apply.
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed. This server runs the stateless Streamable HTTP transport (POST only).",
    },
    id: null,
  })
}

export function createHttpApp(auth: HttpAuthOptions = authOptionsFromEnv()): Express {
  validateAuthOptions(auth)

  const app = express()
  app.use(express.json())

  // Cloud Run (and any load balancer in front of it) needs a cheap liveness
  // check that never touches Microsoft Graph or the token cache.
  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" })
  })

  const mcp = Router()

  mcp.post("/", async (req: Request, res: Response) => {
    // A brand-new server + transport per request is the deliberate choice
    // described above -- do not hoist these above the handler.
    const server = createTodoServer()

    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      })

      res.on("close", () => {
        transport.close()
        server.close()
      })

      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      console.error("Error handling MCP request:", error)
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        })
      }
    }
  })

  mcp.get("/", methodNotAllowed)
  mcp.delete("/", methodNotAllowed)

  // /mcp needs the bearer header; /<secretPath>/mcp is authenticated by
  // knowing the path. Anything else 404s before reaching the MCP handler.
  app.use("/mcp", requireBearer(auth.sharedSecret), mcp)
  if (auth.secretPath) {
    app.use(`/${auth.secretPath}/mcp`, mcp)
  }

  return app
}

export function startHttpServer(port: number): Promise<HttpServer> {
  const app = createHttpApp()
  return new Promise((resolve, reject) => {
    // Cloud Run routes traffic to the container on all interfaces; binding to
    // 0.0.0.0 (not the express default of localhost-only in some setups) is
    // required for the health check and real traffic to reach the process.
    const httpServer = app.listen(port, "0.0.0.0", () => resolve(httpServer))
    httpServer.on("error", reject)
  })
}
