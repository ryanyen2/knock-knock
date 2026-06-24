/**
 * Messaging-adapter factory — the single point where a `platform` string
 * becomes a live MessagingAdapter. The sibling of `adapters/index.ts` (which
 * does the same for agent runtimes). relay.ts and the host stay free of any
 * platform SDK; only the adapter and this factory import one.
 *
 * Discord is the live surface. Adding a platform is one new file in
 * `adapters-msg/` implementing MessagingAdapter plus one branch here.
 */

import type { MessagingAdapter } from '../messaging-adapter.ts'
import { DiscordMessagingAdapter } from './discord.ts'

export function makeMessagingAdapter(platform: string): MessagingAdapter {
  switch (platform) {
    case 'discord':
      return new DiscordMessagingAdapter()
    default:
      throw new Error(
        `knock-knock: unsupported messaging platform "${platform}". ` +
          `Discord is the only live platform; add a MessagingAdapter to support another.`,
      )
  }
}
