/**
 * dialect — translate the project's Discord-flavored markdown lingua franca (what
 * `ledger/render/*` and the agents emit) into each platform's own text dialect.
 *
 * The render layer speaks ONE dialect (Discord's: `**bold**`, `*italic*`, `-#`
 * subtext, `# headings`, `[t](url)`, `<@id>` mentions). Discord is the canonical
 * dialect (richest, battle-tested), so the renderers are never touched; instead
 * each adapter translates at its `send`/`edit` boundary — the seam's "adapter
 * absorbs its platform's quirks" philosophy. These functions are pure and unit-
 * tested so an adapter's formatting is verifiable without a live platform.
 *
 * Per-platform "best fit" (see docs/messaging-generalization.md):
 *  - Slack    → mrkdwn (`*bold*`, `_italic_`, `<url|t>`); `-#`/headings stripped.
 *  - Telegram → CLEAN PLAINTEXT (no parse_mode): all markers unwrapped, since
 *               MarkdownV2 escaping is fragile and easy to get subtly wrong.
 *  - GitHub   → GitHub-flavored markdown: keep bold/italic/headings/links/code;
 *               only strip `-#` (no equivalent) and normalize `<@id>` mentions.
 *  - Notion   → structured rich_text NODES (Notion isn't markdown at all): bold/
 *               italic/strike/code annotations + link nodes.
 *
 * `code` and ```fenced``` spans are stashed before any transform and restored last,
 * so none of the rules ever touch their contents.
 */

/** Sentinels that cannot appear in user text: one wraps stashed code spans, the
 *  other marks bold runs so the single-`*` italic pass never confuses the two. */
const STASH = '\u0000'
const BOLD = '\u0001'

// ─── shared primitives ────────────────────────────────────────────────────────

/** Replace code spans (fenced first, then inline) with `N` placeholders.
 *  Returns the placeholdered text plus the verbatim spans for later restore. */
function stashCode(input: string): { text: string; spans: string[] } {
  const spans: string[] = []
  const keep = (m: string): string => {
    const token = `${STASH}${spans.length}${STASH}`
    spans.push(m)
    return token
  }
  let t = input.replace(/```[\s\S]*?```/g, keep)
  t = t.replace(/`[^`\n]+`/g, keep)
  return { text: t, spans }
}

/** Restore stashed spans verbatim (keeps the backticks/fences). */
function restoreVerbatim(text: string, spans: string[]): string {
  return text.replace(new RegExp(`${STASH}(\\d+)${STASH}`, 'g'), (_, i) => spans[Number(i)] ?? '')
}

/** Strip the backtick/fence delimiters from a stashed span, keeping its inner
 *  content — for plaintext dialects where backticks would just be visual noise. */
function codeInner(span: string): string {
  if (span.startsWith('```')) {
    return span.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '')
  }
  return span.replace(/^`+/, '').replace(/`+$/, '')
}

/** Restore stashed spans as their bare inner content (no delimiters). */
function restorePlain(text: string, spans: string[]): string {
  return text.replace(new RegExp(`${STASH}(\\d+)${STASH}`, 'g'), (_, i) =>
    codeInner(spans[Number(i)] ?? ''),
  )
}

/** Per-line map helper. */
function mapLines(text: string, fn: (line: string) => string): string {
  return text.split('\n').map(fn).join('\n')
}

const SUBTEXT_LINE = /^(\s*)-#\s?(.*)$/ // Discord small-text: only meaningful at line start
const HEADING_LINE = /^#{1,6}\s+(.*)$/
const BULLET_LINE = /^(\s*)[-*]\s+(.*)$/

// ─── Slack (mrkdwn) ─────────────────────────────────────────────────────────────

/**
 * Discord markdown → Slack mrkdwn: double-asterisk/underscore bold becomes a
 * single-asterisk bold, single-marker italic becomes underscore italic, strike
 * collapses to one tilde, links become `<url|text>`, headings become bold, `-#`
 * subtext is stripped, bullets become `•`, and bare `@Uxxx` ids become `<@Uxxx>`.
 */
export function toSlackMrkdwn(input: string): string {
  if (!input) return input
  const { text: stashed, spans } = stashCode(input)
  let t = stashed

  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<$2|$1>')
  t = t.replace(/\*\*([^\n]+?)\*\*/g, `${BOLD}$1${BOLD}`)
  t = t.replace(/__([^\n]+?)__/g, `${BOLD}$1${BOLD}`)
  t = t.replace(/~~([^\n]+?)~~/g, '~$1~')
  t = t.replace(/(?<![\w*])\*([^\s*][^*\n]*?)\*(?![\w*])/g, '_$1_')
  t = t.split(BOLD).join('*')

  t = mapLines(t, line => {
    let m = line.match(SUBTEXT_LINE)
    if (m) return `${m[1]}${m[2]}`
    m = line.match(HEADING_LINE)
    if (m) return `*${m[1]!.trim()}*`
    m = line.match(BULLET_LINE)
    if (m) return `${m[1]}• ${m[2]}`
    return line
  })

  t = t.replace(/(?<![<\w])@([UW][A-Z0-9]{6,})\b/g, '<@$1>')
  return restoreVerbatim(t, spans)
}

// ─── Telegram (clean plaintext, no parse_mode) ──────────────────────────────────

/**
 * Discord markdown → clean plaintext for Telegram. Every emphasis marker is
 * unwrapped to its bare text (no `parse_mode`, so leaving `**`/`_` in would just
 * render the markers). Links become `text (url)`; `-#`/headings/bullets normalize;
 * `<@id>` mentions become `@id`. Code keeps only its inner content.
 */
export function toTelegramText(input: string): string {
  if (!input) return input
  const { text: stashed, spans } = stashCode(input)
  let t = stashed

  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
  // Unwrap emphasis: paired markers first, then single, so `**x**` → `x` cleanly.
  t = t.replace(/\*\*([^\n]+?)\*\*/g, '$1')
  t = t.replace(/__([^\n]+?)__/g, '$1')
  t = t.replace(/~~([^\n]+?)~~/g, '$1')
  t = t.replace(/(?<![\w*])\*([^\s*][^*\n]*?)\*(?![\w*])/g, '$1')
  t = t.replace(/(?<![\w_])_([^\s_][^_\n]*?)_(?![\w_])/g, '$1')

  t = mapLines(t, line => {
    let m = line.match(SUBTEXT_LINE)
    if (m) return `${m[1]}${m[2]}`
    m = line.match(HEADING_LINE)
    if (m) return m[1]!.trim()
    m = line.match(BULLET_LINE)
    if (m) return `${m[1]}• ${m[2]}`
    return line
  })

  t = t.replace(/<@([^>\s]+)>/g, '@$1')
  return restorePlain(t, spans)
}

// ─── GitHub (GitHub-flavored markdown) ──────────────────────────────────────────

/**
 * Discord markdown → GitHub-flavored markdown. GFM already renders **bold**,
 * *italic*, headings, [links](url), and `code`, so those pass through untouched.
 * Only the two genuine gaps are translated: `-#` subtext (no equivalent → plain
 * line) and `<@id>` mentions (Discord/Notion angle form → GitHub's `@login`).
 */
export function toGitHubMarkdown(input: string): string {
  if (!input) return input
  const { text: stashed, spans } = stashCode(input)
  let t = stashed

  t = mapLines(t, line => {
    const m = line.match(SUBTEXT_LINE)
    return m ? `${m[1]}${m[2]}` : line
  })
  t = t.replace(/<@([^>\s]+)>/g, '@$1')
  return restoreVerbatim(t, spans)
}

// ─── Notion (structured rich_text nodes) ────────────────────────────────────────

export type NotionRichTextNode = {
  type: 'text'
  text: { content: string; link?: { url: string } }
  annotations?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; code?: boolean }
}

/** Notion caps each rich_text node's content at 2000 chars. */
const NOTION_NODE_MAX = 2000

/** One inline token: code | link | bold | strike | italic. Order matters — paired
 *  markers (**, ~~, __) are tried before single (*, _) so the greedy single-char
 *  pass never splits a bold run. */
const INLINE_TOKEN = new RegExp(
  [
    '(?<code>`[^`\\n]+`)',
    '(?<link>\\[[^\\]]+\\]\\(https?:\\/\\/[^\\s)]+\\))',
    '(?<bold>\\*\\*[^*\\n]+?\\*\\*|__[^_\\n]+?__)',
    '(?<strike>~~[^~\\n]+?~~)',
    '(?<italic>(?<![\\w*])\\*[^\\s*][^*\\n]*?\\*(?![\\w*])|(?<![\\w_])_[^\\s_][^_\\n]*?_(?![\\w_]))',
  ].join('|'),
  'g',
)

/**
 * Discord markdown → Notion rich_text nodes. Notion isn't markdown, so emphasis
 * becomes per-node `annotations` and links become `text.link`. `-#`/headings are
 * normalized at the line level first (heading → a bold run), then the inline
 * tokenizer walks the text emitting plain + annotated nodes. Long plain runs are
 * split to Notion's 2000-char/node ceiling. Falls back to a single plain node on
 * anything it can't classify, so it never throws.
 */
export function toNotionRichText(input: string): NotionRichTextNode[] {
  if (!input) return [{ type: 'text', text: { content: '' } }]

  // Line level: strip `-#`, turn headings into a bold run (so the inline pass bolds it).
  const normalized = mapLines(input, line => {
    let m = line.match(SUBTEXT_LINE)
    if (m) return `${m[1]}${m[2]}`
    m = line.match(HEADING_LINE)
    if (m) return `**${m[1]!.trim()}**`
    return line
  }).replace(/<@([^>\s]+)>/g, '@$1')

  const nodes: NotionRichTextNode[] = []
  const pushText = (content: string, ann?: NotionRichTextNode['annotations']): void => {
    if (!content) return
    for (let i = 0; i < content.length; i += NOTION_NODE_MAX) {
      const slice = content.slice(i, i + NOTION_NODE_MAX)
      nodes.push(ann ? { type: 'text', text: { content: slice }, annotations: ann } : { type: 'text', text: { content: slice } })
    }
  }

  let last = 0
  for (const match of normalized.matchAll(INLINE_TOKEN)) {
    const idx = match.index ?? 0
    if (idx > last) pushText(normalized.slice(last, idx))
    const g = match.groups ?? {}
    if (g.code) {
      pushText(g.code.replace(/^`/, '').replace(/`$/, ''), { code: true })
    } else if (g.link) {
      const lm = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(g.link)
      if (lm) nodes.push({ type: 'text', text: { content: lm[1]!, link: { url: lm[2]! } } })
    } else if (g.bold) {
      pushText(g.bold.replace(/^(\*\*|__)/, '').replace(/(\*\*|__)$/, ''), { bold: true })
    } else if (g.strike) {
      pushText(g.strike.replace(/^~~/, '').replace(/~~$/, ''), { strikethrough: true })
    } else if (g.italic) {
      pushText(g.italic.replace(/^[*_]/, '').replace(/[*_]$/, ''), { italic: true })
    }
    last = idx + match[0].length
  }
  if (last < normalized.length) pushText(normalized.slice(last))

  return nodes.length > 0 ? nodes : [{ type: 'text', text: { content: '' } }]
}
