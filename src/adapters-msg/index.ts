/**
 * Messaging-adapter factory — a `platform` string becomes a live MessagingAdapter.
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
