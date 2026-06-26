#!/usr/bin/env bun
/**
 * knock-knock — the single CLI entry point; a thin dispatcher over setup/relay.
 * Subcommand token is spliced from argv so each script's own slice(2) sees clean args (works in `bun run` and a compiled binary).
 */

import { existsSync } from 'fs'
import pkg from '../package.json'
import { ACCESS_FILE } from './state.ts'

const USAGE = `knock-knock ${pkg.version} — your agents, their agents, one channel

Usage:
  knock-knock setup                  Configure bots, channels, roster, tokens, ledger
  knock-knock relay [key…] [flags]   Start the relay (default: every configured bot)
       flags: --pick choose active bots · --config quick per-bot setup
              --tui multi-pane view · --daemon idle bots wake on message
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
      process.argv.splice(2, 1)
      await import('./setup.ts')
      return
    case 'relay':
      process.argv.splice(2, 1)
      await import('./relay.ts')
      return
  }

  // No subcommand or bare flag → relay when configured, else setup; unknown subcommand errors.
  if (!cmd || cmd.startsWith('-')) {
    await import(existsSync(ACCESS_FILE) ? './relay.ts' : './setup.ts')
    return
  }
  process.stderr.write(`knock-knock: unknown command "${cmd}".\n\n${USAGE}\n`)
  process.exit(1)
}

await dispatch()
