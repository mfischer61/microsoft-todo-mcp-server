// Covers the 16th tool, get-overdue-tasks, added on top of the original 15.
// Uses the SDK's in-memory transport pair (no network, no HTTP server) since
// this is testing tool behavior, not the transport -- that's already covered
// by http-transport.test.ts.
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTodoServer } from "./todo-index.js"

const LIST_WORK = { id: "list-work", displayName: "Work" }
const LIST_HOME = { id: "list-home", displayName: "Home" }

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()
}

function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString()
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response
}

describe("get-overdue-tasks", () => {
  let client: Client
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.stubEnv("MS_TODO_ACCESS_TOKEN", "test-access-token")
    vi.stubEnv("MS_TODO_REFRESH_TOKEN", "test-refresh-token")

    fetchMock = vi.fn(async (url: string) => {
      const u = url.toString()

      if (u.endsWith("/me/todo/lists")) {
        return jsonResponse({ value: [LIST_WORK, LIST_HOME] })
      }

      if (u.includes(`/lists/${LIST_WORK.id}/tasks`)) {
        return jsonResponse({
          value: [
            { id: "t1", title: "Overdue by 5 days", status: "notStarted", dueDateTime: { dateTime: daysAgo(5) } },
            {
              id: "t2",
              title: "Overdue by 1 day",
              status: "inProgress",
              dueDateTime: { dateTime: daysAgo(1) },
            },
            { id: "t3", title: "Not due yet", status: "notStarted", dueDateTime: { dateTime: daysFromNow(3) } },
            { id: "t4", title: "No due date", status: "notStarted" },
          ],
        })
      }

      if (u.includes(`/lists/${LIST_HOME.id}/tasks`)) {
        return jsonResponse({
          value: [
            {
              id: "t5",
              title: "Very overdue",
              status: "waitingOnOthers",
              dueDateTime: { dateTime: daysAgo(30) },
            },
          ],
        })
      }

      throw new Error(`Unexpected fetch URL in test: ${u}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createTodoServer()
    await server.connect(serverTransport)

    client = new Client({ name: "test-client", version: "1.0.0" })
    await client.connect(clientTransport)
  })

  afterEach(async () => {
    await client.close()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  async function callOverdue(args: Record<string, unknown> = {}): Promise<string> {
    const result = await client.callTool({ name: "get-overdue-tasks", arguments: args })
    const content = result.content as Array<{ type: string; text?: string }>
    return content[0]?.text ?? ""
  }

  it("is registered alongside the original 15 tools", async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain("get-overdue-tasks")
    // 15 original + this one + the pre-existing test-graph-api-exploration
    // debug tool upstream already shipped = 17.
    expect(tools.length).toBe(17)
  })

  it("finds overdue tasks across every list, sorted most-overdue first", async () => {
    const text = await callOverdue()

    expect(text).toContain("3 overdue tasks across 2 lists")

    // Most overdue (30 days, Home) must come before less overdue ones.
    const veryOverdueIndex = text.indexOf("Very overdue")
    const fiveDayIndex = text.indexOf("Overdue by 5 days")
    const oneDayIndex = text.indexOf("Overdue by 1 day")
    expect(veryOverdueIndex).toBeGreaterThan(-1)
    expect(veryOverdueIndex).toBeLessThan(fiveDayIndex)
    expect(fiveDayIndex).toBeLessThan(oneDayIndex)

    // Tasks with no due date, or a future due date, must not appear.
    expect(text).not.toContain("Not due yet")
    expect(text).not.toContain("No due date")
  })

  it("scopes to a single list when listId is given", async () => {
    const text = await callOverdue({ listId: LIST_WORK.id })

    expect(text).toContain("2 overdue tasks:")
    expect(text).not.toContain("Very overdue") // that one's in Home, not Work
    expect(text).not.toContain("across")
  })

  it("reports a specific, friendly message when nothing is overdue", async () => {
    const text = await callOverdue({ asOf: daysAgo(100) }) // before every fake due date
    expect(text.toLowerCase()).toContain("no overdue tasks")
  })

  it("rejects an unparseable asOf instead of silently using 'now'", async () => {
    const text = await callOverdue({ asOf: "not-a-date" })
    expect(text).toContain("Invalid asOf value")
    // Must fail before making any Graph API calls.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("errors clearly for an unknown listId rather than silently returning nothing", async () => {
    const text = await callOverdue({ listId: "does-not-exist" })
    expect(text).toContain("No task list found with ID: does-not-exist")
  })
})
