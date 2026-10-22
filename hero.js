/* Voice field: a procedural, cursor-reactive waveform made of dots.
   Idle: a dotted waveform that breathes like speech and swells toward the pointer.
   Press and hold: the dots gather into the Voice Notes pill waveform.
   Release: they type a short phrase out, left to right, then drift back.
   Performance notes: the canvas covers only the band the waveform lives in, the soft glow is CSS,
   the pill glass is pre-rendered once, dots are drawn as a few batched rect paths, nothing is
   allocated per frame, the frame rate is capped at 60 (ProMotion screens would otherwise double
   the work), and everything stops when the panel is offscreen or the tab is hidden. */
(() => {
  'use strict';
  const cv = document.getElementById('field');
  if (!cv || !cv.getContext) return;
  const panel = cv.parentElement;
  const content = panel.querySelector('.opener-content');
  const glow = panel.querySelector('.opener-glow');
  const ctx = cv.getContext('2d', { alpha: true });
  const mqReduce = matchMedia('(prefers-reduced-motion: reduce)');
  const mqDark = matchMedia('(prefers-color-scheme: dark)');
  const PHRASES = ['Just say it.', 'It types for you.', 'Right where you are.'];
  const MAX_DPR = 1.5;
  const FRAME_MS = 1000 / 60 - 2; // cap at ~60 fps

  let W = 0, H = 0, dpr = 1, C = 0, R = 0, N = 0, colGap = 8, dot = 2.4;
  let hy = 0, ampMax = 0, pillK = 1, bandTop = 0, bandH = 0, x0 = 0;
  let X, Y, VX, VY, A, TX, TY, KF, DEL, ISTXT, COL, FROW;
  let amp, ampS, EDGE, COLX, ENV;
  let dark = mqDark.matches, reduce = mqReduce.matches;
  let grad = null, barColor = '#232226', caretColor = '#5b3ee0';
  let pillSprite = null, pillSpriteK = 0, pillPad = 0;
  let running = false, visible = true, raf = 0, last = 0, lastDraw = 0, t0 = performance.now();

  // interaction state (fixed-size ripple pool, no per-frame allocation)
  const ptr = { x: -1e4, y: -1e4, inside: false, energy: 0, lastX: 0, lastY: 0, lastRipple: 0 };
  const RP = 8, rpX = new Float32Array(RP), rpAge = new Float32Array(RP), rpP = new Float32Array(RP), rpS = new Float32Array(RP);
  let rpN = 0;
  let mode = 'field', modeT = 0, pillAmt = 0, auto = false, lastUser = -1e4, lastAuto = -1e4, phraseIx = 0;
  let txt = null;
  let glowX = -1, glowO = -1;

  const stats = (window.__vnHero = { frames: 0, total: 0, max: 0, N: 0, mode: () => mode });

  // ---------- layout ----------
  function layout() {
    const r = panel.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    const mobile = W < 700;
    dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const top = content ? content.offsetTop : H * 0.55;
    hy = Math.round(Math.max(110, top * 0.52));
    ampMax = Math.min(top * 0.4, H * 0.2);
    pillK = Math.min(W * (mobile ? 0.5 : 0.22), 340) / 85;
    // About 1,500-1,700 dots on desktop and 700-800 on phones.
    colGap = mobile ? 6 : Math.max(8, (W - 24) / 190);
    C = Math.floor((W - 24) / colGap);
    R = mobile ? 12 : 9;
    dot = mobile ? 2.1 : 2.4;
    N = C * R;
    x0 = (W - (C - 1) * colGap) / 2;
    // canvas covers only the band around the waveform
    const half = Math.ceil(Math.max(ampMax, 16 * pillK + 26, 72) + 18);
    bandTop = Math.max(0, hy - half); bandH = Math.min(H - bandTop, hy + half - bandTop);
    cv.style.top = bandTop + 'px'; cv.style.height = bandH + 'px';
    cv.width = Math.round(W * dpr); cv.height = Math.round(bandH * dpr);
    if (glow) glow.style.top = hy + 'px';

    X = new Float32Array(N); Y = new Float32Array(N); VX = new Float32Array(N); VY = new Float32Array(N);
    A = new Float32Array(N); TX = new Float32Array(N); TY = new Float32Array(N);
    KF = new Float32Array(N); DEL = new Float32Array(N); ISTXT = new Uint8Array(N);
    COL = new Uint16Array(N); FROW = new Float32Array(N);
    amp = new Float32Array(C); ampS = new Float32Array(C); EDGE = new Float32Array(C); COLX = new Float32Array(C); ENV = new Float32Array(C);
    for (let i = 0; i < C; i++) {
      const u = i / (C - 1), e = Math.min(1, Math.min(u, 1 - u) / 0.14);
      EDGE[i] = e * e * (3 - 2 * e);
      COLX[i] = x0 + i * colGap;
      ENV[i] = 0.18 + 0.82 * Math.exp(-Math.pow((u - 0.5) / 0.3, 2));
    }
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0, n = 0; i < C; i++) for (let k = 0; k < R; k++, n++) {
      COL[n] = i; FROW[n] = ((k + 0.5) / R) * 2 - 1;
      X[n] = COLX[i]; Y[n] = hy; A[n] = 0;
      KF[n] = 0.75 + rnd() * 0.5;
    }
    stats.N = N;
    themeChanged();
    if (mode === 'type' && txt) buildText(txt.phrase);
  }

  function themeChanged() {
    dark = mqDark.matches;
    grad = ctx.createLinearGradient(0, 0, W, 0);
    const s = dark
      ? ['#8a92ff', '#b096ff', '#e488f2', '#ff95b0']
      : ['#4b3fe0', '#6d3ae6', '#b42bc9', '#e8426e'];
    grad.addColorStop(0, s[0]); grad.addColorStop(0.42, s[1]); grad.addColorStop(0.76, s[2]); grad.addColorStop(1, s[3]);
    barColor = dark ? '#EBEAEE' : '#232226';
    caretColor = dark ? '#b3a4ff' : '#5b3ee0';
    pillSprite = null;
    if (!running) drawStatic();
  }

  // Pill glass rendered once (shadow included) and reused with drawImage.
  function ensurePill() {
    if (pillSprite && pillSpriteK === pillK) return;
    const pw = 85 * pillK, ph = 32 * pillK;
    pillPad = Math.ceil(16 * pillK * 0.6 + 8);
    const c = document.createElement('canvas');
    c.width = Math.ceil((pw + pillPad * 2) * dpr); c.height = Math.ceil((ph + pillPad * 2) * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    const x = pillPad, y = pillPad, rr = ph / 2;
    const path = () => { g.beginPath(); g.moveTo(x + rr, y); g.arcTo(x + pw, y, x + pw, y + ph, rr); g.arcTo(x + pw, y + ph, x, y + ph, rr); g.arcTo(x, y + ph, x, y, rr); g.arcTo(x, y, x + pw, y, rr); g.closePath(); };
    path();
    g.shadowColor = dark ? 'rgba(0,0,0,.55)' : 'rgba(40,20,90,.18)';
    g.shadowBlur = 18 * pillK * 0.6; g.shadowOffsetY = 4 * pillK * 0.4;
    g.fillStyle = dark ? 'rgba(42,40,48,.82)' : 'rgba(255,255,255,.8)';
    g.fill();
    g.shadowColor = 'transparent';
    g.lineWidth = 1; g.strokeStyle = dark ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.08)'; g.stroke();
    const sh = g.createLinearGradient(0, y, 0, y + ph);
    sh.addColorStop(0, dark ? 'rgba(255,255,255,.10)' : 'rgba(255,255,255,.9)'); sh.addColorStop(0.5, 'rgba(255,255,255,0)');
    g.fillStyle = sh; g.fill();
    pillSprite = c; pillSpriteK = pillK;
  }

  // ---------- signals ----------
  function fieldAmps(t, dt) {
    const sig2 = 2 * (0.06 * W) ** 2, sigR = Math.max(18, 0.022 * W), sigR2 = 2 * sigR * sigR;
    const breath = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 0.7));
    const syll = 0.75 + 0.25 * Math.sin(t * 2.3) * Math.sin(t * 0.9 + 1);
    const e = ptr.energy > 0.001 ? ampMax * 0.62 * ptr.energy : 0;
    const rspeed = W * 0.42;
    for (let i = 0; i < C; i++) {
      const u = i / (C - 1);
      const w = 0.5 + 0.5 * (0.5 * Math.sin(u * 13.0 + t * 1.6) + 0.3 * Math.sin(u * 29.0 - t * 2.7) + 0.2 * Math.sin(u * 5.0 + t * 0.8));
      let a = ampMax * (0.05 + 0.78 * ENV[i] * Math.pow(w, 1.6) * breath * syll);
      const x = COLX[i];
      if (e) { const d = x - ptr.x; a += e * Math.exp(-(d * d) / sig2); }
      for (let j = 0; j < rpN; j++) {
        const d = Math.abs(x - rpX[j]) - rpAge[j] * rspeed;
        a += ampMax * 0.5 * rpS[j] * Math.exp(-(d * d) / sigR2);
      }
      amp[i] = a < ampMax ? a : ampMax;
    }
    const f = Math.min(1, dt * 14);
    for (let i = 0; i < C; i++) ampS[i] += (amp[i] - ampS[i]) * f;
  }

  const barLv = new Float32Array(14);
  function pillLevels(t) {
    for (let b = 0; b < 14; b++) {
      const center = 1 - ((b - 6.5) / 8) ** 2;
      const v = center * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 8.3 + b * 1.9) * Math.sin(t * 3.7 + b * 0.7)));
      barLv[b] += (v - barLv[b]) * 0.35;
    }
  }

  // ---------- text targets (built once per phrase) ----------
  const off = document.createElement('canvas');
  const offCtx = off.getContext('2d', { willReadFrequently: true });
  function buildText(phrase) {
    const fam = getComputedStyle(document.querySelector('.opener h1') || document.body).fontFamily;
    let fs = Math.min(ampMax * 1.05, W * (W < 700 ? 0.15 : 0.12), 108);
    offCtx.font = `700 ${fs}px ${fam}`;
    const maxW = W * 0.86, mw = offCtx.measureText(phrase).width;
    if (mw > maxW) fs *= maxW / mw;
    const oy = hy - bandTop;
    off.width = W; off.height = bandH;
    offCtx.font = `700 ${fs}px ${fam}`;
    offCtx.textAlign = 'center'; offCtx.textBaseline = 'middle'; offCtx.fillStyle = '#000';
    offCtx.fillText(phrase, W / 2, oy);
    const img = offCtx.getImageData(0, 0, W, bandH).data;
    let pts = null, step = Math.max(W < 700 ? 2.0 : 2.2, fs / 48);
    for (let tries = 0; tries < 40; tries++, step *= 1.06) {
      const p = [];
      for (let y = Math.max(0, oy - fs); y < Math.min(bandH, oy + fs); y += step)
        for (let x = 0; x < W; x += step) if (img[((y | 0) * W + (x | 0)) * 4 + 3] > 140) p.push(x, y + bandTop);
      if (p.length / 2 <= N * 0.9) { pts = p; break; }
    }
    if (!pts) return;
    const M = pts.length / 2;
    const order = new Array(M); for (let j = 0; j < M; j++) order[j] = j;
    order.sort((a, b) => pts[a * 2] - pts[b * 2]);
    const pidx = new Array(N); for (let n = 0; n < N; n++) pidx[n] = n;
    pidx.sort((a, b) => X[a] - X[b]);
    ISTXT.fill(0);
    const minx = pts[order[0] * 2], maxx = pts[order[M - 1] * 2];
    for (let j = 0; j < M; j++) {
      const n = pidx[Math.floor((j * N) / M)], o = order[j];
      ISTXT[n] = 1; TX[n] = pts[o * 2]; TY[n] = pts[o * 2 + 1];
      DEL[n] = 0.08 + 0.9 * ((TX[n] - minx) / Math.max(1, maxx - minx));
    }
    txt = { phrase, minx, maxx, fs, step, M, sz: Math.max(1.4, Math.min(step * 0.86, 3.4)) };
    stats.txt = txt;
  }

  // ---------- modes ----------
  function startListen(isAuto, now) {
    if (reduce) return;
    auto = !!isAuto; mode = 'listen'; modeT = now;
    if (!isAuto) lastUser = now;
  }
  function release(now) {
    if (mode !== 'listen') return;
    if ((now - modeT) / 1000 < 0.18 && !auto) { mode = 'field'; return; }
    buildText(PHRASES[phraseIx++ % PHRASES.length]);
    mode = 'type'; modeT = now;
  }

  // ---------- frame ----------
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - lastDraw < FRAME_MS) return; // 120 Hz displays: draw every other vsync
    lastDraw = now;
    const tStart = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    const t = (now - t0) / 1000;
    step(now, t, dt);
    draw(now);
    const ms = performance.now() - tStart;
    stats.frames++; stats.total += ms; if (ms > stats.max) stats.max = ms;
  }

  function step(now, t, dt) {
    if (mode === 'field' && now - lastUser > 6500 && now - lastAuto > 11000 && now - t0 > 1800) { lastAuto = now; startListen(true, now); }
    if (mode === 'listen' && auto && now - modeT > 1700) release(now);
    if (mode === 'type' && now - modeT > (txt ? 3600 : 0)) { mode = 'field'; modeT = now; }

    ptr.energy *= Math.pow(0.18, dt);
    for (let j = rpN - 1; j >= 0; j--) {
      rpAge[j] += dt;
      if (rpAge[j] > 1.6) { rpN--; rpX[j] = rpX[rpN]; rpAge[j] = rpAge[rpN]; rpP[j] = rpP[rpN]; rpS[j] = rpS[rpN]; continue; }
      const k = 1 - rpAge[j] / 1.6; rpS[j] = k * k * rpP[j];
    }
    fieldAmps(t, dt);
    pillLevels(t);
    const wantPill = mode === 'listen' ? 1 : 0;
    pillAmt += (wantPill - pillAmt) * Math.min(1, dt * (wantPill ? 9 : 6));

    const cx = W / 2, barW = 2.5 * pillK, gap = 2 * pillK, total = 14 * barW + 13 * gap, bx0 = cx - total / 2;
    const colsPerBar = C / 14;
    const typeT = mode === 'type' ? (now - modeT) / 1000 : 0;
    const leaving = mode === 'type' && typeT > 3.0;
    const listen = mode === 'listen', typing = mode === 'type' && txt;
    const inv = 1 / (ampMax * 0.45);

    for (let n = 0; n < N; n++) {
      const i = COL[n], f = FROW[n], as = ampS[i];
      let tx, ty, ta, K = 0.16, D = 0.68;
      const lv = as * inv;
      const fa = EDGE[i] * (0.28 + 0.72 * (1 - f * f) * (0.35 + 0.65 * (lv < 1 ? lv : 1)));
      if (listen) {
        const b = Math.min(13, (i / colsPerBar) | 0);
        const s0 = Math.ceil(b * colsPerBar), s1 = Math.ceil((b + 1) * colsPerBar) - 1;
        const sub = (i - s0 + 0.5) / Math.max(1, s1 - s0 + 1);
        const bh = (3 + 15 * barLv[b]) * pillK;
        tx = bx0 + b * (barW + gap) + barW * sub; ty = hy + (bh / 2 - pillK * 0.6) * f; ta = 1;
        K = 0.11 * KF[n]; D = 0.74;
      } else if (typing) {
        if (ISTXT[n] && !leaving) {
          if (typeT > DEL[n]) { tx = TX[n]; ty = TY[n]; ta = 1; K = 0.075 * KF[n]; D = 0.78; }
          else { const b = Math.min(13, (i / colsPerBar) | 0); tx = bx0 + b * (barW + gap) + barW / 2; ty = hy; ta = 0.9; K = 0.1; D = 0.75; }
        } else { tx = COLX[i]; ty = hy + as * f * 0.35; ta = leaving ? fa : fa * 0.12; K = leaving ? 0.05 * KF[n] : 0.08; D = 0.8; }
      } else { tx = COLX[i]; ty = hy + as * f; ta = fa; }
      const vx = (VX[n] + (tx - X[n]) * K) * D, vy = (VY[n] + (ty - Y[n]) * K) * D;
      VX[n] = vx; VY[n] = vy; X[n] += vx; Y[n] += vy;
      A[n] += (ta - A[n]) * 0.18;
    }

    // CSS glow follows the pointer: compositor-only transform/opacity, written only when it changes
    if (glow) {
      let e = 0; for (let i = 0; i < C; i += 6) e += ampS[i];
      e = e / Math.ceil(C / 6) / ampMax;
      const gx = Math.round(((ptr.inside ? ptr.x : W / 2) - W / 2) * 0.5);
      const go = Math.round(Math.min(1, 0.55 + e * 0.8 + pillAmt * 0.25) * 50) / 50;
      if (gx !== glowX) { glowX = gx; glow.style.transform = `translate3d(${gx}px,0,0)`; }
      if (go !== glowO) { glowO = go; glow.style.opacity = go; }
    }
  }

  const B_LO = [0.03, 0.3, 0.62], B_HI = [0.3, 0.62, 9], B_A = [0.26, 0.55, 1];
  function draw(now) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, -bandTop * dpr);

    if (pillAmt > 0.01) {
      ensurePill();
      const s = 0.97 + 0.03 * pillAmt, pw = (85 * pillK + pillPad * 2) * s, ph = (32 * pillK + pillPad * 2) * s;
      ctx.globalAlpha = pillAmt;
      ctx.drawImage(pillSprite, W / 2 - pw / 2, hy - ph / 2 + (1 - pillAmt) * 1.2 * pillK, pw, ph);
      ctx.globalAlpha = 1;
    }

    const m = pillAmt;
    const sz = mode === 'type' && txt ? txt.sz : dot;
    const alpha = 1 - m * 0.9;
    if (alpha > 0.01) {
      ctx.fillStyle = grad;
      const h = sz / 2;
      for (let b = 0; b < 3; b++) {
        const lo = B_LO[b], hi = B_HI[b];
        ctx.globalAlpha = B_A[b] * alpha;
        ctx.beginPath();
        for (let n = 0; n < N; n++) { const a = A[n]; if (a > lo && a <= hi) ctx.rect(X[n] - h, Y[n] - h, sz, sz); }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    if (m > 0.02) drawBars(m);

    if (mode === 'type' && txt) {
      const tt = (now - modeT) / 1000;
      if (tt < 3.0) {
        const prog = Math.min(1, Math.max(0, (tt - 0.3) / 0.9));
        const cxr = txt.minx + (txt.maxx - txt.minx) * prog + txt.fs * 0.1;
        const blink = prog < 1 ? 1 : (Math.sin(tt * 8) > 0 ? 1 : 0.15);
        ctx.globalAlpha = blink * Math.min(1, tt * 5);
        ctx.fillStyle = caretColor;
        ctx.fillRect(Math.round(cxr), hy - txt.fs * 0.4, Math.max(2, txt.fs * 0.03), txt.fs * 0.8);
        ctx.globalAlpha = 1;
      }
    }
  }

  // Solid capsule bars, same geometry as the app pill: 14 bars, 2.5 wide, 2 apart, 3 to 18 tall.
  function drawBars(m) {
    const barW = 2.5 * pillK, gap = 2 * pillK, total = 14 * barW + 13 * gap, bx = W / 2 - total / 2, r = barW / 2;
    ctx.globalAlpha = Math.min(1, m * m * 1.15);
    ctx.fillStyle = barColor;
    ctx.beginPath();
    for (let b = 0; b < 14; b++) {
      const bh = (3 + 15 * barLv[b]) * pillK * (0.6 + 0.4 * m);
      const x = bx + b * (barW + gap), y = hy - bh / 2;
      ctx.moveTo(x + r, y); ctx.arcTo(x + barW, y, x + barW, y + bh, r); ctx.arcTo(x + barW, y + bh, x, y + bh, r);
      ctx.arcTo(x, y + bh, x, y, r); ctx.arcTo(x, y, x + barW, y, r); ctx.closePath();
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // A calm, finished-looking still frame for reduced motion.
  function drawStatic() {
    if (!W) return;
    const t = 2.15;
    ptr.energy = 0; rpN = 0; pillAmt = 0; mode = 'field';
    for (let i = 0; i < 40; i++) fieldAmps(t, 1);
    for (let n = 0; n < N; n++) {
      const i = COL[n], f = FROW[n];
      X[n] = COLX[i]; Y[n] = hy + ampS[i] * f;
      A[n] = EDGE[i] * (0.28 + 0.72 * (1 - f * f) * (0.35 + 0.65 * Math.min(1, ampS[i] / (ampMax * 0.45))));
    }
    if (glow) { glow.style.transform = ''; glow.style.opacity = ''; glowX = glowO = -1; }
    draw(performance.now());
  }

  // ---------- run control ----------
  function shouldRun() { return !reduce && visible && !document.hidden; }
  function sync() {
    const want = shouldRun();
    if (want && !running) { running = true; last = lastDraw = 0; raf = requestAnimationFrame(frame); }
    else if (!want && running) { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
    if (!want) drawStatic();
  }
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; sync(); }, { threshold: 0 }).observe(cv);
  document.addEventListener('visibilitychange', sync);
  mqReduce.addEventListener('change', () => { reduce = mqReduce.matches; sync(); });
  mqDark.addEventListener('change', themeChanged);
  let rz = 0;
  new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(() => { layout(); if (!running) drawStatic(); }, 80); }).observe(panel);

  // ---------- pointer ----------
  let pr = null;
  const prect = () => (pr || (pr = panel.getBoundingClientRect()));
  addEventListener('scroll', () => { pr = null; }, { passive: true });
  addEventListener('resize', () => { pr = null; }, { passive: true });
  function addRipple(x, p) {
    if (rpN === RP) return;
    rpX[rpN] = x; rpAge[rpN] = 0; rpP[rpN] = p; rpS[rpN] = p; rpN++;
  }
  panel.addEventListener('pointermove', (e) => {
    if (reduce) return;
    const r = prect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const now = performance.now();
    const sp = Math.hypot(x - ptr.lastX, y - ptr.lastY);
    ptr.x = x; ptr.y = y; ptr.inside = true;
    ptr.energy = Math.min(1, ptr.energy + sp / 120);
    if (sp > 6 && now - ptr.lastRipple > 140) { addRipple(x, Math.min(1, sp / 60)); ptr.lastRipple = now; }
    ptr.lastX = x; ptr.lastY = y;
    lastUser = now;
  }, { passive: true });
  panel.addEventListener('pointerleave', () => { ptr.inside = false; });
  panel.addEventListener('pointerdown', (e) => {
    if (reduce || e.button > 0 || e.target.closest('button, a')) return;
    const r = prect(), x = e.clientX - r.left;
    const now = performance.now();
    ptr.x = x; ptr.y = e.clientY - r.top; ptr.energy = 1; addRipple(x, 1);
    startListen(false, now);
    if (e.pointerType === 'touch') { // touch: a tap plays the whole gesture
      clearTimeout(panel._tap); panel._tap = setTimeout(() => release(performance.now()), 1100);
    }
  });
  addEventListener('pointerup', (e) => { if (!reduce && e.pointerType !== 'touch') release(performance.now()); });
  panel.addEventListener('pointercancel', () => { if (mode === 'listen' && !auto) { clearTimeout(panel._tap); release(performance.now()); } });

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
