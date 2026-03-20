#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

APP_BASE_URL="${APP_BASE_URL:-http://127.0.0.1:3000}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-3000}"
MCP_URL="${MCP_URL:-${APP_BASE_URL%/}/mcp}"
SERVER_LOG="${SERVER_LOG:-/tmp/horizon-layer-smoke.log}"
DB_NAME="${DB_NAME:-horizon_layer}"
DB_USER="${DB_USER:-postgres}"
DB_PASS="${DB_PASSWORD:-${DB_USER}}"
DB_PORT="${DB_PORT:-}"

server_pid=""
selected_db_port=""

select_db_port() {
  if [[ -n "$DB_PORT" ]]; then
    echo "$DB_PORT"
    return
  fi

  node <<'EOF'
const net = require('node:net');

const candidates = [5432, 55432, 55433, 55434, 55435];

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

(async () => {
  for (const port of candidates) {
    if (await canListen(port)) {
      process.stdout.write(String(port));
      return;
    }
  }

  process.stderr.write('No available local Postgres port found for smoke-local\n');
  process.exit(1);
})();
EOF
}

cleanup() {
  local exit_code=$?

  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi

  docker compose stop db >/dev/null 2>&1 || true

  if [[ $exit_code -ne 0 && -f "$SERVER_LOG" ]]; then
    echo ""
    echo "Server log ($SERVER_LOG):"
    tail -n 200 "$SERVER_LOG" || true
  fi

  exit "$exit_code"
}

trap cleanup EXIT

wait_for_db() {
  local deadline=$((SECONDS + 60))

  while (( SECONDS < deadline )); do
    if DB_PORT="$selected_db_port" DB_NAME="$DB_NAME" DB_USER="$DB_USER" DB_PASSWORD="$DB_PASS" \
      docker compose exec -T db pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
      return
    fi

    sleep 1
  done

  echo "Timed out waiting for Postgres to accept connections on 127.0.0.1:${selected_db_port}" >&2
  exit 1
}

selected_db_port="$(select_db_port)"
DATABASE_URL="${DATABASE_URL:-postgres://${DB_USER}:${DB_PASS}@localhost:${selected_db_port}/${DB_NAME}}"

echo "Starting local Postgres on 127.0.0.1:${selected_db_port}..."
DB_PORT="$selected_db_port" DB_NAME="$DB_NAME" DB_USER="$DB_USER" DB_PASSWORD="$DB_PASS" docker compose up -d db
wait_for_db

echo "Starting Horizon Layer dev server..."
DATABASE_URL="$DATABASE_URL" \
APP_NAME="Horizon Layer" \
APP_BASE_URL="$APP_BASE_URL" \
HOST="$HOST" \
PORT="$PORT" \
npm run dev:http >"$SERVER_LOG" 2>&1 &
server_pid=$!

echo "Waiting for $APP_BASE_URL/healthz ..."
node - "$APP_BASE_URL/healthz" <<'EOF'
const healthUrl = process.argv[2];
const deadline = Date.now() + 60_000;

async function waitForHealth() {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until the timeout expires.
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for ${healthUrl}`);
}

waitForHealth().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
EOF

echo "Running live smoke test against $MCP_URL ..."
MCP_URL="$MCP_URL" npm run test:smoke:live
