import { describe, expect, test } from "bun:test"
import { makeTestServer, uploadForm, urlPath } from "./helpers.js"

const PDF = "%PDF-1.7\n%test content\n"
const SESSION = "roundtrip-session"

describe("file upload / list / get / download / delete roundtrip", () => {
  test("full lifecycle through the client paths", async () => {
    const server = await makeTestServer()
    try {
      const fileId = "11111111-1111-4111-8111-111111111111"

      const upload = await server.app.request(`/sessions/${SESSION}/files`, {
        method: "POST",
        body: uploadForm("notes.pdf", PDF, "application/pdf", fileId),
      })
      expect(upload.status).toBe(200)
      expect(await upload.json()).toEqual({ fileId })

      const list = await server.app.request(`/sessions/${SESSION}/files`)
      expect(list.status).toBe(200)
      const items = (await list.json()) as Array<Record<string, unknown>>
      expect(items).toHaveLength(1)
      expect(items[0]?.["objectId"]).toBe(fileId)
      expect(items[0]?.["sessionId"]).toBe(SESSION)
      expect(typeof items[0]?.["preSignedUrl"]).toBe("string")
      expect(typeof items[0]?.["presignedUrl"]).toBe("string")

      const one = await server.app.request(`/sessions/${SESSION}/files/${fileId}`)
      expect(one.status).toBe(200)
      const info = (await one.json()) as Record<string, unknown>
      expect(info["fileId"]).toBe(fileId)
      expect(info["fileName"]).toBe("notes.pdf")
      expect(typeof info["presignedUrl"]).toBe("string")

      const download = await server.app.request(urlPath(info["presignedUrl"] as string))
      expect(download.status).toBe(200)
      expect(download.headers.get("content-type")).toContain("application/pdf")
      expect(download.headers.get("content-disposition")).toContain("attachment")
      expect(await download.text()).toBe(PDF)

      const del = await server.app.request(`/sessions/${SESSION}/files/${fileId}`, { method: "DELETE" })
      expect(del.status).toBe(200)

      const listAfter = await server.app.request(`/sessions/${SESSION}/files`)
      expect((await listAfter.json()) as unknown[]).toHaveLength(0)

      const gone = await server.app.request(`/sessions/${SESSION}/files/${fileId}`)
      expect(gone.status).toBe(404)

      const downloadAfterDelete = await server.app.request(urlPath(info["presignedUrl"] as string))
      expect(downloadAfterDelete.status).toBe(404)
    } finally {
      await server.cleanup()
    }
  })

  test("sessions are isolated from each other", async () => {
    const server = await makeTestServer()
    try {
      const fileId = "22222222-2222-4222-8222-222222222222"
      await server.app.request(`/sessions/session-a/files`, {
        method: "POST",
        body: uploadForm("a.txt", "hello", "text/plain", fileId),
      })
      const other = (await (await server.app.request(`/sessions/session-b/files`)).json()) as unknown[]
      expect(other).toHaveLength(0)
      const missing = await server.app.request(`/sessions/session-b/files/${fileId}`)
      expect(missing.status).toBe(404)
    } finally {
      await server.cleanup()
    }
  })

  test("the /v1/documents alias serves the same operations", async () => {
    const server = await makeTestServer()
    try {
      const fileId = "33333333-3333-4333-8333-333333333333"
      const upload = await server.app.request(`/v1/documents/sessions/${SESSION}/files`, {
        method: "POST",
        body: uploadForm("alias.txt", "via alias", "text/plain", fileId),
      })
      expect(upload.status).toBe(200)
      const listRes = await server.app.request(`/v1/documents/sessions/${SESSION}/files`)
      const list = (await listRes.json()) as Array<Record<string, unknown>>
      expect(list).toHaveLength(1)
      const one = await server.app.request(`/v1/documents/sessions/${SESSION}/files/${fileId}`)
      expect(one.status).toBe(200)
      // And the primary path sees the same file.
      const primary = await server.app.request(`/sessions/${SESSION}/files/${fileId}`)
      expect(primary.status).toBe(200)
    } finally {
      await server.cleanup()
    }
  })

  test("upload without Bearer token is rejected when auth is enabled", async () => {
    const server = await makeTestServer({}, { enabled: true, sessionId: SESSION })
    try {
      const noAuth = await server.app.request(`/sessions/${SESSION}/files`, {
        method: "POST",
        body: uploadForm("x.pdf", PDF, "application/pdf", "no-auth-id"),
      })
      expect(noAuth.status).toBe(401)

      const token = await server.mintToken()
      const authed = await server.app.request(`/sessions/${SESSION}/files`, {
        method: "POST",
        headers: server.authHeaders(token),
        body: uploadForm("x.pdf", PDF, "application/pdf", "authed-id"),
      })
      expect(authed.status).toBe(200)
    } finally {
      await server.cleanup()
    }
  })

  test("token meeting_id must match the URL session id", async () => {
    const server = await makeTestServer({}, { enabled: true, sessionId: SESSION })
    try {
      const token = await server.mintToken({}, "other-session")
      const res = await server.app.request(`/sessions/${SESSION}/files`, { headers: server.authHeaders(token) })
      expect(res.status).toBe(403)
    } finally {
      await server.cleanup()
    }
  })

  test("moderator gate is off by default and enforced when enabled", async () => {
    const open = await makeTestServer({}, { enabled: true, sessionId: SESSION })
    try {
      const plain = await open.mintToken()
      const res = await open.app.request(`/sessions/${SESSION}/files`, { headers: open.authHeaders(plain) })
      expect(res.status).toBe(200)
    } finally {
      await open.cleanup()
    }

    const gated = await makeTestServer({ REQUIRE_MODERATOR: "1" }, { enabled: true, sessionId: SESSION })
    try {
      const plain = await gated.mintToken()
      const denied = await gated.app.request(`/sessions/${SESSION}/files`, { headers: gated.authHeaders(plain) })
      expect(denied.status).toBe(403)
      const mod = await gated.mintToken({ context: { user: { moderator: true } } })
      const allowed = await gated.app.request(`/sessions/${SESSION}/files`, { headers: gated.authHeaders(mod) })
      expect(allowed.status).toBe(200)
    } finally {
      await gated.cleanup()
    }
  })
})
