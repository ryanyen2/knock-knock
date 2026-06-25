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
    document.querySelectorAll('.hero-block-feat').forEach((b) => b.classList.add('is-in'));
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

  /* ─────────────  HERO FEATURE BLOCKS: scroll-reveal + step dots  ───────────── */
  (function initFeatureBlocks() {
    const blocks = document.querySelectorAll('.hero-block-feat');
    const dots   = document.querySelectorAll('.hero-step-dot');

    if (!blocks.length || reduced) {
      blocks.forEach(b => b.classList.add('is-in'));
      return;
    }
    if (!('IntersectionObserver' in window)) {
      blocks.forEach(b => b.classList.add('is-in'));
      return;
    }

    // Reveal + step-dot highlight
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        e.target.classList.add('is-in');
        // find which feature block (0-indexed) → dot index is featIdx+1 (dot 0 = headline)
        const idx = Array.from(blocks).indexOf(e.target);
        if (idx >= 0 && dots.length) {
          dots.forEach((d, i) => d.classList.toggle('is-active', i === idx + 1));
        }
      });
    }, { rootMargin: '0px 0px -30% 0px', threshold: 0.4 });

    // Dot 0 active while headline block is in view
    const leadBlock = document.querySelector('.hero-block-lead');
    if (leadBlock) {
      const leadIO = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
          dots.forEach((d, i) => d.classList.toggle('is-active', i === 0));
        }
      }, { rootMargin: '0px 0px -40% 0px', threshold: 0.3 });
      leadIO.observe(leadBlock);
    }

    blocks.forEach(b => io.observe(b));
  })();

  /* ─────────────  HERO VISUAL PARALLAX: gentle drift while scrolling features  ───────────── */
  (function initHeroParallax() {
    if (reduced) return;
    const track = document.getElementById('heroCopyTrack');
    const visual = document.getElementById('heroVisual');
    if (!track || !visual) return;
    // Visual drifts up 60px over the full hero scroll — much slower than page
    gsap.to(visual, {
      y: -60,
      ease: 'none',
      scrollTrigger: {
        trigger: track,
        start: 'top top',
        end: 'bottom bottom',
        scrub: 2,
      },
    });
  })();

  /* ═════════════  NETWORK DIAGRAM — DOM-measured paths, bidirectional pulses  ═════════════ */
  (function initNetwork() {
    if (typeof anime === 'undefined') return;
    if (reduced) return;

    const container = document.getElementById('heroVisual');
    const svg       = document.getElementById('networkSvg');
    const chatWrap  = document.getElementById('heroChatWrap');
    if (!container || !svg || !chatWrap) return;

    // Dynamic path arrays built from DOM measurements
    let aPathEls = [], pPathEls = [];
    let pathsBuilt = false;

    // Build bezier paths from node right-edges → chat left-edge (agents)
    // and chat right-edge → node left-edges (platforms)
    function buildPaths() {
      svg.querySelectorAll('.net-edge').forEach(e => e.remove());
      aPathEls = []; pPathEls = [];

      const cr   = container.getBoundingClientRect();
      const chat = chatWrap.getBoundingClientRect();
      if (!cr.width || !chat.width) return false;

      const cx0 = chat.left   - cr.left;   // chat left x (relative to container)
      const cx1 = chat.right  - cr.left;   // chat right x
      const cy0 = chat.top    - cr.top;    // chat top y
      const chatH = chat.height;

      function makeEdge(x0, y0, x1, y1, id) {
        const midX = x0 + (x1 - x0) * 0.5;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'net-edge');
        path.id = id;
        // Cubic bezier: horizontal handles keep entry/exit tangent smooth
        path.setAttribute('d',
          `M ${x0.toFixed(1)},${y0.toFixed(1)} ` +
          `C ${midX.toFixed(1)},${y0.toFixed(1)} ` +
          `${midX.toFixed(1)},${y1.toFixed(1)} ` +
          `${x1.toFixed(1)},${y1.toFixed(1)}`
        );
        // Insert before pulse circles so pulses render on top
        svg.insertBefore(path, svg.firstChild);
        return path;
      }

      // Agent nodes → chat left edge
      const leftCards = Array.from(
        document.querySelectorAll('#netNodesLeft .net-node-card:not(.net-node-dim)')
      );
      leftCards.forEach((card, i) => {
        const nr  = card.getBoundingClientRect();
        const nx  = nr.right  - cr.left;
        const ny  = nr.top + nr.height / 2 - cr.top;
        // Distribute connection points on chat left edge (skip 14px for border-radius)
        const cy  = cy0 + 14 + (chatH - 28) * (i + 1) / (leftCards.length + 1);
        aPathEls.push(makeEdge(nx, ny, cx0, cy, 'ea-' + i));
      });

      // Chat right edge → platform nodes
      const rightCards = Array.from(
        document.querySelectorAll('#netNodesPlatform .net-node-card:not(.net-node-dim)')
      );
      rightCards.forEach((card, i) => {
        const nr  = card.getBoundingClientRect();
        const nx  = nr.left   - cr.left;
        const ny  = nr.top + nr.height / 2 - cr.top;
        const cy  = cy0 + 14 + (chatH - 28) * (i + 1) / (rightCards.length + 1);
        pPathEls.push(makeEdge(cx1, cy, nx, ny, 'ep-' + i));
      });

      pathsBuilt = aPathEls.length > 0 && pPathEls.length > 0;
      return pathsBuilt;
    }

    // Animate a pulse dot along a path; dir: 1=forward, -1=reverse
    function runPulse(pulseId, pathEl, dir, dur, onDone) {
      const el = document.getElementById(pulseId);
      if (!el || !pathEl) { if (onDone) onDone(); return; }
      const len   = pathEl.getTotalLength();
      const proxy = { t: dir > 0 ? 0 : 1 };
      anime({
        targets: proxy,
        t: dir > 0 ? 1 : 0,
        duration: dur,
        easing: 'easeInOutQuad',
        update() {
          const pt   = pathEl.getPointAtLength(proxy.t * len);
          const prog = dir > 0 ? proxy.t : 1 - proxy.t;
          const op   = prog < 0.08 ? prog / 0.08 : prog > 0.88 ? (1 - prog) / 0.12 : 1;
          el.setAttribute('cx', pt.x);
          el.setAttribute('cy', pt.y);
          el.setAttribute('opacity', op.toFixed(3));
        },
        complete() {
          el.setAttribute('opacity', 0);
          if (onDone) onDone();
        },
      });
    }

    // Rim-glow the chat when a forward pulse arrives at a platform
    function triggerChatRim() {
      chatWrap.classList.remove('rim-active');
      void chatWrap.offsetWidth;
      chatWrap.classList.add('rim-active');
    }

    // Launch one message: agent→chat (forward), then chat→platform (forward)
    // Optionally fire a reverse ack after
    function launchMessage() {
      if (!pathsBuilt || !aPathEls.length || !pPathEls.length) return;
      const ai   = Math.floor(Math.random() * aPathEls.length);
      const pi   = Math.floor(Math.random() * pPathEls.length);
      const aDur = 820 + Math.random() * 280;
      const pDur = 760 + Math.random() * 280;

      runPulse('pa-' + ai, aPathEls[ai], 1, aDur, () => {
        runPulse('pp-' + pi, pPathEls[pi], 1, pDur, () => {
          triggerChatRim();
        });
      });

      // 35% chance: reverse ack after forward completes
      if (Math.random() < 0.35) {
        setTimeout(() => {
          const rpi = Math.floor(Math.random() * pPathEls.length);
          const rai = Math.floor(Math.random() * aPathEls.length);
          const rDur = 640 + Math.random() * 200;
          runPulse('pp-' + rpi, pPathEls[rpi], -1, rDur, () => {
            runPulse('pa-' + rai, aPathEls[rai], -1, rDur + Math.random() * 80, null);
          });
        }, aDur + pDur + 300 + Math.random() * 500);
      }
    }

    // 4 staggered independent streams
    function startScheduler() {
      [0, 380, 780, 1380].forEach(delay => {
        setTimeout(function tick() {
          launchMessage();
          setTimeout(tick, 1050 + Math.random() * 1100);
        }, delay);
      });
    }

    // Animate dash-offset so edges appear to stream (re-queries dynamic paths)
    function startEdgeFlow() {
      svg.querySelectorAll('.net-edge').forEach((edge, i) => {
        anime({ targets: edge, strokeDashoffset: [0, -12],
                duration: 900 + i * 45, loop: true, easing: 'linear' });
      });
    }

    let started = false;
    new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || started) return;
      started = true;
      // Small delay: let reveal animation settle before measuring layout
      setTimeout(() => {
        if (buildPaths()) {
          startEdgeFlow();
          setTimeout(startScheduler, 250);
        }
      }, 300);
    }, { threshold: 0.1 }).observe(container);

    // Rebuild paths on resize (debounced 180ms)
    let resizeTimer;
    window.addEventListener('resize', () => {
      if (!started) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        svg.querySelectorAll('.net-edge').forEach(e => anime.remove(e));
        if (buildPaths()) startEdgeFlow();
      }, 180);
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
