# Changelog

## Unreleased

- New `MAX_TOTAL_STORAGE_GB` env (default `0` = unlimited): global quota
  over total stored bytes across all sessions. Over-quota uploads are
  rejected with HTTP 507 `files.storage-quota` (logged as
  `upload.rejected` with `reason: storage-quota`); deletes, room purges,
  and TTL expiry free quota. The check-then-insert has a residual race
  under concurrent uploads (documented in README).
- New `ALLOW_ALL_FILE_TYPES` env flag (default `false`): when enabled
  (`1`/`true`), upload validation accepts every file type — extension
  allowlist, blocked extensions, executable magic-byte rejection, and
  markup/script sniffing are all skipped (including `.exe`, `.html`,
  script-carrying `.svg`, unknown or missing extensions). Auth, the
  `MAX_FILE_SIZE_MB` cap, `attachment` downloads with `nosniff`, and
  filename sanitization stay enforced regardless.

- Allow `.svg` image uploads (`image/svg+xml`): real meeting users share SVG
  logos/seals/diagrams and the blanket block turned those shares into a
  generic "Upload failed" (HTTP 415 `files.disallowed-type`). Downloads stay
  `Content-Disposition: attachment` (now plus `nosniff`), SVGs with embedded
  `<script>` are rejected, and SVG markup behind any other extension is still
  rejected.
- Download responses now send `X-Content-Type-Options: nosniff`.

## 0.1.0 — initial public release

- Jitsi Meet `config.fileSharing` backend: `POST /sessions/:id/files`
  (multipart), `GET` list, `GET` one (`{presignedUrl, fileName}`), `DELETE`
  one, plus `/v1/documents` aliases matching `resources/file-sharing.yaml`.
- Prosody short-lived JWT auth (RS256, issuer/audience `file-sharing`,
  `meeting_id` session binding), `DEV_NO_AUTH` local-testing mode,
  `REQUIRE_MODERATOR` stub gate (default off).
- Local filesystem + S3-compatible (B2/R2/MinIO, SigV4, no SDK) storage.
- Persistent SQLite index (survives restarts); TTL sweeper (default 24h) +
  internal `DELETE /sessions/:id` room-purge endpoint.
- Upload validation: 10MB default cap, allowlist, executable magic-byte and
  markup rejection, `attachment` downloads.
