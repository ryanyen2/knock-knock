# knock-knock — landing site

A single-page, warm-cream landing page for knock-knock. It answers, in order:
what it is, how a request actually flows, how control works, where it earns its
keep, and how to set it up. The spine of the page is a **pinned group-chat
mockup** that fills with a real request (a vLLM box owner standing up a LoRA
fine-tune endpoint for the team) as you scroll, with annotations explaining each
safety beat alongside.

## View it

Static site, no build step. Serve the folder and open it:

```bash
cd website
python3 -m http.server 8899      # or: bunx serve .
# → http://localhost:8899/index.html
```

Opening `index.html` directly via `file://` mostly works, but a couple of
browsers block local fetches, so a static server is the reliable path.

## Design system

A warm-cream, flat, PostHog-inspired system. All colors are CSS variables in
`styles.css` `:root`, so the palette is one block.

| Token | Value | Role |
|-------|-------|------|
| canvas | `#EEEFE9` | warm cream page ground |
| surface | `#FFFFFF` | white cards on cream |
| ink | `#23251D` | olive-charcoal headlines + dark code/UI |
| muted / faint | `#4D4F46` / `#6C6E63` | body / metadata |
| cta | `#F7A501` | the single saturated yellow-orange CTA (dark text on it) |
| accent | `#1078A3` | teal — links, eyebrows, active states (kept distinct from the CTA) |
| hairline | `#BFC1B7` | 1px card borders / rules |

- **Theme is light-locked** by design decision (warm cream, never pure white).
- **Type is IBM Plex Sans** (Google Fonts) across every role, weight-stepped
  400/500/600/700. Mono is **Source Code Pro** (→ JetBrains Mono → system mono).
- **Flat:** no drop shadows — every `box-shadow` resolves to a 1px hairline ring,
  so cards read as bordered, not lifted.
- **Yellow is scarce:** reserved for the primary CTA pill; links/interactive use
  teal. Green / red / purple appear only inside chat content (allow / deny /
  conflict), as PostHog-style soft pastels — never as page chrome.
- **One tight radius scale** (4 / 6 / 8 / 12px).

## What's inside

| File | Purpose |
|------|---------|
| `index.html` | structure + copy (grounded in the repo's real docs) + an inline stroke-icon sprite + the chat-UI mockups |
| `styles.css` | the warm-cream design system and the reusable chat-component vocabulary (`.chat`, `.msg`, `.embed-ask`, `.embed-work`, `.embed-deny`, `.embed-conflict`) |
| `main.js` | GSAP-driven pinned scrollytelling, reveal-on-scroll, frosted nav, copy buttons, the security dial |
| `vendor/` | self-hosted GSAP + ScrollTrigger (works offline) |

## Notes

- **Native scrolling**, no smooth-scroll hijack. GSAP ScrollTrigger pins the
  `#flow` chat panel and reveals one message + one annotation per scroll step.
- **The chat mockups are real component previews**, built from the same visual
  vocabulary the product uses (channel header, messages, approval cards, the
  Workbench activity log, the deny-floor block, conflict cards), not stock
  screenshots.
- **Motion respects `prefers-reduced-motion`.** Append `?static=1` to force the
  no-motion layout: the pinned sequence unrolls into a normal stack, every
  message and annotation is shown, deep links jump instantly.
- **Icons** are a small inline stroke set (one family, `1.7` weight) rather than
  an icon library, because the site ships with no bundler and stays offline-capable.
- The footer links point at the repo's `docs/*.md` for the deep dives.
