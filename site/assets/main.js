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
    mark.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>';
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
    const merge = new URLSearchParams(location.search).get('demo') === 'merge';
    demo.classList.add('is-live');
    if (merge) demo.classList.add('is-merge');
    demo.style.setProperty('--demo-height', merge ? '840vh' : '560vh');

    const app = demo.querySelector('[data-app]');
    const view = demo.querySelector('.thread-view');
    const thread = demo.querySelector('[data-thread]');
    const msgs = [...demo.querySelectorAll('.msg')].map((node) => ({ node, at: +node.dataset.at, beat: +node.dataset.beat, on: null, past: null }));
    const captions = [...demo.querySelectorAll('[data-caption]')];
    const captionBox = demo.querySelector('.captions');
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
      ? { pre: [0, 0.3], grow: [0.3, 0.38], chat: [0.38, 0.93], shrink: [0.94, 1] }
      : { grow: [0, 0.1], chat: [0.1, 0.92], shrink: [0.93, 1] };

    // Prelude parts
    const prelude = demo.querySelector('.prelude');
    const preCaption = demo.querySelector('[data-prelude-caption]');
    const punch = demo.querySelector('[data-punch]');
    const soloA = demo.querySelector('.solo-a');
    const soloB = demo.querySelector('.solo-b');
    const soloMsgs = [...demo.querySelectorAll('[data-solo-at]')].map((n) => ({ n, at: +n.dataset.soloAt }));
    const PRE_CAPTIONS = [
      'Today, everyone has their own AI chat.',
      'So you copy, paste, and explain it all again.',
    ];
    let preIndex = 0;
    let swapTimer = 0;

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
        dots.forEach((n, i) => n.classList.toggle('is-on', i + 1 === beat));
        lastBeat = beat;
      }
      if (changed) {
        // Keep the newest message in view, like a real chat.
        const avail = view.clientHeight - 30;
        const shift = Math.max(0, thread.offsetHeight - avail);
        if (shift !== lastShift) { thread.style.transform = `translateY(${-shift}px)`; lastShift = shift; }
      }
    };

    const preludeState = (p) => {
      const q = seg(p, P.pre);
      for (const m of soloMsgs) m.n.classList.toggle('is-in', q >= m.at);
      const idx = q < 0.42 ? 0 : 1;
      if (idx !== preIndex) {
        preIndex = idx;
        clearTimeout(swapTimer);
        preCaption.classList.add('is-swapping');
        swapTimer = setTimeout(() => { preCaption.textContent = PRE_CAPTIONS[preIndex]; preCaption.classList.remove('is-swapping'); }, 220);
      }
      preCaption.style.opacity = 1 - seg(q, [0.6, 0.68]);
      const w = soloA.offsetWidth;
      const far = w / 2 + Math.min(80, window.innerWidth * 0.04);
      const near = w * 0.16;
      const drift = easeInOut(seg(q, [0.42, 0.6]));
      const fuse = easeInOut(seg(q, [0.6, 0.76]));
      const x = lerp(lerp(far, near, drift), 0, fuse);
      const rot = lerp(0, 3, drift) * (1 - fuse);
      const scale = lerp(1, 0.92, fuse);
      const alpha = 1 - seg(q, [0.66, 0.78]);
      soloA.style.transform = `translateX(${-x}px) rotate(${-rot}deg) scale(${scale})`;
      soloB.style.transform = `translateX(${x}px) rotate(${rot}deg) scale(${scale})`;
      soloA.style.opacity = soloB.style.opacity = alpha;
      prelude.style.opacity = 1 - seg(p, [P.grow[0] + 0.01, P.grow[0] + 0.05]);
      captionBox.style.opacity = seg(p, [P.grow[0] + 0.03, P.grow[0] + 0.07]);
      // The punch line: alone in the frame, centered, growing as you scroll; it gives way when the app arrives.
      const pIn = seg(q, [0.72, 0.84]);
      const pOut = seg(p, [P.grow[0], P.grow[0] + 0.035]);
      const pScale = lerp(0.9, 1.08, easeOut(seg(q, [0.72, 1]))) + 0.06 * pOut;
      punch.style.opacity = (easeOut(pIn) * (1 - pOut)).toFixed(3);
      punch.style.transform = `translateY(-50%) scale(${pScale.toFixed(4)})`;
      return seg(p, [P.grow[0] + 0.01, P.grow[0] + 0.05]);
    };

    updateDemo = () => {
      const r = demo.getBoundingClientRect();
      const vh = window.innerHeight;
      if (r.bottom < 0 || r.top > vh) { navWrap.classList.remove('is-hidden'); return; }
      const p = clamp(-r.top / (r.height - vh));

      let appIn = 1;
      if (merge) appIn = preludeState(p);

      const g = easeOut(seg(p, P.grow));
      const sh = easeInOut(seg(p, P.shrink));
      const start = window.innerWidth < 860 ? 0.9 : 0.8;
      let s = sh > 0 ? lerp(1, 0.86, sh) : lerp(start, 1, g);
      if (merge && appIn < 1) s *= lerp(0.88, 1, easeOut(appIn));
      const radius = (26 * Math.max(1 - g, sh)) / s;
      app.style.transform = `scale(${s.toFixed(4)})`;
      app.style.borderRadius = `${radius.toFixed(2)}px`;
      app.style.opacity = merge ? appIn.toFixed(3) : '';

      navWrap.classList.toggle('is-hidden', g > 0.85 && sh < 0.4);
      chatState(seg(p, P.chat));
    };
  }

  // One passive scroll listener, batched to animation frames.
  let queued = false;
  const onFrame = () => {
    queued = false;
    nav.classList.toggle('is-scrolled', window.scrollY > 8);
    updateDemo();
  };
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(onFrame); } };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  onFrame();
})();
