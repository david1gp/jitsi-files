import { describe, expect, test } from "bun:test"
import { validateUpload } from "../src/validation.js"

const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00])
const HTML = new TextEncoder().encode("<!DOCTYPE html><html><body>hi</body></html>")
const EVIL_SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

describe("ALLOW_ALL_FILE_TYPES=on", () => {
  test("accepts previously-rejected types", () => {
    const allowAll = { allowAllFileTypes: true }
    expect(validateUpload("tool.exe", "application/octet-stream", EXE, allowAll).ok).toBe(true)
    expect(validateUpload("page.html", "text/html", HTML, allowAll).ok).toBe(true)
    expect(validateUpload("evil.svg", "image/svg+xml", EVIL_SVG, allowAll).ok).toBe(true)
    expect(
      validateUpload("data.zzzunknown", "application/octet-stream", new TextEncoder().encode("data"), allowAll).ok,
    ).toBe(true)
    expect(
      validateUpload("file-no-ext", "application/octet-stream", new TextEncoder().encode("data"), allowAll).ok,
    ).toBe(true)
  })
})

describe("ALLOW_ALL_FILE_TYPES=on (HTTP)", () => {
  test("server accepts exe upload when enabled, rejects when off", async () => {
    const { makeTestServer, uploadForm } = await import("./helpers.js")
    const on = await makeTestServer({ ALLOW_ALL_FILE_TYPES: "1" })
    try {
      const res = await on.app.request("/sessions/allowall/files", {
        method: "POST",
        body: uploadForm("tool.exe", new Uint8Array([0x4d, 0x5a, 0x90, 0x00]), "application/octet-stream", "exe-1"),
      })
      expect(res.status).toBe(200)
    } finally {
      await on.cleanup()
    }
    const off = await makeTestServer()
    try {
      const res = await off.app.request("/sessions/allowall/files", {
        method: "POST",
        body: uploadForm("tool.exe", new Uint8Array([0x4d, 0x5a, 0x90, 0x00]), "application/octet-stream", "exe-1"),
      })
      expect(res.status).toBe(415)
    } finally {
      await off.cleanup()
    }
  })
})
