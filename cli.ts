#!/usr/bin/env bun
/**
 * knock-knock — the single CLI entry point. A thin dispatcher over the two
 * existing entry scripts; it imports neither agent SDK nor a platform SDK.
 *
 *   knock-knock setup                  interactive setup wizard / menu
 *   knock-knock relay [key…] [--pick]  start the relay (all agents, or a subset)
 *   knock-knock                        no config yet → setup; otherwise → relay
 *   knock-knock --version | --help
 *
 * `relay`/`setup` are dynamically imported (Bun bundles static-string dynamic
 * imports into the compiled binary), and their top-level body runs on import.
 * The subcommand token is spliced out of process.argv first, so `relay`'s own
 * `process.argv.slice(2)` parsing (positional keys, `--pick`) sees a clean argv.
 * process.argv keeps a placeholder at index 1 in both `bun run` and a compiled
 * `--compile` binary, so `slice(2)` is the user args in either mode.
 */

import { existsSync } from 'fs'
import pkg from './package.json'
import { ACCESS_FILE } from './state.ts'

const USAGE = `knock-knock ${pkg.version} — your agents, their agents, one channel

Usage:
  knock-knock setup                  Configure bots, channels, roster, tokens, ledger
  knock-knock relay [key…] [--pick]  Start the relay (default: every configured bot)
  knock-knock                        Setup if nothing is configured yet, else relay
  knock-knock --version              Print the version
  knock-knock --help                 Print this help

Docs: https://github.com/ryanyen2/knock-knock`

async function dispatch(): Promise<void> {
  const cmd = process.argv[2]

  switch (cmd) {
    case '--version':
    case '-v':
      console.log(pkg.version)
      return
    case '--help':
    case '-h':
      console.log(USAGE)
      return
    case 'setup':
      process.argv.splice(2, 1) // drop "setup"
      await import('./setup.ts')
      return
    case 'relay':
      process.argv.splice(2, 1) // drop "relay"; relay parses the rest itself
      await import('./relay.ts')
      return
  }

  // No subcommand (or a bare flag like `--pick`): default to the relay when a
  // config exists, otherwise drop the user into setup. An unknown subcommand is
  // an error rather than a silent guess.
  if (!cmd || cmd.startsWith('-')) {
    await import(existsSync(ACCESS_FILE) ? './relay.ts' : './setup.ts')
    return
  }
  process.stderr.write(`knock-knock: unknown command "${cmd}".\n\n${USAGE}\n`)
  process.exit(1)
}

await dispatch()
