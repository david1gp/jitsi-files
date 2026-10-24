import { existsSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { sweepExpired } from "../src/app.js"
import { makeTestServer, uploadForm, urlPath } from "./helpers.js"

describe("meeting lifecycle: purge and TTL", () => {
  test("DELETE /sessions/:sessionId purges blobs and index rows", async () => {
    const server = await makeTestServer()
    const session = "purge-session"
    try {
      const ids = ["aaa-1", "aaa-2"]
      let downloadPath = ""
      for (const id of ids) {
        await server.app.request(`/sessions/${session}/files`, {
          method: "POST",
          body: uploadForm(`${id}.txt`, "content", "text/plain", id),
        })
      }
      const one = (await (await server.app.request(`/sessions/${session}/files/aaa-1`)).json()) as Record<
        string,
        unknown
      >
      downloadPath = urlPath(one["presignedUrl"] as string)

      const noToken = await server.app.request(`/sessions/${session}`, { method: "DELETE" })
      expect(noToken.status).toBe(401)
      const wrong = await server.app.request(`/sessions/${session}`, {
        method: "DELETE",
        headers: { "x-internal-token": "wrong" },
      })
      expect(wrong.status).toBe(401)

      const purged = await server.app.request(`/sessions/${session}`, {
        method: "DELETE",
        headers: { "x-internal-token": "test-internal-token" },
      })
      expect(purged.status).toBe(200)
      expect(await purged.json()).toEqual({ ok: true, deletedFiles: 2 })

      expect((await (await server.app.request(`/sessions/${session}/files`)).json()) as unknown[]).toHaveLength(0)
      // Index rows and blobs are gone: old download links 404, files removed from disk.
      expect((await server.app.request(downloadPath)).status).toBe(404)
      expect(existsSync(`${server.dir}/files/${session}`)).toBe(false)
    } finally {
      await server.cleanup()
    }
  })

  test("TTL sweeper removes expired files and their blobs", async () => {
    const server = await makeTestServer()
    try {
      const now = Date.now()
      server.ctx.index.insert({
        id: "expired-1",
        session_id: "ttl-session",
        file_name: "old.txt",
        content_type: "text/plain",
        size: 3,
        storage_key: "ttl-session/expired-1-old.txt",
        uploader: "test",
        created_at: now - 100_000,
        expires_at: now - 1_000,
      })
      const removed = await sweepExpired(server.ctx)
      expect(removed).toBe(1)
      expect(server.ctx.index.get("ttl-session", "expired-1")).toBeNull()
      expect((await server.app.request("/sessions/ttl-session/files")).status).toBe(200)
      expect((await (await server.app.request("/sessions/ttl-session/files")).json()) as unknown[]).toHaveLength(0)
    } finally {
      await server.cleanup()
    }
  })

  test("fresh uploads carry an expiry of now + FILE_TTL_HOURS", async () => {
    const server = await makeTestServer({ FILE_TTL_HOURS: "24" })
    try {
      const before = Date.now()
      await server.app.request("/sessions/expiry-session/files", {
        method: "POST",
        body: uploadForm("e.txt", "data", "text/plain", "expiry-1"),
      })
      const row = server.ctx.index.get("expiry-session", "expiry-1")
      expect(row).not.toBeNull()
      // created_at follows the client timestamp; expiry is anchored to server time.
      expect(Math.abs(row!.expires_at - row!.created_at - 24 * 3600 * 1000)).toBeLessThan(5000)
      expect(row!.created_at).toBeGreaterThanOrEqual(before)
    } finally {
      await server.cleanup()
    }
  })
})
