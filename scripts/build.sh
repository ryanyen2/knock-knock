#!/usr/bin/env bash
#
# Build standalone knock-knock binaries for every supported target.
#
# Each binary embeds the Bun runtime (`bun build --compile`), so end users need
# nothing installed. `bun:sqlite` and `Bun.spawn` are part of that embedded
# runtime; pg / discord.js / the agent SDKs are plain JS and bundle in. The CLI's
# dynamic `import('./relay.ts' | './setup.ts')` uses static string literals, so
# Bun includes both in the bundle.
#
# Usage:  bash scripts/build.sh [version]
#   version defaults to the "version" field in package.json.
#
# Output: dist/knock-knock-<os>-<arch>[.exe] plus a matching .sha256 each, and a
#         combined SHA256SUMS.txt — the artifacts a GitHub Release attaches and
#         the Homebrew formula / install.sh download.

set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-$(bun -e 'console.log(require("./package.json").version)')}"
OUT="dist"
ENTRY="cli.ts"

# target triple  →  output suffix
TARGETS=(
  "bun-darwin-arm64:darwin-arm64"
  "bun-darwin-x64:darwin-x64"
  "bun-linux-x64:linux-x64"
  "bun-linux-arm64:linux-arm64"
)

rm -rf "$OUT"
mkdir -p "$OUT"

shasum_cmd() { command -v sha256sum >/dev/null 2>&1 && sha256sum "$@" || shasum -a 256 "$@"; }

echo "Building knock-knock v$VERSION"
for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  suffix="${entry##*:}"
  outfile="$OUT/knock-knock-$suffix"
  echo "  → $target"
  bun build --compile --minify --sourcemap=none \
    --target="$target" \
    "$ENTRY" --outfile "$outfile"
  ( cd "$OUT" && shasum_cmd "knock-knock-$suffix" > "knock-knock-$suffix.sha256" )
done

# Drop any non-artifact files the bundler may leave behind (stray .map/.js).
find "$OUT" -maxdepth 1 -type f ! -name 'knock-knock-*' ! -name 'SHA256SUMS.txt' -delete
( cd "$OUT" && shasum_cmd knock-knock-* | grep -v '\.sha256$' > SHA256SUMS.txt )
echo "Done. Artifacts in $OUT/:"
ls -1 "$OUT"
