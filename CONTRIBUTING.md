# Contributing & releasing

Notes for working on knock-knock and for cutting a release. The deep
architecture lives in [`CLAUDE.md`](CLAUDE.md) and [`docs/`](docs/); this file is
about the *mechanics* — dev loop, and how a tag becomes a published release +
Homebrew formula.

## Dev loop

```bash
bun install            # deps (Bun ≥ 1.1)
bun test               # all tests under tests/
bun run typecheck      # tsc --noEmit
bun src/cli.ts setup   # interactive setup wizard
bun src/cli.ts relay   # start the relay
```

Run a single test file or pattern:

```bash
bun test tests/ledger/render/surface.test.ts
bun test --test-name-pattern "conflict"
```

Source lives under `src/`; pure decision logic is in `src/lib.ts` (no I/O) and is
the easiest place to add unit-tested behavior.

---

## Releasing

A release is **fully automated from a git tag.** You do two things: bump the
version and push a tag. GitHub Actions does the rest.

### What ships

[`.github/workflows/release.yml`](.github/workflows/release.yml) runs on a
`v*` tag push (or manual `workflow_dispatch` with a `version` input) and produces:

- **4 prebuilt binaries** (`darwin-arm64`, `darwin-x64`, `linux-x64`,
  `linux-arm64`) — each embeds the Bun runtime, so end users install nothing else.
  Built by [`scripts/build.sh`](scripts/build.sh).
- **`.deb` packages** (amd64 + arm64) via [`packaging/nfpm.yaml`](packaging/nfpm.yaml).
- **A GitHub Release** with all of the above + `SHA256SUMS.txt` + the rendered
  Homebrew formula.
- **An npm publish** — *only if* the `NPM_TOKEN` secret is set.
- **A Homebrew formula push** to the tap — *only if* the `HOMEBREW_TAP_TOKEN`
  secret is set.

### Cutting a release

```bash
# 1. Bump the version in package.json so it MATCHES the tag you're about to push.
#    (binaries/.deb use the tag; npm publish uses package.json — keep them equal.)
#    e.g. edit "version": "0.1.2"

git add package.json
git commit -m "release: v0.1.2"
git push

# 2. Tag and push. The "v" prefix is required (the workflow triggers on v*).
git tag v0.1.2
git push origin v0.1.2
```

That's it — watch the run under the repo's **Actions** tab.

### ⚠️ Gotchas learned the hard way

1. **`package.json` version must equal the tag.** The tag drives the binaries and
   `.deb`; `package.json` drives the npm publish. If they disagree, brew/.deb say
   one version and npm says another.

2. **A tag can't be re-released.** `gh release create` fails with *"a release with
   the same tag name already exists"* if you re-run a tag that already has a
   release. To retry a **failed** release, either:
   - delete the release **and** the tag, then re-push the tag; or
   - bump to the next version (cleanest) — e.g. `v0.1.2` → `v0.1.3`.

   Moving a tag: `git tag -f vX.Y.Z && git push -f origin vX.Y.Z` (only safe if no
   successful release exists for it yet).

3. **The workflow runs the code *at the tagged commit*.** A fix on `main` does
   nothing for an existing tag — you must re-tag (or new tag) so the tagged commit
   includes the fix.

4. **nfpm needs `expand: true`.** In `packaging/nfpm.yaml`, the `contents[].src:
   ${BIN}` entry **must** keep `expand: true` — nfpm only substitutes env vars in
   a `contents` entry when it opts in (top-level `arch`/`version` expand
   unconditionally; `contents` do not). Without it the `.deb` step dies with
   `glob failed: ${BIN}: no matching files`.

---

## Homebrew tap

Users install with:

```bash
brew install ryanyen2/tap/knock-knock
```

Homebrew expands `ryanyen2/tap/knock-knock` → the GitHub repo
**`ryanyen2/homebrew-tap`**, formula `Formula/knock-knock.rb`. (The `homebrew-`
prefix on the repo is the convention; you write just `tap` in the install
command.)

### Source of truth vs. the published formula

- [`packaging/knock-knock.rb`](packaging/knock-knock.rb) is the **template** in
  this repo, with `REPLACE_*_SHA256` placeholders and a `version` line.
- On each release, the workflow `sed`s in the real `version` + four sha256s from
  `SHA256SUMS.txt`, attaches the result to the GitHub Release, **and** pushes it
  to `ryanyen2/homebrew-tap/Formula/knock-knock.rb`.

So editing the formula's structure (description, install block) is done **here**
in `packaging/knock-knock.rb`; the tap copy is regenerated every release. Don't
hand-edit the tap.

### One-time setup (already done, documented for memory)

1. **Create the tap repo** `ryanyen2/homebrew-tap` (public). It can start empty —
   the first release pushes `Formula/knock-knock.rb` into it.
2. **Create a Personal Access Token** (Fine-grained): repository access limited to
   `homebrew-tap`, permission **Contents: Read and write**.
3. **Add it as a secret** on the `knock-knock` repo named **`HOMEBREW_TAP_TOKEN`**
   (Settings → Secrets and variables → Actions). Without it, the
   `if: ${{ env.TAP_TOKEN != '' }}` guard silently **skips** the tap push.

The default `GITHUB_TOKEN` can't write to a *different* repo, which is why the PAT
is required.

### Verifying a release

After a tagged run goes green:

1. The [Releases page](https://github.com/ryanyen2/knock-knock/releases) shows the
   new tag with binaries, `.deb`s, `SHA256SUMS.txt`, and `knock-knock.rb`.
2. `ryanyen2/homebrew-tap` → `Formula/knock-knock.rb` has the new `version` and
   real sha256s (not `REPLACE_*`).
3. Locally:
   ```bash
   brew update && brew upgrade knock-knock   # or: brew install ryanyen2/tap/knock-knock
   knock-knock --version
   ```
   If a stale/empty tap is cached locally (e.g. from before it was seeded),
   clear it first: `brew untap ryanyen2/tap`.
