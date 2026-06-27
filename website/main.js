/* ════════════════════════════════════════════════════════════════
   knock-knock — site interactions
   GSAP ScrollTrigger drives the pinned chat scrollytelling. Everything
   else is IntersectionObserver + light DOM. Native scrolling, no hijack.
   Respects prefers-reduced-motion (or ?static=1).
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    || /[?&]static=1\b/.test(location.search);
  const hasGSAP = typeof gsap !== 'undefined' && typeof ScrollTrigger !== 'undefined';

  /* ─────────────  COPY BUTTONS  ───────────── */
  document.querySelectorAll('.code[data-copy]').forEach((block) => {
    const btn = block.querySelector('.copy');
    const codeEl = block.querySelector('code');
    if (!btn || !codeEl) return;
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(codeEl.innerText);
      } catch (_) {
        const r = document.createRange(); r.selectNodeContents(codeEl);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        try { document.execCommand('copy'); } catch (e) {}
        s.removeAllRanges();
      }
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1600);
    });
  });

  /* ─────────────  PERMISSION CONSOLE  ─────────────
     One dial drives the tool→tier pills, the live profile JSON, and an
     approval-card preview. The dial and the tiers are the same widget. */
  (function initPermConsole() {
    const console_ = document.getElementById('permConsole');
    if (!console_) return;
    const hasAnime = typeof anime !== 'undefined';

    const PRESETS = {
      strict: {
        summary: 'It can look, but never touch.',
        tiers: { read: 'allow', edit: 'deny', shell: 'deny', share: 'deny' },
        card: { state: 'deny', tool: 'Edit', arg: 'gateway/auth.py', foot: 'Writes are refused outright. A read-only door for an untrusted peer.' },
        json: '{\n  "allow": ["Read(**)"],\n  "ask":   [],\n  "deny":  ["Edit(**)", "Write(**)", "Bash(*)", "FileShare(**)"]\n}',
      },
      ask: {
        summary: 'You approve every change. The recommended starting point.',
        tiers: { read: 'allow', edit: 'ask', shell: 'ask', share: 'ask' },
        card: { state: 'ask', tool: 'Edit', arg: 'gateway/auth.py', foot: 'The prompt pings the owner. Nobody else can approve.' },
        json: '{\n  "allow": ["Read(**)"],\n  "ask":   ["Edit(**)", "Write(**)", "Bash(*)", "FileShare(**)"],\n  "deny":  ["Bash(rm -rf *)", "Bash(sudo *)", "Read(**/.env)", "FileShare(**/.env)"]\n}',
      },
      auto: {
        summary: 'Edits flow without prompts. Shell still waits for your nod.',
        tiers: { read: 'allow', edit: 'allow', shell: 'ask', share: 'ask' },
        card: { state: 'allow', tool: 'Edit', arg: 'gateway/auth.py', foot: 'Edits run with no prompt. The next shell command still asks.' },
        json: '{\n  "allow": ["Read(**)", "Edit(**)", "Write(**)"],\n  "ask":   ["Bash(*)", "FileShare(**)"],\n  "deny":  ["Bash(rm -rf *)", "Bash(sudo *)", "Read(**/.env)", "FileShare(**/.env)"]\n}',
      },
      bypass: {
        summary: 'No prompts. Only the deny floor holds, so you review after.',
        tiers: { read: 'allow', edit: 'allow', shell: 'allow', share: 'allow' },
        card: { state: 'floor', tool: 'Bash', arg: 'rm -rf /models/old', foot: 'Everything runs. The floor still catches this one before it does.' },
        json: '{\n  "allow": ["Read(**)", "Edit(**)", "Write(**)", "Bash(*)", "FileShare(**)"],\n  "ask":   [],\n  "deny":  ["Bash(rm -rf *)", "Bash(sudo *)", "Write(~/.ssh/**)", "Read(**/.env)", "FileShare(**/.env)"]\n}',
      },
    };

    const stops = console_.querySelectorAll('.cstop');
    const rows = console_.querySelectorAll('.tool-row');
    const summaryEl = console_.querySelector('#presetSummary');
    const cardEl = console_.querySelector('#consoleCard');
    const jsonEl = console_.querySelector('#profileJson');

    function cardHTML(c) {
      if (c.state === 'ask') {
        return '<div class="cc cc-ask"><div class="cc-head"><svg class="ic"><use href="#i-bolt"/></svg> Needs approval</div>'
          + '<p class="cc-cmd"><code>' + c.tool + '</code><span class="arg">' + c.arg + '</span></p>'
          + '<div class="cc-row"><span class="pill pill-allow"><svg class="ic"><use href="#i-check"/></svg> Allow</span>'
          + '<span class="pill pill-deny"><svg class="ic"><use href="#i-x"/></svg> Deny</span></div>'
          + '<p class="cc-foot">' + c.foot + '</p></div>';
      }
      if (c.state === 'allow') {
        return '<div class="cc cc-allow"><div class="cc-head"><svg class="ic"><use href="#i-check"/></svg> Ran, no prompt</div>'
          + '<p class="cc-cmd"><code>' + c.tool + '</code><span class="arg">' + c.arg + '</span></p>'
          + '<p class="cc-cmd"><span class="cc-verdict"><svg class="ic"><use href="#i-check"/></svg> applied locally</span></p>'
          + '<p class="cc-foot">' + c.foot + '</p></div>';
      }
      var headLabel = c.state === 'floor' ? 'Blocked by the deny floor' : 'Denied';
      return '<div class="cc cc-' + c.state + '"><div class="cc-head"><svg class="ic"><use href="#i-shield"/></svg> ' + headLabel + '</div>'
        + '<p class="cc-cmd"><code>' + c.tool + '</code><span class="arg struck">' + c.arg + '</span></p>'
        + '<p class="cc-cmd"><span class="cc-verdict"><svg class="ic"><use href="#i-x"/></svg> never ran</span></p>'
        + '<p class="cc-foot">' + c.foot + '</p></div>';
    }

    function apply(name, animate) {
      const p = PRESETS[name];
      if (!p) return;
      stops.forEach((s) => {
        const on = s.dataset.preset === name;
        s.classList.toggle('is-active', on);
        s.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      summaryEl.textContent = p.summary;
      rows.forEach((row) => {
        const pill = row.querySelector('.tierpill');
        const tier = p.tiers[row.dataset.tool];
        if (pill.dataset.tier !== tier) {
          pill.dataset.tier = tier;
          pill.textContent = tier;
          if (animate && hasAnime) anime({ targets: pill, scale: [0.82, 1], opacity: [0.4, 1], duration: 360, easing: 'easeOutBack' });
        }
      });
      cardEl.innerHTML = cardHTML(p.card);
      jsonEl.textContent = p.json;
      if (animate && hasAnime) anime({ targets: cardEl.firstElementChild, translateY: [8, 0], opacity: [0, 1], duration: 320, easing: 'easeOutCubic' });
    }

    stops.forEach((s) => s.addEventListener('click', () => apply(s.dataset.preset, true)));
    apply('strict', false);
  })();

  /* ─────────────  ARCHITECTURE FIGURE (one connected scene)  ─────────────
     A central chat panel flanked by local machines, ledger across the base.
     A pattern switcher re-choreographs anime.js flow pulses between the
     panels and appends ledger blocks. Static + readable without motion. */
  (function initArchFigure() {
    const stage = document.getElementById('figStage');
    const svg = document.getElementById('figSvg');
    if (!stage || !svg) return;
    const reducedMotion = reduced || typeof anime === 'undefined';

    const node = (n) => stage.querySelector('[data-node="' + n + '"]');
    const chips = stage.parentElement.querySelectorAll('.fig-pat');
    const caption = document.getElementById('figCaption');
    const blocksEl = document.getElementById('ledgerBlocks');
    const baseBlocks = ['channel.message', 'turn.prompted', 'tool.requested', 'tool.executed', 'turn.replied'];

    const PATTERNS = {
      knock: {
        edges: [['you', 'chat'], ['chat', 'maya'], ['maya', 'chat']],
        lit: ['maya'],
        caption: 'You <code>@tag</code> Maya\'s bot. The request crosses the chat to her machine, her agent runs it under her rules, the reply comes back, and the ledger records every step.',
        append: ['tool.executed'],
      },
      delegate: {
        edges: [['you', 'chat'], ['chat', 'maya'], ['chat', 'devin']],
        lit: ['maya', 'devin'],
        caption: 'One request fans out to two bots on two machines. Maya\'s builds the endpoint, Devin\'s wires the client. They coordinate over the ledger, with no shared server.',
        append: ['task.claimed', 'task.claimed'],
      },
      reverse: {
        edges: [['chat', 'ledger']],
        lit: ['ledger'],
        caption: 'Because every action is an entry in the ledger, any of them can be superseded. Undo a step and a new entry records the reversal. Nothing is silently lost.',
        append: ['__revert__'],
      },
    };

    // build one dashed bezier between two panels, return the <path>
    function edgePath(fromEl, toEl) {
      const s = stage.getBoundingClientRect();
      const a = fromEl.getBoundingClientRect();
      const b = toEl.getBoundingClientRect();
      const ac = { x: a.left + a.width / 2 - s.left, y: a.top + a.height / 2 - s.top };
      const bc = { x: b.left + b.width / 2 - s.left, y: b.top + b.height / 2 - s.top };
      // exit/enter on the facing edges
      let x0 = ac.x, y0 = ac.y, x1 = bc.x, y1 = bc.y;
      if (Math.abs(bc.x - ac.x) > Math.abs(bc.y - ac.y)) {
        x0 = bc.x > ac.x ? a.right - s.left : a.left - s.left;
        x1 = bc.x > ac.x ? b.left - s.left : b.right - s.left;
      } else {
        y0 = bc.y > ac.y ? a.bottom - s.top : a.top - s.top;
        y1 = bc.y > ac.y ? b.top - s.top : b.bottom - s.top;
      }
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      const horizontal = Math.abs(x1 - x0) > Math.abs(y1 - y0);
      const d = horizontal
        ? `M ${x0} ${y0} C ${mx} ${y0} ${mx} ${y1} ${x1} ${y1}`
        : `M ${x0} ${y0} C ${x0} ${my} ${x1} ${my} ${x1} ${y1}`;
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('class', 'fig-edge');
      p.setAttribute('d', d);
      svg.appendChild(p);
      return p;
    }

    let token = 0;
    let current = 'knock';

    function clearSvg() { while (svg.firstChild) svg.removeChild(svg.firstChild); }

    function setLit(names) {
      stage.querySelectorAll('.fig-node').forEach((el) => {
        el.classList.toggle('is-lit', names.indexOf(el.dataset.node) !== -1);
      });
    }

    function resetBlocks() {
      blocksEl.innerHTML = '';
      baseBlocks.forEach((t) => {
        const b = document.createElement('span');
        b.className = 'lblock';
        b.textContent = t;
        blocksEl.appendChild(b);
      });
    }

    function appendBlock(text, opts) {
      opts = opts || {};
      const b = document.createElement('span');
      b.className = 'lblock pop is-new';
      b.textContent = text;
      // demote previous "new"
      blocksEl.querySelectorAll('.lblock.is-new').forEach((x) => x.classList.remove('is-new'));
      blocksEl.appendChild(b);
      // keep the tape from growing without bound
      const all = blocksEl.querySelectorAll('.lblock');
      if (all.length > 9) all[0].remove();
      return b;
    }

    function doAppends(p) {
      p.append.forEach((t) => {
        if (t === '__revert__') {
          const reals = blocksEl.querySelectorAll('.lblock:not(.is-reverted)');
          if (reals.length) reals[reals.length - 1].classList.add('is-reverted');
          appendBlock('merge.resolve');
        } else {
          appendBlock(t);
        }
      });
    }

    // animate a single pulse along a path
    function pulse(pathEl, dur) {
      return new Promise((resolve) => {
        const len = pathEl.getTotalLength();
        if (len < 1 || reducedMotion) { resolve(); return; }
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('r', '4'); dot.setAttribute('class', 'fig-pulse');
        svg.appendChild(dot);
        const proxy = { t: 0 };
        anime({
          targets: proxy, t: len, duration: dur, easing: 'easeInOutSine',
          update() {
            const pt = pathEl.getPointAtLength(proxy.t);
            dot.setAttribute('cx', pt.x); dot.setAttribute('cy', pt.y);
            const prog = proxy.t / len;
            dot.setAttribute('opacity', (prog < 0.1 ? prog / 0.1 : prog > 0.85 ? (1 - prog) / 0.15 : 1).toFixed(2));
          },
          complete() { dot.remove(); resolve(); },
        });
      });
    }

    async function runCycle(myToken) {
      const p = PATTERNS[current];
      clearSvg();
      const paths = p.edges.map((e) => edgePath(node(e[0]), node(e[1])));
      if (reducedMotion) { doAppends(p); return; }
      // fan-out (delegate) pulses the two chat→machine edges together
      for (let i = 0; i < paths.length; i++) {
        if (myToken !== token) return;
        await pulse(paths[i], 760);
      }
      if (myToken !== token) return;
      doAppends(p);
      setTimeout(() => { if (myToken === token) runCycle(myToken); }, 2600);
    }

    function activate(name, restart) {
      current = name;
      const p = PATTERNS[name];
      chips.forEach((c) => {
        const on = c.dataset.pat === name;
        c.classList.toggle('is-active', on);
        c.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      if (caption) caption.innerHTML = p.caption;
      setLit(p.lit);
      resetBlocks();
      token++;
      if (restart) runCycle(token);
    }

    chips.forEach((c) => c.addEventListener('click', () => activate(c.dataset.pat, true)));

    // kick off when the figure scrolls into view (so paths measure correctly)
    let started = false;
    function begin() {
      if (started) return; started = true;
      activate('knock', !reducedMotion);
    }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((ents, obs) => {
        ents.forEach((e) => { if (e.isIntersecting) { begin(); obs.disconnect(); } });
      }, { threshold: 0.25 }).observe(stage);
    } else { begin(); }

    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (started) { token++; runCycle(token); } }, 200); });
  })();

  /* ─────────────  PLATFORM TABS (setup page)  ───────────── */
  const ptabs = document.querySelectorAll('.ptab');
  const ppanels = document.querySelectorAll('.ppanel');
  ptabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      ptabs.forEach((t) => {
        const on = t === tab;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      ppanels.forEach((p) => { p.hidden = p.dataset.panel !== name; });
    });
  });

  /* ─────────────  NAV: frosted-on-scroll (sentinel, no scroll listener)  ───────────── */
  const nav = document.getElementById('nav');
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'position:absolute;top:0;left:0;height:12px;width:1px;pointer-events:none;';
  document.body.prepend(sentinel);
  if ('IntersectionObserver' in window && nav) {
    new IntersectionObserver(
      ([e]) => nav.classList.toggle('scrolled', !e.isIntersecting),
      { threshold: 0 }
    ).observe(sentinel);
  }

  /* ─────────────  ACTIVE NAV LINK  ───────────── */
  const navLinks = document.querySelectorAll('.nav-links a');
  if ('IntersectionObserver' in window && navLinks.length) {
    const navIO = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        navLinks.forEach((l) => l.removeAttribute('aria-current'));
        const l = document.querySelector('.nav-links a[href="#' + e.target.id + '"]');
        if (l) l.setAttribute('aria-current', 'true');
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    ['network', 'flow', 'architecture', 'control', 'cases', 'start'].forEach((id) => {
      const s = document.getElementById(id); if (s) navIO.observe(s);
    });
  }

  /* ─────────────  ANCHOR JUMPS (offset for fixed nav)  ───────────── */
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (ev) => {
      const id = a.getAttribute('href');
      if (id.length < 2) return;
      const target = document.querySelector(id);
      if (!target) return;
      ev.preventDefault();
      const y = target.getBoundingClientRect().top + window.scrollY - 54;
      window.scrollTo({ top: y, behavior: reduced ? 'auto' : 'smooth' });
    });
  });

  /* ─────────────  REVEAL ON SCROLL  ───────────── */
  const reveals = document.querySelectorAll('.reveal');
  const seen = new Map();
  reveals.forEach((el) => {
    const p = el.parentElement;
    const i = seen.get(p) || 0;
    el.style.setProperty('--d', Math.min(i * 70, 350) + 'ms');
    seen.set(p, i + 1);
  });
  if ('IntersectionObserver' in window && !reduced) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.1 });
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('is-in'));
  }

  /* ─────────────  FLOW SCENARIO TABS (shared by both motion modes)  ─────────────
     Each tab swaps which .flow-scenario is active. In full-motion mode the click
     handler below also rebuilds the pinned ScrollTrigger; here we expose just the
     visibility swap so it works in reduced mode too. */
  const flowTabEls = document.querySelectorAll('.flow-tab');
  const flowScenarioEls = document.querySelectorAll('.flow-scenario');
  function setActiveScenario(name) {
    flowTabEls.forEach((t) => {
      const on = t.dataset.scenario === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    let active = null;
    flowScenarioEls.forEach((s) => {
      const on = s.dataset.scenario === name;
      s.classList.toggle('is-active', on);
      if (on) active = s;
    });
    return active;
  }

  /* ═════════════  REDUCED MOTION: stop before GSAP  ═════════════ */
  if (reduced || !hasGSAP) {
    document.body.classList.add('reduced');
    document.querySelectorAll('.flow-msg').forEach((m) => m.classList.add('is-in'));
    document.querySelectorAll('.flow-note').forEach((n) => n.classList.add('is-on'));
    document.querySelectorAll('.hero-chat .msg').forEach((m) => m.classList.add('is-in'));
    document.querySelectorAll('.flow-progress span').forEach((b) => (b.style.width = '100%'));
    // Tabs just swap which scenario is shown — no scroll choreography.
    flowTabEls.forEach((tab) => tab.addEventListener('click', () => setActiveScenario(tab.dataset.scenario)));
    if (location.hash && location.hash.length > 1) {
      const t = document.querySelector(location.hash);
      if (t) window.addEventListener('load', () => setTimeout(() => t.scrollIntoView(), 60));
    }
    return;
  }

  gsap.registerPlugin(ScrollTrigger);

  /* ─────────────  PINNED CHAT SCROLLYTELLING (per active scenario)  ─────────────
     One pinned ScrollTrigger drives the *active* scenario's beats. Switching tabs
     kills the current trigger and rebuilds it against the newly-active scenario,
     since each scenario has its own beat count (and thus its own scroll length). */
  const stage = document.getElementById('flowStage');
  let flowST = null;

  function buildFlow(scene) {
    if (!stage || !scene) return;
    const scroller = scene.querySelector('.chat-scroll');
    const track = scene.querySelector('.chat-track');
    const msgs = gsap.utils.toArray(scene.querySelectorAll('.flow-msg'));
    const notes = gsap.utils.toArray(scene.querySelectorAll('.flow-note'));
    const bar = scene.querySelector('.flow-progress span');
    if (!scroller || !track || !msgs.length) return;
    const n = msgs.length;
    let current = -1;

    // keep the newest revealed message resting near the bottom of the window
    const positionTrack = (idx) => {
      const view = scroller.clientHeight;
      const active = msgs[idx];
      if (!active) return;
      const target = Math.max(0, active.offsetTop + active.offsetHeight - view + 18);
      gsap.to(track, { y: -target, duration: 0.45, ease: 'power2.out', overwrite: true });
    };

    const render = (idx) => {
      if (idx === current) return;
      current = idx;
      msgs.forEach((m, i) => m.classList.toggle('is-in', i <= idx));
      notes.forEach((no, i) => no.classList.toggle('is-on', i === idx));
      positionTrack(idx);
    };

    flowST = ScrollTrigger.create({
      trigger: '.flow',
      start: 'top top',
      end: '+=' + n * 360,
      pin: stage,
      pinSpacing: true,
      anticipatePin: 1,
      invalidateOnRefresh: true,
      scrub: 0.5,
      onUpdate: (self) => {
        const idx = Math.min(n - 1, Math.floor(self.progress * n));
        render(idx);
        if (bar) bar.style.width = (self.progress * 100).toFixed(1) + '%';
      },
      onRefresh: () => { current = -1; render(0); },
    });

    render(0);
  }

  if (stage) {
    const initial = document.querySelector('.flow-scenario.is-active') || flowScenarioEls[0];
    buildFlow(initial);

    // Tab click: tear down the current pinned trigger, swap scenario, rebuild.
    flowTabEls.forEach((tab) => {
      tab.addEventListener('click', () => {
        const name = tab.dataset.scenario;
        if (tab.classList.contains('is-active') && flowST) return; // already showing
        if (flowST) { flowST.kill(true); flowST = null; }
        const active = setActiveScenario(name);
        // restart the scrub from the top of the flow section
        const y = document.querySelector('.flow').getBoundingClientRect().top + window.scrollY;
        window.scrollTo({ top: y, behavior: 'auto' });
        buildFlow(active);
        ScrollTrigger.refresh();
      });
    });
  }

  window.addEventListener('load', () => ScrollTrigger.refresh());

  /* ─────────────  HERO CHAT: staggered message reveal  ───────────── */
  (function initHeroChatReveal() {
    const msgs = Array.from(document.querySelectorAll('.hero-chat .msg'));
    if (!msgs.length) return;
    // Stagger each message: first at 500ms, then +350ms each
    msgs.forEach((m, i) => m.style.setProperty('--md', (500 + i * 350) + 'ms'));
    window.addEventListener('load', () => msgs.forEach(m => m.classList.add('is-in')));
  })();

  /* ─────────────  HERO VISUAL PARALLAX: visual drifts slower than page  ───────────── */
  (function initHeroParallax() {
    const visual = document.getElementById('heroVisualWrap');
    if (!visual) return;
    // Visual drifts up 80px over the full hero height — creates floating depth effect
    gsap.to(visual, {
      y: -80,
      ease: 'none',
      scrollTrigger: {
        trigger: '.hero',
        start: 'top top',
        end: 'bottom bottom',
        scrub: 1.5,
      },
    });
  })();

  /* ═════════════  NETWORK DIAGRAM — platform → chat → agent flow  ═════════════ */
  (function initNetwork() {
    if (typeof anime === 'undefined') return;
    if (reduced) return;

    const container = document.getElementById('heroVisual');
    const svg       = document.getElementById('networkSvg');
    const chatWrap  = document.getElementById('heroChatWrap');
    if (!container || !svg || !chatWrap) return;

    let platPaths = [], agentPaths = [];
    let pathsBuilt = false;

    function buildPaths() {
      svg.querySelectorAll('.net-edge').forEach(e => e.remove());
      platPaths = []; agentPaths = [];

      const cr    = container.getBoundingClientRect();
      const chat  = chatWrap.getBoundingClientRect();
      if (!cr.width || !chat.width) return false;

      const cx0   = chat.left  - cr.left;
      const cx1   = chat.right - cr.left;
      const cy0   = chat.top   - cr.top;
      const chatH = chat.height;

      function makeEdge(x0, y0, x1, y1, id) {
        const midX = x0 + (x1 - x0) * 0.5;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'net-edge');
        path.id = id;
        path.setAttribute('d',
          `M ${x0.toFixed(1)},${y0.toFixed(1)} ` +
          `C ${midX.toFixed(1)},${y0.toFixed(1)} ` +
          `${midX.toFixed(1)},${y1.toFixed(1)} ` +
          `${x1.toFixed(1)},${y1.toFixed(1)}`
        );
        svg.insertBefore(path, svg.firstChild);
        return path;
      }

      // Platform nodes (left) → chat left edge
      const platCards = Array.from(
        document.querySelectorAll('#netNodesPlatform .net-node-card:not(.net-node-dim)')
      );
      platCards.forEach((card, i) => {
        const nr = card.getBoundingClientRect();
        const nx = nr.right - cr.left;
        const ny = nr.top + nr.height / 2 - cr.top;
        const cy = cy0 + 14 + (chatH - 28) * (i + 1) / (platCards.length + 1);
        platPaths.push(makeEdge(nx, ny, cx0, cy, 'ep-' + i));
      });

      // Chat right edge → agent nodes (right)
      const agentCards = Array.from(
        document.querySelectorAll('#netNodesAgents .net-node-card:not(.net-node-dim)')
      );
      agentCards.forEach((card, i) => {
        const nr = card.getBoundingClientRect();
        const nx = nr.left - cr.left;
        const ny = nr.top + nr.height / 2 - cr.top;
        const cy = cy0 + 14 + (chatH - 28) * (i + 1) / (agentCards.length + 1);
        agentPaths.push(makeEdge(cx1, cy, nx, ny, 'ea-' + i));
      });

      pathsBuilt = platPaths.length > 0 && agentPaths.length > 0;
      return pathsBuilt;
    }

    // Animate pulse dot + traveling ring glow along a path (always forward 0→len)
    function animatePath(pathEl, pulseEl, dur, onComplete) {
      if (!pathEl || !pulseEl) { if (onComplete) onComplete(); return; }
      const len = pathEl.getTotalLength();
      if (len < 1) { if (onComplete) onComplete(); return; }

      const d    = pathEl.getAttribute('d');
      const TAIL = Math.min(len * 0.32, 68);

      // Outer soft ring (wide, transparent glow)
      const outer = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      outer.setAttribute('d', d);
      outer.style.cssText = 'fill:none;stroke:rgba(16,120,163,0.2);stroke-width:4;stroke-linecap:round;pointer-events:none;';
      outer.setAttribute('opacity', 0);

      // Inner bright line
      const inner = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      inner.setAttribute('d', d);
      inner.style.cssText = 'fill:none;stroke:rgba(16,120,163,0.62);stroke-width:1.5;stroke-linecap:round;pointer-events:none;';
      inner.setAttribute('opacity', 0);

      // Insert glow below pulse dots
      svg.insertBefore(inner, svg.firstChild);
      svg.insertBefore(outer, svg.firstChild);

      const proxy = { pos: 0 };
      anime({
        targets: proxy,
        pos: len,
        duration: dur,
        easing: 'easeInOutSine',
        update() {
          const pos  = proxy.pos;
          const prog = pos / len;
          const fade = prog < 0.08 ? prog / 0.08 : prog > 0.88 ? (1 - prog) / 0.12 : 1;

          // Move pulse dot
          const pt = pathEl.getPointAtLength(Math.min(pos, len));
          pulseEl.setAttribute('cx', pt.x);
          pulseEl.setAttribute('cy', pt.y);
          pulseEl.setAttribute('opacity', (fade * 0.85).toFixed(3));

          // Draw trailing glow: segment from (pos-TAIL) to pos
          const ts = Math.max(0, pos - TAIL);
          const sl = pos - ts;
          const rl = Math.max(0, len - pos);
          if (sl > 0.5) {
            const da = `0 ${ts.toFixed(1)} ${sl.toFixed(1)} ${rl.toFixed(1)}`;
            outer.setAttribute('stroke-dasharray', da);
            outer.setAttribute('opacity', (fade * 0.28).toFixed(3));
            inner.setAttribute('stroke-dasharray', da);
            inner.setAttribute('opacity', (fade * 0.62).toFixed(3));
          }
        },
        complete() {
          pulseEl.setAttribute('opacity', 0);
          outer.remove();
          inner.remove();
          if (onComplete) onComplete();
        },
      });
    }

    function triggerChatRim() {
      chatWrap.classList.remove('rim-active');
      void chatWrap.offsetWidth;
      chatWrap.classList.add('rim-active');
    }

    function activateAgent(idx) {
      const cards = document.querySelectorAll('#netNodesAgents .net-node-card:not(.net-node-dim)');
      const dot   = cards[idx] && cards[idx].querySelector('.net-dot-agent');
      if (!dot) return;
      dot.classList.remove('is-working');
      void dot.offsetWidth;
      dot.classList.add('is-working');
      setTimeout(() => dot.classList.remove('is-working'), 1400);
    }

    // One message flow: platform → chat (glow) then chat → agent (glow), agent lights up
    function launchMessage() {
      if (!pathsBuilt || !platPaths.length || !agentPaths.length) return;
      const pi   = Math.floor(Math.random() * platPaths.length);
      const ai   = Math.floor(Math.random() * agentPaths.length);
      const pDur = 900 + Math.random() * 300;
      const aDur = 720 + Math.random() * 250;

      const platPulse  = document.getElementById('pp-' + pi);
      const agentPulse = document.getElementById('pa-' + ai);

      animatePath(platPaths[pi], platPulse, pDur, () => {
        triggerChatRim();
        setTimeout(() => {
          animatePath(agentPaths[ai], agentPulse, aDur, () => {
            activateAgent(ai);
          });
        }, 160);
      });
    }

    function startScheduler() {
      [0, 420, 870, 1530].forEach(delay => {
        setTimeout(function tick() {
          launchMessage();
          setTimeout(tick, 1100 + Math.random() * 1050);
        }, delay);
      });
    }

    let started = false;
    new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || started) return;
      started = true;
      setTimeout(() => {
        if (buildPaths()) setTimeout(startScheduler, 250);
      }, 300);
    }, { threshold: 0.1 }).observe(container);

    let resizeTimer;
    window.addEventListener('resize', () => {
      if (!started) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { buildPaths(); }, 180);
    });
  })();

  if (location.hash && location.hash.length > 1) {
    const target = document.querySelector(location.hash);
    if (target) window.addEventListener('load', () => {
      ScrollTrigger.refresh();
      requestAnimationFrame(() => window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - 54, behavior: 'auto' }));
    });
  }
})();
