/**
 * toSlackMrkdwn — translate the project's Discord-flavored markdown lingua franca
 * (what `ledger/render/*` and the agents emit) into Slack mrkdwn. Pure + unit-
 * tested; the Slack adapter applies it to every outbound text so the render layer
 * stays platform-agnostic (it speaks one dialect; each adapter translates).
 *
 * Discord → Slack dialect gaps handled:
 *  - **bold** / __bold__       → *bold*          (Slack bold is a single *)
 *  - *italic* / _italic_       → _italic_        (Slack italic is _ , not *)
 *  - ~~strike~~                → ~strike~
 *  - [text](url)               → <url|text>
 *  - #/##/### headings         → *bold*          (Slack has no headings)
 *  - "-# subtext" (line start) → plain           (Slack has no small text)
 *  - "- " / "* " bullets       → "• "            (Slack renders no list markers)
 *  - bare @Uxxxxxxx ids        → <@Uxxxxxxx>      (a real, clickable mention)
 *
 * `code` and ```fenced``` spans are stashed first and restored last, so none of
 * the above touches their contents.
 */

/** Sentinels that cannot appear in user text: one wraps stashed code spans, the
 *  other marks bold runs so the single-`*` italic pass never confuses the two. */
const STASH = '\u0000'
const BOLD = '\u0001'

export function toSlackMrkdwn(input: string): string {
  if (!input) return input

  // 1. Protect code spans (fenced first, then inline) behind placeholders.
  const spans: string[] = []
  const stash = (s: string): string => {
    const token = `${STASH}${spans.length}${STASH}`
    spans.push(s)
    return token
  }
  let t = input.replace(/```[\s\S]*?```/g, m => stash(m))
  t = t.replace(/`[^`\n]+`/g, m => stash(m))

  // 2. Links [text](url) → <url|text>.
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<$2|$1>')

  // 3. Bold **x** / __x__ → a sentinel, so the single-* italic pass can't see it.
  t = t.replace(/\*\*([^\n]+?)\*\*/g, `${BOLD}$1${BOLD}`)
  t = t.replace(/__([^\n]+?)__/g, `${BOLD}$1${BOLD}`)

  // 4. Strike ~~x~~ → ~x~.
  t = t.replace(/~~([^\n]+?)~~/g, '~$1~')

  // 5. Italic *x* → _x_ (single asterisks are now only italics). Guard against
  //    matching adjacent to word chars / other asterisks (arithmetic, globs).
  t = t.replace(/(?<![\w*])\*([^\s*][^*\n]*?)\*(?![\w*])/g, '_$1_')

  // 6. Sentinel → Slack bold.
  t = t.split(BOLD).join('*')

  // 7. Line-level transforms Slack can't express inline.
  t = t
    .split('\n')
    .map(line => {
      // "-# subtext" (optionally indented) → strip the marker, keep the content.
      let m = line.match(/^(\s*)-#\s?(.*)$/)
      if (m) return `${m[1]}${m[2]}`
      // Headings → bold (Slack has no headings).
      m = line.match(/^#{1,6}\s+(.*)$/)
      if (m) return `*${m[1]!.trim()}*`
      // Bullets "- "/"* " → "• " (Slack renders no list markers otherwise).
      m = line.match(/^(\s*)[-*]\s+(.*)$/)
      if (m) return `${m[1]}• ${m[2]}`
      return line
    })
    .join('\n')

  // 8. Bare Slack user ids → real mentions (skip ones already inside <@…>).
  t = t.replace(/(?<![<\w])@([UW][A-Z0-9]{6,})\b/g, '<@$1>')

  // 9. Restore the stashed code spans.
  t = t.replace(new RegExp(`${STASH}(\\d+)${STASH}`, 'g'), (_, i) => spans[Number(i)] ?? '')
  return t
}
