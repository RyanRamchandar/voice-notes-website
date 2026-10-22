/* Voice field, GPU edition.
   Thousands of dots form a breathing, speech-like waveform that swells toward the pointer.
   Press and hold: the dots gather into the Voice Notes pill. Release: they type a short phrase,
   left to right, then drift back into the wave.

   How it stays fluid: every dot's position, size and colour is computed in the vertex shader from
   a handful of uniforms (time, pointer, ripples, morph progress, scroll depth). Per frame the CPU
   only sets ~20 uniforms and issues two draw calls; no per-dot JavaScript runs. Text targets are
   rasterised once per phrase and uploaded to a GPU buffer. Dots are gl.POINTS with a soft round
   edge computed analytically in the fragment shader (no loops, no textures).
   Falls back to the Canvas2D renderer (hero-2d.js) when WebGL is unavailable or lost for good. */
(() => {
  'use strict';
  const cv = document.getElementById('field');
  if (!cv) return;
  const panel = cv.parentElement;
  const content = panel.querySelector('.opener-content');
  const glow = panel.querySelector('.opener-glow');
  const mqReduce = matchMedia('(prefers-reduced-motion: reduce)');
  const mqDark = matchMedia('(prefers-color-scheme: dark)');
  const PHRASES = ['Just say it.', 'It types for you.', 'Right where you are.'];
  const qs = new URLSearchParams(location.search);

  function fallback() {
    if (window.__vnHeroFallback) return;
    window.__vnHeroFallback = true;
    stopAll();
    const fresh = cv.cloneNode(false); // a canvas that once held a GL context cannot become 2D
    cv.replaceWith(fresh);
    [pillEl, caretEl].forEach((e) => e && e.remove());
    const s = document.createElement('script');
    s.src = 'hero-2d.js'; s.defer = true;
    document.body.appendChild(s);
  }

  // ---------- GL context ----------
  const ctxOpts = { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true,
    preserveDrawingBuffer: false, powerPreference: 'low-power', failIfMajorPerformanceCaveat: true };
  let gl = null, isGL2 = false;
  if (qs.get('hero') !== '2d') {
    gl = cv.getContext('webgl2', ctxOpts);
    isGL2 = !!gl;
    if (!gl) gl = cv.getContext('webgl', ctxOpts) || cv.getContext('experimental-webgl', ctxOpts);
  }
  let pillEl = null, caretEl = null, stopAll = () => {};
  if (!gl) { fallback(); return; }

  // ---------- shaders (GLSL ES 1.00 runs on WebGL1 and WebGL2) ----------
  const VS = `
precision highp float;
attribute vec4 aBase;   // u (column 0..1), f (row -1..1), seed, unused
attribute vec4 aTxt;    // text target x, y (panel px), type delay (s), is-text flag
uniform vec2 uRes;      // canvas size in CSS px (W, band height)
uniform float uBandTop, uHy, uAmp, uX0, uSpan, uT, uBS, uDot, uDpr, uPill, uPillK, uScroll;
uniform vec3 uPtr;      // pointer x, swell height, 1/(2 sigma^2)
uniform vec4 uRip[8];   // ripple x, radius, height, unused
uniform float uRipInv;
uniform float uBars[14];
uniform vec4 uType;     // seconds since release, seconds since leaving (<0 = not), text dot size, typing flag
uniform vec3 uC0, uC1, uC2, uC3;
uniform float uDark;
varying vec4 vCol;
varying vec2 vPt;       // point size px, radius px

float amp(float u, float x) {
  float w = 0.5 + 0.5 * (0.5 * sin(u * 13.0 + uT * 1.6) + 0.3 * sin(u * 29.0 - uT * 2.7) + 0.2 * sin(u * 5.0 + uT * 0.8));
  float c = (u - 0.5) / 0.3;
  float env = 0.18 + 0.82 * exp(-c * c);
  float a = uAmp * (0.06 + 0.9 * env * pow(w, 1.45) * uBS);
  float d = x - uPtr.x;
  a += uPtr.y * exp(-d * d * uPtr.z);
  for (int j = 0; j < 8; j++) {            // fixed 8 iterations, per vertex (not per pixel)
    float r = abs(x - uRip[j].x) - uRip[j].y;
    a += uRip[j].z * exp(-r * r * uRipInv);
  }
  return min(a, uAmp);
}
float easeOutBack(float p) { float q = p - 1.0; return 1.0 + q * q * (2.4 * q + 1.4); }

void main() {
  float u = aBase.x, f = aBase.y, sd = aBase.z;
  float x = uX0 + u * uSpan;
  float a = amp(u, x);
  float edge = smoothstep(0.0, 0.14, min(u, 1.0 - u));
  float lv = min(1.0, a / (uAmp * 0.45));
  float fa = edge * (0.28 + 0.72 * (1.0 - f * f) * (0.35 + 0.65 * lv));
  vec2 field = vec2(x, uHy + a * f + sin(uT * 1.7 + sd * 40.0) * 0.6);

  // pill target: 14 capsule bars, 2.5 wide and 2 apart, scaled by uPillK
  float bf = u * 14.0, b = min(13.0, floor(bf)), sub = bf - b;
  float barW = 2.5 * uPillK, gap = 2.0 * uPillK;
  float bx0 = uRes.x * 0.5 - (14.0 * barW + 13.0 * gap) * 0.5;
  float bh = (3.0 + 15.0 * uBars[int(b)]) * uPillK;
  vec2 pill = vec2(bx0 + b * (barW + gap) + barW * sub, uHy + (bh * 0.5 - 0.6 * uPillK) * f);

  vec2 pos; float al; float sz = uDot; float lift = 0.0;
  if (uType.w > 0.5) {
    if (aTxt.w > 0.5) {
      float p = clamp((uType.x - aTxt.z) / 0.6, 0.0, 1.0);
      vec2 d = aTxt.xy - pill;
      vec2 perp = vec2(-d.y, d.x);
      pos = mix(pill, aTxt.xy, easeOutBack(p)) + perp * sin(p * 3.14159) * (sd - 0.5) * 0.35;
      al = mix(0.9, 1.0, p);
      sz = mix(uDot, uType.z, p);
      lift = p;
    } else {
      float q = smoothstep(0.0, 1.0, clamp(uType.x * 1.6 - sd * 0.5, 0.0, 1.0));
      pos = mix(pill, vec2(x, uHy + a * f * 0.35), q);
      al = mix(0.9, fa * 0.12, q);
    }
    if (uType.y >= 0.0) {
      float lp = smoothstep(0.0, 1.0, clamp((uType.y - sd * 0.4) / 0.6, 0.0, 1.0));
      pos = mix(pos, field, lp); al = mix(al, fa, lp); sz = mix(sz, uDot, lp); lift *= 1.0 - lp;
    }
  } else {
    float pp = smoothstep(sd * 0.35, sd * 0.35 + 0.65, uPill);
    pos = mix(field, pill, pp);
    al = mix(fa, 1.0, pp);
  }
  al *= 1.0 - 0.9 * uPill;

  // scroll-linked depth: as the hero scrolls away the wave opens up and scatters toward the viewer
  float s = uScroll;
  pos.x = uRes.x * 0.5 + (pos.x - uRes.x * 0.5) * (1.0 + 0.1 * s);
  pos.y = uHy + (pos.y - uHy) * (1.0 + 0.7 * s) + (sd - 0.5) * s * uAmp * 0.8;
  al *= 1.0 - 0.7 * s;
  sz *= 1.0 + s * sd * 1.3;

  float ly = pos.y - uBandTop;
  al *= smoothstep(0.0, 14.0, min(ly, uRes.y - ly));   // soft edge instead of clipping at the band

  float g = clamp(pos.x / uRes.x, 0.0, 1.0);
  vec3 col = g < 0.42 ? mix(uC0, uC1, g / 0.42) : (g < 0.76 ? mix(uC1, uC2, (g - 0.42) / 0.34) : mix(uC2, uC3, (g - 0.76) / 0.24));
  col = mix(col, vec3(1.0), uDark * 0.22 * lift);   // letters read a touch brighter on dark
  vCol = vec4(col * al, al);
  float rpx = sz * uDpr * 0.5;
  vPt = vec2(rpx * 2.0 + 2.0, rpx);
  gl_PointSize = vPt.x;
  gl_Position = vec4(pos.x / uRes.x * 2.0 - 1.0, 1.0 - ly / uRes.y * 2.0, 0.0, 1.0);
}`;
  const FS = `
precision mediump float;
varying vec4 vCol;
varying vec2 vPt;
void main() {
  float d = length(gl_PointCoord - 0.5) * vPt.x;
  gl_FragColor = vCol * clamp(vPt.y - d + 0.5, 0.0, 1.0);
}`;
  // Pill bars: 14 points, each shaded as a capsule.
  const VS_BAR = `
precision highp float;
attribute float aI;
uniform vec2 uRes;
uniform float uBandTop, uHy, uPillK, uM, uDpr;
uniform float uBars[14];
varying vec3 vB;       // point size px, half width px, half height px
void main() {
  float barW = 2.5 * uPillK, gap = 2.0 * uPillK;
  float bx0 = uRes.x * 0.5 - (14.0 * barW + 13.0 * gap) * 0.5;
  float bh = (3.0 + 15.0 * uBars[int(aI)]) * uPillK * (0.6 + 0.4 * uM);
  vec2 c = vec2(bx0 + aI * (barW + gap) + barW * 0.5, uHy - uBandTop);
  vB = vec3(bh * uDpr + 4.0, barW * 0.5 * uDpr, bh * 0.5 * uDpr);
  gl_PointSize = vB.x;
  gl_Position = vec4(c.x / uRes.x * 2.0 - 1.0, 1.0 - c.y / uRes.y * 2.0, 0.0, 1.0);
}`;
  const FS_BAR = `
precision mediump float;
uniform vec4 uBarCol;
varying vec3 vB;
void main() {
  vec2 p = abs((gl_PointCoord - 0.5) * vB.x);
  float d = length(vec2(p.x, max(p.y - (vB.z - vB.y), 0.0))) - vB.y; // vertical capsule SDF
  gl_FragColor = uBarCol * clamp(0.5 - d, 0.0, 1.0);
}`;

  let prog, progBar, U = {}, UB = {}, bufBase, bufTxt, bufBar, locBase, locTxt, locBar;
  function compile(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function link(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  function uniforms(p, names) {
    const o = {}; names.forEach((n) => { o[n] = gl.getUniformLocation(p, n); }); return o;
  }
  function initGL() {
    prog = link(VS, FS);
    progBar = link(VS_BAR, FS_BAR);
    U = uniforms(prog, ['uRes', 'uBandTop', 'uHy', 'uAmp', 'uX0', 'uSpan', 'uT', 'uBS', 'uDot', 'uDpr', 'uPill', 'uPillK', 'uScroll',
      'uPtr', 'uRip', 'uRipInv', 'uBars', 'uType', 'uC0', 'uC1', 'uC2', 'uC3', 'uDark']);
    UB = uniforms(progBar, ['uRes', 'uBandTop', 'uHy', 'uPillK', 'uM', 'uDpr', 'uBars', 'uBarCol']);
    locBase = gl.getAttribLocation(prog, 'aBase'); locTxt = gl.getAttribLocation(prog, 'aTxt'); locBar = gl.getAttribLocation(progBar, 'aI');
    bufBase = gl.createBuffer(); bufTxt = gl.createBuffer(); bufBar = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufBar);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]), gl.STATIC_DRAW);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
  }
  try { initGL(); } catch (e) { fallback(); return; }

  // ---------- DOM bits: pill glass below the dots, caret above (compositor-only updates) ----------
  pillEl = document.createElement('div'); pillEl.className = 'vn-pill'; pillEl.setAttribute('aria-hidden', 'true');
  caretEl = document.createElement('div'); caretEl.className = 'vn-caret'; caretEl.setAttribute('aria-hidden', 'true');
  cv.before(pillEl); cv.after(caretEl);

  // ---------- state ----------
  let W = 0, H = 0, dpr = 1, C = 0, R = 0, N = 0, colGap = 4, dot = 1.8, mobile = false;
  let hy = 0, ampMax = 0, pillK = 1, bandTop = 0, bandH = 0, x0 = 0, panelTop = 0;
  let txtArr = null;
  let dark = mqDark.matches, reduce = mqReduce.matches;
  let running = false, visible = true, raf = 0, last = 0, t0 = performance.now(), lost = false;
  let quality = 1, aStart = 0, aN = 0, aSlow = 0, lastFrame = 0; // adaptive resolution state
  const ptr = { x: -1e4, y: -1e4, inside: false, energy: 0, lastX: 0, lastY: 0, lastRipple: 0 };
  const RP = 8, rpX = new Float32Array(RP), rpAge = new Float32Array(RP), rpP = new Float32Array(RP);
  let rpN = 0;
  const ripU = new Float32Array(RP * 4);
  const barLv = new Float32Array(14);
  let mode = 'field', modeT = 0, pillAmt = 0, auto = false, lastUser = -1e4, lastAuto = -1e4, phraseIx = 0;
  let txt = null, glowX = -1e9, glowO = -1, pillO = -1, caretKey = '';
  const stats = (window.__vnHero = { frames: 0, total: 0, max: 0, N: 0, renderer: isGL2 ? 'webgl2' : 'webgl1', mode: () => mode });

  // ---------- layout ----------
  function layout() {
    const r = panel.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    panelTop = r.top + scrollY;
    mobile = W < 700;
    const top = content ? content.offsetTop : H * 0.55;
    hy = Math.round(Math.max(110, top * 0.52));
    ampMax = Math.min(top * 0.4, H * 0.2);
    pillK = Math.min(W * (mobile ? 0.5 : 0.22), 340) / 85;
    // Density: ~9-10k dots on a 1440 px desktop, ~3.5k on a 390 px phone.
    colGap = mobile ? 3.1 : Math.max(3.2, (W - 24) / 440);
    C = Math.floor((W - 24) / colGap);
    R = mobile ? 30 : 22;
    dot = mobile ? 1.55 : 1.8;
    N = C * R;
    x0 = (W - (C - 1) * colGap) / 2;
    const textHalf = mobile ? Math.min(W * 0.17, 72) * 1.2 : Math.min(ampMax * 1.05, 108) * 0.75;
    const half = Math.ceil(Math.max(ampMax * 1.35, 16 * pillK + 26, textHalf, 72) + 24);
    bandTop = Math.max(0, hy - half); bandH = Math.min(H - bandTop, hy + half - bandTop);
    // DPR: cap at 2, then keep the backing store inside a pixel budget (smaller on phones).
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const budget = W < 768 ? 1.6e6 : 4.5e6, px = W * bandH * dpr * dpr;
    if (px > budget) dpr *= Math.sqrt(budget / px);
    dpr = Math.max(Math.min(dpr, 1), dpr * quality); // adaptive resolution (see adapt())
    cv.style.top = bandTop + 'px'; cv.style.height = bandH + 'px';
    cv.width = Math.round(W * dpr); cv.height = Math.round(bandH * dpr);
    if (glow) glow.style.top = hy + 'px';
    pillEl.style.cssText = `top:${hy}px;width:${85 * pillK}px;height:${32 * pillK}px;opacity:0`;
    pillO = -1;

    const base = new Float32Array(N * 4);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0, n = 0; i < C; i++) for (let k = 0; k < R; k++, n++) {
      base[n * 4] = i / (C - 1); base[n * 4 + 1] = ((k + 0.5) / R) * 2 - 1; base[n * 4 + 2] = rnd();
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, bufBase); gl.bufferData(gl.ARRAY_BUFFER, base, gl.STATIC_DRAW);
    txtArr = new Float32Array(N * 4);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufTxt); gl.bufferData(gl.ARRAY_BUFFER, txtArr, gl.DYNAMIC_DRAW);
    stats.N = N; stats.dpr = dpr; stats.canvas = [cv.width, cv.height];
    themeChanged();
    if (mode === 'type' && txt) buildText(txt.phrase);
  }

  const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
  let stops, barCol;
  function themeChanged() {
    dark = mqDark.matches;
    stops = (dark ? ['#8a92ff', '#b096ff', '#e488f2', '#ff95b0'] : ['#4b3fe0', '#6d3ae6', '#b42bc9', '#e8426e']).map(hex);
    barCol = dark ? hex('#EBEAEE') : hex('#232226');
    if (!running) drawStatic();
  }

  function pillLevels(t) {
    for (let b = 0; b < 14; b++) {
      const center = 1 - ((b - 6.5) / 8) ** 2;
      const v = center * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 8.3 + b * 1.9) * Math.sin(t * 3.7 + b * 0.7)));
      barLv[b] += (v - barLv[b]) * 0.35;
    }
  }

  // ---------- text targets (rasterised once per phrase, uploaded once) ----------
  const off = document.createElement('canvas');
  const offCtx = off.getContext('2d', { willReadFrequently: true });
  function splitLines(phrase, fam, cap, maxW) {
    offCtx.font = `700 ${cap}px ${fam}`;
    const one = offCtx.measureText(phrase).width;
    const words = phrase.split(' ');
    if (!mobile || one <= maxW || words.length < 2) return { lines: [phrase], fs: Math.min(cap, (cap * maxW) / one) };
    let best = null;
    for (let k = 1; k < words.length; k++) { // most balanced two-line split
      const a = words.slice(0, k).join(' '), b = words.slice(k).join(' ');
      const w = Math.max(offCtx.measureText(a).width, offCtx.measureText(b).width);
      if (!best || w < best.w) best = { lines: [a, b], w };
    }
    return { lines: best.lines, fs: Math.min(cap, (cap * maxW) / best.w) };
  }
  function buildText(phrase) {
    const fam = getComputedStyle(document.querySelector('.opener h1') || document.body).fontFamily;
    const cap = mobile ? Math.min(W * 0.17, 72) : Math.min(ampMax * 1.05, W * 0.12, 108);
    const { lines, fs } = splitLines(phrase, fam, cap, W * (mobile ? 0.88 : 0.86));
    const lh = fs * 1.08, oy = hy - bandTop;
    off.width = W; off.height = bandH;
    offCtx.font = `700 ${fs}px ${fam}`;
    offCtx.textAlign = 'center'; offCtx.textBaseline = 'middle'; offCtx.fillStyle = '#000';
    const ly = lines.map((_, i) => oy + (i - (lines.length - 1) / 2) * lh);
    lines.forEach((l, i) => offCtx.fillText(l, W / 2, ly[i]));
    const img = offCtx.getImageData(0, 0, W, bandH).data;
    const y0 = Math.max(0, Math.floor(ly[0] - fs * 0.7)), y1 = Math.min(bandH, Math.ceil(ly[ly.length - 1] + fs * 0.7));
    let pts = null, step = Math.max(mobile ? 1.7 : 2.3, fs / (mobile ? 30 : 46));
    for (let tries = 0; tries < 50; tries++, step *= 1.05) {
      const p = [];
      for (let y = y0; y < y1; y += step) {
        const odd = Math.round((y - y0) / step) & 1; // staggered rows read smoother than a square grid
        for (let x = odd ? step / 2 : 0; x < W; x += step) if (img[((y | 0) * W + (x | 0)) * 4 + 3] > 128) p.push(x, y + bandTop);
      }
      if (p.length / 2 <= N * 0.9) { pts = p; break; }
    }
    if (!pts) return;
    const M = pts.length / 2;
    const order = new Array(M); for (let j = 0; j < M; j++) order[j] = j;
    order.sort((a, b) => pts[a * 2] - pts[b * 2]);
    // per-line extents for the caret and the typing delay
    const ext = lines.map(() => ({ minx: 1e9, maxx: -1e9 }));
    const lineOf = (y) => { let li = 0, bd = 1e9; ly.forEach((v, i) => { const d = Math.abs(y - bandTop - v); if (d < bd) { bd = d; li = i; } }); return li; };
    for (let j = 0; j < M; j++) { const e = ext[lineOf(pts[j * 2 + 1])]; const x = pts[j * 2]; if (x < e.minx) e.minx = x; if (x > e.maxx) e.maxx = x; }
    const L = lines.length;
    txtArr.fill(0);
    for (let j = 0; j < M; j++) {
      const n = Math.floor((j * N) / M), o = order[j], x = pts[o * 2], y = pts[o * 2 + 1], li = lineOf(y), e = ext[li];
      txtArr[n * 4] = x; txtArr[n * 4 + 1] = y;
      txtArr[n * 4 + 2] = 0.08 + 0.9 * ((li + (x - e.minx) / Math.max(1, e.maxx - e.minx)) / L);
      txtArr[n * 4 + 3] = 1;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, bufTxt); gl.bufferSubData(gl.ARRAY_BUFFER, 0, txtArr);
    txt = { phrase, fs, step, M, lines: L, ext, ly: ly.map((v) => v + bandTop), sz: Math.max(1.3, Math.min(step * 0.84, 3.2)) };
    stats.txt = { M, fs: Math.round(fs), step: +step.toFixed(2), lines: L };
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
    raf = requestAnimationFrame(frame); // runs at the display rate (120 Hz on ProMotion); the CPU cost is tiny
    const tStart = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    step(now, dt);
    render(now, (now - t0) / 1000);
    const ms = performance.now() - tStart;
    stats.frames++; stats.total += ms; if (ms > stats.max) stats.max = ms;
    adapt(now);
  }

  // Adaptive resolution: the shaders are cheap, so the only thing that can choke a weak GPU is
  // fill rate. If frames run long for a sustained window, shrink the backing store a notch
  // (never below 1 device px per CSS px) and never grow it back, so it can't oscillate.
  function adapt(now) {
    if (!aStart) { aStart = lastFrame = now; aN = 0; aSlow = 0; return; }
    aN++; if (now - lastFrame > 22) aSlow++;
    lastFrame = now;
    if (aN < 40) return;
    const slow = aSlow / aN; aStart = 0;
    if (slow > 0.25 && dpr > 1.01) {
      quality *= 0.8;
      dpr = Math.max(1, dpr * 0.8);
      cv.width = Math.round(W * dpr); cv.height = Math.round(bandH * dpr);
      stats.dpr = dpr; stats.canvas = [cv.width, cv.height]; stats.adapted = (stats.adapted || 0) + 1;
    }
  }


  function step(now, dt) {
    if (mode === 'field' && now - lastUser > 6500 && now - lastAuto > 11000 && now - t0 > 1800) { lastAuto = now; startListen(true, now); }
    if (mode === 'listen' && auto && now - modeT > 1700) release(now);
    if (mode === 'type' && now - modeT > (txt ? 4000 : 0)) { mode = 'field'; modeT = now; }
    ptr.energy *= Math.pow(0.18, dt);
    for (let j = rpN - 1; j >= 0; j--) {
      rpAge[j] += dt;
      if (rpAge[j] > 1.6) { rpN--; rpX[j] = rpX[rpN]; rpAge[j] = rpAge[rpN]; rpP[j] = rpP[rpN]; }
    }
    pillLevels((now - t0) / 1000);
    const want = mode === 'listen' ? 1 : 0;
    pillAmt += (want - pillAmt) * Math.min(1, dt * (want ? 9 : 6));
    if (pillAmt < 0.002) pillAmt = 0;
  }

  function render(now, t) {
    gl.viewport(0, 0, cv.width, cv.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    // light: premultiplied "over"; dark: screen blend, so dense areas glow without blowing out
    if (dark) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR); else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const breath = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 0.7));
    const syll = 0.75 + 0.25 * Math.sin(t * 2.3) * Math.sin(t * 0.9 + 1);
    const sigR = Math.max(18, 0.022 * W);
    for (let j = 0; j < RP; j++) {
      const on = j < rpN, k = on ? 1 - rpAge[j] / 1.6 : 0;
      ripU[j * 4] = on ? rpX[j] : -1e4; ripU[j * 4 + 1] = on ? rpAge[j] * W * 0.42 : 0; ripU[j * 4 + 2] = on ? ampMax * 0.5 * k * k * rpP[j] : 0;
    }
    const typing = mode === 'type' && txt;
    const typeT = typing ? (now - modeT) / 1000 : 0;
    const leaveT = typing && typeT > 3.0 ? typeT - 3.0 : -1;
    const scroll = Math.min(1, Math.max(0, (scrollY - panelTop + 56) / (H * 0.85)));

    gl.useProgram(prog);
    gl.uniform2f(U.uRes, W, bandH); gl.uniform1f(U.uBandTop, bandTop); gl.uniform1f(U.uHy, hy); gl.uniform1f(U.uAmp, ampMax);
    gl.uniform1f(U.uX0, x0); gl.uniform1f(U.uSpan, (C - 1) * colGap); gl.uniform1f(U.uT, t); gl.uniform1f(U.uBS, breath * syll);
    gl.uniform1f(U.uDot, dot); gl.uniform1f(U.uDpr, dpr); gl.uniform1f(U.uPill, pillAmt); gl.uniform1f(U.uPillK, pillK);
    gl.uniform1f(U.uScroll, reduce ? 0 : scroll);
    gl.uniform3f(U.uPtr, ptr.x, ptr.energy > 0.001 ? ampMax * 0.62 * ptr.energy : 0, 1 / (2 * (0.06 * W) ** 2));
    gl.uniform4fv(U.uRip, ripU); gl.uniform1f(U.uRipInv, 1 / (2 * sigR * sigR));
    gl.uniform1fv(U.uBars, barLv);
    gl.uniform4f(U.uType, typeT, leaveT, typing ? txt.sz : dot, typing ? 1 : 0);
    gl.uniform3fv(U.uC0, stops[0]); gl.uniform3fv(U.uC1, stops[1]); gl.uniform3fv(U.uC2, stops[2]); gl.uniform3fv(U.uC3, stops[3]); gl.uniform1f(U.uDark, dark ? 1 : 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufBase); gl.enableVertexAttribArray(locBase); gl.vertexAttribPointer(locBase, 4, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufTxt); gl.enableVertexAttribArray(locTxt); gl.vertexAttribPointer(locTxt, 4, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, N);
    gl.disableVertexAttribArray(locBase); gl.disableVertexAttribArray(locTxt);

    if (pillAmt > 0.02) {
      const m = pillAmt, a = Math.min(1, m * m * 1.15);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(progBar);
      gl.uniform2f(UB.uRes, W, bandH); gl.uniform1f(UB.uBandTop, bandTop); gl.uniform1f(UB.uHy, hy); gl.uniform1f(UB.uPillK, pillK);
      gl.uniform1f(UB.uM, m); gl.uniform1f(UB.uDpr, dpr); gl.uniform1fv(UB.uBars, barLv);
      gl.uniform4f(UB.uBarCol, barCol[0] * a, barCol[1] * a, barCol[2] * a, a);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufBar); gl.enableVertexAttribArray(locBar); gl.vertexAttribPointer(locBar, 1, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, 14);
      gl.disableVertexAttribArray(locBar);
    }

    // DOM: pill glass, caret and glow; written only when the value changes
    const po = Math.round(pillAmt * 100) / 100;
    if (po !== pillO) { pillO = po; pillEl.style.opacity = po; pillEl.style.transform = `translate(-50%,calc(-50% + ${((1 - po) * 1.2 * pillK).toFixed(2)}px)) scale(${(0.97 + 0.03 * po).toFixed(3)})`; }
    let ck = 'off';
    if (typing && typeT < 3.0) {
      const prog = Math.min(1, Math.max(0, (typeT - 0.3) / 0.95));
      const li = Math.min(txt.lines - 1, Math.floor(prog * txt.lines - 1e-6)), lp = prog * txt.lines - li, e = txt.ext[li];
      const cx = e.minx + (e.maxx - e.minx) * Math.max(0, Math.min(1, prog >= 1 ? 1 : lp)) + txt.fs * 0.1;
      const on = prog < 1 ? 1 : (Math.sin(typeT * 8) > 0 ? 1 : 0.15);
      ck = `${Math.round(cx)},${Math.round(txt.ly[li] - txt.fs * 0.4)},${Math.round(txt.fs * 0.8)},${(on * Math.min(1, typeT * 5)).toFixed(2)}`;
      if (ck !== caretKey) {
        caretEl.style.height = Math.round(txt.fs * 0.8) + 'px'; caretEl.style.width = Math.max(2, Math.round(txt.fs * 0.03)) + 'px';
        caretEl.style.transform = `translate3d(${Math.round(cx)}px,${Math.round(txt.ly[li] - txt.fs * 0.4)}px,0)`;
        caretEl.style.opacity = (on * Math.min(1, typeT * 5)).toFixed(2);
      }
    } else if (caretKey !== 'off') caretEl.style.opacity = 0;
    caretKey = ck;
    if (glow) {
      const gx = Math.round(((ptr.inside ? ptr.x : W / 2) - W / 2) * 0.5);
      const go = Math.round(Math.min(1, 0.55 + 0.3 * breath * syll + ptr.energy * 0.35 + pillAmt * 0.25) * 50) / 50;
      if (gx !== glowX) { glowX = gx; glow.style.transform = `translate3d(${gx}px,0,0)`; }
      if (go !== glowO) { glowO = go; glow.style.opacity = go; }
    }
  }

  // A calm, finished-looking still frame for reduced motion (and while paused).
  function drawStatic() {
    if (!W || lost) return;
    ptr.energy = 0; rpN = 0; pillAmt = 0; mode = 'field';
    render(performance.now(), 2.15);
    if (glow) { glow.style.transform = ''; glow.style.opacity = ''; glowX = -1e9; glowO = -1; }
  }

  // ---------- run control ----------
  function shouldRun() { return !reduce && visible && !document.hidden && !lost; }
  function sync() {
    const want = shouldRun();
    if (want && !running) { running = true; last = 0; aStart = 0; lastFrame = 0; raf = requestAnimationFrame(frame); }
    else if (!want && running) { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
    if (!want && reduce) drawStatic();
  }
  const io = new IntersectionObserver((es) => { visible = es[0].isIntersecting; sync(); }, { threshold: 0 });
  io.observe(cv);
  document.addEventListener('visibilitychange', sync);
  mqReduce.addEventListener('change', () => { reduce = mqReduce.matches; sync(); });
  mqDark.addEventListener('change', themeChanged);
  let rz = 0;
  const ro = new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(() => { if (lost) return; layout(); if (!running) drawStatic(); }, 80); });
  ro.observe(panel);
  stopAll = () => { running = false; if (raf) cancelAnimationFrame(raf); io.disconnect(); ro.disconnect(); document.removeEventListener('visibilitychange', sync); };

  // context loss: pause, then rebuild everything on restore; give up to Canvas2D if it never comes back
  let lostTimer = 0;
  cv.addEventListener('webglcontextlost', (e) => {
    e.preventDefault(); lost = true; sync();
    lostTimer = setTimeout(fallback, 4000);
  });
  cv.addEventListener('webglcontextrestored', () => {
    clearTimeout(lostTimer);
    try { initGL(); } catch (err) { fallback(); return; }
    lost = false; layout(); sync();
  });

  // ---------- pointer ----------
  let pr = null;
  const prect = () => (pr || (pr = panel.getBoundingClientRect()));
  addEventListener('scroll', () => { pr = null; }, { passive: true });
  addEventListener('resize', () => { pr = null; }, { passive: true });
  function addRipple(x, p) {
    if (rpN === RP) return;
    rpX[rpN] = x; rpAge[rpN] = 0; rpP[rpN] = p; rpN++;
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
  window.__vnHeroSet = (state, ix) => {
    if (ix !== undefined) phraseIx = ix;
    const now = performance.now();
    lastUser = now; lastAuto = now;
    if (state === 'listen') startListen(false, now);
    else if (state === 'type') { startListen(false, now - 1000); pillAmt = 1; release(now); }
    else { mode = 'field'; }
  };

  layout();
  sync();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (mode === 'type' && txt) buildText(txt.phrase); });
})();
