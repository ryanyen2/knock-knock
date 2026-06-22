# knock-knock — getting-started site

A friendly, single-page guide to setting up knock-knock: platform setup
(Discord step-by-step + Slack/Telegram/WhatsApp/iMessage), the permission model,
and four copy-paste **security levels**. Built to feel safe and warm — the door
*is* the permission boundary.

## View it

It's a static site (no build step). Serve the folder and open it:

```bash
cd website
python3 -m http.server 8899      # or: bunx serve .
# → http://localhost:8899/index.html
```

Opening `index.html` directly via `file://` mostly works, but a couple of
browsers block the local module fetches — a static server is the reliable path.

## What's inside

| File | Purpose |
|------|---------|
| `index.html` | structure + copy (grounded in the repo's real docs) + an inline stroke-icon sprite |
| `styles.css` | the design system — white ground, teal anchor with coral / yellow / blush / cream accents; layout-led (color blocks + whitespace carry structure, not cards) |
| `main.js` | interactions — the knock, the scroll-driven request walkthrough, copy buttons, platform tabs, the security dial |
| `vendor/` | self-hosted `anime.js`, `gsap` + `ScrollTrigger` (works offline) |

## Notes

- **Scrolling is native** — no smooth-scroll hijack, so the wheel stays snappy;
  GSAP ScrollTrigger drives the door-open and the pinned conversation directly.
- **Icons** are a small inline stroke set (no emoji), tinted from the palette.
- **Fonts** load from Google Fonts (Bricolage Grotesque · Hanken Grotesk · JetBrains Mono),
  with system fallbacks if offline.
- **Motion** respects `prefers-reduced-motion`. Append `?static=1` to force the
  no-motion layout (everything stacks, deep links jump instantly).
- **Deep links** work: `index.html#safety`, `#levels`, `#platforms`, etc.
- The footer/links point at the repo's `docs/*.md` for the deep dives.
