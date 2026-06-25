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

  /* ─────────────  SECURITY DIAL  ───────────── */
  const stops = document.querySelectorAll('.dial-stop');
  const lcards = document.querySelectorAll('.level-card');
  stops.forEach((stop) => {
    stop.addEventListener('click', () => {
      const lvl = stop.dataset.level;
      stops.forEach((s) => {
        const on = s === stop;
        s.classList.toggle('is-active', on);
        s.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      lcards.forEach((c) => {
        const on = c.dataset.level === lvl;
        c.classList.toggle('is-active', on);
        c.hidden = !on;
      });
    });
  });

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
    ['network', 'flow', 'control', 'cases', 'levels', 'start'].forEach((id) => {
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

  /* ═════════════  REDUCED MOTION: stop before GSAP  ═════════════ */
  if (reduced || !hasGSAP) {
    document.body.classList.add('reduced');
    document.querySelectorAll('.flow-msg').forEach((m) => m.classList.add('is-in'));
    document.querySelectorAll('.flow-note').forEach((n) => n.classList.add('is-on'));
    document.querySelectorAll('.hero-chat .msg').forEach((m) => m.classList.add('is-in'));
    const bar = document.getElementById('flowBar'); if (bar) bar.style.width = '100%';
    if (location.hash && location.hash.length > 1) {
      const t = document.querySelector(location.hash);
      if (t) window.addEventListener('load', () => setTimeout(() => t.scrollIntoView(), 60));
    }
    return;
  }

  gsap.registerPlugin(ScrollTrigger);

  /* ─────────────  PINNED CHAT SCROLLYTELLING  ───────────── */
  const stage = document.getElementById('flowStage');
  const track = document.getElementById('flowTrack');
  const scroller = document.getElementById('flowScroll');
  const msgs = gsap.utils.toArray('.flow-msg');
  const notes = gsap.utils.toArray('.flow-note');
  const bar = document.getElementById('flowBar');

  if (stage && track && scroller && msgs.length) {
    const n = msgs.length;
    let current = -1;

    const render = (idx) => {
      if (idx === current) return;
      current = idx;
      msgs.forEach((m, i) => m.classList.toggle('is-in', i <= idx));
      notes.forEach((no, i) => no.classList.toggle('is-on', i === idx));
      positionTrack(idx);
    };

    // keep the newest revealed message resting near the bottom of the window
    const positionTrack = (idx) => {
      const view = scroller.clientHeight;
      const active = msgs[idx];
      if (!active) return;
      const target = Math.max(0, active.offsetTop + active.offsetHeight - view + 18);
      gsap.to(track, { y: -target, duration: 0.45, ease: 'power2.out', overwrite: true });
    };

    ScrollTrigger.create({
      trigger: '.flow',
      start: 'top top',
      end: '+=' + n * 360,
      pin: stage,
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
