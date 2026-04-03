#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

DB_NAME="${DB_NAME:-horizon_layer}"
DB_USER="${DB_USER:-postgres}"
DB_PASS="${DB_PASSWORD:-${DB_USER}}"
DB_PORT="${DB_PORT:-}"
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

  docker compose stop db >/dev/null 2>&1 || true

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

echo "Building launcher for stdio smoke test..."
npm run build

echo "Running stdio smoke test ..."
DATABASE_URL="$DATABASE_URL" MCP_COMMAND="node" MCP_ARGS="dist/launcher.js" npm run test:smoke:live
