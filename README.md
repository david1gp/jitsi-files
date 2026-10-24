# @adaptive-ds/jitsi-files

Self-hostable file-sharing backend for Jitsi Meet's built-in file sharing UI
(`config.fileSharing`). A small Bun + Hono + SQLite HTTP service that stores
meeting files, verifies Prosody short-lived JWTs, and deletes files when the
meeting ends — like chat messages do.

## Why not the demo service?

The upstream reference implementation
(`jitsi/jitsi-meet-file-sharing-service`) keeps its file index in memory, so a
restart orphans every blob on disk while the API reports them gone. It also
leaves the meeting-end lifecycle to the deployer. This service instead:

- persists the index in SQLite next to the blobs, so restarts lose nothing;
- deletes a whole session via an internal purge endpoint (called by a Prosody
  room-destroyed hook — deployment side, documented below) **and** a TTL
  sweeper fallback, so nothing accumulates when the hook never fires;
- verifies Prosody short-lived JWTs (RS256, issuer/audience `file-sharing`)
  with meeting/token session scoping;
- rejects executables and markup by extension **and** magic bytes, serves
  everything as `attachment`.

## Install

```bash
git clone https://github.com/david1gp/jitsi-files.git
cd jitsi-files
bun install
cp .env.example .env
```

## Scripts

```bash
bun run dev      # run from source (Bun loads .env automatically)
bun run start    # run the built output
bun test         # bun tests (33 tests: auth, roundtrip, purge, TTL, validation, persistence, S3)
bun run typecheck
bun run build    # emit dist/server.js
bun run format   # biome
bun run smoke    # live curl smoke test against a local server (dev mode)
```

## Configuration

Env only — see [.env.example](./.env.example) (complete). Key decisions:

| Variable                                                        | Default                                        | Meaning                                                                                           |
| --------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `PORT` / `HOST` / `PUBLIC_BASE_URL`                             | `8070` / `127.0.0.1` / `http://localhost:8070` | Listen address and the public origin used to build local download URLs                            |
| `JWT_PUBLIC_KEY` / `JWT_PUBLIC_KEY_PATH`                        | —                                              | RSA **public** key (SPKI PEM) matching Prosody's `short_lived_token.key_path` private key         |
| `JWT_ISSUER` / `JWT_AUDIENCE`                                   | `file-sharing` / `file-sharing`                | Must match Prosody's `short_lived_token` block                                                    |
| `DEV_NO_AUTH`                                                   | `false`                                        | **Local testing only.** Skips Bearer verification entirely                                        |
| `REQUIRE_MODERATOR`                                             | `false`                                        | Stub gate: when true, uploads/deletes need a moderator claim. Default lets all participants share |
| `STORAGE_DRIVER`                                                | `local`                                        | `local` filesystem or `s3` (B2 / R2 / MinIO)                                                      |
| `LOCAL_DIR` / `SQLITE_PATH`                                     | `./data/files` / `./data/jitsi-files.sqlite`   | Blobs and persistent index (back these up together)                                               |
| `DOWNLOAD_SECRET`                                               | —                                              | HMAC secret for local download URLs. Empty = ephemeral (links die on restart)                     |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | —                                              | S3-compatible backend (`S3_FORCE_PATH_STYLE=true` suits MinIO/B2/R2)                              |
| `PRESIGNED_URL_TTL_SECONDS`                                     | `10800` (3h)                                   | S3 presigned download-URL lifetime                                                                |
| `MAX_FILE_SIZE_MB`                                              | `10`                                           | Server-side upload cap, enforced for every upload                                                 |
| `ALLOW_ALL_FILE_TYPES`                                      | `false`                                        | Accept every file type (skip allowlist + content sniffing). Staff-only use; downloads stay `attachment` + `nosniff` |
| `FILE_TTL_HOURS`                                                | `24`                                           | Fallback expiry when the room-destroyed hook never fires                                          |
| `SWEEP_INTERVAL_MINUTES`                                        | `15`                                           | How often expired blobs + index rows are deleted                                                  |
| `INTERNAL_PURGE_TOKEN`                                          | —                                              | Shared secret for `DELETE /sessions/:sessionId` (Prosody hook)                                    |

## API

Client paths are relative to `config.fileSharing.apiUrl`, e.g.
`apiUrl = https://files.example.com`. The `/v1/documents` prefix from
[`resources/file-sharing.yaml`](https://github.com/jitsi/jitsi-meet/blob/master/resources/file-sharing.yaml)
is served as an alias, so both `apiUrl=https://files.example.com` and
`apiUrl=https://files.example.com/v1/documents` work.

| Method   | Path                                 | Auth               | Description                                                                                                                      |
| -------- | ------------------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/health`                            | none               | `{ok, driver, now}`                                                                                                              |
| `POST`   | `/sessions/:sessionId/files`         | Bearer             | multipart `metadata` (JSON: `fileId`, `conferenceFullName`, `timestamp`, `fileSize`) + `file` → `{fileId}`                       |
| `GET`    | `/sessions/:sessionId/files`         | Bearer             | list → `[{objectId, sessionId, timestamp, contentType, objectName, initiatorId, preSignedUrl}]` (`?offset=&page-size=`, max 100) |
| `GET`    | `/sessions/:sessionId/files/:fileId` | Bearer             | `{fileId, fileName, presignedUrl, fileSize, …}` — the client reads `presignedUrl` + `fileName`                                   |
| `DELETE` | `/sessions/:sessionId/files/:fileId` | Bearer             | delete one file                                                                                                                  |
| `GET`    | `/download/:token`                   | HMAC link          | blob bytes, `Content-Disposition: attachment` (local driver; S3 presigned URLs point at the bucket directly)                     |
| `DELETE` | `/sessions/:sessionId`               | `x-internal-token` | **room-purge hook**: deletes all blobs + index rows for a meeting                                                                |

Error bodies are `{error: {code}}` with codes like `auth.invalid-token`,
`auth.session-mismatch`, `files.too-large` (413), `files.disallowed-type`
(415), `files.not-found` (404), `purge.unauthorized` (401).

## Jitsi wiring

Jitsi Meet (`config.js`):

```js
config.fileSharing = {
  enabled: true,
  apiUrl: "https://files.example.com",
  maxFileSize: 10 * 1024 * 1024, // keep in sync with MAX_FILE_SIZE_MB
}
```

Prosody — issue short-lived tokens for the `file-sharing` audience
(`mod_short_lived_token`, enabled under the main virtual host):

```lua
short_lived_token = {
    issuer = 'file-sharing';
    accepted_audiences = { 'file-sharing' };
    key_path = '/etc/prosody/short_lived_token.key';
    key_id = 'file-sharing-key';
    ttl_seconds = 30;
}
```

Copy the matching **public** key to this service (`JWT_PUBLIC_KEY_PATH`).
`mod_filesharing_component` (upstream `resources/prosody-plugins/`) provides
the XMPP side; the client passes the token as `Authorization: Bearer`.

nginx:

```nginx
location /file-service/ {
    proxy_pass http://127.0.0.1:8070/;
    client_max_body_size 12m; # just above MAX_FILE_SIZE_MB
    proxy_set_header Host $host;
}
```

With that prefix setup, `apiUrl` is `https://meet.example.com/file-service`.

### Room-purge hook contract (deployment side)

When a room is destroyed, Prosody must call:

```http
DELETE /sessions/{meetingId} HTTP/1.1
x-internal-token: <INTERNAL_PURGE_TOKEN>
```

`{meetingId}` is the same id the client uses as `sessionId`
(`conference.getMeetingUniqueId()`, = Prosody `room._data.meetingId`, which the
short-lived token also carries as `meeting_id` — the service rejects tokens
whose `meeting_id` does not match the URL session).

Response: `{ok: true, deletedFiles: n}` (`n = 0` when the session is already
gone — the hook is idempotent). On `401` the token is wrong; the TTL sweeper
(`FILE_TTL_HOURS`, default 24h) still deletes the leftovers, so a missed hook
delays cleanup but never leaks storage permanently.

## Security notes

- Never commit `.env`, `*.pem`, `*.key`, or `data/` — gitignored and verified
  via `git ls-files`.
- `DEV_NO_AUTH=1` disables all Bearer checks. It logs a startup warning and
  must never be set in production.
- Short-lived tokens are verified for signature (RS256), issuer, audience,
  expiry/nbf (±60s skew), and `meeting_id` ↔ URL session binding.
- Uploads are capped (`MAX_FILE_SIZE_MB`, default 10MB), restricted to a
  document/image/media/zip allowlist (`.svg` images included — meeting users
  share logos/seals/diagrams), and screened for executable magic bytes
  (MZ/ELF/Mach-O/shebang) and markup payloads. No `.html/.js` or executables,
  ever; SVGs with embedded `<script>` are rejected. Downloads are always
  `attachment` + `nosniff`.
- Structured logs carry ids, sizes, and reasons — never file contents, tokens,
  or secrets.

## Limits

- One service instance per deployment (SQLite index is local; run one replica
  and back up `LOCAL_DIR` + `SQLITE_PATH` together).
- `REQUIRE_MODERATOR` trusts the token's moderator claim; role mapping is a
  deployment concern.
- S3 downloads redirect off-box via presigned URLs; local downloads stream
  through this service.

## License

MIT — see [LICENSE](./LICENSE).
