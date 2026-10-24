/**
 * Minimal S3-compatible client (B2 / R2 / MinIO): PUT object, DELETE object,
 * and SigV4 presigned GET URLs. Implemented with WebCrypto so the service
 * needs no AWS SDK dependency.
 */

export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  accessKey: string
  secretKey: string
  forcePathStyle: boolean
  prefix: string
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<Uint8Array> {
  const raw = key instanceof Uint8Array ? (key.buffer as ArrayBuffer) : key
  const cryptoKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data)))
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const p = (n: number, l = 2) => String(n).padStart(l, "0")
  const dateStamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`
  const amzDate = `${dateStamp}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`
  return { amzDate, dateStamp }
}

function encodeKey(key: string): string {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")
}

async function signingKey(secret: string, dateStamp: string, region: string): Promise<Uint8Array> {
  const kDate = await hmacSha256(new TextEncoder().encode(`AWS4${secret}`), dateStamp)
  const kRegion = await hmacSha256(kDate, region)
  const kService = await hmacSha256(kRegion, "s3")
  return hmacSha256(kService, "aws4_request")
}

function objectUrl(config: S3Config, key: string): string {
  const base = config.endpoint.replace(/\/+$/, "")
  const path = `${config.prefix}${key}`.replace(/^\/+/, "")
  if (config.forcePathStyle) return `${base}/${config.bucket}/${encodeKey(path)}`
  const url = new URL(base)
  return `${url.protocol}//${config.bucket}.${url.host}${url.pathname.replace(/\/+$/, "")}/${encodeKey(path)}`
}

function authorizationHeader(
  config: S3Config,
  method: string,
  key: string,
  payloadHash: string,
  contentType: string,
  now: Date,
): Promise<{ url: string; headers: Record<string, string> }> {
  return (async () => {
    const url = objectUrl(config, key)
    const { amzDate, dateStamp } = amzDates(now)
    const parsed = new URL(url)
    const canonicalUri = parsed.pathname
    const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date"
    const canonicalHeaders = `content-type:${contentType}\nhost:${parsed.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
    const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n")
    const scope = `${dateStamp}/${config.region}/s3/aws4_request`
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n")
    const signKey = await signingKey(config.secretKey, dateStamp, config.region)
    const signature = [...(await hmacSha256(signKey, stringToSign))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
    return {
      url,
      headers: {
        Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        "content-type": contentType,
      },
    }
  })()
}

export async function s3PutObject(config: S3Config, key: string, body: Uint8Array, contentType: string): Promise<void> {
  const payloadHash = await sha256Hex(body)
  const { url, headers } = await authorizationHeader(config, "PUT", key, payloadHash, contentType, new Date())
  const res = await fetch(url, { method: "PUT", headers, body: body.buffer as ArrayBuffer })
  if (!res.ok) throw new Error(`S3 PUT failed: ${res.status} ${res.statusText}`)
  await res.arrayBuffer().catch(() => null)
}

export async function s3DeleteObject(config: S3Config, key: string): Promise<void> {
  const payloadHash = await sha256Hex("")
  const { url, headers } = await authorizationHeader(
    config,
    "DELETE",
    key,
    payloadHash,
    "application/octet-stream",
    new Date(),
  )
  const res = await fetch(url, { method: "DELETE", headers })
  if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE failed: ${res.status} ${res.statusText}`)
  await res.arrayBuffer().catch(() => null)
}

/** Build a SigV4 presigned GET URL valid for `expiresInSeconds` (max 7 days). */
export async function s3PresignedGetUrl(config: S3Config, key: string, expiresInSeconds: number): Promise<string> {
  const now = new Date()
  const { amzDate, dateStamp } = amzDates(now)
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`
  const credential = `${config.accessKey}/${scope}`
  const url = new URL(objectUrl(config, key))
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256")
  url.searchParams.set("X-Amz-Credential", credential)
  url.searchParams.set("X-Amz-Date", amzDate)
  url.searchParams.set("X-Amz-Expires", String(Math.min(Math.max(1, Math.floor(expiresInSeconds)), 604800)))
  url.searchParams.set("X-Amz-SignedHeaders", "host")
  const canonicalRequest = [
    "GET",
    url.pathname,
    url.searchParams.toString(),
    `host:${url.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n")
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n")
  const signKey = await signingKey(config.secretKey, dateStamp, config.region)
  const signature = [...(await hmacSha256(signKey, stringToSign))].map((b) => b.toString(16).padStart(2, "0")).join("")
  url.searchParams.set("X-Amz-Signature", signature)
  return url.toString()
}
