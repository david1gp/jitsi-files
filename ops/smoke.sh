#!/usr/bin/env bash
# Live curl smoke test (dev mode, no Prosody needed). Starts the server,
# exercises upload/list/get/download/delete/purge, then stops it.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMOKE_PORT:-18091}"
WORK="$(mktemp -d)"
trap 'kill "$PID" 2>/dev/null; rm -rf "$WORK"' EXIT

printf '%%PDF-1.7\nsmoke test doc\n' > "$WORK/doc.pdf"
cat > "$WORK/smoke.env" <<EOF
HOST=127.0.0.1
PORT=$PORT
PUBLIC_BASE_URL=http://127.0.0.1:$PORT
DEV_NO_AUTH=1
LOCAL_DIR=$WORK/files
SQLITE_PATH=$WORK/smoke.sqlite
INTERNAL_PURGE_TOKEN=smoke-purge-token
DOWNLOAD_SECRET=smoke-secret
EOF

setsid -f bun run --env-file "$WORK/smoke.env" "$ROOT/src/server.ts" </dev/null >"$WORK/server.log" 2>&1
PID=""
for _ in $(seq 1 50); do
  PID="$(pgrep -f "smoke.env.*server.ts" | head -1 || true)"
  curl -sf -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.2
done
[ -n "$PID" ] || { echo "server did not start"; cat "$WORK/server.log"; exit 1; }

BASE="http://127.0.0.1:$PORT"
S="smoke-meeting"
FID="9f3a4b2c-1d2e-4f5a-8b6c-7d8e9f0a1b2c"
check() { [ "$2" = "$3" ] || { echo "FAIL: $1: want $3 got $2"; exit 1; }; echo "ok: $1 ($2)"; }

check health "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health")" 200
check upload "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/sessions/$S/files" -F "metadata={\"fileId\":\"$FID\",\"fileName\":\"doc.pdf\"}" -F "file=@$WORK/doc.pdf;type=application/pdf")" 200
LIST="$(curl -s "$BASE/sessions/$S/files")"
echo "$LIST" | grep -q "$FID" || { echo "FAIL: list missing file"; exit 1; }
echo "ok: list contains file"
URL="$(echo "$LIST" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["presignedUrl"])')"
check download "$(curl -s -o "$WORK/got.pdf" -w '%{http_code}' "http://127.0.0.1:$PORT$(python3 -c "from urllib.parse import urlparse; print(urlparse('$URL').path)")")" 200
cmp "$WORK/doc.pdf" "$WORK/got.pdf" && echo "ok: download bytes identical"
check exe-rejected "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/sessions/$S/files" -F 'metadata={"fileId":"evil","fileName":"evil.exe"}' -F 'file=@/bin/true;type=application/octet-stream;filename=evil.exe')" 415
check delete "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/sessions/$S/files/$FID")" 200
check purge-no-token "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/sessions/$S")" 401
check purge "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/sessions/$S" -H 'x-internal-token: smoke-purge-token')" 200
[ "$(curl -s "$BASE/sessions/$S/files")" = "[]" ] || { echo "FAIL: session not empty after purge"; exit 1; }
echo "ok: session empty after purge"
echo "SMOKE PASS"
