/**
 * settings-ui.ts — the embedded single-page settings UI served by settings-server.ts.
 *
 * Exported as a string constant (not a separate .html + `with { type: 'file' }` import) so it
 * bundles into `bun build --compile` with the same static-literal guarantee build.sh relies on
 * for the dynamic CLI imports — no embedded-asset resolution to verify per target.
 *
 * One self-contained document: no framework, no external fonts/CDN (so the per-run token can't
 * leak via a third-party request), system font stack, one accent, dark/light via
 * prefers-color-scheme. The inline <script> reads the token from the URL once, strips it from
 * the address bar, and talks to the token-gated JSON API. It deliberately uses no backticks or
 * ${...} so it never collides with this outer template literal.
 */

export const SETTINGS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>knock-knock settings</title>
<style>
  :root {
    --bg: #fafafa; --surface: #ffffff; --surface-2: #f4f4f5;
    --text: #18181b; --muted: #71717a; --faint: #a1a1aa;
    --border: #e4e4e7; --accent: #2563eb; --accent-fg: #ffffff;
    --danger: #b91c1c; --ok: #15803d; --warn-bg: #fef3c7; --warn-fg: #92400e;
    --radius: 9px; --r-sm: 6px; --gap: 14px;
    --shadow: 0 1px 2px rgba(24,24,27,.06), 0 8px 24px rgba(24,24,27,.05);
    --speed: 150ms;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e0e10; --surface: #161618; --surface-2: #1d1d20;
      --text: #f4f4f5; --muted: #a1a1aa; --faint: #71717a;
      --border: #2a2a2e; --accent: #5b9aff; --accent-fg: #0e0e10;
      --danger: #f87171; --ok: #4ade80; --warn-bg: #3a2f12; --warn-fg: #fcd34d;
      --shadow: 0 1px 2px rgba(0,0,0,.3), 0 10px 30px rgba(0,0,0,.35);
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .app { display: grid; grid-template-columns: 248px 1fr; min-height: 100dvh; }
  /* ── Sidebar ── */
  aside {
    border-right: 1px solid var(--border); padding: 22px 14px; background: var(--surface);
    display: flex; flex-direction: column; gap: 4px;
  }
  .brand { display: flex; align-items: center; gap: 9px; padding: 0 8px 18px; }
  .brand .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); }
  .brand b { font-weight: 600; letter-spacing: -.01em; }
  .brand span { color: var(--faint); font-size: 12px; }
  .navgroup { color: var(--faint); font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; padding: 16px 8px 6px; }
  .navitem {
    display: flex; justify-content: space-between; align-items: center; gap: 8px;
    width: 100%; text-align: left; border: 0; background: transparent; color: var(--text);
    padding: 8px 10px; border-radius: var(--r-sm); cursor: pointer; font-size: 13.5px;
    transition: background var(--speed) ease;
  }
  .navitem:hover { background: var(--surface-2); }
  .navitem[aria-current="true"] { background: var(--surface-2); font-weight: 600; }
  .navitem .count { color: var(--faint); font-size: 12px; font-variant-numeric: tabular-nums; }
  /* ── Main ── */
  main { padding: 30px 36px 120px; max-width: 860px; }
  .head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 4px; }
  h1 { font-size: 21px; font-weight: 650; letter-spacing: -.02em; margin: 0; }
  h2 { font-size: 15px; font-weight: 600; margin: 26px 0 10px; letter-spacing: -.01em; }
  .sub { color: var(--muted); margin: 2px 0 22px; }
  .row { display: flex; align-items: center; gap: 10px; }
  .between { justify-content: space-between; }
  /* ── List (master) ── */
  .list { display: flex; flex-direction: column; gap: 7px; }
  .card {
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
    padding: 13px 15px; display: flex; align-items: center; justify-content: space-between; gap: 12px;
    cursor: pointer; transition: border-color var(--speed) ease, transform var(--speed) ease;
  }
  .card:hover { border-color: var(--accent); }
  .card:active { transform: translateY(1px); }
  .card .title { font-weight: 550; }
  .card .meta { color: var(--muted); font-size: 12.5px; margin-top: 2px; }
  .pill { font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 2px 9px; background: var(--surface-2); }
  /* ── Detail form ── */
  .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
  .field label { font-weight: 550; font-size: 13px; }
  .field .hint { color: var(--muted); font-size: 12.5px; }
  input[type=text], select, textarea {
    width: 100%; font: inherit; color: var(--text); background: var(--surface);
    border: 1px solid var(--border); border-radius: var(--r-sm); padding: 9px 11px;
    transition: border-color var(--speed) ease, box-shadow var(--speed) ease;
  }
  input:focus, select:focus, textarea:focus {
    outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
  }
  input[readonly] { background: var(--surface-2); color: var(--muted); }
  .field.err input, .field.err select { border-color: var(--danger); }
  .field .errmsg { color: var(--danger); font-size: 12.5px; }
  .toggle { display: flex; align-items: center; gap: 10px; cursor: pointer; }
  .toggle input { width: auto; }
  /* ── Buttons ── */
  button.btn {
    font: inherit; font-weight: 550; border-radius: var(--r-sm); padding: 9px 15px; cursor: pointer;
    border: 1px solid var(--border); background: var(--surface); color: var(--text);
    transition: transform var(--speed) ease, background var(--speed) ease, border-color var(--speed) ease, opacity var(--speed) ease;
  }
  button.btn:hover { background: var(--surface-2); }
  button.btn:active { transform: translateY(1px); }
  button.btn.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
  button.btn.primary:hover { filter: brightness(1.06); background: var(--accent); }
  button.btn.ghost { border-color: transparent; color: var(--muted); }
  button.btn.danger { color: var(--danger); border-color: transparent; }
  button.btn.danger:hover { background: color-mix(in srgb, var(--danger) 12%, transparent); }
  button.btn:disabled { opacity: .55; cursor: default; transform: none; }
  .btn.sm { padding: 5px 10px; font-size: 12.5px; }
  .addbtn { color: var(--accent); border: 1px dashed var(--border); background: transparent; }
  .addbtn:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 7%, transparent); }
  /* ── Save bar ── */
  .savebar {
    position: fixed; left: 248px; right: 0; bottom: 0; padding: 14px 36px;
    background: color-mix(in srgb, var(--surface) 86%, transparent); backdrop-filter: blur(8px);
    border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 14px;
    transform: translateY(120%); transition: transform 220ms cubic-bezier(.16,1,.3,1);
  }
  .savebar.show { transform: translateY(0); }
  .savebar .note { color: var(--muted); font-size: 13px; }
  .spinner { width: 14px; height: 14px; border: 2px solid var(--accent-fg); border-top-color: transparent; border-radius: 50%; display: inline-block; vertical-align: -2px; margin-right: 7px; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* ── Toast + conflict banner ── */
  .toast {
    position: fixed; right: 22px; bottom: 86px; background: var(--surface); color: var(--text);
    border: 1px solid var(--border); border-left: 3px solid var(--ok); border-radius: var(--radius);
    padding: 12px 16px; box-shadow: var(--shadow); opacity: 0; transform: translateY(8px);
    transition: opacity 200ms ease, transform 200ms ease; pointer-events: none; max-width: 340px;
  }
  .toast.show { opacity: 1; transform: translateY(0); }
  .toast.err { border-left-color: var(--danger); }
  .banner {
    background: var(--warn-bg); color: var(--warn-fg); border: 1px solid color-mix(in srgb, var(--warn-fg) 30%, transparent);
    border-radius: var(--radius); padding: 13px 16px; margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between; gap: 14px;
  }
  .banner .row { gap: 8px; }
  /* ── States ── */
  .empty { text-align: center; color: var(--muted); padding: 60px 20px; border: 1px dashed var(--border); border-radius: var(--radius); }
  .empty b { color: var(--text); display: block; margin-bottom: 6px; font-weight: 600; }
  .skel { height: 56px; border-radius: var(--radius); background: linear-gradient(90deg, var(--surface-2) 25%, var(--border) 50%, var(--surface-2) 75%); background-size: 200% 100%; animation: sh 1.3s ease infinite; margin-bottom: 8px; }
  @keyframes sh { to { background-position: -200% 0; } }
  .back { color: var(--muted); background: transparent; border: 0; cursor: pointer; font: inherit; padding: 0 0 14px; }
  .back:hover { color: var(--text); }
  .chips { display: flex; flex-wrap: wrap; gap: 7px; }
  .chip { display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--border); border-radius: 999px; padding: 4px 6px 4px 11px; background: var(--surface-2); font-size: 12.5px; }
  .chip button { border: 0; background: transparent; color: var(--faint); cursor: pointer; font-size: 14px; line-height: 1; padding: 0 2px; }
  .chip button:hover { color: var(--danger); }
  code.env { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-sm); padding: 2px 7px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
  @media (max-width: 760px) {
    .app { grid-template-columns: 1fr; }
    aside { border-right: 0; border-bottom: 1px solid var(--border); }
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

  // ── Token: read once from the URL, hold in memory, strip from the address bar (R19). ──
  var params = new URLSearchParams(location.search);
  var TOKEN = params.get("token") || "";
  if (location.search) history.replaceState(null, "", location.pathname);

  var GROUPS = [
    { key: "bots", label: "Bots" },
    { key: "channels", label: "Channels" },
    { key: "roster", label: "Roster" },
    { key: "preferences", label: "Preferences" },
    { key: "ledger", label: "Ledger" }
  ];
  var PLATFORMS = ["discord", "slack", "telegram", "github", "notion"];

  var S = {
    loading: true, error: null, access: null, ledger: null, version: null,
    dirty: false, saving: false, conflict: false,
    group: "bots", detail: null, errors: {}
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

  // ── data load ──
  function load() {
    S.loading = true; render();
    api("/api/config").then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (data) {
      S.access = data.access; S.ledger = data.ledger; S.version = data.version;
      S.loading = false; S.error = null; S.dirty = false; S.conflict = false; S.errors = {};
      render();
    }).catch(function (e) {
      S.loading = false; S.error = String(e); render();
    });
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
        toast("Settings saved.", false); render();
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

  // On a 409 we keep the in-progress edits; the user chooses. "Reload" discards them
  // deliberately and pulls the on-disk version; "Keep editing" lets them Save again
  // (which will 409 again until they reload). Their work is never silently dropped.
  function reloadFromDisk() { S.conflict = false; load(); }

  function toast(msg, isErr) {
    var t = document.getElementById("toast");
    t.textContent = msg; t.className = "toast" + (isErr ? " err" : "") + " show";
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = "toast" + (isErr ? " err" : ""); }, 2600);
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
    if (S.loading) { main.appendChild(skeleton()); return; }
    if (S.error) { main.appendChild(h("div", { class: "empty" }, [h("b", {}, ["Could not load settings"]), S.error])); return; }
    if (S.conflict) main.appendChild(conflictBanner());
    var fn = ({ bots: viewBots, channels: viewChannels, roster: viewRoster, preferences: viewPrefs, ledger: viewLedger })[S.group];
    fn(main);
    syncSaveBar();
  }

  function renderNav() {
    var nav = document.getElementById("nav"); clr(nav);
    nav.appendChild(h("div", { class: "brand" }, [h("span", { class: "dot" }), h("b", {}, ["knock-knock"]), h("span", {}, ["settings"])]));
    GROUPS.forEach(function (g) {
      nav.appendChild(h("button", {
        class: "navitem", "aria-current": String(S.group === g.key),
        onclick: function () { S.group = g.key; S.detail = null; S.errors = {}; render(); }
      }, [h("span", {}, [g.label]), h("span", { class: "count" }, [countFor(g.key)])]));
    });
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
  function header(title, sub) {
    return h("div", {}, [h("div", { class: "head" }, [h("h1", {}, [title])]), sub ? h("p", { class: "sub" }, [sub]) : null]);
  }
  function backBtn() { return h("button", { class: "back", onclick: function () { S.detail = null; S.errors = {}; render(); } }, ["← Back"]); }
  function field(labelText, control, hint, errKey) {
    var err = errKey && S.errors[errKey];
    return h("div", { class: "field" + (err ? " err" : "") }, [
      h("label", {}, [labelText]), control,
      hint ? h("div", { class: "hint" }, [hint]) : null,
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
  function selectInput(value, options, oninput) {
    var sel = h("select", {});
    options.forEach(function (o) {
      var opt = h("option", { value: o }, [o]); if (o === value) opt.selected = true; sel.appendChild(opt);
    });
    sel.addEventListener("change", function () { oninput(sel.value); });
    return sel;
  }

  // ── BOTS ──
  function viewBots(main) {
    var bots = S.access.bots;
    if (S.detail && bots[S.detail]) return botDetail(main, S.detail);
    main.appendChild(header("Bots", "The agent identities you run. Token values are managed in the terminal; the UI shows only which env var holds each one."));
    var keys = Object.keys(bots);
    if (!keys.length) main.appendChild(emptyState("No bots yet.", "Add a bot, then save."));
    var list = h("div", { class: "list" });
    keys.forEach(function (k) {
      var b = bots[k];
      list.appendChild(h("div", { class: "card", onclick: function () { S.detail = k; S.errors = {}; render(); } }, [
        h("div", {}, [h("div", { class: "title" }, [k]), h("div", { class: "meta" }, [(b.displayName ? b.displayName + " · " : "") + (b.runtime || "")])]),
        h("span", { class: "pill" }, [b.platform])
      ]));
    });
    main.appendChild(list);
    main.appendChild(h("button", { class: "btn addbtn", style: "margin-top:12px", onclick: addBot }, ["+ Add bot"]));
  }
  function botDetail(main, key) {
    var b = S.access.bots[key];
    main.appendChild(backBtn());
    main.appendChild(header(key, null));
    main.appendChild(field("Platform", textInput(b.platform, function () {}, { readonly: true }), "Set when the bot is created."));
    main.appendChild(field("Token env var", h("div", {}, [h("code", { class: "env" }, [b.tokenEnv])]), "The name of the env var holding this bot's token. The value lives in the terminal, never here."));
    main.appendChild(field("Coding agent (runtime)", textInput(b.runtime, function (v) { b.runtime = v; markDirty(); }), "e.g. claude-sdk", "bots." + key));
    main.appendChild(field("Display name", textInput(b.displayName || "", function (v) { if (v) b.displayName = v; else delete b.displayName; markDirty(); }), "Cosmetic; usually fetched from the platform."));
    main.appendChild(field("Default blurb", textInput(b.blurb || "", function (v) { if (v) b.blurb = v; else delete b.blurb; markDirty(); }), "One-line capability description."));
    main.appendChild(h("button", { class: "btn danger", onclick: function () { removeBot(key); } }, ["Remove bot"]));
  }
  function addBot() {
    var key = uniqueKey("bot", S.access.bots);
    S.access.bots[key] = { platform: "discord", tokenEnv: "DISCORD_BOT_TOKEN", runtime: "claude-sdk" };
    S.detail = key; markDirty(); render();
  }
  function removeBot(key) {
    delete S.access.bots[key];
    // keep config valid: drop this bot from every channel's members (mirrors the runtime contract)
    Object.values(S.access.channels).forEach(function (ch) {
      ch.members = ch.members.filter(function (m) { return m.bot !== key; });
    });
    S.detail = null; markDirty(); render();
  }

  // ── CHANNELS ──
  function viewChannels(main) {
    var chans = S.access.channels;
    if (S.detail && chans[S.detail]) return channelDetail(main, S.detail);
    main.appendChild(header("Channels", "Each channel is a project and a permission boundary. Add the bots that work here and the people or peer bots they collaborate with."));
    var keys = Object.keys(chans);
    if (!keys.length) main.appendChild(emptyState("No channels yet.", "Add a channel, then save."));
    var list = h("div", { class: "list" });
    keys.forEach(function (ck) {
      var ch = chans[ck];
      list.appendChild(h("div", { class: "card", onclick: function () { S.detail = ck; S.errors = {}; render(); } }, [
        h("div", {}, [h("div", { class: "title" }, [ch.label || ch.channelId]), h("div", { class: "meta" }, [ch.members.length + " bot(s) · " + ch.collaborators.length + " collaborator(s)"])]),
        h("span", { class: "pill" }, [ch.platform])
      ]));
    });
    main.appendChild(list);
    main.appendChild(h("button", { class: "btn addbtn", style: "margin-top:12px", onclick: addChannel }, ["+ Add channel"]));
  }
  function channelDetail(main, ck) {
    var ch = S.access.channels[ck];
    main.appendChild(backBtn());
    main.appendChild(header(ch.label || ch.channelId, null));
    main.appendChild(field("Platform", textInput(ch.platform, function () {}, { readonly: true }), "Set when the channel is created."));
    main.appendChild(field("Channel ID", textInput(ch.channelId, function () {}, { readonly: true }), "Identity; create a new channel to change it.", "channels." + ck + ".channelId"));
    main.appendChild(field("Label", textInput(ch.label || "", function (v) { if (v) ch.label = v; else delete ch.label; markDirty(); }), "Friendly project name."));
    main.appendChild(field("", toggle("Require @mention before the bot engages", ch.requireMention !== false, function (on) { ch.requireMention = on; markDirty(); })));
    main.appendChild(field("", toggle("Dedicated mesh-transport channel (no chat or tasks)", !!ch.meshTransport, function (on) { if (on) ch.meshTransport = true; else delete ch.meshTransport; markDirty(); })));

    main.appendChild(h("h2", {}, ["Bots here"]));
    var membersErr = S.errors["channels." + ck + ".members"];
    if (membersErr) main.appendChild(h("div", { class: "errmsg", style: "margin:-4px 0 10px" }, [membersErr]));
    ch.members.forEach(function (m, i) {
      main.appendChild(h("div", { class: "card", style: "cursor:default;display:block" }, [
        h("div", { class: "row between" }, [h("span", { class: "title" }, [m.bot]), h("button", { class: "btn sm danger", onclick: function () { ch.members.splice(i, 1); markDirty(); render(); } }, ["Remove"])]),
        h("div", { style: "margin-top:10px" }, [field("Workspace", textInput(m.workspace, function (v) { m.workspace = v; markDirty(); }), "Absolute path this bot works in for this channel.", "channels." + ck + ".members." + m.bot + ".workspace")])
      ]));
    });
    var addable = Object.keys(S.access.bots).filter(function (k) { return S.access.bots[k].platform === ch.platform && !ch.members.some(function (m) { return m.bot === k; }); });
    if (addable.length) main.appendChild(adderRow("Add a bot to this channel", addable, function (botKey) { ch.members.push({ bot: botKey, workspace: "" }); markDirty(); render(); }));

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
    if (rosterAddable.length) main.appendChild(adderRow("Add a collaborator", rosterAddable.map(function (r) { return r.kind + ":" + r.id; }), function (val) { var p = val.split(":"); ch.collaborators.push({ kind: p[0], id: p[1] }); markDirty(); render(); }, function (val) { var p = val.split(":"); return rosterLabel({ kind: p[0], id: p[1] }); }));
    else if (!rosterRefs().length) main.appendChild(h("p", { class: "hint" }, ["Add people or peer bots under Roster first."]));

    main.appendChild(h("div", { style: "margin-top:26px" }, [h("button", { class: "btn danger", onclick: function () { delete S.access.channels[ck]; S.detail = null; markDirty(); render(); } }, ["Remove channel"])]));
  }
  function addChannel() {
    var platform = Object.values(S.access.bots)[0] ? Object.values(S.access.bots)[0].platform : "discord";
    var id = "";
    var ck = uniqueKey(platform + ":new", S.access.channels);
    S.access.channels[ck] = { platform: platform, channelId: id, members: [], collaborators: [] };
    S.detail = ck; markDirty(); render();
    toast("Set the channel ID and platform, then save.", false);
  }

  // ── ROSTER ──
  function viewRoster(main) {
    if (S.detail && (S.access.roster.people[S.detail.split(":")[1]] || S.access.roster.peers[S.detail.split(":")[1]])) return rosterDetail(main, S.detail);
    main.appendChild(header("Roster", "People and peer bots your bots can collaborate with, referenced from channels."));
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
          h("div", {}, [h("div", { class: "title" }, [x.label || x.userId]), h("div", { class: "meta" }, [x.userId])]),
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
    main.appendChild(field("Platform", selectInput(x.platform, PLATFORMS, function (v) { x.platform = v; markDirty(); }), "Which platform this identity is on."));
    main.appendChild(field("User ID", textInput(x.userId, function (v) { x.userId = v; markDirty(); }), "The platform user ID.", "roster." + (kind === "human" ? "people" : "peers") + "." + id));
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
    // cascade: drop from every channel's collaborators (mirrors lib.removeRosterEntry)
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
    return (c.kind === "human" ? "👤 " : "🤖 ") + (x ? (x.label || x.userId) : c.id);
  }

  // ── PREFERENCES ──
  function viewPrefs(main) {
    main.appendChild(header("Preferences", "Cross-channel defaults."));
    var a = S.access;
    main.appendChild(h("h2", {}, ["Mention patterns"]));
    main.appendChild(h("p", { class: "hint", style: "margin-top:-4px" }, ["Extra names your bots respond to beyond an @mention."]));
    var chips = h("div", { class: "chips" });
    (a.mentionPatterns || []).forEach(function (p, i) {
      chips.appendChild(h("span", { class: "chip" }, [p, h("button", { onclick: function () { a.mentionPatterns.splice(i, 1); if (!a.mentionPatterns.length) delete a.mentionPatterns; markDirty(); render(); } }, ["×"])]));
    });
    main.appendChild(chips);
    var inp = textInput("", function () {}, { placeholder: "type a pattern, press Enter" });
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter" && inp.value.trim()) { a.mentionPatterns = (a.mentionPatterns || []).concat(inp.value.trim()); markDirty(); render(); } });
    main.appendChild(h("div", { style: "max-width:340px;margin-top:10px" }, [inp]));
    main.appendChild(h("h2", {}, ["Acknowledgement reaction"]));
    main.appendChild(field("", textInput(a.ackReaction || "", function (v) { if (v) a.ackReaction = v; else delete a.ackReaction; markDirty(); }, { placeholder: "e.g. eyes" }), "Emoji name the bot reacts with to acknowledge a message."));
  }

  // ── LEDGER (separate write path) ──
  function viewLedger(main) {
    main.appendChild(header("Ledger", "Where shared coordination state is stored. Saved independently of the rest."));
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
