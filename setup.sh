#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

NODE_DOWNLOAD_URL="https://nodejs.org/en/download/"
DOCKER_MAC_URL="https://docs.docker.com/desktop/setup/install/mac-install/"
DOCKER_WINDOWS_URL="https://docs.docker.com/desktop/setup/install/windows-install/"
DOCKER_LINUX_URL="https://docs.docker.com/engine/install/"

detect_platform() {
  local uname_s
  uname_s="$(uname -s)"
  case "$uname_s" in
    Darwin)
      echo "macOS"
      ;;
    Linux)
      if grep -qi microsoft /proc/version 2>/dev/null; then
        echo "Windows (WSL)"
      else
        echo "Linux"
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*)
      echo "Windows"
      ;;
    *)
      echo "$uname_s"
      ;;
  esac
}

platform_install_hint() {
  local tool="$1"
  local platform="$2"

  case "$tool" in
    node)
      echo "Install Node.js 22+ from: $NODE_DOWNLOAD_URL"
      ;;
    docker)
      case "$platform" in
        macOS)
          echo "Install Docker Desktop for Mac from: $DOCKER_MAC_URL"
          ;;
        Windows|Windows\ \(WSL\))
          echo "Install Docker Desktop for Windows from: $DOCKER_WINDOWS_URL"
          ;;
        *)
          echo "Install Docker for Linux from: $DOCKER_LINUX_URL"
          ;;
      esac
      ;;
  esac
}

print_failure_help() {
  local platform="$1"
  shift

  echo ""
  echo "Setup could not continue."
  echo "Detected platform: $platform"
  echo ""
  echo "What you need installed:"
  echo "  - Node.js 22 or newer"
  echo "  - npm"
  echo "  - Docker"
  echo ""

  for item in "$@"; do
    echo "$item"
  done
}

echo "=== Horizon Layer local setup ==="
echo "Project dir: $PROJECT_DIR"
PLATFORM="$(detect_platform)"
echo "Detected platform: $PLATFORM"
echo ""

issues=()

if ! command -v node >/dev/null 2>&1; then
  issues+=("Missing required tool: node")
  issues+=("  $(platform_install_hint node "$PLATFORM")")
fi

if ! command -v npm >/dev/null 2>&1; then
  issues+=("Missing required tool: npm")
  issues+=("  npm is included with the standard Node.js installer: $NODE_DOWNLOAD_URL")
fi

if command -v node >/dev/null 2>&1; then
  node_major="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')"
  if [ "$node_major" -lt 22 ]; then
    issues+=("Node.js is too old: found $(node -v), need Node.js 22+")
    issues+=("  Upgrade Node.js from: $NODE_DOWNLOAD_URL")
  else
    echo "Node.js: $(node -v)"
  fi
fi

if command -v npm >/dev/null 2>&1; then
  echo "npm: $(npm -v)"
fi

if ! command -v docker >/dev/null 2>&1; then
  issues+=("Missing required tool: docker")
  issues+=("  $(platform_install_hint docker "$PLATFORM")")
else
  echo "docker: $(docker --version)"
  if ! docker info >/dev/null 2>&1; then
    issues+=("Docker is installed but not running.")
    case "$PLATFORM" in
      macOS|Windows|Windows\ \(WSL\))
        issues+=("  Start Docker Desktop, then rerun ./setup.sh")
        ;;
      *)
        issues+=("  Start your Docker daemon, then rerun ./setup.sh")
        ;;
    esac
  fi
fi

if [ "${#issues[@]}" -gt 0 ]; then
  print_failure_help "$PLATFORM" "${issues[@]}"
  exit 1
fi

echo ""
echo "Installing dependencies..."
make install

echo ""
echo "Building project..."
make build

echo ""
echo "Setup complete."
echo ""
echo "Add to Codex:"
echo "  codex mcp add horizondb -- node $PROJECT_DIR/dist/launcher.js"
echo ""
echo "Add to Claude:"
echo "  claude mcp add -s user horizondb -- node $PROJECT_DIR/dist/launcher.js"
