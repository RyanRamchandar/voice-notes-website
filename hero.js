/* Voice field: a procedural, cursor-reactive waveform made of dots.
   Idle: a dotted waveform that breathes like speech and swells toward the pointer.
   Press and hold: the dots gather into the Voice Notes pill waveform.
   Release: they type a short phrase out, left to right, then drift back.
   Optional mic mode drives the field with the visitor's voice. Audio never leaves the tab. */
(() => {
  'use strict';
  const cv = document.getElementById('field');
  if (!cv || !cv.getContext) return;
  const panel = cv.parentElement;
  const content = panel.querySelector('.opener-content');
  const micBtn = document.getElementById('micBtn');
  const ctx = cv.getContext('2d');
  const mqReduce = matchMedia('(prefers-reduced-motion: reduce)');
  const mqDark = matchMedia('(prefers-color-scheme: dark)');
  const PHRASES = ['Just say it.', 'It types for you.', 'Right where you are.'];
  const MIC_PHRASE = 'That was your voice.';
  const TAU = Math.PI * 2;

  let W = 0, H = 0, dpr = 1, C = 0, R = 0, N = 0, colGap = 6, dot = 2;
  let hy = 0, ampMax = 0, pillK = 1;
  let X, Y, VX, VY, A, TX, TY, TA, KF, DEL, ISTXT, COL, ROW;
  let amp, ampS, micBins, EDGE;
  let dark = mqDark.matches, reduce = mqReduce.matches;
  let grad = null, barColor = '#232226';
  let running = false, visible = true, raf = 0, last = 0, t0 = performance.now();

  // interaction state
  const ptr = { x: -1e4, y: -1e4, inside: false, energy: 0, lastX: 0, lastY: 0, lastRipple: 0 };
  const ripples = [];
  let mode = 'field', modeT = 0, pillAmt = 0, auto = false, lastUser = -1e4, lastAuto = -1e4, phraseIx = 0;
  let txt = null; // { minx, maxx, fs, cx, top, bottom }
  let mic = null; // { ctx, an, td, fd, stream, level, speaking, voicedFor, silentFor }

  const stats = (window.__vnHero = { frames: 0, total: 0, max: 0, N: 0, mode: () => mode });

  // ---------- layout ----------
  function layout() {
    const r = panel.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    const mobile = W < 700;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    // Waveform lives in the space above the headline.
    const top = content ? content.offsetTop : H * 0.55;
    hy = Math.round(Math.max(110, top * 0.52));
    ampMax = Math.min(top * 0.4, H * 0.2);
    colGap = mobile ? 5 : 6;
    dot = mobile ? 1.8 : 2;
    C = Math.floor((W - 24) / colGap);
    R = mobile ? 30 : 20;
    N = C * R;
    pillK = Math.min(W * (mobile ? 0.5 : 0.22), 340) / 85;
    X = new Float32Array(N); Y = new Float32Array(N); VX = new Float32Array(N); VY = new Float32Array(N);
    A = new Float32Array(N); TX = new Float32Array(N); TY = new Float32Array(N); TA = new Float32Array(N);
    KF = new Float32Array(N); DEL = new Float32Array(N); ISTXT = new Uint8Array(N);
    COL = new Uint16Array(N); ROW = new Uint8Array(N);
    amp = new Float32Array(C); ampS = new Float32Array(C); micBins = new Float32Array(C);
    EDGE = new Float32Array(C);
    for (let i = 0; i < C; i++) { const u = i / (C - 1), e = Math.min(1, Math.min(u, 1 - u) / 0.14); EDGE[i] = e * e * (3 - 2 * e); }
    const x0 = (W - (C - 1) * colGap) / 2;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0, n = 0; i < C; i++) for (let k = 0; k < R; k++, n++) {
      COL[n] = i; ROW[n] = k;
      X[n] = x0 + i * colGap; Y[n] = hy; A[n] = 0;
      KF[n] = 0.75 + rnd() * 0.5;
    }
    stats.N = N;
    themeChanged();
    if (mode === 'type' && txt) buildText(txt.phrase);
  }

  function themeChanged() {
    dark = mqDark.matches;
    grad = ctx.createLinearGradient(0, 0, W * dpr, 0);
    const s = dark
      ? ['#7d86ff', '#a98bff', '#e07bf0', '#ff8aa8']
      : ['#4b3fe0', '#6d3ae6', '#b42bc9', '#e8426e'];
    grad.addColorStop(0, s[0]); grad.addColorStop(0.42, s[1]); grad.addColorStop(0.76, s[2]); grad.addColorStop(1, s[3]);
    barColor = dark ? '#EBEAEE' : '#232226';
    if (!running) drawStatic();
  }

  // ---------- signals ----------
  const x0of = () => (W - (C - 1) * colGap) / 2;
  function fieldAmps(t, dt) {
    const sig = 0.06 * W, sigR = Math.max(18, 0.022 * W);
    const breath = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 0.7));
    const syll = 0.75 + 0.25 * Math.sin(t * 2.3) * Math.sin(t * 0.9 + 1);
    const x0 = x0of();
    const ml = mic ? mic.level : 0;
    for (let i = 0; i < C; i++) {
      const u = i / (C - 1);
      const env = 0.18 + 0.82 * Math.exp(-Math.pow((u - 0.5) / 0.3, 2));
      const w = 0.5 + 0.5 * (0.5 * Math.sin(u * 13.0 + t * 1.6) + 0.3 * Math.sin(u * 29.0 - t * 2.7) + 0.2 * Math.sin(u * 5.0 + t * 0.8));
      let a = ampMax * (0.05 + 0.78 * env * Math.pow(w, 1.6) * breath * syll);
      const x = x0 + i * colGap;
      if (ptr.energy > 0.001) {
        const d = x - ptr.x;
        a += ampMax * 0.62 * ptr.energy * Math.exp(-(d * d) / (2 * sig * sig));
      }
      for (let j = 0; j < ripples.length; j++) {
        const rp = ripples[j];
        const rad = rp.age * W * 0.42;
        const d = Math.abs(x - rp.x) - rad;
        a += ampMax * 0.5 * rp.s * Math.exp(-(d * d) / (2 * sigR * sigR));
      }
      if (ml > 0) a = a * (1 - Math.min(ml * 1.5, 0.7)) + ampMax * 1.1 * env * micBins[i];
      amp[i] = Math.min(a, ampMax);
    }
    const f = Math.min(1, dt * 14);
    for (let i = 0; i < C; i++) ampS[i] += (amp[i] - ampS[i]) * f;
  }

  const barLv = new Float32Array(14);
  function pillLevels(t) {
    for (let b = 0; b < 14; b++) {
      let v;
      if (mic && mic.level > 0.02) {
        v = 0;
        const lo = Math.floor((b / 14) * C * 0.5 + C * 0.25), hi = Math.floor(((b + 1) / 14) * C * 0.5 + C * 0.25);
        for (let i = lo; i < hi; i++) v = Math.max(v, micBins[i]);
        v = Math.min(1, v * 1.4);
      } else {
        const center = 1 - Math.pow((b - 6.5) / 8, 2);
        v = center * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 8.3 + b * 1.9) * Math.sin(t * 3.7 + b * 0.7)));
      }
      barLv[b] += (v - barLv[b]) * 0.35;
    }
  }

  // ---------- text targets ----------
  const off = document.createElement('canvas');
  const offCtx = off.getContext('2d', { willReadFrequently: true });
  function buildText(phrase) {
    const fam = getComputedStyle(document.querySelector('.opener h1') || document.body).fontFamily;
    let fs = Math.min(ampMax * 1.05, W * (W < 700 ? 0.15 : 0.12), 108);
    offCtx.font = `700 ${fs}px ${fam}`;
    const maxW = W * 0.86;
    const mw = offCtx.measureText(phrase).width;
    if (mw > maxW) fs *= maxW / mw;
    off.width = W; off.height = H;
    offCtx.clearRect(0, 0, W, H);
    offCtx.font = `700 ${fs}px ${fam}`;
    offCtx.textAlign = 'center'; offCtx.textBaseline = 'middle';
    offCtx.fillStyle = '#000';
    offCtx.fillText(phrase, W / 2, hy);
    const img = offCtx.getImageData(0, 0, W, H).data;
    let pts = null, step = Math.max(W < 700 ? 1.9 : 1.6, fs / 60);
    for (let tries = 0; tries < 30; tries++, step *= 1.08) {
      const p = [];
      for (let y = Math.max(0, hy - fs); y < Math.min(H, hy + fs); y += step)
        for (let x = 0; x < W; x += step) if (img[((y | 0) * W + (x | 0)) * 4 + 3] > 140) p.push(x, y);
      if (p.length / 2 <= N * 0.88) { pts = p; break; }
    }
    if (!pts) return;
    const M = pts.length / 2;
    // order targets left to right
    const order = new Array(M); for (let j = 0; j < M; j++) order[j] = j;
    order.sort((a, b) => pts[a * 2] - pts[b * 2]);
    // particles ordered by current x
    const pidx = new Array(N); for (let n = 0; n < N; n++) pidx[n] = n;
    pidx.sort((a, b) => X[a] - X[b]);
    ISTXT.fill(0);
    let minx = 1e9, maxx = -1e9;
    for (let j = 0; j < M; j++) { const x = pts[order[j] * 2]; if (x < minx) minx = x; if (x > maxx) maxx = x; }
    for (let j = 0; j < M; j++) {
      const n = pidx[Math.floor((j * N) / M)];
      const o = order[j];
      ISTXT[n] = 1; TX[n] = pts[o * 2]; TY[n] = pts[o * 2 + 1];
      DEL[n] = 0.08 + 0.9 * ((TX[n] - minx) / Math.max(1, maxx - minx));
    }
    txt = { phrase, minx, maxx, fs, step, M };
    stats.txt = txt;
  }

  // ---------- modes ----------
  function startListen(isAuto, now) {
    if (reduce) return;
    auto = !!isAuto; mode = 'listen'; modeT = now;
    if (!isAuto) lastUser = now;
  }
  function release(now, phrase) {
    if (mode !== 'listen') return;
    const held = (now - modeT) / 1000;
    if (held < 0.18 && !auto && !phrase) { mode = 'field'; return; }
    buildText(phrase || PHRASES[phraseIx++ % PHRASES.length]);
    mode = 'type'; modeT = now;
  }

  // ---------- frame ----------
  function frame(now) {
    raf = 0;
    if (!running) return;
    const tStart = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    const t = (now - t0) / 1000;
    step(now, t, dt);
    draw(now, t);
    const ms = performance.now() - tStart;
    stats.frames++; stats.total += ms; if (ms > stats.max) stats.max = ms;
    raf = requestAnimationFrame(frame);
  }

  function step(now, t, dt) {
    // mic analysis
    if (mic) analyseMic(dt, now);
    // attract loop for passive visitors
    if (!mic && mode === 'field' && now - lastUser > 6500 && now - lastAuto > 11000 && now - t0 > 1800) {
      lastAuto = now; startListen(true, now);
    }
    if (mode === 'listen' && auto && now - modeT > 1700) release(now);
    if (mode === 'type' && now - modeT > (txt ? 3600 : 0)) { mode = 'field'; modeT = now; }

    ptr.energy *= Math.pow(0.18, dt);
    for (let j = ripples.length - 1; j >= 0; j--) {
      const rp = ripples[j]; rp.age += dt; rp.s = Math.max(0, 1 - rp.age / 1.6) ** 2 * rp.p;
      if (rp.age > 1.6) ripples.splice(j, 1);
    }
    fieldAmps(t, dt);
    pillLevels(t);
    const wantPill = mode === 'listen' ? 1 : 0;
    pillAmt += (wantPill - pillAmt) * Math.min(1, dt * (wantPill ? 9 : 6));

    const x0 = x0of();
    const cx = W / 2, barW = 2.5 * pillK, gap = 2 * pillK, total = 14 * barW + 13 * gap;
    const colsPerBar = C / 14;
    const typeT = mode === 'type' ? (now - modeT) / 1000 : 0;
    const leaving = mode === 'type' && typeT > 3.0;

    for (let n = 0; n < N; n++) {
      const i = COL[n], k = ROW[n];
      const f = ((k + 0.5) / R) * 2 - 1; // -1..1
      let tx, ty, ta, K = 0.16, D = 0.68;
      // field home
      const fx = x0 + i * colGap, fy = hy + ampS[i] * f;
      const fa = EDGE[i] * (0.28 + 0.72 * (1 - f * f) * (0.35 + 0.65 * Math.min(1, ampS[i] / (ampMax * 0.45))));
      if (mode === 'listen') {
        const b = Math.min(13, Math.floor(i / colsPerBar));
        const s0 = Math.ceil(b * colsPerBar), s1 = Math.ceil((b + 1) * colsPerBar) - 1;
        const sub = (i - s0 + 0.5) / Math.max(1, s1 - s0 + 1);
        const bx = cx - total / 2 + b * (barW + gap) + barW * sub;
        const bh = (3 + 15 * barLv[b]) * pillK;
        tx = bx; ty = hy + (bh / 2 - pillK * 0.6) * f; ta = 1;
        K = 0.11 * KF[n]; D = 0.74;
      } else if (mode === 'type' && txt) {
        if (ISTXT[n] && !leaving) {
          if (typeT > DEL[n]) { tx = TX[n]; ty = TY[n]; ta = 1; K = 0.075 * KF[n]; D = 0.78; }
          else { // still waiting inside the pill
            const b = Math.min(13, Math.floor(i / colsPerBar));
            tx = cx - total / 2 + b * (barW + gap) + barW / 2; ty = hy; ta = 0.9; K = 0.1; D = 0.75;
          }
        } else {
          tx = fx; ty = hy + ampS[i] * f * 0.35; ta = leaving ? fa : fa * 0.12; K = leaving ? 0.05 * KF[n] : 0.08; D = 0.8;
        }
      } else { tx = fx; ty = fy; ta = fa; }
      VX[n] = (VX[n] + (tx - X[n]) * K) * D;
      VY[n] = (VY[n] + (ty - Y[n]) * K) * D;
      X[n] += VX[n]; Y[n] += VY[n];
      A[n] += (ta - A[n]) * 0.18;
    }
  }

  const BUCKETS = [0.22, 0.45, 0.7, 1];
  function draw(now, t) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // soft glow under the waveform, brighter with energy
    let e = 0; for (let i = 0; i < C; i += 4) e += ampS[i]; e = e / Math.ceil(C / 4) / ampMax;
    const gx = ptr.inside ? ptr.x : W / 2;
    const g = ctx.createRadialGradient(gx, hy, 0, gx, hy, Math.max(W, H) * 0.45);
    const ga = (dark ? 0.2 : 0.11) * (0.5 + e) + pillAmt * 0.05;
    g.addColorStop(0, dark ? `rgba(140,110,255,${ga})` : `rgba(120,90,255,${ga})`);
    g.addColorStop(1, 'rgba(120,90,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // pill glass
    if (pillAmt > 0.01) {
      const pw = 85 * pillK, ph = 32 * pillK, s = 0.97 + 0.03 * pillAmt;
      const px = W / 2 - (pw * s) / 2, py = hy - (ph * s) / 2 + (1 - pillAmt) * 4 * pillK * 0.3;
      ctx.save();
      ctx.globalAlpha = pillAmt;
      ctx.shadowColor = dark ? 'rgba(0,0,0,.55)' : 'rgba(40,20,90,.18)';
      ctx.shadowBlur = 18 * pillK * 0.6; ctx.shadowOffsetY = 4 * pillK * 0.4;
      roundRect(px, py, pw * s, ph * s, (ph * s) / 2);
      ctx.fillStyle = dark ? 'rgba(42,40,48,.78)' : 'rgba(255,255,255,.74)';
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = 1;
      ctx.strokeStyle = dark ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.08)';
      ctx.stroke();
      // top sheen
      const sh = ctx.createLinearGradient(0, py, 0, py + ph * s);
      sh.addColorStop(0, dark ? 'rgba(255,255,255,.10)' : 'rgba(255,255,255,.9)');
      sh.addColorStop(0.5, 'rgba(255,255,255,0)');
      ctx.fillStyle = sh; ctx.fill();
      ctx.restore();
    }

    // dots: gradient pass, then solid pill-colour pass while gathered
    const m = pillAmt;
    const sz = mode === 'type' && txt ? Math.max(1.1, Math.min(txt.step * (W < 700 ? 0.68 : 0.86), 3.2)) : dot;
    if (dark) ctx.globalCompositeOperation = 'lighter';
    drawDots(grad, 1 - m * 0.9, sz);
    ctx.globalCompositeOperation = 'source-over';
    if (m > 0.02) drawBars(m);

    // caret at the typing front
    if (mode === 'type' && txt) {
      const tt = (now - modeT) / 1000;
      const prog = Math.min(1, Math.max(0, (tt - 0.3) / 0.9));
      if (tt < 3.0) {
        const cxr = txt.minx + (txt.maxx - txt.minx) * prog + txt.fs * 0.1;
        const blink = prog < 1 ? 1 : (Math.sin(tt * 8) > 0 ? 1 : 0.15);
        ctx.globalAlpha = blink * Math.min(1, tt * 5);
        ctx.fillStyle = dark ? '#a593ff' : '#5b3ee0';
        ctx.fillRect(Math.round(cxr), hy - txt.fs * 0.4, Math.max(2, txt.fs * 0.03), txt.fs * 0.8);
        ctx.globalAlpha = 1;
      }
    }
  }

  // Solid capsule bars, same geometry as the app pill: 14 bars, 2.5 wide, 2 apart, 3 to 18 tall.
  function drawBars(m) {
    const barW = 2.5 * pillK, gap = 2 * pillK, total = 14 * barW + 13 * gap, x0 = W / 2 - total / 2;
    ctx.globalAlpha = Math.min(1, m * m * 1.15);
    ctx.fillStyle = barColor;
    ctx.beginPath();
    for (let b = 0; b < 14; b++) {
      const bh = (3 + 15 * barLv[b]) * pillK * (0.6 + 0.4 * m);
      const x = x0 + b * (barW + gap), y = hy - bh / 2, r = barW / 2;
      ctx.moveTo(x + r, y); ctx.arcTo(x + barW, y, x + barW, y + bh, r); ctx.arcTo(x + barW, y + bh, x, y + bh, r);
      ctx.arcTo(x, y + bh, x, y, r); ctx.arcTo(x, y, x + barW, y, r); ctx.closePath();
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawDots(style, alpha, sz) {
    if (alpha <= 0.01) return;
    ctx.fillStyle = style;
    const h = sz / 2;
    for (let b = 0; b < BUCKETS.length; b++) {
      const lo = b ? BUCKETS[b - 1] : 0.03, hi = BUCKETS[b];
      ctx.globalAlpha = hi * alpha;
      ctx.beginPath();
      for (let n = 0; n < N; n++) {
        const a = A[n];
        if (a > lo && a <= hi + (b === BUCKETS.length - 1 ? 1 : 0)) ctx.rect(X[n] - h, Y[n] - h, sz, sz);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // A calm, finished-looking still frame for reduced motion.
  function drawStatic() {
    if (!W) return;
    const t = 2.15;
    ptr.energy = 0; ripples.length = 0; pillAmt = 0; mode = 'field';
    for (let i = 0; i < 40; i++) { fieldAmps(t, 1); }
    const x0 = x0of();
    for (let n = 0; n < N; n++) {
      const i = COL[n], f = ((ROW[n] + 0.5) / R) * 2 - 1;
      X[n] = x0 + i * colGap; Y[n] = hy + ampS[i] * f;
      A[n] = EDGE[i] * (0.28 + 0.72 * (1 - f * f) * (0.35 + 0.65 * Math.min(1, ampS[i] / (ampMax * 0.45))));
    }
    draw(performance.now(), t);
  }

  // ---------- run control ----------
  function shouldRun() { return !reduce && visible && !document.hidden; }
  function sync() {
    const want = shouldRun();
    if (want && !running) { running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
    else if (!want && running) { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
    if (!want) drawStatic();
  }
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; sync(); }, { threshold: 0 }).observe(panel);
  document.addEventListener('visibilitychange', () => { if (document.hidden && mic) stopMic(); sync(); });
  mqReduce.addEventListener('change', () => { reduce = mqReduce.matches; sync(); });
  mqDark.addEventListener('change', themeChanged);
  let rz = 0;
  new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(() => { layout(); if (!running) drawStatic(); }, 80); }).observe(panel);

  // ---------- pointer ----------
  function local(e) { const r = panel.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  panel.addEventListener('pointermove', (e) => {
    if (reduce) return;
    const [x, y] = local(e);
    const now = performance.now();
    const sp = Math.hypot(x - ptr.lastX, y - ptr.lastY);
    ptr.x = x; ptr.y = y; ptr.inside = true;
    ptr.energy = Math.min(1, ptr.energy + sp / 120);
    if (sp > 6 && now - ptr.lastRipple > 140) { ripples.push({ x, age: 0, s: 1, p: Math.min(1, sp / 60) }); ptr.lastRipple = now; }
    ptr.lastX = x; ptr.lastY = y;
    lastUser = now;
  }, { passive: true });
  panel.addEventListener('pointerleave', () => { ptr.inside = false; });
  panel.addEventListener('pointerdown', (e) => {
    if (reduce || e.button > 0 || e.target.closest('button, a')) return;
    const [x, y] = local(e);
    const now = performance.now();
    ptr.x = x; ptr.y = y; ptr.energy = 1; ripples.push({ x, age: 0, s: 1, p: 1 });
    if (mic) return;
    startListen(false, now);
    if (e.pointerType === 'touch') { // touch: a tap plays the whole gesture
      clearTimeout(panel._tap); panel._tap = setTimeout(() => release(performance.now()), 1100);
    }
  });
  const up = (e) => {
    if (reduce || mic || e.pointerType === 'touch') return;
    release(performance.now());
  };
  window.addEventListener('pointerup', up);
  panel.addEventListener('pointercancel', () => { if (mode === 'listen' && !auto) { clearTimeout(panel._tap); release(performance.now()); } });

  // ---------- optional mic ----------
  async function startMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const src = ac.createMediaStreamSource(stream);
      const an = ac.createAnalyser(); an.fftSize = 1024; an.smoothingTimeConstant = 0.72;
      src.connect(an); // analyser only: nothing is played back, stored, or sent
      mic = { ac, an, stream, td: new Uint8Array(an.fftSize), fd: new Uint8Array(an.frequencyBinCount), level: 0, voiced: 0, silent: 0 };
      micBtn.setAttribute('aria-pressed', 'true');
      micBtn.querySelector('.mic-label').textContent = 'Listening… tap to stop';
      lastUser = performance.now();
    } catch (err) {
      micBtn.querySelector('.mic-label').textContent = 'Mic not available';
      micBtn.disabled = true;
    }
  }
  function stopMic() {
    if (!mic) return;
    mic.stream.getTracks().forEach((tr) => tr.stop());
    mic.ac.close();
    mic = null;
    micBtn.setAttribute('aria-pressed', 'false');
    micBtn.querySelector('.mic-label').textContent = 'Try speaking';
    if (mode === 'listen') mode = 'field';
    micBins.fill(0);
  }
  function analyseMic(dt, now) {
    const { an, td, fd } = mic;
    an.getByteTimeDomainData(td);
    let s = 0; for (let i = 0; i < td.length; i++) { const v = (td[i] - 128) / 128; s += v * v; }
    const rms = Math.sqrt(s / td.length);
    const lvl = Math.min(1, Math.max(0, (rms - 0.01) * 9));
    mic.level += (lvl - mic.level) * 0.3;
    an.getByteFrequencyData(fd);
    // map ~80 Hz to ~5 kHz onto columns, mirrored from the centre outward
    const hzPerBin = mic.ac.sampleRate / an.fftSize;
    const b0 = Math.max(1, Math.floor(80 / hzPerBin)), b1 = Math.floor(5000 / hzPerBin);
    const half = C / 2;
    for (let i = 0; i < C; i++) {
      const d = Math.abs(i - half) / half;
      const bin = Math.floor(b0 + (b1 - b0) * Math.pow(d, 1.4));
      const v = Math.max(0, (fd[bin] - 60) / 170);
      micBins[i] += (v * (0.4 + 0.6 * mic.level) - micBins[i]) * 0.4;
    }
    if (mic.level > 0.12) { mic.voiced += dt; mic.silent = 0; if (mode !== 'listen' && mic.voiced > 0.25) startListen(false, now); }
    else { mic.silent += dt; if (mode === 'listen' && mic.silent > 0.9) { const said = mic.voiced; mic.voiced = 0; if (said > 0.6) release(now, MIC_PHRASE); else mode = 'field'; } }
  }
  if (micBtn) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) micBtn.hidden = true;
    micBtn.addEventListener('click', () => { mic ? stopMic() : startMic(); });
    if (reduce) { micBtn.hidden = true; const note = document.getElementById('micNote'); if (note) note.hidden = true; }
  }

  // test hook for screenshots: force a state deterministically
  window.__vnHeroSet = (state) => {
    const now = performance.now();
    lastUser = now; lastAuto = now;
    if (state === 'listen') startListen(false, now);
    else if (state === 'type') { startListen(false, now - 1000); release(now); }
    else { mode = 'field'; }
  };

  layout();
  sync();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (mode === 'type' && txt) buildText(txt.phrase); });
})();
