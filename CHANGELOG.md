# Changelog

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
