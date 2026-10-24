import { describe, expect, test } from "bun:test"
import { s3PresignedGetUrl, type S3Config } from "../src/s3.js"

const CONFIG: S3Config = {
  endpoint: "https://s3.example.test",
  region: "auto",
  bucket: "test-bucket",
  accessKey: "test-access",
  secretKey: "test-secret",
  forcePathStyle: true,
  prefix: "jitsi-files/",
}

describe("S3-compatible storage", () => {
  test("presigned GET URLs carry SigV4 query parameters", async () => {
    const url = new URL(await s3PresignedGetUrl(CONFIG, "sess/file-1-a.pdf", 3600))
    expect(url.host).toBe("s3.example.test")
    expect(url.pathname).toBe("/test-bucket/jitsi-files/sess/file-1-a.pdf")
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256")
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600")
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host")
    expect(url.searchParams.get("X-Amz-Credential") ?? "").toContain("test-access/")
    expect(url.searchParams.get("X-Amz-Signature") ?? "").toHaveLength(64)
  })

  test("expiry is clamped to the SigV4 7-day maximum", async () => {
    const url = new URL(await s3PresignedGetUrl(CONFIG, "k", 999_999_999))
    expect(url.searchParams.get("X-Amz-Expires")).toBe("604800")
  })

  test("PUT and DELETE sign requests against a stub endpoint", async () => {
    const seen: Array<{ method: string; auth: string | null }> = []
    const stub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        seen.push({ method: req.method, auth: req.headers.get("authorization") })
        return new Response("ok")
      },
    })
    try {
      const stubConfig: S3Config = { ...CONFIG, endpoint: `http://127.0.0.1:${stub.port}` }
      const { s3DeleteObject, s3PutObject } = await import("../src/s3.js")
      await s3PutObject(stubConfig, "sess/f.pdf", new TextEncoder().encode("%PDF-x"), "application/pdf")
      await s3DeleteObject(stubConfig, "sess/f.pdf")
      expect(seen).toHaveLength(2)
      expect(seen[0]?.method).toBe("PUT")
      expect(seen[0]?.auth ?? "").toContain("AWS4-HMAC-SHA256 Credential=test-access/")
      expect(seen[1]?.method).toBe("DELETE")
    } finally {
      stub.stop()
    }
  })

  test("full roundtrip works through the S3 driver against a stub", async () => {
    const blobs = new Map<string, { bytes: Uint8Array; type: string }>()
    const stub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url)
        if (req.method === "PUT") {
          blobs.set(url.pathname, { bytes: new Uint8Array(await req.arrayBuffer()), type: "application/pdf" })
          return new Response("ok")
        }
        if (req.method === "DELETE") {
          blobs.delete(url.pathname)
          return new Response("ok")
        }
        const blob = blobs.get(url.pathname)
        if (!blob) return new Response("no", { status: 404 })
        return new Response(blob.bytes.buffer as ArrayBuffer, { headers: { "content-type": blob.type } })
      },
    })
    try {
      const { makeTestServer, uploadForm } = await import("./helpers.js")
      const server = await makeTestServer({
        STORAGE_DRIVER: "s3",
        S3_ENDPOINT: `http://127.0.0.1:${stub.port}`,
        S3_REGION: "auto",
        S3_BUCKET: "b",
        S3_ACCESS_KEY: "k",
        S3_SECRET_KEY: "s",
        S3_FORCE_PATH_STYLE: "true",
      })
      try {
        const upload = await server.app.request("/sessions/s3-session/files", {
          method: "POST",
          body: uploadForm("d.pdf", "%PDF-doc", "application/pdf", "s3-file-1"),
        })
        expect(upload.status).toBe(200)
        const one = (await (await server.app.request("/sessions/s3-session/files/s3-file-1")).json()) as Record<
          string,
          string
        >
        expect(one["presignedUrl"] ?? "").toContain("X-Amz-Signature=")
        const del = await server.app.request("/sessions/s3-session/files/s3-file-1", { method: "DELETE" })
        expect(del.status).toBe(200)
        expect(blobs.size).toBe(0)
      } finally {
        await server.cleanup()
      }
    } finally {
      stub.stop()
    }
  })
})
