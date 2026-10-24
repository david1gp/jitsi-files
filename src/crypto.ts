import * as v from "valibot"

export interface ShortLivedTokenPayload {
  iss?: string
  aud?: string | string[]
  sub?: string
  exp?: number
  nbf?: number
  iat?: number
  room?: string
  meeting_id?: string
  moderator?: boolean
  context?: {
    user?: { id?: string; name?: string; moderator?: boolean }
    features?: Record<string, boolean | string>
  }
  [key: string]: unknown
}

const JwtHeaderSchema = v.object({ alg: v.string(), kid: v.optional(v.string()) })

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/")
  const pad = (4 - (padded.length % 4)) % 4
  const bin = atob(padded + "=".repeat(pad))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function pemDerToBytes(pem: string): Uint8Array {
  const b64 = pem
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("-----"))
    .join("")
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function importRsaPublicKey(pem: string): Promise<CryptoKey> {
  const der = pemDerToBytes(pem)
  return crypto.subtle.importKey(
    "spki",
    der.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  )
}

export interface VerifyOptions {
  issuer: string
  audience: string
  clockSkewSeconds?: number
}

export async function verifyShortLivedToken(
  token: string,
  publicKey: CryptoKey,
  options: VerifyOptions,
): Promise<{ ok: true; payload: ShortLivedTokenPayload } | { ok: false; reason: string }> {
  const parts = token.split(".")
  if (parts.length !== 3) return { ok: false, reason: "malformed token" }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string]

  let header: v.InferOutput<typeof JwtHeaderSchema>
  try {
    header = v.parse(JwtHeaderSchema, JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64))))
  } catch {
    return { ok: false, reason: "malformed header" }
  }
  if (header.alg !== "RS256") return { ok: false, reason: `unexpected alg ${header.alg}` }

  let payload: ShortLivedTokenPayload
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)))
  } catch {
    return { ok: false, reason: "malformed payload" }
  }

  let signature: Uint8Array
  try {
    signature = base64UrlDecode(sigB64)
  } catch {
    return { ok: false, reason: "malformed signature" }
  }

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  let valid = false
  try {
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature.buffer as ArrayBuffer, data)
  } catch {
    return { ok: false, reason: "verification error" }
  }
  if (!valid) return { ok: false, reason: "invalid signature" }

  if (payload.iss !== options.issuer) return { ok: false, reason: "issuer mismatch" }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!aud.includes(options.audience)) return { ok: false, reason: "audience mismatch" }

  const now = Math.floor(Date.now() / 1000)
  const skew = options.clockSkewSeconds ?? 60
  if (typeof payload.exp === "number" && now > payload.exp + skew) return { ok: false, reason: "token expired" }
  if (typeof payload.nbf === "number" && now < payload.nbf - skew) return { ok: false, reason: "token not yet valid" }

  return { ok: true, payload }
}

/** Session scoping: when the token carries meeting_id it must equal the URL session id. */
export function tokenSessionAllows(payload: ShortLivedTokenPayload, sessionId: string): boolean {
  if (typeof payload.meeting_id === "string" && payload.meeting_id.length > 0) {
    return payload.meeting_id === sessionId
  }
  return true
}

export function tokenUploaderId(payload: ShortLivedTokenPayload): string {
  return payload.context?.user?.id ?? (typeof payload.sub === "string" ? payload.sub : "unknown")
}

export function tokenIsModerator(payload: ShortLivedTokenPayload): boolean {
  return payload.moderator === true || payload.context?.user?.moderator === true
}

// --- HMAC-signed download tokens (local storage driver) ---

export async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ])
}

export async function signDownloadToken(
  sessionId: string,
  fileId: string,
  expiresAt: number,
  key: CryptoKey,
): Promise<string> {
  const body = `${sessionId}.${fileId}.${expiresAt}`
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))
  return `${base64UrlEncode(new TextEncoder().encode(sessionId))}.${base64UrlEncode(new TextEncoder().encode(fileId))}.${expiresAt}.${base64UrlEncode(sig)}`
}

export async function verifyDownloadToken(
  token: string,
  key: CryptoKey,
): Promise<{ ok: true; sessionId: string; fileId: string } | { ok: false; reason: string }> {
  const parts = token.split(".")
  if (parts.length !== 4) return { ok: false, reason: "malformed download token" }
  const [sessionB64, fileIdB64, expStr, sigB64] = parts as [string, string, string, string]
  const expiresAt = Number(expStr)
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return { ok: false, reason: "download link expired" }
  let sessionId: string
  let fileId: string
  try {
    sessionId = new TextDecoder().decode(base64UrlDecode(sessionB64))
    fileId = new TextDecoder().decode(base64UrlDecode(fileIdB64))
  } catch {
    return { ok: false, reason: "malformed download token" }
  }
  const body = `${sessionId}.${fileId}.${expiresAt}`
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))
  let provided: Uint8Array
  try {
    provided = base64UrlDecode(sigB64)
  } catch {
    return { ok: false, reason: "malformed download token" }
  }
  if (provided.length !== expected.length) return { ok: false, reason: "invalid download signature" }
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= (expected[i] as number) ^ (provided[i] as number)
  if (diff !== 0) return { ok: false, reason: "invalid download signature" }
  return { ok: true, sessionId, fileId }
}

/** Test helper: generate an RSA keypair and return PEM strings. */
export async function generateRsaKeypair(): Promise<{ publicPem: string; privatePem: string }> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )
  const pubDer = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))
  const privDer = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
  return { publicPem: derToPem(pubDer, "PUBLIC KEY"), privatePem: derToPem(privDer, "PRIVATE KEY") }
}

function derToPem(der: Uint8Array, label: string): string {
  let bin = ""
  for (const b of der) bin += String.fromCharCode(b)
  const b64 = btoa(bin)
  const lines = [`-----BEGIN ${label}-----`]
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64))
  lines.push(`-----END ${label}-----`)
  return lines.join("\n")
}

/** Test helper: mint an RS256 JWT with a PEM private key. */
export async function mintTestToken(payload: Record<string, unknown>, privatePem: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemDerToBytes(privatePem).buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const realSig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${headerB64}.${payloadB64}`)),
  )
  return `${headerB64}.${payloadB64}.${base64UrlEncode(realSig)}`
}
