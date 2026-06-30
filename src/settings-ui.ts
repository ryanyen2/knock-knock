/**
 * settings-ui.ts — the embedded single-page settings UI served by settings-server.ts.
 *
 * Exported as a string constant (not a separate .html + `with { type: 'file' }` import) so it
 * bundles into `bun build --compile` with the same static-literal guarantee build.sh relies on
 * for the dynamic CLI imports — no embedded-asset resolution to verify per target.
 *
 * One self-contained document: no framework, no external fonts/CDN (so the per-run token can't
 * leak via a third-party request), system font stack, a monochrome black/white palette, and a
 * light-default theme with a manual light/dark toggle persisted in localStorage. The inline
 * <script> reads the token from the URL once, stashes it in sessionStorage (so a reload or a
 * reopened tab keeps working instead of 401-ing), strips it from the address bar, and talks to
 * the token-gated JSON API. sessionStorage is same-origin and cleared when the tab closes, so it
 * is no more exposed than the in-memory variable was — just durable across reloads. It
 * deliberately uses no backticks or ${...} so it never collides with this outer template literal.
 *
 * What the web surface will NOT do (by design — see settings-server.ts / lib.ts R17/R20):
 *   • enter token VALUES (only shows set / not-set) and • edit permissions.
 * For both it hands off to the terminal that launched `setup --ui` via /api/handoff, so the
 * secret/permission is typed in the terminal — the user never hunts for .env / access.json.
 */

export const SETTINGS_HTML = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>knock-knock settings</title>
<style>
  :root {
    --bg: #ffffff; --surface: #ffffff; --surface-2: #f6f6f6; --surface-3: #efefef;
    --text: #111113; --muted: #6b6b70; --faint: #9b9ba1;
    --line: #ececec; --line-strong: #d8d8da;
    --accent: #111113; --accent-fg: #ffffff;
    --ok: #1f1f22; --danger: #1f1f22;
    --radius: 12px; --r-sm: 8px; --gap: 14px;
    --shadow: 0 1px 2px rgba(0,0,0,.04), 0 6px 20px rgba(0,0,0,.04);
    --speed: 140ms;
  }
  html[data-theme="dark"] {
    --bg: #0c0c0d; --surface: #151517; --surface-2: #1c1c1f; --surface-3: #232327;
    --text: #f4f4f5; --muted: #a0a0a6; --faint: #6c6c72;
    --line: #262629; --line-strong: #34343a;
    --accent: #f4f4f5; --accent-fg: #0c0c0d;
    --ok: #f4f4f5; --danger: #f4f4f5;
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 28px rgba(0,0,0,.4);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--text);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased; letter-spacing: -.005em;
  }
  .app { display: grid; grid-template-columns: 250px 1fr; min-height: 100dvh; }
  /* ── Sidebar ── */
  aside {
    border-right: 1px solid var(--line); padding: 22px 14px; background: var(--surface);
    display: flex; flex-direction: column; gap: 2px;
  }
  .brand { display: flex; align-items: center; gap: 9px; padding: 2px 8px 20px; }
  .brand .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
  .brand b { font-weight: 600; letter-spacing: -.02em; }
  .brand span { color: var(--faint); font-size: 12px; }
  .navitem {
    display: flex; justify-content: space-between; align-items: center; gap: 8px;
    width: 100%; text-align: left; border: 0; background: transparent; color: var(--muted);
    padding: 8px 10px; border-radius: var(--r-sm); cursor: pointer; font-size: 13.5px;
    transition: background var(--speed) ease, color var(--speed) ease;
  }
  .navitem:hover { background: var(--surface-2); color: var(--text); }
  .navitem[aria-current="true"] { background: var(--surface-2); color: var(--text); font-weight: 600; }
  .navitem .count { color: var(--faint); font-size: 12px; font-variant-numeric: tabular-nums; }
  .navspace { flex: 1; }
  .themebtn {
    border: 1px solid var(--line); background: transparent; color: var(--muted); cursor: pointer;
    border-radius: var(--r-sm); padding: 8px 10px; font: inherit; font-size: 13px; text-align: left;
    display: flex; align-items: center; gap: 8px; transition: background var(--speed) ease;
  }
  .themebtn:hover { background: var(--surface-2); color: var(--text); }
  /* ── Main ── */
  main { padding: 32px 40px 120px; max-width: 900px; }
  .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; gap: 12px; }
  .head .titlewrap { display: flex; align-items: center; gap: 8px; }
  h1 { font-size: 22px; font-weight: 680; letter-spacing: -.025em; margin: 0; }
  h2 { font-size: 14px; font-weight: 640; margin: 28px 0 12px; letter-spacing: -.01em; display: flex; align-items: center; gap: 7px; }
  .sub { color: var(--muted); margin: 4px 0 24px; max-width: 62ch; }
  .row { display: flex; align-items: center; gap: 10px; }
  .between { justify-content: space-between; }
  .wrap { flex-wrap: wrap; }
  /* ── Help tooltip (the "?" beside titles) ── */
  .help {
    display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px;
    border-radius: 50%; border: 1px solid var(--line-strong); color: var(--faint);
    font-size: 10.5px; font-weight: 700; cursor: help; position: relative; flex: none; line-height: 1;
  }
  .help:hover, .help:focus { color: var(--text); border-color: var(--text); outline: none; }
  .help[data-tip]:hover::after, .help[data-tip]:focus::after {
    content: attr(data-tip); position: absolute; left: 50%; top: calc(100% + 8px); transform: translateX(-50%);
    width: max-content; max-width: 280px; white-space: normal; text-align: left;
    background: var(--text); color: var(--bg); font-size: 12px; font-weight: 500; line-height: 1.45;
    padding: 8px 11px; border-radius: var(--r-sm); box-shadow: var(--shadow); z-index: 30; pointer-events: none;
  }
  /* ── Cards / list ── */
  .list { display: flex; flex-direction: column; gap: 8px; }
  .card {
    border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface);
    padding: 14px 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px;
    cursor: pointer; transition: border-color var(--speed) ease, background var(--speed) ease;
  }
  .card:hover { border-color: var(--line-strong); background: var(--surface); }
  .card.static { cursor: default; }
  .card.static:hover { border-color: var(--line); }
  .card .title { font-weight: 580; letter-spacing: -.01em; }
  .card .meta { color: var(--muted); font-size: 12.5px; margin-top: 2px; }
  .pill { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 2px 9px; background: var(--surface-2); white-space: nowrap; }
  .pill.solid { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
  .dotstat { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
  .dotstat i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
  .dotstat i.on { background: var(--text); }
  .dotstat i.off { background: transparent; border: 1px solid var(--line-strong); }
  /* ── Avatars (monochrome, initials) ── */
  .avatar {
    display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px;
    border-radius: 50%; font-size: 11.5px; font-weight: 650; color: var(--text);
    background: var(--surface-2); border: 1px solid var(--line-strong); flex: none; letter-spacing: 0;
  }
  .avatar.sm { width: 24px; height: 24px; font-size: 10px; }
  .avatar[data-lvl="0"] { background: var(--surface-2); }
  .avatar[data-lvl="1"] { background: var(--surface-3); }
  .avatar[data-lvl="2"] { background: var(--line); }
  .avatar[data-lvl="3"] { background: var(--line-strong); }
  .avatar[data-lvl="4"] { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
  .stack { display: inline-flex; }
  .stack .avatar { margin-left: -7px; box-shadow: 0 0 0 2px var(--surface); }
  .stack .avatar:first-child { margin-left: 0; }
  /* ── Detail form ── */
  .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 18px; }
  .field label { font-weight: 560; font-size: 13px; display: flex; align-items: center; gap: 7px; }
  .field .hint { color: var(--muted); font-size: 12.5px; }
  .field .hint a { color: var(--text); text-underline-offset: 2px; }
  .howto { color: var(--muted); font-size: 12.5px; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 10px 12px; white-space: pre-wrap; margin-top: 2px; }
  .howto a { color: var(--text); }
  input[type=text], select, textarea {
    width: 100%; font: inherit; color: var(--text); background: var(--surface);
    border: 1px solid var(--line-strong); border-radius: var(--r-sm); padding: 9px 11px;
    transition: border-color var(--speed) ease, box-shadow var(--speed) ease;
  }
  input:focus, select:focus, textarea:focus {
    outline: none; border-color: var(--text); box-shadow: 0 0 0 3px color-mix(in srgb, var(--text) 12%, transparent);
  }
  input[readonly] { background: var(--surface-2); color: var(--muted); border-color: var(--line); }
  .field.err input, .field.err select { border-color: var(--danger); box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 14%, transparent); }
  .field .errmsg { color: var(--danger); font-size: 12.5px; font-weight: 560; }
  .toggle { display: flex; align-items: center; gap: 10px; cursor: pointer; font-weight: 500; }
  .toggle input { width: auto; accent-color: var(--accent); }
  /* ── Buttons ── */
  button.btn {
    font: inherit; font-weight: 560; border-radius: var(--r-sm); padding: 9px 15px; cursor: pointer;
    border: 1px solid var(--line-strong); background: var(--surface); color: var(--text);
    transition: background var(--speed) ease, border-color var(--speed) ease, opacity var(--speed) ease;
  }
  button.btn:hover { background: var(--surface-2); }
  button.btn.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
  button.btn.primary:hover { filter: brightness(1.08); }
  button.btn.ghost { border-color: transparent; color: var(--muted); }
  button.btn.ghost:hover { color: var(--text); background: var(--surface-2); }
  button.btn.danger { color: var(--danger); border-color: var(--line-strong); }
  button.btn.danger:hover { background: var(--surface-2); }
  button.btn:disabled { opacity: .5; cursor: default; }
  .btn.sm { padding: 6px 11px; font-size: 12.5px; }
  .addbtn { color: var(--text); border: 1px dashed var(--line-strong); background: transparent; }
  .addbtn:hover { border-color: var(--text); background: var(--surface-2); }
  /* ── Save bar ── */
  .savebar {
    position: fixed; left: 250px; right: 0; bottom: 0; padding: 14px 40px;
    background: color-mix(in srgb, var(--surface) 88%, transparent); backdrop-filter: blur(10px);
    border-top: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 14px;
    transform: translateY(120%); transition: transform 220ms cubic-bezier(.16,1,.3,1);
  }
  .savebar.show { transform: translateY(0); }
  .savebar .note { color: var(--muted); font-size: 13px; }
  .spinner { width: 14px; height: 14px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; display: inline-block; vertical-align: -2px; margin-right: 7px; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* ── Toast + banner (no left-accent bars) ── */
  .toast {
    position: fixed; right: 22px; bottom: 86px; background: var(--text); color: var(--bg);
    border-radius: var(--radius); padding: 12px 16px; box-shadow: var(--shadow);
    opacity: 0; transform: translateY(8px); transition: opacity 200ms ease, transform 200ms ease;
    pointer-events: none; max-width: 340px; font-weight: 500;
  }
  .toast.show { opacity: 1; transform: translateY(0); }
  .banner {
    background: var(--surface-2); color: var(--text); border: 1px solid var(--line-strong);
    border-radius: var(--radius); padding: 13px 16px; margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between; gap: 14px;
  }
  .info { background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius); padding: 13px 15px; color: var(--muted); font-size: 13px; }
  .info b { color: var(--text); }
  /* ── States ── */
  .empty { text-align: center; color: var(--muted); padding: 64px 20px; border: 1px dashed var(--line-strong); border-radius: var(--radius); }
  .empty b { color: var(--text); display: block; margin-bottom: 6px; font-weight: 640; font-size: 15px; }
  .skel { height: 60px; border-radius: var(--radius); background: linear-gradient(90deg, var(--surface-2) 25%, var(--line) 50%, var(--surface-2) 75%); background-size: 200% 100%; animation: sh 1.3s ease infinite; margin-bottom: 8px; }
  @keyframes sh { to { background-position: -200% 0; } }
  .back { color: var(--muted); background: transparent; border: 0; cursor: pointer; font: inherit; padding: 0 0 16px; }
  .back:hover { color: var(--text); }
  .chips { display: flex; flex-wrap: wrap; gap: 7px; }
  .chip { display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--line-strong); border-radius: 999px; padding: 4px 6px 4px 11px; background: var(--surface); font-size: 12.5px; }
  .chip.ro { padding: 4px 11px; }
  .chip.deny { text-decoration: line-through; color: var(--muted); }
  .chip.ask { border-style: dashed; }
  .chip button { border: 0; background: transparent; color: var(--faint); cursor: pointer; font-size: 14px; line-height: 1; padding: 0 2px; }
  .chip button:hover { color: var(--text); }
  code.env { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 3px 8px; }
  /* ── Overview dashboard ── */
  .panel { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); padding: 18px 18px 8px; margin-bottom: 16px; }
  .panel > .phead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; gap: 10px; }
  .panel .pname { font-weight: 640; letter-spacing: -.01em; }
  .panel .pcounts { color: var(--muted); font-size: 12.5px; display: flex; gap: 14px; }
  .ov-bots { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  .ov-bot { display: inline-flex; align-items: center; gap: 9px; border: 1px solid var(--line); border-radius: 999px; padding: 5px 12px 5px 6px; background: var(--surface-2); }
  .ov-bot .nm { font-size: 13px; font-weight: 560; }
  .ov-ch { border-top: 1px solid var(--line); padding: 13px 2px; }
  .ov-ch .chrow { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .ov-ch .chname { font-weight: 560; display: flex; align-items: center; gap: 8px; }
  .ov-ch .chmeta { color: var(--muted); font-size: 12px; margin-top: 4px; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .stat { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); padding: 14px 16px; }
  .stat .n { font-size: 24px; font-weight: 700; letter-spacing: -.03em; }
  .stat .l { color: var(--muted); font-size: 12.5px; margin-top: 2px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
  @media (max-width: 820px) {
    .app { grid-template-columns: 1fr; }
    aside { border-right: 0; border-bottom: 1px solid var(--line); flex-direction: row; flex-wrap: wrap; align-items: center; }
    .navspace { flex: 0; }
    main { padding: 22px 18px 120px; }
    .savebar { left: 0; padding: 14px 18px; }
  }
</style>
</head>
<body>
<div class="app">
  <aside id="nav"></aside>
  <main id="main"></main>
</div>
<div class="savebar" id="savebar">
  <span class="note" id="savenote">You have unsaved changes.</span>
  <div class="row">
    <button class="btn ghost" id="discard">Discard</button>
    <button class="btn primary" id="save">Save changes</button>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
(function () {
  "use strict";

  // ── Theme: light by default; honor the saved choice; never auto-dark (R: user asked for light). ──
  try { var saved = localStorage.getItem("kk-theme"); if (saved === "dark" || saved === "light") document.documentElement.setAttribute("data-theme", saved); } catch (e) {}

  // ── Token: take it from the URL when present (a fresh link), else fall back to the one this
  // tab stashed earlier — so a reload or reopened tab keeps working. Then strip it from the bar. ──
  var params = new URLSearchParams(location.search);
  var TOKEN = params.get("token") || "";
  try {
    if (TOKEN) sessionStorage.setItem("kk-token", TOKEN);
    else TOKEN = sessionStorage.getItem("kk-token") || "";
  } catch (e) {}
  if (location.search) history.replaceState(null, "", location.pathname);

  var GROUPS = [
    { key: "overview", label: "Overview" },
    { key: "bots", label: "Bots" },
    { key: "channels", label: "Channels" },
    { key: "roster", label: "Roster" },
    { key: "preferences", label: "Preferences" },
    { key: "ledger", label: "Ledger" }
  ];
  var PLATFORM_KEYS = ["discord", "slack", "telegram", "github", "notion"];

  var S = {
    loading: true, error: null,
    access: null, platforms: null, runtimes: null, presets: null, defaultPreset: "ask-per-edit",
    cwd: "", tokens: null, perms: null, ledger: null, version: null,
    dirty: false, saving: false, conflict: false,
    group: "overview", detail: null, draft: null, collabDraft: null, errors: {},
    handoff: null, handoffSupported: false, relayStarting: false
  };

  // ── tiny DOM helper ──
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs) {
      if (k === "class") el.className = attrs[k];
      else if (k === "html") el.innerHTML = attrs[k];
      else if (k.indexOf("on") === 0) el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] === true) el.setAttribute(k, "");
      else if (attrs[k] != null && attrs[k] !== false) el.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) {
      if (c == null) return;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return el;
  }
  function clr(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ "Authorization": "Bearer " + TOKEN }, opts.headers || {});
    return fetch(path, opts);
  }
  function markDirty() { S.dirty = true; syncSaveBar(); }
  function platformGuide(p) { return (S.platforms && S.platforms[p]) || null; }

  // Env-var names a bot still needs set, judged by what its PLATFORM requires (not just what the
  // bot happens to have mapped) — so a legacy/hand-edited bot missing a secret mapping still reads
  // as "not ready" instead of silently launching a relay that can't log in.
  function botMissing(b) {
    var miss = [];
    if (!(S.tokens && S.tokens[b.tokenEnv])) miss.push(b.tokenEnv);
    var g = platformGuide(b.platform);
    var secrets = (g && g.secrets) || [];
    for (var i = 0; i < secrets.length; i++) {
      var s = secrets[i];
      if (s.whenWebhook) continue; // webhook-only secrets aren't required in poll mode
      var env = b.secretEnv && b.secretEnv[s.name];
      if (!env || !(S.tokens && S.tokens[env])) miss.push(env || s.envBase);
    }
    return miss;
  }
  function botReady(b) { return botMissing(b).length === 0; }

  // Shown whenever the API rejects our token (stale link, or a new setup run minted a fresh
  // one). The only fix is the new URL the terminal printed, so say exactly that.
  var STALE_LINK_MSG = "This link is no longer valid — the access token expired or a newer one was issued. Switch to the terminal running knock-knock setup and open the fresh link it printed.";

  // ── data load ──
  function load() {
    S.loading = true; render();
    api("/api/config").then(function (r) {
      if (r.status === 401) throw new Error(STALE_LINK_MSG);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (data) {
      S.access = data.access; S.platforms = data.platforms; S.tokens = data.tokens || {};
      S.runtimes = data.runtimes || []; S.presets = data.presets || {}; S.defaultPreset = data.defaultPreset || "ask-per-edit";
      S.cwd = data.cwd || "";
      S.perms = data.resolvedPermissions || {}; S.ledger = data.ledger; S.version = data.version;
      S.loading = false; S.error = null; S.dirty = false; S.conflict = false; S.errors = {};
      render();
    }).catch(function (e) {
      S.loading = false; S.error = String(e); render();
    });
    api("/api/handoff").then(function (r) { return r.json(); }).then(function (s) { S.handoffSupported = !!s.supported; }).catch(function () {});
  }

  // ── save ──
  function save() {
    if (S.saving) return;
    S.saving = true; S.errors = {}; syncSaveBar();
    api("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: S.access, version: S.version })
    }).then(function (r) {
      return r.json().then(function (b) { return { status: r.status, body: b }; });
    }).then(function (res) {
      S.saving = false;
      if (res.status === 200) {
        S.version = res.body.version; S.dirty = false; S.conflict = false;
        toast("Settings saved.", false); load();
      } else if (res.status === 401) {
        // Token went stale — keep the edits in memory and surface the recovery path full-screen.
        S.error = STALE_LINK_MSG; render();
      } else if (res.status === 409) {
        S.conflict = true; syncSaveBar(); render();
      } else if (res.status === 400 && res.body.fields) {
        res.body.fields.forEach(function (f) { S.errors[f.field] = f.message; });
        toast("Some fields need fixing.", true); render();
      } else {
        toast("Save failed (" + res.status + ").", true);
      }
      syncSaveBar();
    }).catch(function () { S.saving = false; toast("Save failed.", true); syncSaveBar(); });
  }

  function reloadFromDisk() { S.conflict = false; S.draft = null; load(); }

  // ── handoff: ask the launching terminal to run a sensitive flow ──
  function handoff(action, bot, kind) {
    if (S.handoff) return;
    // The terminal flow (and the relay) read the on-disk config, so unsaved edits would be
    // invisible to them (and a terminal save would then conflict with yours). Require a clean save.
    if (S.dirty) { toast("Save your changes first, then try this again.", true); return; }
    api("/api/handoff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: action, bot: bot }) })
      .then(function (r) {
        if (r.status === 503) { toast("Run knock-knock setup in a terminal to do this.", true); return null; }
        if (r.status === 409) { toast("Another terminal action is already running.", true); return null; }
        if (!r.ok) { toast("Could not start — try saving first (" + r.status + ").", true); return null; }
        return r.json();
      })
      .then(function (res) {
        if (!res) return;
        if (action === "start-relay") { S.relayStarting = true; render(); return; }
        S.handoff = { action: action, bot: bot, kind: kind }; render();
        toast("Check your terminal — answer the prompt, then come back.", false);
        setTimeout(pollHandoff, 900);
      });
  }
  function pollHandoff() {
    api("/api/handoff").then(function (r) { return r.json(); }).then(function (s) {
      if (s.state === "running") { setTimeout(pollHandoff, 900); return; }
      var done = s.state === "done";
      S.handoff = null;
      if (done) { toast("Updated from the terminal.", false); load(); }
      else { toast("Terminal action cancelled.", true); render(); }
    }).catch(function () { S.handoff = null; render(); });
  }

  function toast(msg, isErr) {
    var t = document.getElementById("toast");
    t.textContent = msg; t.className = "toast show";
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = "toast"; }, 2800);
  }

  function syncSaveBar() {
    var bar = document.getElementById("savebar");
    var btn = document.getElementById("save");
    var note = document.getElementById("savenote");
    bar.className = "savebar" + (S.dirty ? " show" : "");
    btn.disabled = S.saving;
    document.getElementById("discard").disabled = S.saving;
    btn.innerHTML = S.saving ? '<span class="spinner"></span>Saving' : "Save changes";
    note.textContent = S.conflict ? "Changed on disk since you loaded." : "You have unsaved changes.";
  }

  // ── render ──
  function render() {
    renderNav();
    var main = document.getElementById("main");
    clr(main);
    if (S.relayStarting) {
      main.appendChild(h("div", { class: "empty" }, [
        h("b", {}, ["Starting the relay…"]),
        "The settings server is shutting down. Switch to your terminal — the relay is taking over there. You can close this tab."
      ]));
      document.getElementById("savebar").className = "savebar";
      return;
    }
    if (S.loading) { main.appendChild(skeleton()); return; }
    if (S.error) { main.appendChild(h("div", { class: "empty" }, [h("b", {}, ["Could not load settings"]), S.error])); return; }
    if (S.conflict) main.appendChild(conflictBanner());
    if (S.handoff) main.appendChild(handoffBanner());
    var fn = ({ overview: viewOverview, bots: viewBots, channels: viewChannels, roster: viewRoster, preferences: viewPrefs, ledger: viewLedger })[S.group];
    fn(main);
    syncSaveBar();
  }

  function renderNav() {
    var nav = document.getElementById("nav"); clr(nav);
    nav.appendChild(h("div", { class: "brand" }, [h("span", { class: "dot" }), h("b", {}, ["knock-knock"]), h("span", {}, ["settings"])]));
    GROUPS.forEach(function (g) {
      nav.appendChild(h("button", {
        class: "navitem", "aria-current": String(S.group === g.key),
        onclick: function () { S.group = g.key; S.detail = null; S.draft = null; S.collabDraft = null; S.errors = {}; render(); }
      }, [h("span", {}, [g.label]), h("span", { class: "count" }, [countFor(g.key)])]));
    });
    nav.appendChild(h("div", { class: "navspace" }));
    var dark = document.documentElement.getAttribute("data-theme") === "dark";
    nav.appendChild(h("button", { class: "themebtn", onclick: toggleTheme }, [dark ? "☀  Light mode" : "☾  Dark mode"]));
  }
  function toggleTheme() {
    var dark = document.documentElement.getAttribute("data-theme") === "dark";
    var next = dark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("kk-theme", next); } catch (e) {}
    renderNav();
  }
  function countFor(key) {
    if (!S.access) return "";
    if (key === "bots") return String(Object.keys(S.access.bots).length);
    if (key === "channels") return String(Object.keys(S.access.channels).length);
    if (key === "roster") return String(Object.keys(S.access.roster.people).length + Object.keys(S.access.roster.peers).length);
    return "";
  }
  function skeleton() { var w = h("div", {}, []); for (var i = 0; i < 4; i++) w.appendChild(h("div", { class: "skel" })); return w; }
  function conflictBanner() {
    return h("div", { class: "banner" }, [
      h("span", {}, ["The config changed on disk since you loaded it. Reloading discards your unsaved edits."]),
      h("div", { class: "row" }, [
        h("button", { class: "btn sm ghost", onclick: function () { S.conflict = false; render(); } }, ["Keep editing"]),
        h("button", { class: "btn sm primary", onclick: reloadFromDisk }, ["Reload"])
      ])
    ]);
  }
  function handoffBanner() {
    var what = S.handoff.action === "set-token" ? "Setting the token" : "Editing permissions";
    return h("div", { class: "banner" }, [
      h("span", {}, [h("span", { class: "spinner" }), what + " for " + S.handoff.bot + " — answer the prompt in your terminal."])
    ]);
  }
  function header(title, sub, tip) {
    return h("div", {}, [
      h("div", { class: "head" }, [h("div", { class: "titlewrap" }, [h("h1", {}, [title]), tip ? helpIcon(tip) : null])]),
      sub ? h("p", { class: "sub" }, [sub]) : null
    ]);
  }
  function helpIcon(tip) { return h("span", { class: "help", "data-tip": tip, tabindex: "0", role: "img", "aria-label": tip }, ["?"]); }
  function backBtn() { return h("button", { class: "back", onclick: function () { S.detail = null; S.draft = null; S.collabDraft = null; S.errors = {}; render(); } }, ["← Back"]); }
  function field(labelText, control, hint, errKey, tip) {
    var err = errKey && S.errors[errKey];
    var lab = h("label", {}, [labelText]); if (tip) lab.appendChild(helpIcon(tip));
    return h("div", { class: "field" + (err ? " err" : "") }, [
      labelText ? lab : null, control,
      hint ? (typeof hint === "string" ? h("div", { class: "hint" }, [hint]) : hint) : null,
      err ? h("div", { class: "errmsg" }, [err]) : null
    ]);
  }
  function textInput(value, oninput, opts) {
    opts = opts || {};
    var i = h("input", { type: "text", value: value || "", placeholder: opts.placeholder || "" });
    if (opts.readonly) i.setAttribute("readonly", "");
    i.addEventListener("input", function () { oninput(i.value); });
    return i;
  }
  function selectInput(value, options, oninput, labeller) {
    var sel = h("select", {});
    options.forEach(function (o) {
      var opt = h("option", { value: o }, [labeller ? labeller(o) : o]); if (o === value) opt.selected = true; sel.appendChild(opt);
    });
    sel.addEventListener("change", function () { oninput(sel.value); });
    return sel;
  }
  // Runtime <select> built from the server-provided list (label shown, value stored).
  function runtimeSelect(value, oninput) {
    var list = S.runtimes && S.runtimes.length ? S.runtimes : [{ value: value || "claude-sdk", label: value || "claude-sdk", hint: "" }];
    var sel = h("select", {});
    list.forEach(function (rt) {
      var opt = h("option", { value: rt.value }, [rt.label + (rt.hint ? " — " + rt.hint : "")]);
      if (rt.value === value) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", function () { oninput(sel.value); });
    return sel;
  }
  // A platform's "where to get the token" help block, with a clickable link.
  function tokenHowtoBlock(p) {
    var g = platformGuide(p); if (!g) return null;
    var wrap = h("div", { class: "howto" }, [g.tokenHowto || ""]);
    if (g.tokenUrl) { wrap.appendChild(document.createTextNode("  ")); wrap.appendChild(h("a", { href: g.tokenUrl, target: "_blank", rel: "noreferrer noopener" }, ["Open →"])); }
    return wrap;
  }
  // A numbered, plain-language "how to set this platform up" block, lifted from the setup guide
  // so the user doesn't have to leave the page. Includes the clickable starting link.
  function setupStepsBlock(p) {
    var g = platformGuide(p); if (!g || !g.setupSteps || !g.setupSteps.length) return null;
    var ol = h("ol", { style: "margin:6px 0 0;padding-left:18px;color:var(--muted);font-size:12.5px;line-height:1.6" });
    g.setupSteps.forEach(function (s) { ol.appendChild(h("li", {}, [s])); });
    var head = h("div", { class: "row", style: "gap:8px;margin-bottom:2px" }, [
      h("span", { style: "font-weight:560;font-size:12.5px" }, ["Set up " + g.label]),
      g.tokenUrl ? h("a", { href: g.tokenUrl, target: "_blank", rel: "noreferrer noopener", style: "font-size:12.5px;color:var(--text)" }, ["Open " + g.label + " →"]) : null
    ]);
    return h("div", { class: "howto", style: "margin-bottom:18px" }, [head, ol]);
  }
  function avatar(name, small) {
    var s = (name || "?").trim();
    var parts = s.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(" ");
    var initials = parts.length > 1 ? (parts[0][0] + parts[1][0]) : s.slice(0, 2);
    var hash = 0; for (var i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    return h("span", { class: "avatar" + (small ? " sm" : ""), "data-lvl": String(hash % 5) }, [(initials || "?").toUpperCase()]);
  }

  // ── OVERVIEW ──
  function viewOverview(main) {
    var a = S.access, bots = a.bots, chans = a.channels;
    main.appendChild(header("Overview", "Your bots and channels at a glance, grouped by platform.", "A read-only dashboard. Mesh-transport channels are how bots coordinate with each other; they carry no chat or tasks."));
    var botKeys = Object.keys(bots), chKeys = Object.keys(chans);
    if (!botKeys.length && !chKeys.length) { main.appendChild(emptyState("Nothing set up yet.", "Add a bot under Bots to get started.")); return; }

    var meshCount = chKeys.filter(function (k) { return chans[k].meshTransport; }).length;
    var stats = h("div", { class: "grid2", style: "margin-bottom:18px" }, [
      stat(String(botKeys.length), "bot" + (botKeys.length === 1 ? "" : "s")),
      stat(String(chKeys.length), "channel" + (chKeys.length === 1 ? "" : "s")),
      stat(String(meshCount), "mesh channel" + (meshCount === 1 ? "" : "s")),
      stat(String(Object.keys(a.roster.people).length + Object.keys(a.roster.peers).length), "roster entries")
    ]);
    main.appendChild(stats);

    // Start the relay straight from here — it takes over this terminal (the settings page closes).
    // Guard it: a relay with no credentialed bot just fails to log in and leaves the page dead, so
    // disable until at least one bot is ready and name the ones still missing tokens.
    if (botKeys.length) {
      var notReady = botKeys.filter(function (k) { return !botReady(bots[k]); });
      var noneReady = notReady.length === botKeys.length;
      var relayHint = S.dirty ? "Save your changes first."
        : noneReady ? "Set bot tokens first — no bot is ready yet."
        : notReady.length ? "Will run, but " + notReady.join(", ") + " still need tokens."
        : "Runs every configured bot in your terminal.";
      main.appendChild(h("div", { class: "row between", style: "margin-bottom:18px;gap:12px;flex-wrap:wrap" }, [
        h("div", { class: "row", style: "gap:10px" }, [
          h("button", { class: "btn primary", disabled: S.dirty || !!S.handoff || noneReady, onclick: function () { handoff("start-relay", null, "relay"); } }, ["▶  Start relay"]),
          h("span", { class: "hint" }, [relayHint])
        ])
      ]));
    }

    // Mesh prompt: peers configured but no dedicated transport channel ⇒ cross-machine coordination is inert.
    var hasPeer = chKeys.some(function (k) { return chans[k].collaborators.some(function (c) { return c.kind === "peer"; }); }) || Object.keys(a.roster.peers).length > 0;
    if (hasPeer && !meshCount) {
      main.appendChild(h("div", { class: "banner", style: "margin-bottom:18px" }, [
        h("span", {}, [
          h("b", {}, ["Set up a mesh channel. "]),
          "You have peer bots, but no dedicated mesh-transport channel — so cross-machine coordination (⟦kk-mesh⟧ traffic) stays inert. In your terminal run ",
          h("code", { class: "env" }, ["knock-knock setup"]),
          " → Auto-configure: the bot can create one and register every party to it. Add the SAME channel on each machine."
        ])
      ]));
    }

    PLATFORM_KEYS.forEach(function (p) {
      var pb = botKeys.filter(function (k) { return bots[k].platform === p; });
      var pc = chKeys.filter(function (k) { return chans[k].platform === p; });
      if (!pb.length && !pc.length) return;
      var g = platformGuide(p);
      var panel = h("div", { class: "panel" }, [
        h("div", { class: "phead" }, [
          h("div", { class: "pname" }, [g ? g.label : p]),
          h("div", { class: "pcounts" }, [
            h("span", {}, [pb.length + " bot" + (pb.length === 1 ? "" : "s")]),
            h("span", {}, [pc.length + " channel" + (pc.length === 1 ? "" : "s")])
          ])
        ])
      ]);
      // bots row
      var botsRow = h("div", { class: "ov-bots" });
      pb.forEach(function (k) {
        var b = bots[k]; var set = botReady(b);
        botsRow.appendChild(h("span", { class: "ov-bot", title: set ? "all tokens set" : "missing: " + botMissing(b).join(", ") }, [
          avatar(b.displayName || k, true), h("span", { class: "nm" }, [k]),
          h("span", { class: "dotstat" }, [h("i", { class: set ? "on" : "off" })])
        ]));
      });
      if (pb.length) panel.appendChild(botsRow);
      // channels — show WHO is here, not just counts
      pc.forEach(function (ck) {
        var ch = chans[ck];
        var memberAvas = h("span", { class: "stack" });
        ch.members.forEach(function (m) { memberAvas.appendChild(avatar(m.bot, true)); });
        var botLine = ch.members.length
          ? h("span", {}, ["bots: " + ch.members.map(function (m) {
              var rp = S.perms[ck] && S.perms[ck][m.bot];
              return m.bot + (rp && rp.preset ? " (" + rp.preset + ")" : "");
            }).join(", ")])
          : h("span", { class: "hint" }, ["no bots yet"]);
        var meta = h("div", { class: "chmeta" }, [botLine]);
        var collabWrap = null;
        if (ch.collaborators.length) {
          collabWrap = h("div", { class: "chips", style: "margin-top:8px" });
          ch.collaborators.forEach(function (c) { collabWrap.appendChild(h("span", { class: "chip ro" }, [rosterLabel(c)])); });
        }
        panel.appendChild(h("div", { class: "ov-ch" }, [
          h("div", { class: "chrow" }, [
            h("div", { class: "chname" }, [ch.label || ch.channelId, ch.meshTransport ? h("span", { class: "pill solid" }, ["mesh"]) : null]),
            memberAvas
          ]),
          meta,
          collabWrap
        ]));
      });
      main.appendChild(panel);
    });
  }
  function stat(n, l) { return h("div", { class: "stat" }, [h("div", { class: "n" }, [n]), h("div", { class: "l" }, [l])]); }

  // ── BOTS ──
  function viewBots(main) {
    var bots = S.access.bots;
    if (S.draft && S.draft.kind === "bot") return createBotForm(main);
    if (S.detail && bots[S.detail]) return botDetail(main, S.detail);
    main.appendChild(header("Bots", "The agent identities you run — one platform app holding a token locally.", "Each bot is one app on a messaging platform. The token stays in your terminal's .env; here you only see whether it is set."));
    var keys = Object.keys(bots);
    if (!keys.length) main.appendChild(emptyState("No bots yet.", "Add a bot to get started."));
    var list = h("div", { class: "list" });
    keys.forEach(function (k) {
      var b = bots[k]; var set = botReady(b);
      list.appendChild(h("div", { class: "card", onclick: function () { S.detail = k; S.errors = {}; render(); } }, [
        h("div", { class: "row" }, [avatar(b.displayName || k), h("div", {}, [
          h("div", { class: "title" }, [k]),
          h("div", { class: "meta" }, [(b.displayName ? b.displayName + " · " : "") + (b.runtime || "")])
        ])]),
        h("div", { class: "row" }, [
          h("span", { class: "dotstat" }, [h("i", { class: set ? "on" : "off" }), set ? "token set" : "no token"]),
          h("span", { class: "pill" }, [b.platform])
        ])
      ]));
    });
    main.appendChild(list);
    main.appendChild(h("button", { class: "btn addbtn", style: "margin-top:12px", onclick: startAddBot }, ["+ Add bot"]));
  }
  function botDetail(main, key) {
    var b = S.access.bots[key];
    var g = platformGuide(b.platform);
    main.appendChild(backBtn());
    main.appendChild(header(key, null));
    main.appendChild(field("Platform", textInput(b.platform, function () {}, { readonly: true }), "Set when the bot is created.", null, "Which messaging platform this bot speaks. It is the bot's identity, so it cannot change after creation — make a new bot instead."));

    // token + secret status + handoff (values never shown — set / not set only). Required secrets
    // come from the platform guide, so a Slack bot's app-level token shows here even if it predates
    // secret-mapping. One "Set in terminal" prompt collects every token this bot needs.
    var primarySet = !!(S.tokens && S.tokens[b.tokenEnv]);
    var ready = botReady(b);
    var bg = platformGuide(b.platform);
    var reqSecrets = ((bg && bg.secrets) || []).filter(function (s) { return !s.whenWebhook; });
    function credRow(label, env, isSet, topGap) {
      return h("div", { class: "row between", style: topGap ? "margin-top:6px" : "" }, [
        h("span", { class: "dotstat" }, [h("i", { class: isSet ? "on" : "off" }), h("span", {}, [label + " "]), h("code", { class: "env" }, [env])]),
        h("span", { class: "hint" }, [isSet ? "set" : "not set"])
      ]);
    }
    var tokenRows = [credRow("Bot token", b.tokenEnv, primarySet, false)];
    reqSecrets.forEach(function (s) {
      var env = (b.secretEnv && b.secretEnv[s.name]) || s.envBase;
      tokenRows.push(credRow(s.label, env, !!(S.tokens && S.tokens[env]), true));
    });
    tokenRows.push(h("div", { class: "row", style: "margin-top:10px" }, [
      h("button", { class: "btn sm" + (ready ? "" : " primary"), disabled: !!S.handoff, onclick: function () { handoff("set-token", key, "bot"); } }, [ready ? "Update in terminal" : "Set in terminal"])
    ]));
    main.appendChild(field(reqSecrets.length ? "Tokens" : "Token", h("div", {}, tokenRows), tokenHowtoBlock(b.platform), null, "Token values live only in your terminal's .env. Click \\"Set in terminal\\" and paste them into the prompts that appear in the terminal running setup --ui — one flow collects every token this bot needs."));

    main.appendChild(field("Coding agent (runtime)", runtimeSelect(b.runtime, function (v) { b.runtime = v; markDirty(); }), "The local coding agent that drives this bot.", "bots." + key, "Which local coding agent runs this bot. Keep non-Claude agents in ask-first mode so the deny floor holds."));
    main.appendChild(field("Display name", textInput(b.displayName || "", function (v) { if (v) b.displayName = v; else delete b.displayName; markDirty(); }), "Cosmetic; usually fetched from the platform."));
    main.appendChild(field("Default blurb", textInput(b.blurb || "", function (v) { if (v) b.blurb = v; else delete b.blurb; markDirty(); }), "One-line capability description."));
    main.appendChild(h("button", { class: "btn danger", onclick: function () { removeBot(key); } }, ["Remove bot"]));
  }
  function startAddBot() {
    S.draft = { kind: "bot", key: uniqueKey("bot", S.access.bots), platform: "discord", runtime: "claude-sdk", tokenEnv: guideTokenEnv("discord"), displayName: "", blurb: "" };
    S.errors = {}; render();
  }
  function guideTokenEnv(p) { var g = platformGuide(p); return g ? g.tokenEnvBase : "BOT_TOKEN"; }
  function createBotForm(main) {
    var d = S.draft;
    main.appendChild(backBtn());
    main.appendChild(header("New bot", "Pick the platform and a name before creating — nothing is saved until you click Create."));
    main.appendChild(field("Name (key)", textInput(d.key, function (v) { d.key = v; S.errors = {}; }), "Lowercase letters, digits, hyphens. Used to reference this bot.", "draft.key", "A short local id for this bot, e.g. \\"cc\\" or \\"reviewer\\"."));
    main.appendChild(field("Platform", selectInput(d.platform, PLATFORM_KEYS, function (v) { d.platform = v; d.tokenEnv = guideTokenEnv(v); S.errors = {}; render(); }, function (p) { var g = platformGuide(p); return g ? g.label : p; }), platformGuide(d.platform) ? platformGuide(d.platform).hint : null, null, "Which messaging platform this bot speaks. You can change it freely here, but not after the bot is created."));
    var steps = setupStepsBlock(d.platform); if (steps) main.appendChild(steps);
    main.appendChild(field("Token env var", textInput(d.tokenEnv, function (v) { d.tokenEnv = v; }), "Name of the env var that will hold this bot's token (the value is set later, in the terminal).", "draft.tokenEnv", "The .env variable NAME — not the token itself. Defaults from the platform; change it only if two bots on the same platform need different vars."));
    main.appendChild(field("Coding agent (runtime)", runtimeSelect(d.runtime, function (v) { d.runtime = v; }), "The local coding agent that will drive this bot."));
    main.appendChild(h("div", { class: "row", style: "margin-top:6px" }, [
      h("button", { class: "btn primary", onclick: commitBot }, ["Create bot"]),
      h("button", { class: "btn ghost", onclick: function () { S.draft = null; S.errors = {}; render(); } }, ["Cancel"])
    ]));
  }
  function commitBot() {
    var d = S.draft; S.errors = {};
    var key = (d.key || "").trim();
    if (!/^[a-z0-9-]+$/.test(key)) S.errors["draft.key"] = "Lowercase letters, digits, and hyphens only.";
    else if (S.access.bots[key]) S.errors["draft.key"] = "A bot named \\"" + key + "\\" already exists.";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test((d.tokenEnv || "").trim())) S.errors["draft.tokenEnv"] = "Not a valid environment-variable name.";
    if (Object.keys(S.errors).length) { render(); return; }
    var bot = { platform: d.platform, tokenEnv: d.tokenEnv.trim(), runtime: (d.runtime || "claude-sdk").trim() };
    if (d.displayName) bot.displayName = d.displayName;
    // Wire the platform's required secrets (e.g. Slack's app-level token) so the bot is born
    // complete — the relay reads secretEnv, and "Set in terminal" prompts for each mapped secret.
    // Webhook-only secrets are skipped (the web sets up poll-mode bots).
    var g = platformGuide(d.platform);
    if (g && g.secrets && g.secrets.length) {
      var se = {};
      for (var si = 0; si < g.secrets.length; si++) { var sec = g.secrets[si]; if (!sec.whenWebhook) se[sec.name] = sec.envBase; }
      if (Object.keys(se).length) bot.secretEnv = se;
    }
    S.access.bots[key] = bot;
    S.draft = null; S.detail = key; markDirty(); render();
    toast("Bot created. Save changes first, then set its token.", false);
  }
  function removeBot(key) {
    delete S.access.bots[key];
    Object.values(S.access.channels).forEach(function (ch) {
      ch.members = ch.members.filter(function (m) { return m.bot !== key; });
    });
    S.detail = null; markDirty(); render();
  }

  // ── CHANNELS ──
  function viewChannels(main) {
    var chans = S.access.channels;
    if (S.draft && S.draft.kind === "channel") return createChannelForm(main);
    if (S.detail && chans[S.detail]) return channelDetail(main, S.detail);
    main.appendChild(header("Channels", "Each channel is a project and a permission boundary. Add the bots that work here and the people or peer bots they collaborate with.", "A channel maps to a real platform channel. The bots you add to it get a workspace and a permission profile that apply only here."));
    var keys = Object.keys(chans);
    if (!keys.length) main.appendChild(emptyState("No channels yet.", "Add a channel, then save."));
    var list = h("div", { class: "list" });
    keys.forEach(function (ck) {
      var ch = chans[ck];
      list.appendChild(h("div", { class: "card", onclick: function () { S.detail = ck; S.errors = {}; render(); } }, [
        h("div", {}, [
          h("div", { class: "title row" }, [ch.label || ch.channelId, ch.meshTransport ? h("span", { class: "pill solid" }, ["mesh"]) : null]),
          h("div", { class: "meta" }, [ch.members.length + " bot(s) · " + ch.collaborators.length + " collaborator(s)"])
        ]),
        h("span", { class: "pill" }, [ch.platform])
      ]));
    });
    main.appendChild(list);
    main.appendChild(h("button", { class: "btn addbtn", style: "margin-top:12px", onclick: startAddChannel }, ["+ Add channel"]));
  }
  function startAddChannel() {
    var platform = Object.values(S.access.bots)[0] ? Object.values(S.access.bots)[0].platform : "discord";
    S.draft = { kind: "channel", platform: platform, channelId: "", label: "", owner: ownerFor(platform) };
    S.errors = {}; render();
  }
  // The owner id is shared per platform (access.me[platform]) — your id, pinged for approvals.
  // Reuse what a prior setup already recorded so we only ask when it's genuinely unknown.
  function ownerFor(platform) { return (S.access.me && S.access.me[platform]) || ""; }
  function createChannelForm(main) {
    var d = S.draft; var g = platformGuide(d.platform);
    main.appendChild(backBtn());
    main.appendChild(header("New channel", "Pick the platform and paste the channel ID before creating."));
    main.appendChild(field("Platform", selectInput(d.platform, PLATFORM_KEYS, function (v) { d.platform = v; d.owner = ownerFor(v); S.errors = {}; render(); }, function (p) { var gg = platformGuide(p); return gg ? gg.label : p; }), g ? g.hint : null, null, "Which platform this channel lives on. Bots can only be added if they speak the same platform."));
    main.appendChild(field(g ? g.idLabel : "Channel ID", textInput(d.channelId, function (v) { d.channelId = v; S.errors = {}; }, { placeholder: g ? g.idPlaceholder : "" }), g && g.idHowto ? h("div", { class: "howto" }, [g.idHowto]) : "The platform's channel/scope identifier.", "draft.channelId", "The channel/scope id from the platform. This becomes part of the channel's identity and can't change later."));
    // Owner id is shared per platform. If a prior setup already set it, this is prefilled and you can leave it; otherwise it's required so approval pings reach you.
    main.appendChild(field(g ? g.ownerLabel : "Your user ID (owner)", textInput(d.owner, function (v) { d.owner = v; S.errors = {}; }, { placeholder: g ? g.ownerPlaceholder : "" }), ownerFor(d.platform) ? "Shared by every bot on " + d.platform + " — already set; edit to change it everywhere." : "Your id on " + d.platform + ". Approval prompts ping this id; shared by every bot on the platform.", "draft.owner", "Your own user id on this platform — the human the bots ask for approval. Set once per platform and reused."));
    main.appendChild(field("Label", textInput(d.label, function (v) { d.label = v; }), "Friendly project name for this channel (optional)."));
    main.appendChild(h("div", { class: "row", style: "margin-top:6px" }, [
      h("button", { class: "btn primary", onclick: commitChannel }, ["Create channel"]),
      h("button", { class: "btn ghost", onclick: function () { S.draft = null; S.errors = {}; render(); } }, ["Cancel"])
    ]));
  }
  function commitChannel() {
    var d = S.draft; S.errors = {};
    var id = (d.channelId || "").trim();
    if (!id) S.errors["draft.channelId"] = "Required.";
    else {
      var ck = d.platform + ":" + id;
      if (S.access.channels[ck]) S.errors["draft.channelId"] = "That channel already exists.";
    }
    // Owner id must be known so approval prompts have someone to ping. Required only when no
    // prior setup recorded one for this platform; format is validated server-side on save.
    var owner = (d.owner || "").trim();
    if (!owner && !ownerFor(d.platform)) S.errors["draft.owner"] = "Required — approval prompts ping this id.";
    if (Object.keys(S.errors).length) { render(); return; }
    if (owner) S.access.me = Object.assign({}, S.access.me, (function () { var o = {}; o[d.platform] = owner; return o; })());
    var key = d.platform + ":" + id;
    var ch = { platform: d.platform, channelId: id, members: [], collaborators: [] };
    if (d.label) ch.label = d.label.trim();
    S.access.channels[key] = ch;
    S.draft = null; S.detail = key; markDirty(); render();
  }
  function channelDetail(main, ck) {
    var ch = S.access.channels[ck];
    if (S.collabDraft && S.collabDraft.ck !== ck) S.collabDraft = null;
    main.appendChild(backBtn());
    main.appendChild(header(ch.label || ch.channelId, null));
    main.appendChild(field("Platform", textInput(ch.platform, function () {}, { readonly: true }), "Set when the channel is created.", null, "The channel's platform — fixed at creation."));
    main.appendChild(field("Channel ID", textInput(ch.channelId, function () {}, { readonly: true }), "Identity; create a new channel to change it.", "channels." + ck + ".channelId"));
    var og = platformGuide(ch.platform);
    main.appendChild(field(og ? og.ownerLabel : "Your user ID (owner)", textInput(ownerFor(ch.platform), function (v) { var t = (v || "").trim(); if (t) S.access.me = Object.assign({}, S.access.me, (function () { var o = {}; o[ch.platform] = t; return o; })()); else if (S.access.me) delete S.access.me[ch.platform]; markDirty(); }, { placeholder: og ? og.ownerPlaceholder : "" }), "Shared by every bot on " + ch.platform + " — the human pinged for approvals.", "me." + ch.platform, "Your own user id on this platform. Set once per platform and reused by every bot here."));
    main.appendChild(field("Label", textInput(ch.label || "", function (v) { if (v) ch.label = v; else delete ch.label; markDirty(); }), "Friendly project name."));
    main.appendChild(field("", toggle("Require @mention before the bot engages", ch.requireMention !== false, function (on) { ch.requireMention = on; markDirty(); })));
    main.appendChild(field("", toggle("Dedicated mesh-transport channel (no chat or tasks)", !!ch.meshTransport, function (on) { if (on) ch.meshTransport = true; else delete ch.meshTransport; markDirty(); })));

    main.appendChild(h("h2", {}, ["Bots here", helpIcon("Each bot active in this channel, its workspace, and the read-only permission profile enforced here. Edit permissions from the terminal.")]));
    var membersErr = S.errors["channels." + ck + ".members"];
    if (membersErr) main.appendChild(h("div", { class: "errmsg", style: "margin:-4px 0 10px" }, [membersErr]));
    ch.members.forEach(function (m, i) {
      main.appendChild(h("div", { class: "card static", style: "display:block" }, [
        h("div", { class: "row between" }, [
          h("div", { class: "row" }, [avatar(m.bot, true), h("span", { class: "title" }, [m.bot])]),
          h("button", { class: "btn sm danger", onclick: function () { ch.members.splice(i, 1); markDirty(); render(); } }, ["Remove"])
        ]),
        h("div", { style: "margin-top:12px" }, [field("Workspace", textInput(m.workspace, function (v) { m.workspace = v; markDirty(); }), "Absolute path this bot works in for this channel.", "channels." + ck + ".members." + m.bot + ".workspace")]),
        permissionBlock(ck, m.bot)
      ]));
    });
    var addable = Object.keys(S.access.bots).filter(function (k) { return S.access.bots[k].platform === ch.platform && !ch.members.some(function (m) { return m.bot === k; }); });
    if (addable.length) main.appendChild(adderRow("Add a bot to this channel", addable, function (botKey) { ch.members.push({ bot: botKey, workspace: S.cwd || "" }); markDirty(); render(); }));

    main.appendChild(h("h2", {}, ["Collaborators"]));
    var collabErr = S.errors["channels." + ck + ".collaborators"];
    if (collabErr) main.appendChild(h("div", { class: "errmsg", style: "margin:-4px 0 10px" }, [collabErr]));
    var chips = h("div", { class: "chips" });
    ch.collaborators.forEach(function (c, i) {
      var label = rosterLabel(c);
      chips.appendChild(h("span", { class: "chip" }, [label, h("button", { title: "Remove", onclick: function () { ch.collaborators.splice(i, 1); markDirty(); render(); } }, ["×"])]));
    });
    main.appendChild(chips);
    var rosterAddable = rosterRefs().filter(function (r) { return S.access.roster[r.kind === "human" ? "people" : "peers"][r.id].platform === ch.platform && !ch.collaborators.some(function (c) { return c.kind === r.kind && c.id === r.id; }); });
    if (rosterAddable.length) main.appendChild(adderRow("Add an existing collaborator", rosterAddable.map(function (r) { return r.kind + ":" + r.id; }), function (val) { var p = val.split(":"); ch.collaborators.push({ kind: p[0], id: p[1] }); markDirty(); render(); }, function (val) { var p = val.split(":"); return rosterLabel({ kind: p[0], id: p[1] }); }));
    // Register a brand-new person/peer right here — no round-trip to the Roster tab.
    main.appendChild(h("div", { class: "row wrap", style: "margin-top:10px;gap:8px" }, [
      h("button", { class: "btn sm addbtn", onclick: function () { S.collabDraft = { kind: "human", ck: ck, userId: "", label: "" }; render(); } }, ["+ New person"]),
      h("button", { class: "btn sm addbtn", onclick: function () { S.collabDraft = { kind: "peer", ck: ck, userId: "", label: "", blurb: "" }; render(); } }, ["+ New peer bot"])
    ]));
    if (S.collabDraft && S.collabDraft.ck === ck) main.appendChild(newCollaboratorForm(ck));

    main.appendChild(h("div", { style: "margin-top:28px" }, [h("button", { class: "btn danger", onclick: function () { delete S.access.channels[ck]; S.detail = null; markDirty(); render(); } }, ["Remove channel"])]));
  }
  // Read-only permission profile, explained in plain language, + "edit in terminal" handoff.
  function permissionBlock(ck, bot) {
    var rp = S.perms[ck] && S.perms[ck][bot];
    var head = h("div", { class: "row between", style: "margin-top:14px" }, [
      h("div", { class: "row" }, [h("span", { style: "font-weight:560;font-size:13px" }, ["What this bot may do"]), helpIcon("A preset decides what the bot can do here: read files, make edits, run shell commands. Read-only on this page — click \\"Edit in terminal\\" to change it safely.")]),
      h("button", { class: "btn sm", disabled: !!S.handoff, onclick: function () { handoff("edit-permissions", bot, "channel"); } }, ["Edit in terminal"])
    ]);
    var body;
    if (!rp || !rp.preset) {
      // No preset yet → the runtime falls back to the deny-floor (it can do almost nothing). Say
      // that plainly and show the realistic options, rather than dumping a 40-line deny list.
      body = h("div", {}, [
        h("div", { class: "info", style: "margin-top:8px" }, [
          h("b", {}, ["No permission preset chosen yet."]),
          " Until you pick one, this bot is held to the safe floor — it can't edit files, run commands, or touch secrets. Click ",
          h("b", {}, ["Edit in terminal"]),
          " and choose one (recommended: " + S.defaultPreset + ")."
        ]),
        presetReference()
      ]);
    } else {
      var hint = (S.presets && S.presets[rp.preset]) || "";
      var details = h("details", { style: "margin-top:10px" }, [
        h("summary", { style: "cursor:pointer;color:var(--muted);font-size:12.5px" }, ["Show the exact allow / ask / deny rules"]),
        h("div", { style: "margin-top:10px" }, [
          permRow("Allowed (runs without asking)", rp.allow, ""),
          permRow("Asks you first", rp.ask, "ask"),
          permRow("Denied (always blocked)", rp.deny, "deny")
        ])
      ]);
      body = h("div", { style: "margin-top:8px" }, [
        h("div", { class: "row wrap", style: "gap:8px" }, [h("span", { class: "pill solid" }, [rp.preset]), hint ? h("span", { class: "hint" }, [hint]) : null]),
        details
      ]);
    }
    return h("div", {}, [head, body]);
  }
  // The four built-in presets in one place, each with its plain-language one-liner.
  function presetReference() {
    var names = ["strict", "ask-per-edit", "auto", "bypass"];
    var rows = h("div", { style: "margin-top:8px;display:flex;flex-direction:column;gap:7px" });
    names.forEach(function (n) {
      rows.appendChild(h("div", { class: "row", style: "gap:9px;align-items:baseline" }, [
        h("span", { class: "pill" }, [n]),
        h("span", { class: "hint" }, [(S.presets && S.presets[n]) || ""])
      ]));
    });
    return h("div", { style: "margin-top:12px" }, [h("div", { class: "hint", style: "font-weight:560;color:var(--text)" }, ["The presets you can choose from"]), rows]);
  }
  function permRow(label, items, cls) {
    items = items || [];
    var chips = h("div", { class: "chips", style: "margin-top:4px" });
    if (!items.length) chips.appendChild(h("span", { class: "hint" }, ["—"]));
    items.forEach(function (it) { chips.appendChild(h("span", { class: "chip ro " + cls }, [it])); });
    return h("div", { style: "margin-bottom:8px" }, [h("div", { class: "hint", style: "font-weight:560;color:var(--muted)" }, [label]), chips]);
  }

  // ── ROSTER ──
  function viewRoster(main) {
    if (S.detail && (S.access.roster.people[S.detail.split(":")[1]] || S.access.roster.peers[S.detail.split(":")[1]])) return rosterDetail(main, S.detail);
    main.appendChild(header("Roster", "People and peer bots your bots can collaborate with, referenced from channels.", "The roster is the address book. You add a person or peer bot once here, then reference them from any channel as a collaborator."));
    section(main, "People", S.access.roster.people, "human");
    section(main, "Peer bots", S.access.roster.peers, "peer");
    function section(root, title, map, kind) {
      root.appendChild(h("h2", {}, [title]));
      var keys = Object.keys(map);
      if (!keys.length) root.appendChild(h("p", { class: "hint" }, ["None yet."]));
      var list = h("div", { class: "list" });
      keys.forEach(function (id) {
        var x = map[id];
        list.appendChild(h("div", { class: "card", onclick: function () { S.detail = kind + ":" + id; S.errors = {}; render(); } }, [
          h("div", { class: "row" }, [avatar(x.label || x.userId), h("div", {}, [h("div", { class: "title" }, [x.label || x.userId]), h("div", { class: "meta" }, [x.userId])])]),
          h("span", { class: "pill" }, [x.platform])
        ]));
      });
      root.appendChild(list);
      root.appendChild(h("button", { class: "btn addbtn", style: "margin:10px 0 4px", onclick: function () { addRoster(kind); } }, ["+ Add " + (kind === "human" ? "person" : "peer bot")]));
    }
  }
  function rosterDetail(main, ref) {
    var parts = ref.split(":"); var kind = parts[0]; var id = parts[1];
    var map = S.access.roster[kind === "human" ? "people" : "peers"]; var x = map[id];
    main.appendChild(backBtn());
    main.appendChild(header(x.label || x.userId, null));
    main.appendChild(field("Platform", selectInput(x.platform, PLATFORM_KEYS, function (v) { x.platform = v; markDirty(); }, function (p) { var g = platformGuide(p); return g ? g.label : p; }), "Which platform this identity is on."));
    main.appendChild(field("User ID", textInput(x.userId, function (v) { x.userId = v; markDirty(); }), "The platform user ID.", "roster." + (kind === "human" ? "people" : "peers") + "." + id, "The collaborator's id on the platform — see the platform's notes under Bots for how to copy it."));
    main.appendChild(field("Label", textInput(x.label || "", function (v) { if (v) x.label = v; else delete x.label; markDirty(); }), "Friendly name."));
    if (kind === "peer") main.appendChild(field("What it does", textInput(x.blurb || "", function (v) { x.blurb = v; markDirty(); }), "One-line capability description."));
    main.appendChild(h("button", { class: "btn danger", onclick: function () { removeRoster(kind, id); } }, ["Remove from roster"]));
  }
  function addRoster(kind) {
    var map = S.access.roster[kind === "human" ? "people" : "peers"];
    var id = uniqueKey(kind, map);
    map[id] = kind === "human" ? { platform: "discord", userId: "" } : { platform: "discord", userId: "", blurb: "" };
    S.detail = kind + ":" + id; markDirty(); render();
  }
  function removeRoster(kind, id) {
    delete S.access.roster[kind === "human" ? "people" : "peers"][id];
    Object.values(S.access.channels).forEach(function (ch) {
      ch.collaborators = ch.collaborators.filter(function (c) { return !(c.kind === kind && c.id === id); });
    });
    S.detail = null; markDirty(); render();
  }
  function rosterRefs() {
    return Object.keys(S.access.roster.people).map(function (id) { return { kind: "human", id: id }; })
      .concat(Object.keys(S.access.roster.peers).map(function (id) { return { kind: "peer", id: id }; }));
  }
  function rosterLabel(c) {
    var map = S.access.roster[c.kind === "human" ? "people" : "peers"]; var x = map[c.id];
    return (c.kind === "human" ? "person · " : "peer · ") + (x ? (x.label || x.userId) : c.id);
  }
  // Register a new person/peer AND attach it to this channel in one step (no Roster round-trip).
  function newCollaboratorForm(ck) {
    var d = S.collabDraft; var ch = S.access.channels[ck]; var g = platformGuide(ch.platform);
    return h("div", { class: "card static", style: "display:block;margin-top:10px" }, [
      h("div", { class: "row", style: "gap:8px;margin-bottom:8px" }, [h("span", { class: "title" }, [d.kind === "human" ? "New person" : "New peer bot"]), h("span", { class: "pill" }, [ch.platform])]),
      field(g ? g.memberIdLabel : "User ID", textInput(d.userId, function (v) { d.userId = v; S.errors = {}; }), "Their id on " + ch.platform + ".", "collab.userId", "The collaborator's user id on this platform. It is added to your roster and attached here at once."),
      field("Label", textInput(d.label, function (v) { d.label = v; }), "Friendly name (optional)."),
      d.kind === "peer" ? field("What it does", textInput(d.blurb, function (v) { d.blurb = v; }), "One-line capability description — your bot reads this to know who to @mention.") : null,
      h("div", { class: "row", style: "gap:8px" }, [
        h("button", { class: "btn sm primary", onclick: function () { commitCollaborator(ck); } }, ["Add to channel"]),
        h("button", { class: "btn sm ghost", onclick: function () { S.collabDraft = null; S.errors = {}; render(); } }, ["Cancel"])
      ])
    ]);
  }
  function commitCollaborator(ck) {
    var d = S.collabDraft; var ch = S.access.channels[ck]; S.errors = {};
    var uid = (d.userId || "").trim();
    if (!uid) { S.errors["collab.userId"] = "Required."; render(); return; }
    var map = S.access.roster[d.kind === "human" ? "people" : "peers"];
    var id = uniqueKey(slugLocal(d.label || uid || d.kind), map);
    var entry = { platform: ch.platform, userId: uid };
    if (d.label) entry.label = d.label.trim();
    if (d.kind === "peer") entry.blurb = (d.blurb || "").trim();
    map[id] = entry;
    ch.collaborators.push({ kind: d.kind, id: id });
    S.collabDraft = null; markDirty(); render();
    toast("Added to your roster and this channel.", false);
  }
  function slugLocal(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "id"; }

  // ── PREFERENCES ──
  function viewPrefs(main) {
    main.appendChild(header("Preferences", "Cross-channel defaults."));
    var a = S.access;
    main.appendChild(h("h2", {}, ["Mention patterns", helpIcon("Extra names your bots answer to beyond a literal @mention — e.g. a nickname.")]));
    var chips = h("div", { class: "chips" });
    (a.mentionPatterns || []).forEach(function (p, i) {
      chips.appendChild(h("span", { class: "chip" }, [p, h("button", { onclick: function () { a.mentionPatterns.splice(i, 1); if (!a.mentionPatterns.length) delete a.mentionPatterns; markDirty(); render(); } }, ["×"])]));
    });
    main.appendChild(chips);
    var inp = textInput("", function () {}, { placeholder: "type a pattern, press Enter" });
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter" && inp.value.trim()) { a.mentionPatterns = (a.mentionPatterns || []).concat(inp.value.trim()); markDirty(); render(); } });
    main.appendChild(h("div", { style: "max-width:340px;margin-top:10px" }, [inp]));
    main.appendChild(h("h2", {}, ["Acknowledgement reaction", helpIcon("Emoji name the bot reacts with to show it saw a message.")]));
    main.appendChild(field("", textInput(a.ackReaction || "", function (v) { if (v) a.ackReaction = v; else delete a.ackReaction; markDirty(); }, { placeholder: "e.g. eyes" }), "Emoji name the bot reacts with to acknowledge a message."));
  }

  // ── LEDGER (separate write path) ──
  function viewLedger(main) {
    main.appendChild(header("Ledger", "Where shared coordination state is stored. Saved independently of the rest.", "SQLite keeps everything local; Postgres lets multiple operators share coordination state."));
    var backend = (S.ledger && S.ledger.backend) || "sqlite";
    var url = (S.ledger && S.ledger.url) || "";
    var local = { backend: backend, url: url };
    main.appendChild(field("Backend", selectInput(local.backend, ["sqlite", "postgres"], function (v) { local.backend = v; renderUrl(); }), "SQLite is local; Postgres enables collaboration."));
    var urlWrap = h("div", {});
    main.appendChild(urlWrap);
    var status = h("div", { class: "hint", style: "margin:12px 0" });
    main.appendChild(status);
    main.appendChild(h("button", { class: "btn primary", onclick: saveLedger }, ["Save ledger backend"]));
    renderUrl();
    function renderUrl() {
      clr(urlWrap);
      if (local.backend === "postgres") urlWrap.appendChild(field("Connection URL", textInput(local.url, function (v) { local.url = v; }, { placeholder: "postgres://user:pass@host/db" }), "Required for Postgres.", "url"));
    }
    function saveLedger() {
      status.textContent = "";
      api("/api/ledger", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(local) })
        .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
        .then(function (res) {
          if (res.status === 200) { S.ledger = { backend: local.backend }; if (local.url) S.ledger.url = local.url; toast("Ledger backend saved.", false); }
          else { status.textContent = (res.body.fields && res.body.fields[0]) ? res.body.fields[0].message : "Save failed."; }
        }).catch(function () { status.textContent = "Save failed."; });
    }
  }

  // ── shared bits ──
  function toggle(labelText, on, onchange) {
    var cb = h("input", { type: "checkbox" }); cb.checked = on;
    cb.addEventListener("change", function () { onchange(cb.checked); });
    return h("label", { class: "toggle" }, [cb, h("span", {}, [labelText])]);
  }
  function emptyState(title, sub) { return h("div", { class: "empty" }, [h("b", {}, [title]), sub]); }
  function adderRow(labelText, values, onpick, labeller) {
    var sel = h("select", {});
    sel.appendChild(h("option", { value: "" }, [labelText]));
    values.forEach(function (v) { sel.appendChild(h("option", { value: v }, [labeller ? labeller(v) : v])); });
    sel.addEventListener("change", function () { if (sel.value) onpick(sel.value); });
    return h("div", { style: "max-width:340px;margin-top:10px" }, [sel]);
  }
  function uniqueKey(base, map) { var k = base, n = 2; while (map[k]) { k = base + "-" + n; n++; } return k; }

  document.getElementById("save").addEventListener("click", save);
  document.getElementById("discard").addEventListener("click", function () { reloadFromDisk(); });
  load();
})();
</script>
</body>
</html>`
