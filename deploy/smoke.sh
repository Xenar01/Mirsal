#!/usr/bin/env bash
# Mirsal end-to-end smoke test — exercises the full share lifecycle against a
# RUNNING instance over HTTP. It CHANGES the admin password, so point it at a
# THROWAWAY instance (a fresh image + temp data dir on a temp port), never the
# production container.
#
# Usage: deploy/smoke.sh [BASE_URL] [ADMIN_CRED_FILE]
#   BASE_URL         default http://127.0.0.1:18084
#   ADMIN_CRED_FILE  default ./data-smoke/db/admin-credential.txt
#
# Flow: health -> login -> change pw -> create folder -> upload -> share file ->
#       public meta+download -> share folder -> public list+zip -> stop -> 410 ->
#       unknown token -> 404.
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:18084}"
CRED_FILE="${2:-./data-smoke/db/admin-credential.txt}"
JAR="$(mktemp)"
WORK="$(mktemp -d)"
trap 'rm -rf "$JAR" "$WORK"' EXIT

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }

# curl helper: writes body to $WORK/body, echoes the HTTP status code.
req() { curl -sS -o "$WORK/body" -w '%{http_code}' "$@"; }
csrf() { awk '/mirsal_csrf/ {print $7}' "$JAR" | tail -1; }
# JSON field readers from $WORK/body (grep -m1 avoids SIGPIPE under pipefail).
jnum() { grep -oam1 "\"$1\":[0-9]*" "$WORK/body" | sed 's/.*://'; }
jstr() { grep -oam1 "\"$1\":\"[^\"]*\"" "$WORK/body" | sed 's/.*:"//;s/"$//'; }

echo "== Mirsal smoke @ $BASE_URL =="

# 0. Health (wait up to ~20s for first boot)
for i in $(seq 1 40); do curl -sf -o /dev/null "$BASE_URL/api/health" && break; sleep 0.5; done
[ "$(req "$BASE_URL/api/health")" = 200 ] && pass "health 200" || fail "health not 200"

# 1. Read seeded admin creds
[ -f "$CRED_FILE" ] || fail "admin credential file not found: $CRED_FILE"
ADMIN_PW="$(awk -F': ' '/password/ {print $2}' "$CRED_FILE" | tr -d '\r')"
[ -n "$ADMIN_PW" ] || fail "could not read admin password"
pass "read admin credential"

# 2. Login
code=$(req -c "$JAR" -H 'content-type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PW\"}" "$BASE_URL/api/auth/login")
[ "$code" = 200 ] || fail "login ($code)"
ROOT_ID=$(jnum rootNodeId)
[ -n "$ROOT_ID" ] && pass "login 200, rootNodeId=$ROOT_ID" || fail "login gave no rootNodeId"

# 3. Change password (forced must_change_password) then re-login with the new one
NEWPW="Smoke-$(head -c6 /dev/urandom | od -An -tx1 | tr -d ' \n')A1!"
code=$(req -b "$JAR" -c "$JAR" -H 'content-type: application/json' -H "x-csrf-token: $(csrf)" \
  -d "{\"current\":\"$ADMIN_PW\",\"new\":\"$NEWPW\"}" "$BASE_URL/api/auth/password")
[ "$code" = 200 ] || fail "change password ($code): $(cat "$WORK/body")"
pass "password changed"
: > "$JAR"
code=$(req -c "$JAR" -H 'content-type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$NEWPW\"}" "$BASE_URL/api/auth/login")
[ "$code" = 200 ] || fail "re-login with new pw ($code)"
pass "re-login with new password"

# 4. Create a folder at root
code=$(req -b "$JAR" -c "$JAR" -H 'content-type: application/json' -H "x-csrf-token: $(csrf)" \
  -d "{\"name\":\"smoke-folder\"}" "$BASE_URL/api/nodes/folder")
[ "$code" = 200 ] || [ "$code" = 201 ] || fail "create folder ($code): $(cat "$WORK/body")"
FOLDER_ID=$(jnum id)
[ -n "$FOLDER_ID" ] && pass "folder created id=$FOLDER_ID" || fail "no folder id"

# 5. Upload a file into the folder (parent_id via query — busboy stream order)
echo "hello mirsal $(date -u)" > "$WORK/greeting.txt"
code=$(req -b "$JAR" -c "$JAR" -H "x-csrf-token: $(csrf)" \
  -F "file=@$WORK/greeting.txt" "$BASE_URL/api/nodes/upload?parent_id=$FOLDER_ID")
[ "$code" = 200 ] || [ "$code" = 201 ] || fail "upload ($code): $(cat "$WORK/body")"
FILE_ID=$(jnum id)
[ -n "$FILE_ID" ] && pass "file uploaded id=$FILE_ID" || fail "no file id"

# 6. Share the FILE, fetch public metadata + download
code=$(req -b "$JAR" -c "$JAR" -H 'content-type: application/json' -H "x-csrf-token: $(csrf)" \
  -d "{\"node_id\":$FILE_ID}" "$BASE_URL/api/shares")
[ "$code" = 200 ] || [ "$code" = 201 ] || fail "share file ($code): $(cat "$WORK/body")"
FTOKEN=$(jstr token)
[ -n "$FTOKEN" ] && pass "file shared token=${FTOKEN:0:8}…" || fail "no file token"
[ "$(req "$BASE_URL/api/public/$FTOKEN")" = 200 ] && pass "public file meta 200" || fail "public file meta"
code=$(req "$BASE_URL/api/public/$FTOKEN/download")
[ "$code" = 200 ] && grep -q "hello mirsal" "$WORK/body" && pass "public download bytes match" || fail "public download ($code)"

# 7. Share the FOLDER, list + zip
code=$(req -b "$JAR" -c "$JAR" -H 'content-type: application/json' -H "x-csrf-token: $(csrf)" \
  -d "{\"node_id\":$FOLDER_ID}" "$BASE_URL/api/shares")
[ "$code" = 200 ] || [ "$code" = 201 ] || fail "share folder ($code): $(cat "$WORK/body")"
DTOKEN=$(jstr token)
SHARE_ID=$(jnum id)
[ -n "$DTOKEN" ] && pass "folder shared token=${DTOKEN:0:8}…" || fail "no folder token"
[ -n "$SHARE_ID" ] && pass "folder share id=$SHARE_ID" || fail "no folder share id (body: $(cat "$WORK/body"))"
[ "$(req "$BASE_URL/api/public/$DTOKEN/list")" = 200 ] && pass "public folder list 200" || fail "public list"
code=$(curl -sS -o "$WORK/z.zip" -w '%{http_code}' "$BASE_URL/api/public/$DTOKEN/zip")
[ "$code" = 200 ] && [ -s "$WORK/z.zip" ] && pass "public zip downloaded ($(wc -c <"$WORK/z.zip") bytes)" || fail "public zip ($code)"

# 8. Stop the folder share -> public access now 410
code=$(req -X PATCH -b "$JAR" -c "$JAR" -H 'content-type: application/json' -H "x-csrf-token: $(csrf)" \
  -d '{"is_active":false}' "$BASE_URL/api/shares/$SHARE_ID")
[ "$code" = 200 ] || fail "stop share ($code): $(cat "$WORK/body")"
pass "share stopped"
[ "$(req "$BASE_URL/api/public/$DTOKEN")" = 410 ] && pass "stopped share -> 410" || fail "stopped share not 410"

# 9. Unknown token -> 404
[ "$(req "$BASE_URL/api/public/nonexistenttoken123")" = 404 ] && pass "unknown token -> 404" || fail "unknown token not 404"

echo ""
echo -e "\033[32m== ALL SMOKE CHECKS PASSED ==\033[0m"
