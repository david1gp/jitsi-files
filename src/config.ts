import * as v from "valibot"

const BoolFromEnv = v.pipe(
  v.optional(v.string(), "false"),
  v.transform((s) => s === "1" || s.toLowerCase() === "true"),
)

const NumFromEnv = (fallback: number) =>
  v.pipe(
    v.optional(v.string(), String(fallback)),
    v.transform((s) => Number(s)),
    v.number(),
  )

const ConfigSchema = v.object({
  HOST: v.optional(v.string(), "127.0.0.1"),
  PORT: NumFromEnv(8070),
  PUBLIC_BASE_URL: v.optional(v.string(), "http://localhost:8070"),

  // --- Auth (Prosody short-lived JWTs, mod_short_lived_token) ---
  /** PEM-encoded RSA public key (SPKI) used to verify Prosody-issued short-lived tokens. */
  JWT_PUBLIC_KEY: v.optional(v.string(), ""),
  /** Path to a PEM file with the RSA public key. Used when JWT_PUBLIC_KEY is empty. */
  JWT_PUBLIC_KEY_PATH: v.optional(v.string(), ""),
  JWT_ISSUER: v.optional(v.string(), "file-sharing"),
  JWT_AUDIENCE: v.optional(v.string(), "file-sharing"),
  /** DANGER: skip Bearer verification entirely. Local testing only, never in production. */
  DEV_NO_AUTH: BoolFromEnv,
  /** Optional moderator-only gate (stub). When true, uploads/deletes require a moderator claim. Default: all participants. */
  REQUIRE_MODERATOR: BoolFromEnv,

  // --- Storage ---
  STORAGE_DRIVER: v.pipe(
    v.optional(v.string(), "local"),
    v.transform((s) => s.toLowerCase()),
    v.picklist(["local", "s3"]),
  ),
  LOCAL_DIR: v.optional(v.string(), "./data/files"),
  SQLITE_PATH: v.optional(v.string(), "./data/jitsi-files.sqlite"),
  DOWNLOAD_SECRET: v.optional(v.string(), ""),
  DOWNLOAD_URL_TTL_SECONDS: NumFromEnv(900),

  // S3-compatible (B2 / R2 / MinIO)
  S3_ENDPOINT: v.optional(v.string(), ""),
  S3_REGION: v.optional(v.string(), "auto"),
  S3_BUCKET: v.optional(v.string(), ""),
  S3_ACCESS_KEY: v.optional(v.string(), ""),
  S3_SECRET_KEY: v.optional(v.string(), ""),
  S3_FORCE_PATH_STYLE: v.pipe(
    v.optional(v.string(), "true"),
    v.transform((s) => s === "1" || s.toLowerCase() === "true"),
  ),
  S3_PREFIX: v.optional(v.string(), "jitsi-files/"),
  PRESIGNED_URL_TTL_SECONDS: NumFromEnv(10_800),

  // --- Limits ---
  MAX_FILE_SIZE_MB: NumFromEnv(10),
  /**
   * When true, accept every upload file type (skip extension allowlist,
   * blocked extensions, executable magic-byte and markup/script checks).
   * Staff-only deployments may enable this; default false (responsible
   * default for other self-hosters).
   */
  ALLOW_ALL_FILE_TYPES: BoolFromEnv,
  /**
   * Global storage quota in gigabytes (fractional values allowed, so tests
   * can set a tiny quota). 0 or unset = unlimited (public default).
   * Uploads that would push total stored bytes (all sessions) over the
   * quota are rejected with 507 `files.storage-quota`.
   */
  MAX_TOTAL_STORAGE_GB: NumFromEnv(0),

  // --- Lifecycle ---
  /** Fallback expiry for files when the room-destroyed hook never fires. Hours. */
  FILE_TTL_HOURS: NumFromEnv(24),
  SWEEP_INTERVAL_MINUTES: NumFromEnv(15),
  /** Shared secret for the internal room-purge endpoint (Prosody room-destroyed hook). */
  INTERNAL_PURGE_TOKEN: v.optional(v.string(), ""),
})

export type Config = v.InferOutput<typeof ConfigSchema>

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return v.parse(ConfigSchema, {
    HOST: env["HOST"],
    PORT: env["PORT"],
    PUBLIC_BASE_URL: env["PUBLIC_BASE_URL"],
    JWT_PUBLIC_KEY: env["JWT_PUBLIC_KEY"],
    JWT_PUBLIC_KEY_PATH: env["JWT_PUBLIC_KEY_PATH"],
    JWT_ISSUER: env["JWT_ISSUER"],
    JWT_AUDIENCE: env["JWT_AUDIENCE"],
    DEV_NO_AUTH: env["DEV_NO_AUTH"],
    REQUIRE_MODERATOR: env["REQUIRE_MODERATOR"],
    STORAGE_DRIVER: env["STORAGE_DRIVER"],
    LOCAL_DIR: env["LOCAL_DIR"],
    SQLITE_PATH: env["SQLITE_PATH"],
    DOWNLOAD_SECRET: env["DOWNLOAD_SECRET"],
    DOWNLOAD_URL_TTL_SECONDS: env["DOWNLOAD_URL_TTL_SECONDS"],
    S3_ENDPOINT: env["S3_ENDPOINT"],
    S3_REGION: env["S3_REGION"],
    S3_BUCKET: env["S3_BUCKET"],
    S3_ACCESS_KEY: env["S3_ACCESS_KEY"],
    S3_SECRET_KEY: env["S3_SECRET_KEY"],
    S3_FORCE_PATH_STYLE: env["S3_FORCE_PATH_STYLE"],
    S3_PREFIX: env["S3_PREFIX"],
    PRESIGNED_URL_TTL_SECONDS: env["PRESIGNED_URL_TTL_SECONDS"],
    MAX_FILE_SIZE_MB: env["MAX_FILE_SIZE_MB"],
    ALLOW_ALL_FILE_TYPES: env["ALLOW_ALL_FILE_TYPES"],
    MAX_TOTAL_STORAGE_GB: env["MAX_TOTAL_STORAGE_GB"],
    FILE_TTL_HOURS: env["FILE_TTL_HOURS"],
    SWEEP_INTERVAL_MINUTES: env["SWEEP_INTERVAL_MINUTES"],
    INTERNAL_PURGE_TOKEN: env["INTERNAL_PURGE_TOKEN"],
  })
}

export function maxFileSizeBytes(config: Config): number {
  return Math.floor(config.MAX_FILE_SIZE_MB * 1024 * 1024)
}

export function maxTotalStorageBytes(config: Config): number {
  return Math.floor(config.MAX_TOTAL_STORAGE_GB * 1024 * 1024 * 1024)
}

export function fileTtlMs(config: Config): number {
  return Math.floor(config.FILE_TTL_HOURS * 3600 * 1000)
}
