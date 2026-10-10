#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
demo_container="horizonlayer-handoff-$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
cleanup() {
  docker rm -f -v "$demo_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A fresh container, an ephemeral loopback port, and in-memory data keep this
# separate from the user's managed runtime and any DATABASE_URL in their shell.
docker run --detach --rm --name "$demo_container" \
  --publish 127.0.0.1::5432 --tmpfs /var/lib/postgresql/data \
  --env POSTGRES_PASSWORD=handoff-demo --env POSTGRES_DB=handoff \
  postgres:17 >/dev/null
demo_ready=false
for ((attempt = 0; attempt < 60; attempt++)); do
  if docker exec "$demo_container" pg_isready -h 127.0.0.1 -U postgres -d handoff >/dev/null 2>&1; then
    demo_ready=true
    break
  fi
  sleep 1
done
if [[ "$demo_ready" != true ]]; then
  echo 'Timed out waiting for the isolated demo database' >&2
  exit 1
fi
demo_port="$(docker port "$demo_container" 5432/tcp)"
demo_port="${demo_port##*:}"
npm run build:server >&2
HORIZONLAYER_DEMO_DATABASE_URL="postgres://postgres:handoff-demo@127.0.0.1:${demo_port}/handoff" \
  DB_SSL_MODE=disable node dist/testing/sessionHandoff.js
