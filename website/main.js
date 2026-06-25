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

  /* ═════════════  NETWORK DIAGRAM — anime.js pulse animation  ═════════════ */
  (function initNetwork() {
    if (typeof anime === 'undefined') return;

    // Pulse dots that travel along each SVG path
    const routes = [
      // agent → hub (left to right along each path)
      { pulseId: 'p-claude',   pathId: 'e-claude',   delay: 0,    dur: 1800 },
      { pulseId: 'p-codex',    pathId: 'e-codex',    delay: 400,  dur: 1700 },
      { pulseId: 'p-opencode', pathId: 'e-opencode', delay: 900,  dur: 1600 },
      { pulseId: 'p-gemini',   pathId: 'e-gemini',   delay: 200,  dur: 1900 },
      // hub → platform (right half)
      { pulseId: 'p-discord',  pathId: 'e-discord',  delay: 1100, dur: 1600 },
      { pulseId: 'p-slack',    pathId: 'e-slack',    delay: 700,  dur: 1700 },
      { pulseId: 'p-telegram', pathId: 'e-telegram', delay: 1400, dur: 1800 },
      { pulseId: 'p-github',   pathId: 'e-github',   delay: 300,  dur: 2000 },
    ];

    // Wait for the network section to enter the viewport before starting
    const stage = document.getElementById('networkStage');
    if (!stage) return;

    let started = false;
    const startAnimations = () => {
      if (started) return;
      started = true;

      routes.forEach(({ pulseId, pathId, delay, dur }) => {
        const pulse = document.getElementById(pulseId);
        const path  = document.getElementById(pathId);
        if (!pulse || !path) return;

        const length = path.getTotalLength();

        const runPulse = (extraDelay) => {
          // reset to start of path
          const startPt = path.getPointAtLength(0);
          pulse.setAttribute('cx', startPt.x);
          pulse.setAttribute('cy', startPt.y);

          anime({
            targets: {},
            progress: [0, 1],
            duration: dur,
            delay: extraDelay,
            easing: 'easeInOutSine',
            update: (anim) => {
              const p = anim.animations[0].currentValue;
              const pt = path.getPointAtLength(p * length);
              pulse.setAttribute('cx', pt.x);
              pulse.setAttribute('cy', pt.y);
              pulse.setAttribute('opacity', p < 0.05 ? p / 0.05 : p > 0.9 ? (1 - p) / 0.1 : 1);
            },
            complete: () => {
              // loop with a pause at the end
              setTimeout(() => runPulse(0), 600 + Math.random() * 1200);
            },
          });
        };

        runPulse(delay);
      });

      // Hub ring pulse
      const rings = document.querySelectorAll('.hub-ring');
      if (rings.length) {
        rings.forEach((ring, i) => {
          anime({
            targets: ring,
            opacity: [0.04, 0.18, 0.04],
            duration: 2400 + i * 600,
            delay: i * 300,
            loop: true,
            easing: 'easeInOutSine',
            direction: 'alternate',
          });
        });

        // Hub core gentle scale pulse
        const core = document.querySelector('.hub-core');
        if (core) {
          anime({
            targets: core,
            r: [22, 24, 22],
            duration: 2800,
            loop: true,
            easing: 'easeInOutSine',
            direction: 'alternate',
          });
        }
      }

      // Edge dash-offset animation (make the dashes appear to flow)
      const edges = document.querySelectorAll('.net-edge:not(.net-edge-dim)');
      edges.forEach((edge, i) => {
        anime({
          targets: edge,
          strokeDashoffset: [0, -18],
          duration: 1200 + i * 80,
          loop: true,
          easing: 'linear',
        });
      });
    };

    if (reduced) {
      // In reduced-motion mode, just show static diagram (no animation)
      routes.forEach(({ pulseId }) => {
        const p = document.getElementById(pulseId);
        if (p) p.setAttribute('opacity', '0');
      });
      return;
    }

    new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) startAnimations();
    }, { threshold: 0.2 }).observe(stage);
  })();

  if (location.hash && location.hash.length > 1) {
    const target = document.querySelector(location.hash);
    if (target) window.addEventListener('load', () => {
      ScrollTrigger.refresh();
      requestAnimationFrame(() => window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - 54, behavior: 'auto' }));
    });
  }
})();
