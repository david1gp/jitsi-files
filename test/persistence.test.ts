import { describe, expect, test } from "bun:test"
import { createApp, type AppContext } from "../src/app.js"
import { loadConfig } from "../src/config.js"
import { importHmacKey } from "../src/crypto.js"
import { openFileIndex } from "../src/db.js"
import { createBlobStore } from "../src/storage.js"
import { makeTestServer, uploadForm, urlPath } from "./helpers.js"

const PDF = "%PDF-1.7\n%persistent\n"

async function openServerOn(dir: string) {
  const config = loadConfig({
    DEV_NO_AUTH: "1",
    LOCAL_DIR: `${dir}/files`,
    SQLITE_PATH: `${dir}/index.sqlite`,
    DOWNLOAD_SECRET: "persist-secret",
  })
  const ctx: AppContext = {
    config,
    index: openFileIndex(config.SQLITE_PATH),
    store: await createBlobStore(config, { downloadSecret: "persist-secret" }),
    downloadKey: await importHmacKey("persist-secret"),
    now: () => Date.now(),
  }
  return { app: await createApp(ctx), ctx }
}

describe("restart persistence", () => {
  test("files survive a process restart via the file-backed SQLite index", async () => {
    const first = await makeTestServer()
    const dir = first.dir
    const fileId = "persist-1"
    try {
      const upload = await first.app.request("/sessions/persist-session/files", {
        method: "POST",
        body: uploadForm("keep.pdf", PDF, "application/pdf", fileId),
      })
      expect(upload.status).toBe(200)
    } finally {
      // Simulate shutdown: close the index without deleting the directory.
      first.ctx.index.close()
    }

    // "Restart": open a fresh context on the same directory.
    const second = await openServerOn(dir)
    try {
      const list = (await (await second.app.request("/sessions/persist-session/files")).json()) as Array<
        Record<string, unknown>
      >
      expect(list).toHaveLength(1)
      expect(list[0]?.["objectId"]).toBe(fileId)

      const one = (await (await second.app.request(`/sessions/persist-session/files/${fileId}`)).json()) as Record<
        string,
        unknown
      >
      const download = await second.app.request(urlPath(one["presignedUrl"] as string))
      expect(download.status).toBe(200)
      expect(await download.text()).toBe(PDF)
    } finally {
      second.ctx.index.close()
      const { rm } = await import("node:fs/promises")
      await rm(dir, { recursive: true, force: true })
    }
  })
})
