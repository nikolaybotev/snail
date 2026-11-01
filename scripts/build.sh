#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -n "${VERSION:-}" ]]; then
  ver="$VERSION"
else
  if ! ver="$(git describe --tags --dirty 2>/dev/null)"; then
    echo "scripts/build.sh: cannot determine version (set VERSION or tag the repo)" >&2
    exit 1
  fi
fi

if ! sha="$(git rev-parse HEAD 2>/dev/null)"; then
  echo "scripts/build.sh: git rev-parse HEAD failed" >&2
  exit 1
fi

ts="$(date -u +%Y-%m-%dT%H:%MZ)"

mkdir -p dist
staging="$(mktemp -d)"
top="snail-${ver}"
trap 'rm -rf "$staging"' EXIT

mkdir -p "$staging/$top"

cat >"$staging/$top/build-stamp.json" <<JSON
{
  "version": "${ver}",
  "commitSHA": "${sha}",
  "buildTimestamp": "${ts}"
}
JSON

cp package.json package-lock.json README.md LICENSE snail.js snail.example.toml "$staging/$top/"

tar czf "dist/snail-${ver}.tar.gz" -C "$staging" "$top"

(
  cd dist
  sha256sum "snail-${ver}.tar.gz" > SHA256SUMS
)

echo "wrote dist/snail-${ver}.tar.gz and dist/SHA256SUMS"
