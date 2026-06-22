/* ════════════════════════════════════════════════════════════════
   knock-knock — site interactions
   anime.js (the knock) · GSAP ScrollTrigger (door + conversation)
   Native scrolling — no smooth-scroll hijack, so the wheel stays snappy.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    || /[?&]static=1\b/.test(location.search);
  const hasGSAP = typeof gsap !== 'undefined' && typeof ScrollTrigger !== 'undefined';
  const hasAnime = typeof anime !== 'undefined';

  /* ─────────────  COPY BUTTONS  ───────────── */
  document.querySelectorAll('.code[data-copy]').forEach((block) => {
    const btn = block.querySelector('.copy');
    const codeEl = block.querySelector('code');
    if (!btn || !codeEl) return;
    const label = btn.querySelector('span');
    btn.addEventListener('click', async () => {
      const text = codeEl.innerText;
      try {
        await navigator.clipboard.writeText(text);
      } catch (_) {
        const r = document.createRange(); r.selectNodeContents(codeEl);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        try { document.execCommand('copy'); } catch (e) {}
        s.removeAllRanges();
      }
      if (label) label.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(() => { if (label) label.textContent = 'Copy'; btn.classList.remove('copied'); }, 1600);
    });
  });

  /* ─────────────  PLATFORM TABS  ───────────── */
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
      ppanels.forEach((p) => {
        const on = p.dataset.panel === name;
        p.classList.toggle('is-active', on);
        p.hidden = !on;
      });
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

  /* ─────────────  TOPBAR SCROLLED STATE  ───────────── */
  const topbar = document.getElementById('topbar');
  const onScroll = () => { if (topbar) topbar.classList.toggle('scrolled', window.scrollY > 12); };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ─────────────  SMOOTH ANCHOR JUMPS (native, with header offset)  ───────────── */
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (ev) => {
      const id = a.getAttribute('href');
      if (id.length < 2) return;
      const target = document.querySelector(id);
      if (!target) return;
      ev.preventDefault();
      const y = target.getBoundingClientRect().top + window.scrollY - 60;
      window.scrollTo({ top: y, behavior: reduced ? 'auto' : 'smooth' });
    });
  });

  /* ─────────────  THE KNOCK (anime.js)  ───────────── */
  const knocker = document.getElementById('knocker');
  const doorway = document.querySelector('.doorway');
  const hint = document.getElementById('doorHint');
  let knocks = 0;
  if (knocker) knocker.addEventListener('click', () => {
    knocks++;
    if (hasAnime && doorway) {
      anime({ targets: doorway, translateX: [0, -7, 6, -4, 2, 0], duration: 480, easing: 'easeInOutSine' });
      anime({ targets: '.knocker-ring', scale: [1, 2.7], opacity: [0.85, 0], duration: 750, delay: anime.stagger(120), easing: 'easeOutQuad' });
      anime({ targets: '.doorway-glow', opacity: [0, 0.5, 0], duration: 700, easing: 'easeOutQuad' });
    } else if (doorway) {
      doorway.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(0)' }], { duration: 420, easing: 'ease-in-out' });
    }
    if (hint) {
      const lines = ['who’s there? ↓', 'scroll to open', 'come on in →'];
      hint.textContent = lines[Math.min(knocks - 1, lines.length - 1)];
      hint.style.animation = 'none';
    }
  });

  /* ─────────────  REVEAL ON SCROLL (staggered)  ───────────── */
  const reveals = document.querySelectorAll('.reveal');
  const seen = new Map();
  reveals.forEach((el) => {
    const p = el.parentElement;
    const i = seen.get(p) || 0;
    el.style.setProperty('--d', Math.min(i * 80, 480) + 'ms');
    seen.set(p, i + 1);
  });
  if ('IntersectionObserver' in window && !reduced) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('is-in'));
  }

  /* ─────────────  ACTIVE NAV LINK  ───────────── */
  const navLinks = document.querySelectorAll('.topnav a');
  if ('IntersectionObserver' in window && navLinks.length) {
    const navIO = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          navLinks.forEach((l) => l.removeAttribute('aria-current'));
          const l = document.querySelector('.topnav a[href="#' + e.target.id + '"]');
          if (l) l.setAttribute('aria-current', 'true');
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    ['start', 'platforms', 'safety', 'levels', 'features'].forEach((id) => {
      const s = document.getElementById(id); if (s) navIO.observe(s);
    });
  }

  /* ═════════════  REDUCED MOTION: stop here  ═════════════ */
  if (reduced || !hasGSAP) {
    document.body.classList.add('reduced');
    if (location.hash && location.hash.length > 1) {
      const t = document.querySelector(location.hash);
      if (t) window.addEventListener('load', () => setTimeout(() => t.scrollIntoView({ behavior: 'auto' }), 60));
    }
    return;
  }

  gsap.registerPlugin(ScrollTrigger);

  /* ─────────────  HERO DOOR OPENS ON SCROLL  ───────────── */
  const door = document.getElementById('heroDoor');
  if (door) {
    gsap.set(door, { transformPerspective: 1700, transformOrigin: 'left center' });
    const doorTl = gsap.timeline({ scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: 0.4 } });
    doorTl
      .to(door, { rotateY: -84, ease: 'power1.in' }, 0)
      .to('.doorway-glow', { opacity: 0.7, ease: 'none' }, 0)
      .to('.inside-line', { opacity: 1, stagger: 0.15, ease: 'none' }, 0.1)
      .to('.knocker', { opacity: 0.25, ease: 'none' }, 0);
    gsap.to('.door-hint', { opacity: 0, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: '30% top', scrub: true } });
  }

  /* ─────────────  THE CORRESPONDENCE: scroll-driven beats  ───────────── */
  const beats = gsap.utils.toArray('.beat');
  const stepEl = document.getElementById('convoStep');
  const laneA = document.querySelector('.lane-a');
  const laneB = document.querySelector('.lane-b');
  const knot = document.querySelector('.thread-knot');

  if (beats.length) {
    gsap.set(beats, { opacity: 0, y: 44 });
    gsap.set(beats[0], { opacity: 1, y: 0 });
    const sideX = (b) => (b.classList.contains('beat-a') ? -56 : b.classList.contains('beat-b') ? 56 : 0);

    const tl = gsap.timeline({
      scrollTrigger: {
        trigger: '.convo', start: 'top top', end: '+=' + beats.length * 460,
        pin: '.convo-stage', scrub: 0.6,
        onUpdate: (self) => {
          const i = Math.min(beats.length - 1, Math.floor(self.progress * beats.length + 0.0001));
          if (stepEl) stepEl.textContent = i + 1;
          const cur = beats[i];
          if (laneA) laneA.style.opacity = cur.classList.contains('beat-a') ? '1' : '0.4';
          if (laneB) laneB.style.opacity = cur.classList.contains('beat-b') ? '1' : '0.4';
          if (knot) knot.style.transform = 'translateY(' + (self.progress * 120 - 60) + 'px)';
        },
      },
    });

    beats.forEach((b, i) => {
      if (i > 0) tl.fromTo(b, { opacity: 0, y: 44, x: sideX(b) }, { opacity: 1, y: 0, x: 0, duration: 1, ease: 'power2.out' });
      else tl.to(b, { duration: 1 });
      tl.to({}, { duration: 0.8 });
      if (i < beats.length - 1) tl.to(b, { opacity: 0, y: -34, duration: 0.8, ease: 'power1.in' });
    });
  }

  window.addEventListener('load', () => ScrollTrigger.refresh());

  if (location.hash && location.hash.length > 1) {
    const target = document.querySelector(location.hash);
    if (target) window.addEventListener('load', () => {
      ScrollTrigger.refresh();
      requestAnimationFrame(() => window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - 60, behavior: 'auto' }));
    });
  }
})();
