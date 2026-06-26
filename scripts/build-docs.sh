#!/usr/bin/env bash
# Build docs/*.md into website/docs/ as a static Quartz site.
#
# Quartz (v5) targets Node 22 and pulls a fair amount of tooling, so it lives in a
# git-ignored build dir (.docs-build) that this script clones on first run. The
# generated HTML under website/docs/ IS committed, so the published marketing site
# stays self-contained and offline-first — you only need to re-run this when the
# docs change. Config lives in docs-site/quartz.config.yaml.
#
# Usage:  ./scripts/build-docs.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/.docs-build"
CONFIG="$ROOT/docs-site/quartz.config.yaml"
QUARTZ_REPO="https://github.com/jackyzha0/quartz"

# Quartz needs Node 22 — pick it up via nvm if available (system default may be newer).
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || nvm install 22
fi

if [ ! -d "$BUILD/quartz" ]; then
  echo "→ cloning Quartz into $BUILD (first run only)"
  rm -rf "$BUILD"
  git clone --depth 1 "$QUARTZ_REPO" "$BUILD"
  (cd "$BUILD" && npm install)
fi

cp "$CONFIG" "$BUILD/quartz.config.yaml"
cd "$BUILD"
npx quartz plugin install --from-config
npx quartz build -d "$ROOT/docs" -o "$ROOT/website/docs"

# Post-process: Quartz emits flat <slug>.html files but links between them are
# extensionless (./foo), which only resolves on clean-URL hosts. Append .html so the
# docs work on ANY static server (incl. python -m http.server and GitHub Pages). Also
# drop CNAME — we publish under a /docs/ subpath, not at a domain root.
cd "$ROOT/website/docs"
rm -f CNAME
slugs=$(for f in *.html; do [ "$f" = "404.html" ] && continue; echo "${f%.html}"; done)
while IFS= read -r f; do
  for s in $slugs; do
    perl -0pi -e "s{href=\"(\\./)?${s}(#[^\"]*)?\"}{href=\"\${1}${s}.html\${2}\"}g" "$f"
  done
done < <(find . -name '*.html')

echo "✓ docs built into website/docs ($(ls -1 *.html | wc -l | tr -d ' ') pages)"
