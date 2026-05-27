import type { AgentAdapter } from '../agent-adapter.ts'
import { ClaudeSdkAdapter } from './claude-sdk.ts'
import { OpenCodeAdapter } from './opencode.ts'

export function makeAdapter(name: string, opts: { workspace: string }): AgentAdapter {
  switch (name) {
    case 'opencode':
      return new OpenCodeAdapter(opts.workspace)
    case 'claude-sdk':
    default:
      return new ClaudeSdkAdapter(opts.workspace)
  }
}
