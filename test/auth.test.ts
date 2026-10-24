import { describe, expect, test } from "bun:test"
import {
  generateRsaKeypair,
  importRsaPublicKey,
  mintTestToken,
  tokenIsModerator,
  tokenSessionAllows,
  verifyShortLivedToken,
} from "../src/crypto.js"

const OPTIONS = { issuer: "file-sharing", audience: "file-sharing" }

async function setup() {
  const pair = await generateRsaKeypair()
  const publicKey = await importRsaPublicKey(pair.publicPem)
  const now = Math.floor(Date.now() / 1000)
  const base = { iss: "file-sharing", aud: "file-sharing", nbf: now - 10, exp: now + 60, meeting_id: "sess-1" }
  return { pair, publicKey, now, base }
}

describe("short-lived Prosody token verification", () => {
  test("accepts a valid RS256 token with matching issuer and audience", async () => {
    const { pair, publicKey, base } = await setup()
    const token = await mintTestToken(base, pair.privatePem)
    const result = await verifyShortLivedToken(token, publicKey, OPTIONS)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.payload.meeting_id).toBe("sess-1")
  })

  test("rejects a token signed by a different key", async () => {
    const { publicKey, base } = await setup()
    const other = await generateRsaKeypair()
    const token = await mintTestToken(base, other.privatePem)
    const result = await verifyShortLivedToken(token, publicKey, OPTIONS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("invalid signature")
  })

  test("rejects issuer mismatch", async () => {
    const { pair, publicKey, base } = await setup()
    const token = await mintTestToken({ ...base, iss: "someone-else" }, pair.privatePem)
    const result = await verifyShortLivedToken(token, publicKey, OPTIONS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("issuer mismatch")
  })

  test("rejects audience mismatch", async () => {
    const { pair, publicKey, base } = await setup()
    const token = await mintTestToken({ ...base, aud: "other-service" }, pair.privatePem)
    const result = await verifyShortLivedToken(token, publicKey, OPTIONS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("audience mismatch")
  })

  test("accepts an audience array containing file-sharing", async () => {
    const { pair, publicKey, base } = await setup()
    const token = await mintTestToken({ ...base, aud: ["other", "file-sharing"] }, pair.privatePem)
    const result = await verifyShortLivedToken(token, publicKey, OPTIONS)
    expect(result.ok).toBe(true)
  })

  test("rejects an expired token", async () => {
    const { pair, publicKey, now } = await setup()
    const token = await mintTestToken(
      { iss: "file-sharing", aud: "file-sharing", nbf: now - 3600, exp: now - 300 },
      pair.privatePem,
    )
    const result = await verifyShortLivedToken(token, publicKey, OPTIONS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("token expired")
  })

  test("rejects a token used before nbf", async () => {
    const { pair, publicKey, now } = await setup()
    const token = await mintTestToken(
      { iss: "file-sharing", aud: "file-sharing", nbf: now + 3600, exp: now + 7200 },
      pair.privatePem,
    )
    const result = await verifyShortLivedToken(token, publicKey, OPTIONS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("token not yet valid")
  })

  test("rejects malformed tokens", async () => {
    const { publicKey } = await setup()
    for (const bad of ["", "abc", "a.b", "a.b.c.d", "!!!.!!!.!!!"]) {
      const result = await verifyShortLivedToken(bad, publicKey, OPTIONS)
      expect(result.ok).toBe(false)
    }
  })
})

describe("meeting session scoping", () => {
  test("token meeting_id must match the URL session id", () => {
    expect(tokenSessionAllows({ meeting_id: "sess-1" }, "sess-1")).toBe(true)
    expect(tokenSessionAllows({ meeting_id: "sess-1" }, "sess-2")).toBe(false)
  })

  test("tokens without meeting_id allow any session", () => {
    expect(tokenSessionAllows({}, "sess-9")).toBe(true)
  })
})

describe("moderator claim", () => {
  test("detects moderator flags in context.user and top level", () => {
    expect(tokenIsModerator({ context: { user: { moderator: true } } })).toBe(true)
    expect(tokenIsModerator({ moderator: true })).toBe(true)
    expect(tokenIsModerator({ context: { user: { id: "x" } } })).toBe(false)
    expect(tokenIsModerator({})).toBe(false)
  })
})
