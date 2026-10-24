import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp, type AppContext } from "../src/app.js"
import { loadConfig, type Config } from "../src/config.js"
import { generateRsaKeypair, importHmacKey, mintTestToken } from "../src/crypto.js"
import { openFileIndex } from "../src/db.js"
import { createBlobStore } from "../src/storage.js"

export interface TestServer {
  app: Awaited<ReturnType<typeof createApp>>
  ctx: AppContext
  config: Config
  dir: string
  privatePem: string | null
  mintToken: (overrides?: Record<string, unknown>, sessionId?: string) => Promise<string>
  authHeaders: (token: string) => Record<string, string>
  cleanup: () => Promise<void>
}

export async function makeTestServer(
  env: Record<string, string> = {},
  auth: { enabled: boolean; sessionId?: string } = { enabled: false },
): Promise<TestServer> {
  const dir = await mkdtemp(join(tmpdir(), "jitsi-files-test-"))
  let privatePem: string | null = null
  let publicPem = ""
  if (auth.enabled) {
    const pair = await generateRsaKeypair()
    privatePem = pair.privatePem
    publicPem = pair.publicPem
  }
  const config = loadConfig({
    HOST: "127.0.0.1",
    PORT: "0",
    PUBLIC_BASE_URL: "http://localhost:8070",
    JWT_PUBLIC_KEY: publicPem,
    JWT_ISSUER: "file-sharing",
    JWT_AUDIENCE: "file-sharing",
    DEV_NO_AUTH: auth.enabled ? "0" : "1",
    LOCAL_DIR: join(dir, "files"),
    SQLITE_PATH: join(dir, "index.sqlite"),
    DOWNLOAD_SECRET: "test-download-secret",
    MAX_FILE_SIZE_MB: "10",
    FILE_TTL_HOURS: "24",
    INTERNAL_PURGE_TOKEN: "test-internal-token",
    ...env,
  })
  const downloadSecret = "test-download-secret"
  const ctx: AppContext = {
    config,
    index: openFileIndex(config.SQLITE_PATH),
    store: await createBlobStore(config, { downloadSecret }),
    downloadKey: await importHmacKey(downloadSecret),
    now: () => Date.now(),
  }
  const app = await createApp(ctx)
  const sessionId = auth.sessionId ?? "test-session-id"
  return {
    app,
    ctx,
    config,
    dir,
    privatePem,
    mintToken: async (overrides = {}, sid = sessionId) => {
      if (!privatePem) throw new Error("auth not enabled for this test server")
      const now = Math.floor(Date.now() / 1000)
      return mintTestToken(
        {
          iss: "file-sharing",
          aud: "file-sharing",
          nbf: now - 10,
          exp: now + 60,
          meeting_id: sid,
          ...overrides,
        },
        privatePem,
      )
    },
    authHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
    cleanup: async () => {
      ctx.index.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

export function uploadForm(fileName: string, content: string | Uint8Array, mime: string, fileId: string): FormData {
  const form = new FormData()
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content
  form.set("metadata", JSON.stringify({ fileId, fileName, fileSize: bytes.length, timestamp: Date.now() }))
  form.set("file", new File([bytes.buffer as ArrayBuffer], fileName, { type: mime }))
  return form
}

/** Extract the path from an absolute download URL for in-process app.request calls. */
export function urlPath(absoluteUrl: string): string {
  return new URL(absoluteUrl).pathname
}
