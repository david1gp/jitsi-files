import * as v from "valibot"
import { Hono } from "hono"
import { fileTtlMs, maxFileSizeBytes, type Config } from "./config.js"
import {
  importHmacKey,
  importRsaPublicKey,
  tokenIsModerator,
  tokenSessionAllows,
  tokenUploaderId,
  verifyDownloadToken,
  verifyShortLivedToken,
  type ShortLivedTokenPayload,
} from "./crypto.js"
import { type FileIndex, type FileRow } from "./db.js"
import { type BlobStore } from "./storage.js"
import { validateUpload } from "./validation.js"

export interface AppContext {
  config: Config
  index: FileIndex
  store: BlobStore
  downloadKey: CryptoKey | null
  now: () => number
}

const ListQuerySchema = v.object({
  offset: v.pipe(v.optional(v.string(), "0"), v.transform(Number), v.number()),
  "page-size": v.pipe(v.optional(v.string(), "20"), v.transform(Number), v.number()),
})

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

function validSessionId(sessionId: string): boolean {
  return SESSION_ID_RE.test(sessionId)
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))
}

async function buildAuth(ctx: AppContext): Promise<{
  verifyRequest(sessionId: string, req: Request): Promise<{ payload: ShortLivedTokenPayload } | Response>
}> {
  const { config } = ctx
  if (config.DEV_NO_AUTH) {
    return {
      verifyRequest: async () => ({ payload: { sub: "dev" } }),
    }
  }
  let pem = config.JWT_PUBLIC_KEY
  if (!pem && config.JWT_PUBLIC_KEY_PATH) {
    pem = await Bun.file(config.JWT_PUBLIC_KEY_PATH).text()
  }
  if (!pem)
    throw new Error("JWT_PUBLIC_KEY or JWT_PUBLIC_KEY_PATH is required (or set DEV_NO_AUTH=1 for local testing)")
  const publicKey = await importRsaPublicKey(pem)
  return {
    verifyRequest: async (sessionId, req) => {
      const header = req.headers.get("authorization") ?? ""
      const match = /^Bearer (.+)$/.exec(header.trim())
      if (!match?.[1]) return Response.json({ error: { code: "auth.missing-token" } }, { status: 401 })
      const verified = await verifyShortLivedToken(match[1], publicKey, {
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
      })
      if (!verified.ok) {
        log("auth.rejected", { sessionId, reason: verified.reason })
        return Response.json({ error: { code: "auth.invalid-token" } }, { status: 401 })
      }
      if (!tokenSessionAllows(verified.payload, sessionId)) {
        log("auth.rejected", { sessionId, reason: "session mismatch" })
        return Response.json({ error: { code: "auth.session-mismatch" } }, { status: 403 })
      }
      if (config.REQUIRE_MODERATOR && !tokenIsModerator(verified.payload)) {
        log("auth.rejected", { sessionId, reason: "moderator required" })
        return Response.json({ error: { code: "auth.moderator-required" } }, { status: 403 })
      }
      return { payload: verified.payload }
    },
  }
}

function toListItem(ctx: AppContext, row: FileRow, presignedUrl: string) {
  void ctx
  return {
    objectId: row.id,
    sessionId: row.session_id,
    timestamp: row.created_at,
    contentType: row.content_type,
    objectName: row.file_name,
    initiatorId: row.uploader,
    preSignedUrl: presignedUrl,
    presignedUrl,
  }
}

export async function createApp(ctx: AppContext) {
  const { config, index, store } = ctx
  const app = new Hono()
  const auth = await buildAuth(ctx)

  app.get("/health", (c) => c.json({ ok: true, driver: config.STORAGE_DRIVER, now: ctx.now() }))

  // Public download of a single blob via HMAC-signed (local) or real presigned (S3) URL.
  // The token carries (sessionId, fileId); the row is resolved through the
  // persistent index so purged/expired files stop downloading immediately.
  app.get("/download/:token", async (c) => {
    if (!ctx.downloadKey) return c.json({ error: { code: "download.unsupported" } }, 400)
    const verified = await verifyDownloadToken(c.req.param("token"), ctx.downloadKey)
    if (!verified.ok) return c.json({ error: { code: "download.invalid-link" } }, { status: 403 })
    const row = index.get(verified.sessionId, verified.fileId)
    if (!row) return c.json({ error: { code: "files.not-found" } }, { status: 404 })
    const blob = await store.get(row.storage_key)
    if (!blob) return c.json({ error: { code: "files.not-found" } }, { status: 404 })
    return new Response(blob.bytes.buffer as ArrayBuffer, {
      headers: {
        "content-type": row.content_type,
        "content-disposition": `attachment; filename="${encodeURIComponent(row.file_name)}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=60",
      },
    })
  })

  const files = new Hono()

  // POST /sessions/:sessionId/files — multipart {metadata, file}, Bearer short-lived token.
  files.post("/:sessionId/files", async (c) => {
    const sessionId = c.req.param("sessionId")
    if (!validSessionId(sessionId)) return c.json({ error: { code: "files.invalid-session" } }, { status: 400 })
    const authed = await auth.verifyRequest(sessionId, c.req.raw)
    if (authed instanceof Response) return authed

    let form: FormData
    try {
      form = await c.req.formData()
    } catch {
      return c.json({ error: { code: "files.invalid-multipart" } }, { status: 400 })
    }
    const metadataRaw = form.get("metadata")
    const filePart = form.get("file")
    if (typeof metadataRaw !== "string" || !(filePart instanceof File)) {
      return c.json({ error: { code: "files.invalid-multipart" } }, { status: 400 })
    }
    let metadata: { fileId?: string; fileName?: string; fileSize?: number; timestamp?: number }
    try {
      metadata = JSON.parse(metadataRaw)
    } catch {
      return c.json({ error: { code: "files.invalid-metadata" } }, { status: 400 })
    }
    const fileId =
      typeof metadata.fileId === "string" && metadata.fileId.length > 0 ? metadata.fileId : crypto.randomUUID()
    const clientName = filePart.name || metadata.fileName || "file"
    const bytes = new Uint8Array(await filePart.arrayBuffer())
    if (bytes.length > maxFileSizeBytes(config)) {
      log("upload.rejected", { sessionId, fileId, reason: "too large", size: bytes.length })
      return c.json({ error: { code: "files.too-large", maxBytes: maxFileSizeBytes(config) } }, { status: 413 })
    }
    const checked = validateUpload(clientName, filePart.type, bytes)
    if (!checked.ok) {
      log("upload.rejected", { sessionId, fileId, reason: checked.reason, fileName: clientName })
      return c.json({ error: { code: "files.disallowed-type", reason: checked.reason } }, { status: 415 })
    }

    const now = ctx.now()
    const contentType = filePart.type || "application/octet-stream"
    const storageKey = await store.put(sessionId, fileId, clientName, bytes, contentType)
    index.insert({
      id: fileId,
      session_id: sessionId,
      file_name: clientName,
      content_type: contentType,
      size: bytes.length,
      storage_key: storageKey,
      uploader: tokenUploaderId(authed.payload),
      created_at: typeof metadata.timestamp === "number" ? metadata.timestamp : now,
      expires_at: now + fileTtlMs(config),
    })
    log("upload.accepted", { sessionId, fileId, size: bytes.length, uploader: tokenUploaderId(authed.payload) })
    return c.json({ fileId })
  })

  // GET /sessions/:sessionId/files — list with presigned URLs.
  files.get("/:sessionId/files", async (c) => {
    const sessionId = c.req.param("sessionId")
    if (!validSessionId(sessionId)) return c.json({ error: { code: "files.invalid-session" } }, { status: 400 })
    const authed = await auth.verifyRequest(sessionId, c.req.raw)
    if (authed instanceof Response) return authed
    const parsed = v.safeParse(ListQuerySchema, c.req.query())
    const offset = parsed.success ? Math.max(0, Math.floor(parsed.output.offset)) : 0
    const pageSize = parsed.success ? Math.min(100, Math.max(1, Math.floor(parsed.output["page-size"]))) : 20
    const rows = index.list(sessionId, pageSize, offset)
    const items = await Promise.all(rows.map(async (row) => toListItem(ctx, row, await store.downloadUrl(row))))
    return c.json(items)
  })

  // GET /sessions/:sessionId/files/:fileId — single info + presigned URL (client reads presignedUrl/fileName).
  files.get("/:sessionId/files/:fileId", async (c) => {
    const sessionId = c.req.param("sessionId")
    const fileId = c.req.param("fileId")
    if (!validSessionId(sessionId)) return c.json({ error: { code: "files.invalid-session" } }, { status: 400 })
    const authed = await auth.verifyRequest(sessionId, c.req.raw)
    if (authed instanceof Response) return authed
    const row = index.get(sessionId, fileId)
    if (!row) return c.json({ error: { code: "files.not-found" } }, { status: 404 })
    const presignedUrl = await store.downloadUrl(row)
    return c.json({
      fileId: row.id,
      sessionId: row.session_id,
      fileName: row.file_name,
      customerId: "",
      userId: row.uploader,
      presignedUrl,
      preSignedUrl: presignedUrl,
      createdAt: row.created_at,
      fileSize: row.size,
      contentType: row.content_type,
    })
  })

  // DELETE /sessions/:sessionId/files/:fileId
  files.delete("/:sessionId/files/:fileId", async (c) => {
    const sessionId = c.req.param("sessionId")
    const fileId = c.req.param("fileId")
    if (!validSessionId(sessionId)) return c.json({ error: { code: "files.invalid-session" } }, { status: 400 })
    const authed = await auth.verifyRequest(sessionId, c.req.raw)
    if (authed instanceof Response) return authed
    const row = index.delete(sessionId, fileId)
    if (!row) return c.json({ error: { code: "files.not-found" } }, { status: 404 })
    await store.remove(row.storage_key).catch(() => null)
    log("file.deleted", { sessionId, fileId })
    return c.json({ ok: true })
  })

  app.route("/sessions", files)
  // OpenAPI path prefix from resources/file-sharing.yaml (/v1/documents/...) served as an alias.
  app.route("/v1/documents/sessions", files)

  // DELETE /sessions/:sessionId — internal room-purge endpoint for the Prosody
  // room-destroyed hook. Deletes index rows AND blobs. Guarded by shared secret.
  app.delete("/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId")
    if (!validSessionId(sessionId)) return c.json({ error: { code: "files.invalid-session" } }, { status: 400 })
    if (!config.INTERNAL_PURGE_TOKEN || c.req.header("x-internal-token") !== config.INTERNAL_PURGE_TOKEN) {
      log("purge.rejected", { sessionId, reason: "bad internal token" })
      return c.json({ error: { code: "purge.unauthorized" } }, { status: 401 })
    }
    const rows = index.deleteSession(sessionId)
    await Promise.all(rows.map((row) => store.remove(row.storage_key).catch(() => null)))
    try {
      const { rm } = await import("node:fs/promises")
      const { join } = await import("node:path")
      await rm(join(config.LOCAL_DIR, sessionId), { recursive: true, force: true })
    } catch {
      // S3 driver or already gone; per-blob deletes above are authoritative.
    }
    log("session.purged", { sessionId, files: rows.length })
    return c.json({ ok: true, deletedFiles: rows.length })
  })

  return app
}

/** Delete expired rows + blobs. Returns the number of files removed. */
export async function sweepExpired(ctx: AppContext): Promise<number> {
  const rows = ctx.index.deleteExpired(ctx.now())
  await Promise.all(rows.map((row) => ctx.store.remove(row.storage_key).catch(() => null)))
  if (rows.length > 0) log("ttl.swept", { files: rows.length })
  return rows.length
}
