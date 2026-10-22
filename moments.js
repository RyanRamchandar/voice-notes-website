/* Voice Notes site: small scroll moments.
   One shared rAF loop. Each moment starts only when it is in view, and a "stage" lets just one
   canvas animate at a time (the hero registers too). Reduced motion gets the final frame. */
(() => {
  'use strict';
  const mqReduce = matchMedia('(prefers-reduced-motion: reduce)');
  const mqDark = matchMedia('(prefers-color-scheme: dark)');
  const reduce = () => mqReduce.matches;
  const clamp = (v, a = 0, b = 1) => v < a ? a : v > b ? b : v;
  const ease = (t) => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const PAL = () => mqDark.matches ? ['#8a92ff', '#b096ff', '#e488f2', '#ff95b0'] : ['#4b3fe0', '#6d3ae6', '#b42bc9', '#e8426e'];
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  function grad(t) {
    const s = PAL().map(hex), x = clamp(t) * 3, i = Math.min(2, Math.floor(x)), f = x - i;
    const c = s[i].map((v, k) => Math.round(v + (s[i + 1][k] - v) * f));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  // ---------- stage: the most visible registered canvas may animate; everyone else waits ----------
  const items = [];
  let owner = null;
  const stageIO = new IntersectionObserver((es) => {
    for (const e of es) { const it = items.find((i) => i.el === e.target); if (it) it.vis = e.isIntersecting ? e.intersectionRect.height : 0; }
    pick();
  }, { threshold: Array.from({ length: 21 }, (_, i) => i / 20) });
  function pick() {
    let best = null;
    for (const it of items) if (it.vis > 0 && (!best || it.vis > best.vis)) best = it;
    if (best === owner) return;
    const old = owner; owner = best;
    if (old) old.cb(false);
    if (best) best.cb(true);
  }
  const stage = {
    register(el, cb) { const it = { el, cb, vis: 0 }; items.push(it); stageIO.observe(el); return it; },
    release(it) { const i = items.indexOf(it); if (i < 0) return; items.splice(i, 1); stageIO.unobserve(it.el); if (owner === it) { owner = null; pick(); } },
    get owner() { return owner ? owner.el : null; },
  };
  window.__vnStage = stage;

  // ---------- shared loop ----------
  const live = new Set();
  let raf = 0;
  const perf = { frames: 0, ms: 0, max: 0 };
  window.__vnMoments = perf;
  perf.seek = {}; // test hooks: draw a moment at a given time without running it
  function tick(now) {
    raf = 0;
    const t0 = performance.now();
    for (const m of [...live]) if (!m.frame(now)) live.delete(m);
    const dt = performance.now() - t0;
    perf.frames++; perf.ms += dt; if (dt > perf.max) perf.max = dt;
    if (live.size && !document.hidden) raf = requestAnimationFrame(tick);
  }
  function run(m) { live.add(m); if (!raf && !document.hidden) raf = requestAnimationFrame(tick); }
  function stop(m) { live.delete(m); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && live.size && !raf) raf = requestAnimationFrame(tick); });

  function surface(host, cls) {
    const cv = document.createElement('canvas');
    cv.className = cls; cv.setAttribute('aria-hidden', 'true');
    host.appendChild(cv);
    const ctx = cv.getContext('2d');
    const s = { cv, ctx, w: 0, h: 0, fit() {
      const r = cv.getBoundingClientRect(), d = Math.min(window.devicePixelRatio || 1, 2);
      s.w = r.width; s.h = r.height;
      const W = Math.max(1, Math.round(r.width * d)), H = Math.max(1, Math.round(r.height * d));
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      ctx.setTransform(d, 0, 0, d, 0, 0);
    }, clear() { ctx.clearRect(0, 0, s.w, s.h); } };
    s.fit();
    return s;
  }
  // one-shot trigger: fires once when the element is at least `ratio` visible
  function once(el, ratio, fn) {
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) { io.disconnect(); fn(); } }, { threshold: ratio });
    io.observe(el);
  }
  // one-shot canvas moment with a clock that only advances while it holds the stage
  function oneShot({ el, ratio, dur, draw, start, finish }) {
    let t = 0, last = 0, on = false, started = false, done = false, it = null;
    const m = { frame(now) {
      if (!on) return false;
      const dt = last ? Math.min(50, now - last) : 16; last = now;
      t += dt / 1000;
      draw(Math.min(t, dur), false);
      if (t >= dur) { done = true; stage.release(it); draw(dur, true); if (finish) finish(); return false; }
      return true;
    } };
    once(el, ratio, () => {
      if (reduce()) { done = true; draw(dur, true); if (finish) finish(); return; }
      started = true; if (start) start();
      it = stage.register(el, (v) => { on = v; last = 0; if (v && !done) run(m); else stop(m); });
    });
    return { get done() { return done; }, get started() { return started; }, seek(x) { draw(Math.min(x, dur), x >= dur); } };
  }

  // =====================================================================
  // 1. Demo: when you let go of fn, the words stream out of the pill and land in the field
  // =====================================================================
  (function demoStream() {
    const demo = document.querySelector('#see-it .demo'), screen = demo && demo.querySelector('.screen'), pill = screen && screen.querySelector('.pill');
    if (!pill || !pill.getAnimations) return;
    const S = surface(screen, 'mo-stream');
    const N = 64, T = 6000, W0 = 0.545 * T, EMIT = 330, TRAVEL = 470, W1 = W0 + EMIT + TRAVEL + 40;
    let on = false, timer = 0, geo = null, drawn = false;
    const anim = () => pill.getAnimations().find((a) => a.animationName === 'pill');
    function clock() { const a = anim(); return a && a.currentTime != null ? a.currentTime % T : null; }
    function measure() {
      const sr = screen.getBoundingClientRect();
      const panes = [...screen.querySelectorAll('.sc')].filter((p) => p.querySelector('.txt'));
      const pane = panes.find((p) => parseFloat(getComputedStyle(p).opacity) > 0.5) || panes[0];
      const txt = pane.querySelector('.txt');
      const rects = [...txt.getClientRects()].filter((r) => r.width > 2);
      const pr = pill.getBoundingClientRect();
      const u = sr.width / (sr.width <= 620 ? 400 : 960);
      let total = 0; const lines = rects.map((r) => { const l = { x: r.left - sr.left, y: r.top - sr.top + r.height * .55, w: r.width, a: total }; total += r.width; return l; });
      const pts = [];
      for (let i = 0; i < N; i++) {
        const f = (i + .5) / N * total; let L = lines[0];
        for (const l of lines) if (f >= l.a) L = l;
        const sx = pr.left - sr.left + pr.width * (.2 + .6 * ((i * 37) % N) / N), sy = pr.top - sr.top + pr.height / 2;
        const tx = L.x + (f - L.a), ty = L.y + ((i * 13) % 5 - 2) * u * 1.2;
        const side = ((i * 29) % 7 - 3) * u * 9;
        pts.push({ sx, sy, tx, ty, cx: sx + (tx - sx) * .25 + side, cy: sy - (sy - ty) * .85 - u * 30, col: grad(i / (N - 1)) });
      }
      return { pts, r: Math.max(1.1, u * 2.1) };
    }
    function draw(ms) {
      S.clear();
      if (ms < W0 || ms > W1) { drawn = false; return false; }
      if (!geo) geo = measure();
      const ctx = S.ctx, { pts, r } = geo;
      for (let i = 0; i < N; i++) {
        const p = pts[i], q = (ms - W0 - (i / N) * EMIT) / TRAVEL;
        if (q <= 0 || q >= 1) continue;
        const a = clamp(q / .15) * (1 - clamp((q - .82) / .18));
        ctx.fillStyle = p.col;
        for (let g = 0; g < 4; g++) {
          const e = ease(clamp(q - g * .035)), k = 1 - e;
          const x = k * k * p.sx + 2 * k * e * p.cx + e * e * p.tx, y = k * k * p.sy + 2 * k * e * p.cy + e * e * p.ty;
          ctx.globalAlpha = a * (g ? .45 / g : 1);
          ctx.beginPath(); ctx.arc(x, y, r * (1 - g * .18), 0, 6.2832); ctx.fill();
        }
      }
      ctx.globalAlpha = 1; drawn = true;
      return true;
    }
    const m = { frame() {
      if (!on || demo.classList.contains('paused')) return false;
      const ms = clock(); if (ms == null) return false;
      if (draw(ms)) return true;
      geo = null; schedule(); return false;
    } };
    function schedule() {
      clearTimeout(timer);
      if (!on) return;
      const ms = clock(); if (ms == null) { timer = setTimeout(schedule, 500); return; }
      const wait = ms < W0 ? W0 - ms : ms > W1 ? T - ms + W0 : 0;
      timer = setTimeout(() => run(m), Math.max(0, wait - 20));
    }
    perf.seek.stream = (ms) => { geo = null; draw(ms); };
    if (reduce()) return;
    stage.register(screen, (v) => { on = v; if (v) schedule(); else { clearTimeout(timer); stop(m); if (drawn) { S.clear(); drawn = false; } } });
    new ResizeObserver(() => { S.fit(); geo = null; }).observe(screen);
    mqReduce.addEventListener('change', () => { if (reduce()) { on = false; clearTimeout(timer); stop(m); S.clear(); } });
  })();

  // =====================================================================
  // 2. On-device: honest numbers count up once
  // =====================================================================
  (function stats() {
    const box = document.querySelector('.stats'); if (!box) return;
    const nums = [...box.querySelectorAll('[data-to]')];
    const fmt = (el, v) => { el.textContent = v.toFixed(+el.dataset.dec || 0); };
    if (reduce()) return;
    box.classList.add('js-count');
    nums.forEach((el) => fmt(el, +el.dataset.from || 0));
    once(box, .6, () => {
      box.classList.add('in');
      let t0 = 0;
      run({ frame(now) {
        if (!t0) t0 = now;
        const t = (now - t0) / 1100;
        nums.forEach((el, i) => { const k = easeOut(clamp(t - i * .12)); const a = +el.dataset.from || 0, b = +el.dataset.to; fmt(el, a + (b - a) * k); });
        return t < 1.3;
      } });
    });
  })();

  // =====================================================================
  // 3. Meetings: two voices on one timeline fold into a transcript split by speaker
  // =====================================================================
  (function voices() {
    const box = document.querySelector('.voices'); if (!box) return;
    const lines = [...box.querySelectorAll('.vline')];
    if (reduce()) return;
    box.classList.add('js-voices');
    const S = surface(box, 'mo-voices');
    const GAP = 4.2, DUR = 3.1;
    let geo = null;
    function measure() {
      S.fit();
      const br = box.getBoundingClientRect(), pad = Math.min(30, br.width * .06), x0 = pad, x1 = S.w - pad, cy = S.h / 2;
      const segs = [[0, .36], [.39, .70], [.73, 1]];
      const dots = [];
      segs.forEach(([a, b], k) => {
        const sp = lines[k].classList.contains('b') ? 1 : 0;
        const tr = lines[k].querySelector('span').getBoundingClientRect();
        const tgt = []; const tw = Math.min(tr.width, S.w - 20), tx0 = tr.left - br.left, tyc = tr.top - br.top + tr.height / 2;
        for (let x = 0; x <= tw; x += GAP) for (let r = -1; r <= 1; r++) tgt.push([tx0 + x, tyc + r * 3.4]);
        const sx0 = x0 + (x1 - x0) * a, sx1 = x0 + (x1 - x0) * b;
        const cols = Math.max(2, Math.floor((sx1 - sx0) / GAP));
        const segDots = [];
        for (let c = 0; c < cols; c++) { const n = .45 + .55 * (((Math.sin((c + k * 31) * 12.9898) * 43758.5453) % 1 + 1) % 1); for (let r = -3; r <= 3; r++) segDots.push({ c, r, n, f: c / (cols - 1), x: sx0 + c * GAP }); }
        segDots.forEach((d, i) => { const g = tgt[Math.floor(i / segDots.length * tgt.length)]; d.tx = g[0]; d.ty = g[1]; d.k = k; d.sp = sp; });
        dots.push(...segDots);
      });
      return { dots, x0, x1, cy, amp: Math.min(S.h * .36, 46) };
    }
    const colA = () => mqDark.matches ? '#ab9cff' : '#5b3ee0', colB = () => mqDark.matches ? '#ff8fb8' : '#d6336c';
    function draw(t, final) {
      if (final) { S.clear(); return; }
      if (!geo) geo = measure();
      const ctx = S.ctx, { dots, x0, x1, cy, amp } = geo;
      S.clear();
      const reveal = x0 + (x1 - x0) * easeOut(clamp(t / 1.15));
      const fade = 1 - clamp((t - 2.35) / .55);
      const ca = colA(), cb = colB();
      for (let pass = 0; pass < 2; pass++) {
        ctx.fillStyle = pass ? cb : ca; ctx.beginPath();
        for (const d of dots) {
          if (d.sp !== pass) continue;
          const env = Math.sin(Math.PI * d.f) ** .6 * (.45 + .55 * Math.abs(Math.sin(d.f * 9.5 + d.k * 2 + t * 3.2))) * d.n;
          const wy = cy + (d.r / 3) * amp * env * (.5 + .5 * Math.sin(t * 2.4 + d.c * .5));
          const q = ease(clamp((t - 1.12 - d.k * .17 - d.f * .22) / .75));
          if (q <= 0 && d.x > reveal) continue;
          const x = d.x + (d.tx - d.x) * q, y = wy + (d.ty - wy) * q;
          const rad = (1.25 + (1 - Math.abs(d.r) / 3) * .35) * fade;
          if (rad <= .05) continue;
          ctx.moveTo(x + rad, y); ctx.arc(x, y, rad, 0, 6.2832);
        }
        ctx.globalAlpha = .9; ctx.fill(); ctx.globalAlpha = 1;
      }
      // the playhead while recording
      if (t < 1.2) { ctx.globalAlpha = .35 * (1 - clamp((t - .9) / .3)); ctx.fillStyle = mqDark.matches ? '#fff' : '#000'; ctx.fillRect(reveal, cy - amp - 6, 1, amp * 2 + 12); ctx.globalAlpha = 1; }
    }
    let shown = false;
    const showLines = () => { if (!shown) { shown = true; box.classList.add('done'); } };
    perf.seek.voices = oneShot({ el: box, ratio: .55, dur: DUR, draw: (t, f) => { if (t > 2.3) showLines(); draw(t, f); }, finish: showLines }).seek;
    new ResizeObserver(() => { geo = null; S.fit(); }).observe(box);
  })();

  // =====================================================================
  // 4. Compare: the Voice Notes checks land one after another
  // =====================================================================
  (function checks() {
    const wrap = document.querySelector('.table-wrap'); if (!wrap || reduce()) return;
    const marks = [...wrap.querySelectorAll('tbody td.us > .y')];
    marks.forEach((s, i) => s.style.setProperty('--i', i));
    wrap.classList.add('js-pop');
    once(wrap.querySelector('tbody') || wrap, .25, () => wrap.classList.add('in'));
  })();

  // =====================================================================
  // 5. Privacy: a waveform folds into a dotted lock, and the shackle clicks shut
  // =====================================================================
  (function lock() {
    const host = document.querySelector('.lockmark'); if (!host) return;
    const S = surface(host, 'mo-lock');
    const DUR = 2.5;
    let geo = null;
    function measure() {
      S.fit();
      const sc = Math.min(S.h / 100, S.w / 100) * .95, ox = S.w / 2 - 50 * sc, oy = S.h / 2 - 52 * sc;
      const P = [], step = 3.3;
      const seg = (ax, ay, bx, by, kind) => { const L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.round(L / step)); for (let i = 0; i < n; i++) P.push([ax + (bx - ax) * i / n, ay + (by - ay) * i / n, kind]); };
      const arc = (cx, cy, r, a0, a1, kind) => { const n = Math.max(2, Math.round(Math.abs(a1 - a0) * r / step)); for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; P.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, kind]); } };
      // body: rounded rectangle 20..80 x 46..90, r=9
      const L = 20, R = 80, T = 46, B = 90, rr = 9;
      seg(L + rr, T, R - rr, T, 0); arc(R - rr, T + rr, rr, -Math.PI / 2, 0, 0);
      seg(R, T + rr, R, B - rr, 0); arc(R - rr, B - rr, rr, 0, Math.PI / 2, 0);
      seg(R - rr, B, L + rr, B, 0); arc(L + rr, B - rr, rr, Math.PI / 2, Math.PI, 0);
      seg(L, B - rr, L, T + rr, 0); arc(L + rr, T + rr, rr, Math.PI, Math.PI * 1.5, 0);
      // shackle (kind 1 moves when it clicks shut)
      seg(33, 45, 33, 30, 1); arc(50, 30, 17, Math.PI, Math.PI * 2, 1); seg(67, 30, 67, 45, 1);
      // keyhole
      P.push([50, 63.5, 2]); P.push([50, 68.5, 3]); P.push([50, 72.5, 3]);
      const pts = P.map(([x, y, kind], i) => {
        const fx = (i * 0.618034) % 1;
        const sx = S.w * (.04 + .92 * fx);
        return { x: ox + x * sc, y: oy + y * sc, kind, sx, ph: fx * 18, col: grad((x - 20) / 60), d: Math.abs(sx - S.w / 2) / (S.w / 2) };
      });
      return { pts, sc, r: Math.max(1.3, sc * 1.25), cy: S.h * .52 };
    }
    function draw(t, final) {
      if (!geo) geo = measure();
      const ctx = S.ctx, { pts, sc, r, cy } = geo;
      S.clear();
      const lift = final ? 0 : (t < 1.75 ? 7 : 7 * (1 - easeOut(clamp((t - 1.75) / .22)))) * sc;
      const pulse = final ? 0 : clamp(1 - Math.abs(t - 2.0) / .3);
      for (const p of pts) {
        const q = final ? 1 : ease(clamp((t - .45 - p.d * .35) / .95));
        const wy = cy + Math.sin(p.ph + t * 5) * 10 * Math.sin(Math.PI * (p.sx / S.w));
        const x = p.sx + (p.x - p.sx) * q, y = wy + (p.y - (p.kind === 1 ? lift : 0) - wy) * q;
        ctx.globalAlpha = final ? 1 : .55 + .45 * q;
        ctx.fillStyle = p.col;
        const k = 1 + ((p.kind === 2 ? 2.3 : p.kind === 3 ? 1.15 : 1) - 1) * q;
        ctx.beginPath(); ctx.arc(x, y, r * k * (1 + pulse * .25), 0, 6.2832); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    const shot = oneShot({ el: host, ratio: .7, dur: DUR, draw, start: () => draw(0, false) });
    perf.seek.lock = shot.seek;
    // until it plays, show the resting waveform frame so the space is never empty
    if (!reduce()) draw(0, false);
    const redraw = () => { geo = null; if (shot.done) draw(DUR, true); else if (!shot.started) draw(0, false); };
    new ResizeObserver(redraw).observe(host);
    mqDark.addEventListener('change', redraw);
  })();
})();
