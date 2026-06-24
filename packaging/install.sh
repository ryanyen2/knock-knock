#!/usr/bin/env bash
#
# knock-knock installer — detect OS/arch, download the matching prebuilt binary
# from the latest (or a pinned) GitHub Release, verify its sha256, and install it
# to a bin dir on PATH. The binary embeds the Bun runtime, so there is nothing
# else to install.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ryanyen2/knock-knock/main/packaging/install.sh | bash
#   KK_VERSION=v0.2.0 ./install.sh        # pin a version (default: latest release)
#   KK_BIN_DIR=~/.local/bin ./install.sh  # override install dir

set -euo pipefail

REPO="ryanyen2/knock-knock"
BIN_DIR="${KK_BIN_DIR:-/usr/local/bin}"

err() { echo "knock-knock install: $*" >&2; exit 1; }

# ── Detect target ────────────────────────────────────────────────────────────
os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) err "unsupported OS '$os' (macOS and Linux only)." ;;
esac
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=x64 ;;
  *) err "unsupported architecture '$arch'." ;;
esac
asset="knock-knock-$os-$arch"

# ── Resolve version ──────────────────────────────────────────────────────────
version="${KK_VERSION:-}"
if [ -z "$version" ]; then
  version="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep '"tag_name"' | head -1 | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
  [ -n "$version" ] || err "could not resolve the latest release tag."
fi
base="https://github.com/$REPO/releases/download/$version"

# ── Download + verify ────────────────────────────────────────────────────────
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
echo "Downloading $asset ($version)…"
curl -fsSL "$base/$asset" -o "$tmp/knock-knock" || err "download failed for $asset."

if curl -fsSL "$base/$asset.sha256" -o "$tmp/sum" 2>/dev/null; then
  echo "Verifying checksum…"
  expected="$(awk '{print $1}' "$tmp/sum")"
  actual="$( (command -v sha256sum >/dev/null && sha256sum "$tmp/knock-knock" || shasum -a 256 "$tmp/knock-knock") | awk '{print $1}')"
  [ "$expected" = "$actual" ] || err "checksum mismatch (expected $expected, got $actual)."
fi

chmod +x "$tmp/knock-knock"

# ── Install ──────────────────────────────────────────────────────────────────
if [ -w "$BIN_DIR" ] || mkdir -p "$BIN_DIR" 2>/dev/null && [ -w "$BIN_DIR" ]; then
  mv "$tmp/knock-knock" "$BIN_DIR/knock-knock"
else
  echo "Need elevated permission to write $BIN_DIR…"
  sudo mv "$tmp/knock-knock" "$BIN_DIR/knock-knock"
fi

echo "Installed knock-knock $version → $BIN_DIR/knock-knock"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Note: $BIN_DIR is not on your PATH — add it to use 'knock-knock' directly." ;;
esac
echo "Next: run 'knock-knock setup'."
