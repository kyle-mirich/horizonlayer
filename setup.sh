#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

echo "=== Horizon Layer local setup ==="
echo "Project dir: $PROJECT_DIR"
echo ""

make install
make build

echo ""
echo "Setup complete."
echo ""
echo "Add to Codex:"
echo "  codex mcp add horizondb -- node $PROJECT_DIR/dist/launcher.js"
echo ""
echo "Add to Claude:"
echo "  claude mcp add -s user horizondb -- node $PROJECT_DIR/dist/launcher.js"
