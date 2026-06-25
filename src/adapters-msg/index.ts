/**
 * Messaging-adapter factory — a `platform` string becomes a live MessagingAdapter.
 * Each platform is one self-contained file behind the same seam; the core never
 * branches on the platform name (see docs/messaging-platforms-roadmap.md).
 */

import type { MessagingAdapter } from '../messaging-adapter.ts'
import { DiscordMessagingAdapter } from './discord.ts'
import { SlackMessagingAdapter } from './slack.ts'
import { TelegramMessagingAdapter } from './telegram.ts'
import { GitHubMessagingAdapter } from './github.ts'
import { NotionMessagingAdapter } from './notion.ts'

export function makeMessagingAdapter(platform: string): MessagingAdapter {
  switch (platform) {
    case 'discord':
      return new DiscordMessagingAdapter()
    case 'slack':
      return new SlackMessagingAdapter()
    case 'telegram':
      return new TelegramMessagingAdapter()
    case 'github':
      return new GitHubMessagingAdapter()
    case 'notion':
      return new NotionMessagingAdapter()
    default:
      throw new Error(
        `knock-knock: unsupported messaging platform "${platform}". ` +
          `Known: discord, slack, telegram, github, notion. Add a MessagingAdapter to support another.`,
      )
  }
}
