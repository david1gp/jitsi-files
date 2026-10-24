import { describe, expect, test } from "bun:test"
import { validateUpload } from "../src/validation.js"
import { makeTestServer, uploadForm } from "./helpers.js"

const PDF = "%PDF-1.7\n%content\n"
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])
const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00])
const SHEBANG = new TextEncoder().encode("#!/bin/sh\nevil\n")
const HTML = new TextEncoder().encode("<!DOCTYPE html><html><script>alert(1)</script></html>")

describe("upload validation", () => {
  test("allows everyday document, image, and archive types", () => {
    for (const name of [
      "a.pdf",
      "b.docx",
      "c.xlsx",
      "d.pptx",
      "e.odt",
      "f.txt",
      "g.md",
      "h.csv",
      "i.png",
      "j.jpg",
      "k.webp",
      "l.mp3",
      "m.mp4",
      "n.zip",
    ]) {
      const result = validateUpload(name, "application/octet-stream", new TextEncoder().encode("data"))
      expect(result.ok).toBe(true)
    }
  })

  test("rejects executables, scripts, and markup extensions", () => {
    for (const name of [
      "x.exe",
      "x.dll",
      "x.msi",
      "x.sh",
      "x.bat",
      "x.ps1",
      "x.js",
      "x.html",
      "x.htm",
      "x.svg",
      "x.jar",
      "x.apk",
      "x.com",
      "file-no-ext",
    ]) {
      const result = validateUpload(name, "application/octet-stream", new TextEncoder().encode("data"))
      expect(result.ok).toBe(false)
    }
  })

  test("rejects executable magic bytes hiding behind an allowed extension", () => {
    expect(validateUpload("evil.pdf", "application/pdf", EXE).ok).toBe(false)
    expect(validateUpload("evil.pdf", "application/pdf", ELF).ok).toBe(false)
    expect(validateUpload("evil.txt", "text/plain", SHEBANG).ok).toBe(false)
  })

  test("rejects markup payloads hiding behind an allowed extension", () => {
    expect(validateUpload("evil.txt", "text/plain", HTML).ok).toBe(false)
  })

  test("rejects MIME types that do not match the extension", () => {
    const result = validateUpload("a.pdf", "application/x-msdownload", new TextEncoder().encode("data"))
    expect(result.ok).toBe(false)
  })
})

describe("HTTP enforcement", () => {
  test("oversize uploads are rejected with 413", async () => {
    const server = await makeTestServer({ MAX_FILE_SIZE_MB: "1" })
    try {
      const big = new Uint8Array(2 * 1024 * 1024).fill(0x61)
      const form = new FormData()
      form.set("metadata", JSON.stringify({ fileId: "big-1", fileName: "big.pdf" }))
      form.set("file", new File([big.buffer as ArrayBuffer], "big.pdf", { type: "application/pdf" }))
      const res = await server.app.request("/sessions/size-session/files", { method: "POST", body: form })
      expect(res.status).toBe(413)
    } finally {
      await server.cleanup()
    }
  })

  test("disallowed types are rejected with 415", async () => {
    const server = await makeTestServer()
    try {
      for (const [name, mime, content] of [
        ["evil.exe", "application/octet-stream", "MZ..."],
        ["page.html", "text/html", "<html></html>"],
        ["pic.svg", "image/svg+xml", "<svg></svg>"],
      ] as const) {
        const res = await server.app.request("/sessions/type-session/files", {
          method: "POST",
          body: uploadForm(name, content, mime, `type-${name}`),
        })
        expect(res.status).toBe(415)
      }
      const forged = new FormData()
      forged.set("metadata", JSON.stringify({ fileId: "forged", fileName: "forged.pdf" }))
      forged.set("file", new File([EXE.buffer as ArrayBuffer], "forged.pdf", { type: "application/pdf" }))
      const forgedRes = await server.app.request("/sessions/type-session/files", { method: "POST", body: forged })
      expect(forgedRes.status).toBe(415)
    } finally {
      await server.cleanup()
    }
  })

  test("missing parts and bad metadata are rejected with 400", async () => {
    const server = await makeTestServer()
    try {
      const noFile = new FormData()
      noFile.set("metadata", JSON.stringify({ fileId: "x" }))
      expect((await server.app.request("/sessions/s/files", { method: "POST", body: noFile })).status).toBe(400)
      const badMeta = new FormData()
      badMeta.set("metadata", "not json")
      badMeta.set("file", new File(["x"], "x.txt", { type: "text/plain" }))
      expect((await server.app.request("/sessions/s/files", { method: "POST", body: badMeta })).status).toBe(400)
    } finally {
      await server.cleanup()
    }
  })
})
