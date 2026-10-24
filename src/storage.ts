import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import type { Config } from "./config.js"
import { importHmacKey, signDownloadToken } from "./crypto.js"
import { s3DeleteObject, s3PresignedGetUrl, s3PutObject, type S3Config } from "./s3.js"

export interface BlobStore {
  put(sessionId: string, fileId: string, fileName: string, bytes: Uint8Array, contentType: string): Promise<string>
  get(storageKey: string): Promise<{ bytes: Uint8Array; contentType: string } | null>
  remove(storageKey: string): Promise<void>
  /** Public download URL for a stored blob (presigned for S3, HMAC-signed for local). */
  downloadUrl(row: {
    id: string
    session_id: string
    file_name: string
    storage_key: string
    content_type: string
  }): Promise<string>
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "file"
}

export async function createBlobStore(config: Config, opts?: { downloadSecret?: string }): Promise<BlobStore> {
  if (config.STORAGE_DRIVER === "s3") {
    const s3: S3Config = {
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET,
      accessKey: config.S3_ACCESS_KEY,
      secretKey: config.S3_SECRET_KEY,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      prefix: config.S3_PREFIX,
    }
    if (!s3.endpoint || !s3.bucket || !s3.accessKey || !s3.secretKey) {
      throw new Error("S3 driver requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY")
    }
    return {
      async put(sessionId, fileId, fileName, bytes, contentType) {
        const key = `${sessionId}/${fileId}-${sanitizeFileName(fileName)}`
        await s3PutObject(s3, key, bytes, contentType)
        return key
      },
      async get(storageKey) {
        const url = await s3PresignedGetUrl(s3, storageKey, 300)
        const res = await fetch(url)
        if (!res.ok) return null
        const contentType = res.headers.get("content-type") ?? "application/octet-stream"
        return { bytes: new Uint8Array(await res.arrayBuffer()), contentType }
      },
      async remove(storageKey) {
        await s3DeleteObject(s3, storageKey)
      },
      async downloadUrl(row) {
        return s3PresignedGetUrl(s3, row.storage_key, config.PRESIGNED_URL_TTL_SECONDS)
      },
    }
  }

  await mkdir(config.LOCAL_DIR, { recursive: true })
  const secret = opts?.downloadSecret || config.DOWNLOAD_SECRET || crypto.randomUUID()
  const hmacKey = await importHmacKey(secret)
  return {
    async put(sessionId, fileId, fileName, bytes, _contentType) {
      const key = join(sessionId, `${fileId}-${sanitizeFileName(fileName)}`)
      const abs = join(config.LOCAL_DIR, key)
      await mkdir(join(config.LOCAL_DIR, sessionId), { recursive: true })
      await Bun.write(abs, bytes)
      return key
    },
    async get(storageKey) {
      const file = Bun.file(join(config.LOCAL_DIR, storageKey))
      if (!(await file.exists())) return null
      return { bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type || "application/octet-stream" }
    },
    async remove(storageKey) {
      await rm(join(config.LOCAL_DIR, storageKey), { force: true })
    },
    async downloadUrl(row) {
      const expiresAt = Date.now() + config.DOWNLOAD_URL_TTL_SECONDS * 1000
      const token = await signDownloadToken(row.session_id, row.id, expiresAt, hmacKey)
      const base = config.PUBLIC_BASE_URL.replace(/\/+$/, "")
      return `${base}/download/${token}`
    },
  }
}
