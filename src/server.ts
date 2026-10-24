import { createApp, sweepExpired, type AppContext } from "./app.js"
import { loadConfig } from "./config.js"
import { importHmacKey } from "./crypto.js"
import { openFileIndex } from "./db.js"
import { createBlobStore } from "./storage.js"

async function main(): Promise<void> {
  const config = loadConfig()

  if (config.DEV_NO_AUTH) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "startup.dev-no-auth",
        warning: "DEV_NO_AUTH=1: Bearer verification is DISABLED. Local testing only, never production.",
      }),
    )
  }
  if (config.STORAGE_DRIVER === "local" && !config.DOWNLOAD_SECRET) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "startup.ephemeral-download-secret",
        warning:
          "DOWNLOAD_SECRET is empty: generated an ephemeral secret. Download URLs invalidate on restart. Set DOWNLOAD_SECRET for stable links.",
      }),
    )
  }

  const downloadSecret = config.DOWNLOAD_SECRET || crypto.randomUUID()
  const [index, store] = await Promise.all([
    Promise.resolve(openFileIndex(config.SQLITE_PATH)),
    createBlobStore(config, { downloadSecret }),
  ])
  const ctx: AppContext = {
    config,
    index,
    store,
    downloadKey: config.STORAGE_DRIVER === "local" ? await importHmacKey(downloadSecret) : null,
    now: () => Date.now(),
  }

  const sweptAtBoot = await sweepExpired(ctx)
  const app = await createApp(ctx)

  const sweepEveryMs = Math.max(1, config.SWEEP_INTERVAL_MINUTES) * 60 * 1000
  const timer = setInterval(() => {
    sweepExpired(ctx).catch((error) => {
      console.log(JSON.stringify({ ts: new Date().toISOString(), event: "ttl.sweep-error", error: String(error) }))
    })
  }, sweepEveryMs)
  timer.unref?.()

  const server = Bun.serve({ hostname: config.HOST, port: config.PORT, fetch: app.fetch })
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "startup.listening",
      host: config.HOST,
      port: server.port,
      driver: config.STORAGE_DRIVER,
      sweptAtBoot,
    }),
  )
}

main().catch((error) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), event: "startup.failed", error: String(error) }))
  process.exit(1)
})
