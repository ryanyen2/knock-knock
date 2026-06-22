# knock-knock — landing site

A single-page, Apple-style landing page for knock-knock. It answers, in order:
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

| Token | Value | Role |
|-------|-------|------|
| canvas | `#FBFBFD` | page ground |
| ink | `#1D1D1F` | text + dark UI |
| accent | `#0071E3` | the single brand accent (links, CTAs, active states) |
| muted / faint | `#6E6E73` / `#86868B` | secondary text |

- **Theme is light-locked** by design decision (Apple-light).
- **Type is the system SF stack** (`-apple-system, "SF Pro…"`), so it renders as
  real San Francisco on Apple devices with no webfont download. Mono is the
  system mono stack (`ui-monospace, "SF Mono"…`). Hierarchy comes from weight and
  size, not color.
- **Green / red** appear only inside chat content (allow / deny, status), never
  as page chrome. The accent stays blue everywhere else.
- **One radius scale** (8 / 14 / 20 / 28px), one shadow recipe.

## What's inside

| File | Purpose |
|------|---------|
| `index.html` | structure + copy (grounded in the repo's real docs) + an inline stroke-icon sprite + the chat-UI mockups |
| `styles.css` | the Apple-light design system and the reusable chat-component vocabulary (`.chat`, `.msg`, `.embed-ask`, `.embed-work`, `.embed-deny`, `.embed-conflict`) |
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
