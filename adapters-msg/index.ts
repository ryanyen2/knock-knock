/**
 * Messaging-adapter factory — the single point where a `platform` string
 * becomes a live MessagingAdapter. The sibling of `adapters/index.ts` (which
 * does the same for agent runtimes). relay.ts and the host stay free of any
 * platform SDK; only the adapters and this factory import one.
 *
 * Adding a platform is one new file in `adapters-msg/` implementing
 * MessagingAdapter plus one line here (see docs/messaging-platforms.md §6).
 */

import type { MessagingAdapter } from '../messaging-adapter.ts'
import { DiscordMessagingAdapter } from './discord.ts'
import { SlackMessagingAdapter } from './slack.ts'
import { TelegramMessagingAdapter } from './telegram.ts'
import { WhatsAppMessagingAdapter } from './whatsapp.ts'
import { iMessageMessagingAdapter } from './imessage.ts'

/** Platforms with a live in-process adapter. Discord is production-tested; the
 *  others are walking skeletons pending live verification with real credentials
 *  (see docs/messaging-platforms.md §7 and each adapter's header). */
export const MESSAGING_PLATFORMS = ['discord', 'slack', 'telegram', 'whatsapp', 'imessage'] as const

/** Per-agent construction options forwarded to platform adapters. Discord and
 *  Telegram ignore it; Slack uses `appToken`, and webhook/db adapters can take
 *  per-agent ports/paths so two same-platform agents don't collide. */
export type MessagingAdapterOpts = {
  /** Slack app-level token (`xapp-…`) for Socket Mode, resolved per-agent. */
  appToken?: string
}

export function makeMessagingAdapter(platform: string, opts?: MessagingAdapterOpts): MessagingAdapter {
  switch (platform) {
    case 'discord':
      return new DiscordMessagingAdapter()
    case 'slack':
      return new SlackMessagingAdapter(opts)
    case 'telegram':
      return new TelegramMessagingAdapter()
    case 'whatsapp':
      return new WhatsAppMessagingAdapter()
    case 'imessage':
      return new iMessageMessagingAdapter()
    default:
      throw new Error(
        `knock-knock: unknown messaging platform "${platform}". ` +
          `Known: ${MESSAGING_PLATFORMS.join(', ')} (see docs/messaging-platforms.md).`,
      )
  }
}
