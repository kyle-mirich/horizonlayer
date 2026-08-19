#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$(mktemp -d /tmp/horizonlayer-recovery-smoke.XXXXXX)"
PACK_DIR="$WORKSPACE/packed"
RUNTIME_DIR="$WORKSPACE/runtime"
mkdir -p "$PACK_DIR"

cleanup() {
  local exit_code=$?
  local cleanup_failed=0
  if [[ -f "$RUNTIME_DIR/runtime.json" && -f "$PACK_DIR/package/dist/launcher.js" ]]; then
    local compose_project
    compose_project="$(node -e 'const value=require(process.argv[1]); process.stdout.write(value.compose_project)' "$RUNTIME_DIR/runtime.json")" || cleanup_failed=1
    if ! HORIZONLAYER_HOME="$RUNTIME_DIR" \
      node "$PACK_DIR/package/dist/launcher.js" reset --yes >/dev/null 2>&1; then
      if [[ "$compose_project" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
        docker compose -f "$PACK_DIR/package/docker-compose.yml" -p "$compose_project" \
          down -v --remove-orphans >/dev/null 2>&1 || cleanup_failed=1

        local leaked_containers=()
        while IFS= read -r id; do
          [[ -n "$id" ]] && leaked_containers+=("$id")
        done < <(docker ps -aq --filter "label=com.docker.compose.project=$compose_project")
        if (( ${#leaked_containers[@]} > 0 )); then
          docker rm --force "${leaked_containers[@]}" >/dev/null 2>&1 || cleanup_failed=1
        fi

        local leaked_volumes=()
        while IFS= read -r name; do
          [[ -n "$name" ]] && leaked_volumes+=("$name")
        done < <(docker volume ls -q --filter "label=com.docker.compose.project=$compose_project")
        if (( ${#leaked_volumes[@]} > 0 )); then
          docker volume rm "${leaked_volumes[@]}" >/dev/null 2>&1 || cleanup_failed=1
        fi

        local leaked_networks=()
        while IFS= read -r id; do
          [[ -n "$id" ]] && leaked_networks+=("$id")
        done < <(docker network ls -q --filter "label=com.docker.compose.project=$compose_project")
        if (( ${#leaked_networks[@]} > 0 )); then
          docker network rm "${leaked_networks[@]}" >/dev/null 2>&1 || cleanup_failed=1
        fi
      else
        cleanup_failed=1
      fi
    fi
  fi
  find "$WORKSPACE" -depth -delete 2>/dev/null || true
  if (( exit_code == 0 && cleanup_failed != 0 )); then
    echo "Recovery smoke cleanup could not remove every isolated Docker resource" >&2
    exit 1
  fi
  exit "$exit_code"
}
trap cleanup EXIT

cd "$PROJECT_DIR"
echo "Packing the public CLI for recovery smoke..."
PACKAGE_TARBALL="$(npm pack --pack-destination "$WORKSPACE" --silent | tail -n 1)"
tar -xzf "$WORKSPACE/$PACKAGE_TARBALL" -C "$PACK_DIR"
ln -s "$PROJECT_DIR/node_modules" "$PACK_DIR/package/node_modules"

echo "Running isolated packed-CLI Backup and Runtime Recovery smoke..."
HORIZONLAYER_HOME="$RUNTIME_DIR" \
PACKED_LAUNCHER="$PACK_DIR/package/dist/launcher.js" \
RECOVERY_SMOKE_WORKSPACE="$WORKSPACE" \
  npx tsx src/testing/recoverySmoke.ts
