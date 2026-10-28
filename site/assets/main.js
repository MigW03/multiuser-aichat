// Nido coming-soon site: waitlist and idea forms, scroll reveals, and the scroll-driven chat demo.
(() => {
  'use strict';

  // Public values. The publishable key only lets the site call join_waitlist and submit_idea; the tables are closed to it
  // (see supabase/migrations/0025_site_waitlist_and_ideas.sql).
  const SUPABASE_URL = 'https://yjlldwbyzyxpqnqrytux.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_717ZdpHX0odOGjimtFmdQQ_T0lQuERl';
  const EMAIL_KEY = 'nido-site-email';

  const root = document.documentElement;
  root.classList.add('js');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const seg = (v, [a, b]) => clamp((v - a) / (b - a));
  const easeOut = (t) => 1 - Math.pow(1 - t, 4);
  const easeInOut = (t) => (t < 0.5 ? 8 * t ** 4 : 1 - Math.pow(-2 * t + 2, 4) / 2);

  const store = {
    get() { try { return localStorage.getItem(EMAIL_KEY) || ''; } catch { return ''; } },
    set(v) { try { localStorage.setItem(EMAIL_KEY, v); } catch { /* private mode: fine */ } },
  };

  // ------------------------------------------------------------------ reveals
  const reveals = document.querySelectorAll('.reveal');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    reveals.forEach((el) => el.classList.add('is-in'));
  } else {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('is-in');
        io.unobserve(e.target);
      }
    }, { rootMargin: '0px 0px -8% 0px' });
    reveals.forEach((el) => io.observe(el));
  }

  // ------------------------------------------------------------------ forms
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const ERRORS = {
    invalid_email: "That email doesn't look right.",
    empty_idea: 'Write an idea or tap at least one option.',
    invalid_idea: 'Keep it under 500 characters.',
    rate_limited: 'Too many tries from here. Give it a few minutes.',
    network: "Couldn't reach us. Check your connection and try again.",
    server: 'Something went wrong on our side. Try again in a minute.',
  };

  async function rpc(name, args) {
    let res;
    try {
      res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
        body: JSON.stringify(args),
      });
    } catch {
      throw new Error('network');
    }
    if (res.ok) return;
    let code = '';
    try { code = (await res.json()).message || ''; } catch { /* not JSON */ }
    throw new Error(code in ERRORS ? code : 'server');
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function doneBlock(title, parts) {
    const box = el('div', 'done');
    box.setAttribute('role', 'status');
    const mark = el('span', 'done-mark');
    // The nest: ring closes, eggs settle in.
    mark.innerHTML = '<svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><circle class="mark-ring" cx="32" cy="32" r="27" pathLength="1" transform="rotate(-90 32 32)"/><circle class="egg e1" cx="32" cy="22" r="7"/><circle class="egg e2" cx="40.7" cy="37" r="7"/><circle class="egg e3" cx="23.3" cy="37" r="7"/></svg>';
    const text = el('div');
    text.append(el('b', null, title));
    const line = el('span');
    for (const p of parts) line.append(p);
    text.append(line);
    box.append(mark, text);
    return box;
  }

  function busy(btn, on, label) {
    btn.disabled = on;
    btn.classList.toggle('is-busy', on);
    btn.querySelector('.btn-label').textContent = label;
  }

  function fail(form, shell, code) {
    const note = form.querySelector('[data-note]');
    note.textContent = ERRORS[code] || ERRORS.server;
    note.classList.add('is-error');
    if (shell) shell.classList.add('is-error');
  }

  function clearFail(form) {
    const note = form.querySelector('[data-note]');
    if (!note.classList.contains('is-error')) return;
    note.textContent = note.dataset.default;
    note.classList.remove('is-error');
    form.querySelectorAll('.is-error').forEach((n) => n.classList.remove('is-error'));
  }

  document.querySelectorAll('form[data-form]').forEach((form) => {
    const note = form.querySelector('[data-note]');
    note.dataset.default = note.textContent;
    form.addEventListener('input', () => clearFail(form));
    form.addEventListener('change', () => clearFail(form));
  });

  // Waitlist: both forms (hero and closing) turn into the same "you're on the list" note.
  const waitlistForms = [...document.querySelectorAll('form[data-form="waitlist"]')];
  function showJoined(email) {
    for (const form of waitlistForms) {
      const link = el('a', null, 'Tell us what to build');
      link.href = '#roadmap';
      form.replaceChildren(doneBlock("You're on the list.", [`We'll email ${email} when Nido opens. Got a minute? `, link, '.']));
    }
  }
  for (const form of waitlistForms) {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const input = form.querySelector('input[type="email"]');
      const shell = form.querySelector('.field-shell');
      const btn = form.querySelector('button[type="submit"]');
      const email = input.value.trim().toLowerCase();
      if (!EMAIL_RE.test(email) || email.length > 254) { fail(form, shell, 'invalid_email'); input.focus(); return; }
      busy(btn, true, 'Joining');
      try {
        await rpc('join_waitlist', { p_email: email });
        store.set(email);
        const ideaEmail = document.getElementById('idea-email');
        if (ideaEmail && !ideaEmail.value) ideaEmail.value = email;
        showJoined(email);
      } catch (e) {
        busy(btn, false, e.message === 'invalid_email' ? 'Join the waitlist' : 'Try again');
        fail(form, shell, e.message);
      }
    });
  }

  // Ideas
  const ideaForm = document.querySelector('form[data-form="idea"]');
  if (ideaForm) {
    const body = ideaForm.querySelector('textarea');
    const count = ideaForm.querySelector('[data-count]');
    const emailInput = ideaForm.querySelector('input[type="email"]');
    const remembered = store.get();
    if (remembered && !emailInput.value) emailInput.value = remembered;
    const updateCount = () => {
      count.textContent = `${body.value.length} / 500`;
      count.classList.toggle('is-near', body.value.length > 460);
    };
    body.addEventListener('input', updateCount);

    ideaForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = ideaForm.querySelector('button[type="submit"]');
      const text = body.value.trim();
      const chips = [...ideaForm.querySelectorAll('input[name="chips"]:checked')].map((c) => c.value);
      const email = emailInput.value.trim().toLowerCase();
      if (!text && chips.length === 0) { fail(ideaForm, ideaForm.querySelector('.idea-shell'), 'empty_idea'); body.focus(); return; }
      if (text.length > 500) { fail(ideaForm, ideaForm.querySelector('.idea-shell'), 'invalid_idea'); return; }
      if (email && (!EMAIL_RE.test(email) || email.length > 254)) { fail(ideaForm, ideaForm.querySelector('.field-shell'), 'invalid_email'); emailInput.focus(); return; }
      busy(btn, true, 'Sending');
      try {
        await rpc('submit_idea', { p_body: text || null, p_chips: chips, p_email: email || null });
        const again = el('button', 'link', 'Send another idea');
        again.type = 'button';
        const kept = [...ideaForm.children];
        const done = doneBlock('Thanks, got it.', ['We read every one. ', again]);
        again.addEventListener('click', () => {
          body.value = '';
          ideaForm.querySelectorAll('input[name="chips"]').forEach((c) => { c.checked = false; });
          updateCount();
          busy(btn, false, 'Send idea');
          ideaForm.replaceChildren(...kept);
          body.focus();
        });
        ideaForm.replaceChildren(done);
      } catch (e) {
        busy(btn, false, 'Try again');
        const shell = e.message === 'invalid_email' ? ideaForm.querySelector('.field-shell') : null;
        fail(ideaForm, shell, e.message);
      }
    });
  }

  // ------------------------------------------------------------------ nav
  const navWrap = document.querySelector('.nav-wrap');
  const nav = navWrap.querySelector('.nav');

  // ------------------------------------------------------------------ scroll demo
  const demo = document.getElementById('demo');
  const live = demo && !reduceMotion;
  let updateDemo = () => {};

  if (live) {
    const merge = new URLSearchParams(location.search).get('demo') !== 'grow';
    demo.classList.add('is-live');
    if (merge) demo.classList.add('is-merge');
    demo.style.setProperty('--demo-height', merge ? '1350vh' : '560vh');

    const app = demo.querySelector('[data-app]');
    const view = demo.querySelector('.thread-view');
    const thread = demo.querySelector('[data-thread]');
    const msgs = [...demo.querySelectorAll('.msg')].map((node) => ({ node, at: +node.dataset.at, beat: +node.dataset.beat, on: null, past: null }));
    const captions = [...demo.querySelectorAll('[data-caption]')];
    const dots = [...demo.querySelectorAll('.rail li')];
    const typing = demo.querySelector('[data-typing]');

    // Split each AI answer into words so it can "type out" as you scroll.
    const streams = [...demo.querySelectorAll('.ai-text')].map((p) => {
      const words = [];
      const walk = (node) => {
        for (const child of [...node.childNodes]) {
          if (child.nodeType === Node.TEXT_NODE) {
            const frag = document.createDocumentFragment();
            for (const part of child.textContent.split(/(\s+)/)) {
              if (!part) continue;
              if (/^\s+$/.test(part)) { frag.append(part); continue; }
              const w = el('span', 'w', part);
              words.push(w);
              frag.append(w);
            }
            child.replaceWith(frag);
          } else if (child.nodeType === Node.ELEMENT_NODE) {
            walk(child);
          }
        }
      };
      walk(p);
      const [a, b] = p.dataset.stream.split(' ').map(Number);
      return { msg: p.closest('.msg'), words, range: [a, b], shown: -1 };
    });

    const TYPING = [
      { name: 'Ana', range: [0, 0.05] },
      { name: 'Rafael', range: [0.37, 0.42] },
      { name: 'Leo', range: [0.67, 0.72] },
      { name: 'Rafael', range: [0.75, 0.79] },
      { name: 'Ana', range: [0.83, 0.86] },
    ];
    const beatOf = (c) => (c < 0.37 ? 1 : c < 0.67 ? 2 : 3);
    const P = merge
      ? { story: 0.355, pre: [0, 0.477], grow: [0.477, 0.591], chat: [0.591, 0.924], shrink: [0.933, 1] }
      : { grow: [0, 0.1], chat: [0.1, 0.92], shrink: [0.93, 1] };

    // Prelude parts
    const prelude = demo.querySelector('.prelude');
    const preCaption = demo.querySelector('[data-prelude-caption]');
    const punch = demo.querySelector('[data-punch]');
    // Split the punch line into words so scrolling can fill them in one at a time.
    const punchWords = [];
    (function split(node) {
      for (const n of [...node.childNodes]) {
        if (n.nodeType !== 3) { split(n); continue; }
        const frag = document.createDocumentFragment();
        for (const part of n.textContent.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) { frag.append(part); continue; }
          const w = document.createElement('span');
          w.className = 'pw';
          w.textContent = part;
          frag.append(w);
          punchWords.push(w);
        }
        n.replaceWith(frag);
      }
    })(punch);
    let punchShown = -1;
    const solos = [...demo.querySelectorAll('.solo')];
    const eggs = [...demo.querySelectorAll('[data-egg]')];
    const tethers = [...demo.querySelectorAll('[data-tethers] line')];
    const tetherBox = demo.querySelector('[data-tethers]');
    const nest = demo.querySelector('[data-nest]');
    const ring = nest.querySelector('circle');
    const soloMsgs = [...demo.querySelectorAll('[data-solo-at]')].map((n) => ({ n, at: +n.dataset.soloAt }));
    const PRE_CAPTIONS = [
      'Today, everyone has their own AI chat.',
      'So you copy, paste, and explain it all again.',
    ];
    let preIndex = 0;
    let swapTimer = 0;

    // Layout facts for the prelude, measured once per size: where each chat sits and where its egg slot is.
    let geo = null;
    const measure = () => {
      const W = prelude.clientWidth;
      const H = prelude.clientHeight;
      const small = W < 860;
      const L = Math.min(260, H * 0.34, W * 0.56);
      const ed = (14 / 64) * L;
      solos.forEach((n) => { n.style.transform = ''; });
      const pr = prelude.getBoundingClientRect();
      const base = solos.map((n) => {
        const sr = n.getBoundingClientRect();
        const tr = n.querySelector('.slot').getBoundingClientRect();
        const cx = sr.left + sr.width / 2;
        const cy = sr.top + sr.height / 2;
        return { cx: cx - pr.left, cy: cy - pr.top, sx: tr.left + tr.width / 2 - cx, sy: tr.top + tr.height / 2 - cy };
      });
      const ww = solos[0].offsetWidth;
      const far = small
        ? [[-0.12 * W, -0.12 * H], [0.12 * W, 0.1 * H], [-0.06 * W, 0.32 * H]]
        : [[-1.12 * ww, -0.02 * H], [0, 0.06 * H], [1.12 * ww, -0.05 * H]];
      geo = { W, H, L, ed, base, far, cx: W / 2, cy: H * 0.42, hyp: Math.hypot(W, H) };
      eggs.forEach((e) => { e.style.width = e.style.height = `${ed}px`; });
      nest.style.width = nest.style.height = `${L}px`;
    };
    const EGG_AT = [[0, -10], [8.7, 5], [-8.7, 5]]; // logo geometry, in 64-unit space, relative to the ring centre

    let lastTyping = null;
    let lastBeat = 0;
    let lastShift = -1;

    const setTyping = (name) => {
      if (name === lastTyping) return;
      lastTyping = name;
      if (name) {
        typing.replaceChildren(el('span', null, `${name} is typing`), Object.assign(el('span', 'dots'), { innerHTML: '<i></i><i></i><i></i>' }));
      }
      typing.classList.toggle('is-on', !!name);
    };

    const chatState = (c) => {
      let changed = false;
      const beat = beatOf(c);
      for (const m of msgs) {
        const on = c >= m.at;
        const past = on && m.beat < beat;
        if (on !== m.on) { m.node.classList.toggle('is-in', on); m.on = on; changed = true; }
        if (past !== m.past) { m.node.classList.toggle('is-past', past); m.past = past; }
      }
      for (const s of streams) {
        const t = seg(c, s.range);
        const k = Math.round(t * s.words.length);
        if (k !== s.shown) {
          for (let i = 0; i < s.words.length; i++) s.words[i].classList.toggle('is-in', i < k);
          s.shown = k;
          changed = true;
        }
        s.msg.classList.toggle('is-thinking', c >= +s.msg.dataset.at && c < s.range[0]);
        s.msg.classList.toggle('is-streaming', c >= s.range[0] && t < 1);
      }
      const typer = TYPING.find((t) => c >= t.range[0] && c < t.range[1]);
      setTyping(typer ? typer.name : null);
      if (beat !== lastBeat) {
        captions.forEach((n, i) => n.classList.toggle('is-on', i + 1 === beat));
        dots.forEach((n, i) => { n.classList.toggle('is-on', i + 1 <= beat); n.classList.toggle('is-now', i + 1 === beat); });
        lastBeat = beat;
      }
      if (changed) {
        // Keep the newest message in view, like a real chat.
        const avail = view.clientHeight - 30;
        const shift = Math.max(0, thread.offsetHeight - avail);
        if (shift !== lastShift) { thread.style.transform = `translateY(${-shift}px)`; lastShift = shift; }
      }
    };

    const preludeState = (p, appScale) => {
      if (!geo || geo.W !== prelude.clientWidth || geo.H !== prelude.clientHeight) measure();
      const { H, L, ed, base, far, hyp } = geo;
      // q runs the story (three chats, eggs rise out, ring closes); the punch line then holds the frame until the app zooms in.
      const q = seg(p, [0, P.story]);
      for (const m of soloMsgs) m.n.classList.toggle('is-in', q >= m.at);
      const idx = q < 0.42 ? 0 : 1;
      if (idx !== preIndex) {
        preIndex = idx;
        clearTimeout(swapTimer);
        preCaption.classList.add('is-swapping');
        swapTimer = setTimeout(() => { preCaption.textContent = PRE_CAPTIONS[preIndex]; preCaption.classList.remove('is-swapping'); }, 220);
      }
      preCaption.style.opacity = 1 - seg(q, [0.5, 0.58]);

      // The eggs rise out of their chats; the chats and tethers then fade away where they stand, and the eggs fly to the nest.
      const fade = easeInOut(seg(q, [0.5, 0.58]));
      const rise = easeOut(seg(q, [0.4, 0.5]));
      const lift = easeInOut(seg(q, [0.54, 0.72]));
      const sc0 = 16 / ed;
      const nx = geo.cx;
      const grow = seg(p, [P.grow[0], P.grow[0] + 0.03]);
      const ny = lerp(geo.cy, H / 2, easeOut(grow));
      // Ring size: the logo ring until the app zooms, then it grows with the app and flies off the edges.
      const k = Math.max(1, (hyp * appScale * 1.04) / L);
      solos.forEach((n, i) => {
        const [tx, ty] = far[i];
        n.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px)`;
        n.style.opacity = (1 - fade).toFixed(3);
        // Egg start: this chat's avatar slot, followed through the same transform.
        const b = base[i];
        const sx = b.cx + tx + b.sx;
        const sy = b.cy + ty + b.sy;
        const gx = nx + EGG_AT[i][0] * (L / 64) * k;
        const gy = ny + EGG_AT[i][1] * (L / 64) * k;
        // Each egg first lifts straight out of its chat on a dotted tether, then flies to its place in the nest.
        const rx = sx;
        const ry = sy - rise * H * 0.1;
        const x = lerp(rx, gx, lift);
        const y = lerp(ry, gy, lift) - Math.sin(Math.PI * lift) * H * 0.04;
        const sc = lerp(lerp(sc0, sc0 * 1.5, rise), k, lift);
        const tl = tethers[i];
        tl.setAttribute('x1', sx.toFixed(1)); tl.setAttribute('y1', sy.toFixed(1));
        tl.setAttribute('x2', x.toFixed(1)); tl.setAttribute('y2', y.toFixed(1));
        const e = eggs[i];
        e.style.transform = `translate(${(x - ed / 2).toFixed(1)}px, ${(y - ed / 2).toFixed(1)}px) scale(${sc.toFixed(3)})`;
        e.style.opacity = (1 - clamp((k - 1) / 0.5)).toFixed(3);
      });

      tetherBox.style.opacity = (rise * (1 - fade)).toFixed(3);

      // The ring draws itself around the eggs, clockwise.
      ring.style.strokeDashoffset = (1.004 - 1.004 * easeInOut(seg(q, [0.74, 0.86]))).toFixed(4);
      nest.style.transform = `translate(${(nx - (L * k) / 2).toFixed(1)}px, ${(ny - (L * k) / 2).toFixed(1)}px) scale(${k.toFixed(4)})`;
      nest.style.opacity = (1 - seg(p, [P.grow[1] - 0.05, P.grow[1]])).toFixed(3);

      // Hidden only once the app fully covers it.
      prelude.style.opacity = p >= P.grow[1] ? 0 : 1;

      // The punch line sits under the ring and fills in word by word; the app then zooms out over it.
      const pScale = lerp(0.9, 1.04, easeOut(seg(p, [0.88 * P.story, P.grow[0]])));
      punch.style.opacity = (easeOut(seg(q, [0.86, 0.94])) * (1 - seg(p, [P.grow[0], P.grow[0] + 0.05]))).toFixed(3);
      const fill = seg(p, [0.94 * P.story, P.grow[0] - 0.03]);
      const n = punchWords.length;
      const shown = Math.round(fill * 1000);
      if (shown !== punchShown) {
        punchShown = shown;
        punchWords.forEach((w, i) => { w.style.opacity = (0.12 + 0.88 * clamp(fill * (n + 1) - i)).toFixed(3); });
      }
      punch.style.top = `${(ny + (L * k) / 2 + 22).toFixed(1)}px`;
      punch.style.transform = `scale(${pScale.toFixed(4)})`;
      return p >= P.grow[0];
    };

    // The demo eases toward the scroll position instead of jumping with each wheel tick.
    let eased = null;
    let lastT = 0;
    updateDemo = (t) => {
      const r = demo.getBoundingClientRect();
      const vh = window.innerHeight;
      const target = -r.top;
      if (r.bottom < 0 || r.top > vh) { navWrap.classList.remove('is-hidden'); eased = null; return false; }
      const dt = lastT ? Math.min(64, t - lastT) : 16.7;
      lastT = t;
      const span = r.height - vh;
      let next = eased == null ? target : eased + (target - eased) * (1 - Math.pow(0.86, dt / 16.7));
      if (Math.abs(target - next) < 0.5) next = target;
      // The zoom into the app never plays faster than about a second, however fast the scroll.
      if (merge && eased != null) {
        const g0 = P.grow[0] * span, g1 = P.grow[1] * span;
        if (Math.min(eased, next) < g1 && Math.max(eased, next) > g0) {
          const cap = ((g1 - g0) * dt) / 1000;
          next = eased + clamp(next - eased, -cap, cap);
        }
      }
      eased = next;
      const p = clamp(eased / span);

      const sh = easeInOut(seg(p, P.shrink));
      let g, s;
      if (merge) {
        // Zoom out of the middle of the frame: geometric growth reads as steady camera speed.
        const t = seg(p, P.grow);
        g = t * t * (3 - 2 * t);
        s = sh > 0 ? lerp(1, 0.86, sh) : 0.03 * Math.pow(1 / 0.03, g);
      } else {
        g = easeOut(seg(p, P.grow));
        const start = window.innerWidth < 860 ? 0.9 : 0.8;
        s = sh > 0 ? lerp(1, 0.86, sh) : lerp(start, 1, g);
      }
      const appIn = merge ? preludeState(p, s) : true;
      const radius = (26 * Math.max(1 - g, sh)) / s;
      app.style.transform = `scale(${s.toFixed(4)})`;
      app.style.borderRadius = `${radius.toFixed(2)}px`;
      app.style.visibility = appIn ? '' : 'hidden';

      navWrap.classList.toggle('is-hidden', g > 0.85 && sh < 0.4);
      chatState(seg(p, P.chat));
      return eased !== target;
    };
  }

  // Spotlight grid behind the closing waitlist: the dots light up around the pointer.
  const closing = document.querySelector('.closing');
  if (closing) {
    const light = (e) => {
      const r = closing.getBoundingClientRect();
      closing.style.setProperty('--x', `${(e.clientX - r.left).toFixed(0)}px`);
      closing.style.setProperty('--y', `${(e.clientY - r.top).toFixed(0)}px`);
    };
    closing.addEventListener('pointermove', light, { passive: true });
    closing.addEventListener('pointerdown', light, { passive: true });
    closing.addEventListener('pointerleave', () => closing.style.setProperty('--x', '-999px'));
  }

  // The nav mark's ring doubles as a scroll progress bar; the hero ring turns slowly. Both stay still with reduced motion.
  const navRing = nav.querySelector('.mark-nav');
  const heroMark = reduceMotion ? null : document.querySelector('.hero-mark');

  // One passive scroll listener, batched to animation frames.
  let queued = false;
  const onFrame = (t) => {
    queued = false;
    nav.classList.toggle('is-scrolled', window.scrollY > 8);
    const doc = document.documentElement;
    const travel = doc.scrollHeight - window.innerHeight;
    if (!reduceMotion) navRing.style.setProperty('--p', (travel > 0 ? clamp(window.scrollY / travel) : 1).toFixed(3));
    if (heroMark && window.scrollY < window.innerHeight * 1.6) heroMark.style.setProperty('--turn', `${(window.scrollY * 0.06).toFixed(2)}deg`);
    if (updateDemo(t || performance.now())) schedule();
  };
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(onFrame); } };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  onFrame();
})();
