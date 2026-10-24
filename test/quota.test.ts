import { describe, expect, test } from "bun:test"
import { makeTestServer, uploadForm } from "./helpers.js"

// ~100 byte global quota: 100 / 1073741824 bytes per GB.
const TINY_QUOTA_GB = String(100 / 1073741824)

function text(n: number): string {
  return "a".repeat(n)
}

describe("global storage quota", () => {
  test("allows under quota, denies over quota (507), allows again after delete", async () => {
    const server = await makeTestServer({ MAX_TOTAL_STORAGE_GB: TINY_QUOTA_GB })
    try {
      const first = await server.app.request("/sessions/quota-a/files", {
        method: "POST",
        body: uploadForm("small.txt", text(40), "text/plain", "q-1"),
      })
      expect(first.status).toBe(200)

      const over = await server.app.request("/sessions/quota-b/files", {
        method: "POST",
        body: uploadForm("big.txt", text(80), "text/plain", "q-2"),
      })
      expect(over.status).toBe(507)
      expect(((await over.json()) as { error: { code: string } }).error.code).toBe("files.storage-quota")

      const del = await server.app.request("/sessions/quota-a/files/q-1", { method: "DELETE" })
      expect(del.status).toBe(200)

      const retry = await server.app.request("/sessions/quota-b/files", {
        method: "POST",
        body: uploadForm("big.txt", text(80), "text/plain", "q-2"),
      })
      expect(retry.status).toBe(200)
    } finally {
      await server.cleanup()
    }
  })

  test("no quota configured means unlimited", async () => {
    const server = await makeTestServer()
    try {
      const res = await server.app.request("/sessions/quota-free/files", {
        method: "POST",
        body: uploadForm("a.txt", text(10), "text/plain", "free-1"),
      })
      expect(res.status).toBe(200)
    } finally {
      await server.cleanup()
    }
  })
})
