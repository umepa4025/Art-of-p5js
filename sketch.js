/*
 * 墨流し (Suminagashi) — p5.js
 *
 * 水面に墨と「透明な液」を交互に落として同心の輪を作り、
 * 風で水面をゆらして模様を育てる、日本の伝統技法のシミュレーション。
 *
 * しくみ:
 *   - 輪はすべて「多角形(頂点の列)」として持っている。
 *   - しずくが落ちると、水は縮まないので周りの模様が外へ押し出される。
 *     中心からの距離 d の点は sqrt(d^2 + r^2) の位置へ動く(面積が保たれる)。
 *   - 風は「流れ関数」から作った、湧き出しのない(=水が増えも減りもしない)流れ。
 *   - 引き伸ばされた辺には頂点を足し、縮んだ辺からは頂点を間引く。
 */
'use strict';

const PALETTES = [
  { name: '墨', paper: '#ece6d8', ui: '#1c1c20',
    inks: ['#17171a', '#2c2c31', '#57575c', '#8d8b86'], accent: '#27345a' },
  { name: '藍', paper: '#e8e7e0', ui: '#16224a',
    inks: ['#141f45', '#263f7a', '#4c6ea8', '#93aaca'], accent: '#a8402b' },
  { name: '夜', paper: '#0e1014', ui: '#e6dfcc',
    inks: ['#e9e1cc', '#d2b577', '#a8823f', '#62727f'], accent: '#3f777c' },
  { name: '苔', paper: '#e6e4d2', ui: '#232d22',
    inks: ['#222c21', '#44583c', '#7b8a5b', '#b1ae84'], accent: '#8a3324' },
];

const EPS = 0.6;        // しずくが生まれた瞬間の半径(px)
const DROP_DUR = 22;    // しずくが広がりきるまでのフレーム数
const EMBED = !!window.SUMI_EMBED;

let cnv, grain = null, grainTimer = null;
let W = 0, H = 0, U = 0, base = 0;
let pal, palIndex = -1, inkCols = [], seed = 0;
let polys = [];         // { x: [], y: [], fill: 'rgba(...)' } 古い順 = 描く順
let drops = [];         // 広がっている最中のしずく
let sources = [];       // 筆を置く場所
let hands = [];         // 二本の筆
let modes = [];         // 風を作る波
let T = 0, phase = 'drop', phaseT = 0, windDur = 700;
let wind = 0, windTarget = 0;
let budget = 0, spent = 0, dropCount = 0, accentAt = new Set();
let maxLen = 5;
let paused = false, skipping = false, lastTouch = -1e9;
let pointerDown = false, ppx = 0, ppy = 0, holdT = 0, userInk = true, userK = 0;

/* ------------------------------------------------------------ setup */

function setup() {
  pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
  cnv = createCanvas(windowWidth, windowHeight);
  cnv.parent('sheet');
  bindUI();
  newSheet();
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    skipping = true; // 動きを減らす設定の人には、仕上がった一枚を静止画で見せる
  }
}

function newSheet() {
  seed = Math.floor(Math.random() * 9000) + 1000;
  randomSeed(seed);
  noiseSeed(seed);
  palIndex = (palIndex + 1) % PALETTES.length;
  pal = PALETTES[palIndex];
  inkCols = pal.inks.map((c) => color(c));

  W = width; H = height; U = Math.min(W, H);
  base = Math.max(U * 0.06, 20);
  polys = []; drops = [];
  maxLen = 5;

  // 風: 向きと波長のちがう波を4つ重ねる
  modes = [];
  for (let i = 0; i < 4; i++) {
    const a = random(TWO_PI), k = TWO_PI / (U * random(0.55, 1.4));
    modes.push({
      kx: k * Math.cos(a), ky: k * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a),
      s: random(0.12, 0.3) * U / 800,
      ph: random(TWO_PI), om: random(0.0015, 0.005) * (random() < 0.5 ? -1 : 1),
    });
  }

  // 筆を置く場所: たがいに離れるように選ぶ
  sources = [];
  const n = W * H > 500000 ? floor(random(3, 6)) : floor(random(2, 4));
  for (let i = 0; i < n; i++) {
    let best = null, bestD = -1;
    for (let c = 0; c < 30; c++) {
      const x = random(0.2, 0.8) * W, y = random(0.22, 0.78) * H;
      let d = 1e9;
      for (const s of sources) d = Math.min(d, Math.hypot(s.x - x, s.y - y));
      if (d > bestD) { bestD = d; best = { x, y }; }
    }
    sources.push(makeSource(best.x, best.y, 1));
  }

  budget = random(0.7, 0.95) * W * H / PI;
  spent = 0; dropCount = 0;
  accentAt = new Set([floor(random(6, 40)), floor(random(40, 100))]);
  windDur = random(600, 840);
  setPhase('drop');
  wind = windTarget;
  hands = [
    { src: sources[0], burst: floor(random(6, 14)), next: T + 20 },
    { src: sources[1 % sources.length], burst: floor(random(6, 14)), next: T + 31 },
  ];
  userInk = true; userK = 0;

  const root = document.documentElement.style;
  root.setProperty('--paper', pal.paper);
  root.setProperty('--ink', pal.ui);
  const kanji = String(seed).split('').map((d) => '〇一二三四五六七八九'[+d]).join('');
  document.getElementById('leaf').textContent = `第${kanji}葉　${pal.name}`;
  if (!grain) buildGrain();
}

function makeSource(x, y, scale) {
  return { x, y, scale, k: 0, ink: true, ns: random(1000) };
}

function setPhase(p) {
  phase = p; phaseT = 0;
  windTarget = { drop: 0.3, wind: 1, still: 0, lift: 0 }[p];
}

/* ------------------------------------------------------------- draw */

function draw() {
  const dt = Math.min((deltaTime || 16.667) / 16.667, 2.5);

  if (skipping) {
    // 早送り: 画面には出さずに、1フレームあたり約24ミリ秒ぶんだけ計算を進める
    const t0 = performance.now();
    maxLen = Math.max(maxLen, 8);
    while (skipping && performance.now() - t0 < 24) {
      conduct(2); step(2);
      if (phase === 'still' && phaseT > 300) { skipping = false; wind = 0; setPaused(true); }
    }
    document.getElementById('wait').hidden = !skipping;
    if (skipping) { background(pal.paper); image(grain, 0, 0, W, H); return; }
  }

  handlePointer(dt);
  conduct(dt);
  step(dt);
  render();
}

function render() {
  background(pal.paper);
  const c = drawingContext;
  for (const p of polys) {
    const x = p.x, y = p.y, n = x.length;
    c.fillStyle = p.fill;
    c.beginPath();
    // 頂点を「曲線の制御点」として使い、辺の中点どうしをなめらかにつなぐ
    c.moveTo((x[n - 1] + x[0]) / 2, (y[n - 1] + y[0]) / 2);
    for (let i = 0; i < n; i++) {
      const j = i + 1 < n ? i + 1 : 0;
      c.quadraticCurveTo(x[i], y[i], (x[i] + x[j]) / 2, (y[i] + y[j]) / 2);
    }
    c.closePath();
    c.fill();
  }
  if (phase === 'lift') {
    // 紙を引き上げる: 次の紙の色でゆっくり覆う
    const t = constrain(phaseT / 150, 0, 1);
    c.globalAlpha = t * t * (3 - 2 * t);
    c.fillStyle = PALETTES[(palIndex + 1) % PALETTES.length].paper;
    c.fillRect(0, 0, W, H);
    c.globalAlpha = 1;
  }
  image(grain, 0, 0, W, H);
}

/* -------------------------------------------------------- 進行(自動) */

function conduct(dt) {
  if (paused) return;
  if (T - lastTouch < 200) return; // 見ている人が触っているあいだは待つ
  phaseT += dt;

  if (phase === 'drop') {
    for (const h of hands) if (T >= h.next) handDrop(h);
    if (spent >= budget && drops.length === 0) setPhase('wind');
  } else if (phase === 'wind') {
    if (phaseT > windDur) setPhase('still');
  } else if (phase === 'still') {
    if (phaseT > 520) setPhase('lift');
  } else if (phaseT > 175) {
    newSheet();
  }
}

function handDrop(h) {
  if (spent >= budget) { h.next = 1e12; return; }
  if (h.burst <= 0) {
    // 筆を別の場所へ移す。ときどき小さな輪を新しい場所に作る
    const other = hands[0] === h ? hands[1] : hands[0];
    if (random() < 0.18) {
      h.src = makeSource(random(0.08, 0.92) * W, random(0.1, 0.9) * H, random(0.4, 0.65));
      h.burst = floor(random(4, 9));
    } else {
      const free = sources.filter((s) => s !== other.src && s !== h.src);
      h.src = free.length ? random(free) : h.src;
      h.burst = floor(random(5, 15));
    }
    h.next = T + random(20, 70);
    return;
  }
  const s = h.src, isInk = s.ink;
  s.ink = !s.ink;
  const u = noise(s.ns + 300, s.k * 0.3);
  const r = base * s.scale * (isInk ? lerp(0.3, 0.9, u) : lerp(0.6, 2.0, u));
  let fill = pal.paper;
  if (isInk) {
    fill = accentAt.has(dropCount) ? toRGBA(color(pal.accent), 0.9) : inkTone(s.ns, s.k);
  }
  const j = base * 0.05;
  addDrop(s.x + randomGaussian(0, j), s.y + randomGaussian(0, j), r, fill);
  s.k++; h.burst--; dropCount++;
  spent += r * r;
  h.next = T + DROP_DUR + 1;
}

// 墨の濃さをノイズでゆっくり変える → となり合う輪が自然な濃淡になる
function inkTone(ns, k) {
  let u = constrain((noise(ns, k * 0.21) - 0.22) / 0.56, 0, 0.9999);
  u = Math.pow(u, 1.4) * (inkCols.length - 1);
  const i = Math.floor(u);
  const a = 0.82 + 0.14 * noise(ns + 50, k * 0.4);
  return toRGBA(lerpColor(inkCols[i], inkCols[i + 1], u - i), a);
}

function toRGBA(c, a) {
  return `rgba(${Math.round(red(c))},${Math.round(green(c))},${Math.round(blue(c))},${a.toFixed(3)})`;
}

/* ------------------------------------------------------ 水面の物理 */

function addDrop(cx, cy, r, fill) {
  refineNear(cx, cy, maxLen * 3);
  const n = 12, x = [], y = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TWO_PI;
    x.push(cx + EPS * Math.cos(a));
    y.push(cy + EPS * Math.sin(a));
  }
  polys.push({ x, y, fill });
  drops.push({ cx, cy, q: r * r, s: 0, t: 0 });
}

function step(dt) {
  T += dt;
  const target = paused ? 0 : windTarget;
  wind += (target - wind) * Math.min(0.012 * dt, 1);
  if (wind < 0.004 && target === 0) wind = 0;

  if (wind > 0) advect(wind * dt, dt);

  for (const d of drops) {
    d.t += dt;
    const t = Math.min(d.t / DROP_DUR, 1);
    const s = t * t * (3 - 2 * t);
    expand(d.cx, d.cy, d.q * (s - d.s));
    d.s = s;
  }
  if (drops.length) drops = drops.filter((d) => d.t < DROP_DUR);

  resampleAll();
}

// 風で全部の頂点を流す
function advect(a, dt) {
  const M = modes.length;
  for (const p of polys) {
    const x = p.x, y = p.y;
    for (let i = 0, n = x.length; i < n; i++) {
      const px = x[i], py = y[i];
      let vx = 0, vy = 0;
      for (let m = 0; m < M; m++) {
        const o = modes[m];
        const c = o.s * Math.cos(o.kx * px + o.ky * py + o.ph);
        vx += c * o.ny; vy -= c * o.nx;
      }
      x[i] = px + vx * a; y[i] = py + vy * a;
    }
  }
  for (const d of drops) {
    let vx = 0, vy = 0;
    for (const o of modes) {
      const c = o.s * Math.cos(o.kx * d.cx + o.ky * d.cy + o.ph);
      vx += c * o.ny; vy -= c * o.nx;
    }
    d.cx += vx * a; d.cy += vy * a;
  }
  for (const o of modes) o.ph += o.om * dt;
}

// しずくが広がる: 中心からの距離の2乗に dq を足す(面積を保つ変形)
function expand(cx, cy, dq) {
  if (dq <= 0) return;
  for (const p of polys) {
    const x = p.x, y = p.y;
    for (let i = 0, n = x.length; i < n; i++) {
      let dx = x[i] - cx, dy = y[i] - cy;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1e-4) { dx = 0.01; dy = 0; d2 = 1e-4; }
      const f = Math.sqrt(1 + dq / d2);
      x[i] = cx + dx * f; y[i] = cy + dy * f;
    }
  }
}

// 指や棒で水面をなぞる: なぞった方向へ、近くの水ほど強く引きずる
function stylus(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
  if (len < 0.01) return;
  const steps = Math.min(Math.ceil(len / 4), 14);
  const sx = dx / steps, sy = dy / steps;
  const sig2 = Math.pow(U * 0.05, 2), lim = sig2 * 9;
  for (let s = 0; s < steps; s++) {
    const cx = ax + sx * (s + 0.5), cy = ay + sy * (s + 0.5);
    for (const p of polys) {
      const x = p.x, y = p.y;
      for (let i = 0, n = x.length; i < n; i++) {
        const ex = x[i] - cx, ey = y[i] - cy, d2 = ex * ex + ey * ey;
        if (d2 < lim) {
          const w = Math.exp(-d2 / sig2);
          x[i] += sx * w; y[i] += sy * w;
        }
      }
    }
    if (s % 3 === 2) resampleAll();
  }
}

/* ------------------------------------------------ 頂点の足し引き */

function visible(x, y) {
  return x > -140 && x < W + 140 && y > -140 && y < H + 140;
}

function resampleAll() {
  const max2 = maxLen * maxLen, min2 = max2 * 0.1;
  let total = 0;
  for (const p of polys) {
    const x = p.x, y = p.y, n = x.length;
    let dirty = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const dx = x[i] - x[j], dy = y[i] - y[j], d2 = dx * dx + dy * dy;
      if (d2 > max2) {
        if (visible(x[i], y[i]) || visible(x[j], y[j])) { dirty = true; break; }
      } else if (d2 < min2 && n > 12) { dirty = true; break; }
    }
    if (dirty) rebuild(p, max2, min2);
    total += p.x.length;
  }
  if (total > 70000) maxLen = Math.min(maxLen * 1.08, 14); // 重くなりすぎたら粗くする
}

function rebuild(p, max2, min2) {
  const x = p.x, y = p.y, n = x.length, nx = [], ny = [];
  for (let i = 0; i < n; i++) {
    const j = i + 1 < n ? i + 1 : 0;
    const ax = x[i], ay = y[i];
    nx.push(ax); ny.push(ay);
    const dx = x[j] - ax, dy = y[j] - ay, d2 = dx * dx + dy * dy;
    if (d2 > max2) {
      if (visible(ax, ay) || visible(x[j], y[j])) {
        const k = Math.min(Math.ceil(Math.sqrt(d2) / maxLen), 16);
        for (let s = 1; s < k; s++) {
          nx.push(ax + (dx * s) / k); ny.push(ay + (dy * s) / k);
        }
      }
    } else if (d2 < min2 && j !== 0 && n > 12) {
      i++; // 次の頂点を間引く
    }
  }
  if (nx.length >= 6) { p.x = nx; p.y = ny; }
}

// しずくが落ちる場所のすぐ近くだけ、あらかじめ辺を細かくしておく
function refineNear(cx, cy, rad) {
  const r2 = rad * rad;
  for (const p of polys) {
    const x = p.x, y = p.y, n = x.length;
    let hit = false;
    for (let i = 0; i < n; i++) {
      const dx = x[i] - cx, dy = y[i] - cy;
      if (dx * dx + dy * dy < r2) { hit = true; break; }
    }
    if (!hit) continue;
    const nx = [], ny = [];
    for (let i = 0; i < n; i++) {
      const j = i + 1 < n ? i + 1 : 0;
      const ax = x[i], ay = y[i], bx = x[j], by = y[j];
      nx.push(ax); ny.push(ay);
      const da = (ax - cx) * (ax - cx) + (ay - cy) * (ay - cy);
      const db = (bx - cx) * (bx - cx) + (by - cy) * (by - cy);
      if (da < r2 || db < r2) {
        const k = Math.min(Math.ceil(Math.hypot(bx - ax, by - ay)), 16);
        for (let s = 1; s < k; s++) {
          nx.push(ax + ((bx - ax) * s) / k); ny.push(ay + ((by - ay) * s) / k);
        }
      }
    }
    p.x = nx; p.y = ny;
  }
}

/* ------------------------------------------------------- 紙の質感 */

function buildGrain() {
  if (grain) grain.remove();
  grain = createGraphics(W, H);
  grain.pixelDensity(1);
  grain.loadPixels();
  const px = grain.pixels;
  for (let i = 0; i < px.length; i += 4) {
    const v = Math.random() < 0.5 ? 0 : 255, a = Math.random();
    px[i] = px[i + 1] = px[i + 2] = v;
    px[i + 3] = a * a * 21;
  }
  grain.updatePixels();

  // 和紙の繊維
  grain.noFill();
  const count = Math.floor((W * H) / 2600);
  for (let i = 0; i < count; i++) {
    const x = Math.random() * W, y = Math.random() * H;
    const a = Math.random() * Math.PI * 2, l = 6 + Math.random() * 26;
    const bend = (Math.random() - 0.5) * 1.6;
    if (Math.random() < 0.5) grain.stroke(255, 255, 255, 26); else grain.stroke(70, 55, 35, 20);
    grain.strokeWeight(0.4 + Math.random() * 0.5);
    grain.bezier(
      x, y,
      x + Math.cos(a) * l * 0.33, y + Math.sin(a) * l * 0.33,
      x + Math.cos(a + bend) * l * 0.66, y + Math.sin(a + bend) * l * 0.66,
      x + Math.cos(a + bend) * l, y + Math.sin(a + bend) * l
    );
  }

  // ふちをほんの少し暗くする
  const g = grain.drawingContext;
  const v = g.createRadialGradient(W / 2, H / 2, U * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.6);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.2)');
  g.fillStyle = v;
  g.fillRect(0, 0, W, H);
}

/* ------------------------------------------------------- 入力 */

function handlePointer(dt) {
  if (!pointerDown) return;
  lastTouch = T;
  if (Math.hypot(mouseX - ppx, mouseY - ppy) > 1.5) {
    stylus(ppx, ppy, mouseX, mouseY);
    holdT = -10;
  } else {
    holdT += dt;
    if (holdT > DROP_DUR + 1) { holdT = 0; userDrop(); }
  }
  ppx = mouseX; ppy = mouseY;
}

// 押しっぱなしで、墨 → 透明 → 墨 … と交互に落ちて輪になる
function userDrop() {
  const r = base * (userInk ? random(0.45, 0.8) : random(0.6, 1.2));
  addDrop(mouseX, mouseY, r, userInk ? inkTone(777, userK++) : pal.paper);
  userInk = !userInk;
}

function mousePressed(e) {
  if (skipping || (e && e.target !== cnv.elt)) return;
  pointerDown = true;
  ppx = mouseX; ppy = mouseY;
  holdT = 0; userInk = true;
  lastTouch = T;
  if (phase === 'lift') setPhase('still');
  userDrop();
  document.getElementById('hint').classList.add('gone');
  return false;
}

function mouseReleased() { pointerDown = false; }

function keyPressed() {
  const el = document.activeElement;
  if (el && el.tagName === 'BUTTON') return;
  if (key === 'n' || key === 'N') nextSheet();
  else if (key === ' ') { setPaused(!paused); return false; }
  else if ((key === 's' || key === 'S') && !EMBED) savePrint();
  else if (key === 'h' || key === 'H') {
    const ui = document.getElementById('ui');
    ui.hidden = !ui.hidden;
  }
}

function nextSheet() {
  const still = paused || skipping;
  if (paused) setPaused(false);
  newSheet();
  skipping = still; // 止めているときは、次の一枚も仕上がった状態で出す
}

function setPaused(v) {
  paused = v;
  const b = document.getElementById('btn-pause');
  b.textContent = v ? '動かす' : '止める';
  b.setAttribute('aria-pressed', String(v));
}

function savePrint() { saveCanvas(`suminagashi-${seed}-${pal.name}`, 'png'); }

function bindUI() {
  document.getElementById('btn-new').addEventListener('click', nextSheet);
  document.getElementById('btn-pause').addEventListener('click', () => setPaused(!paused));
  const save = document.getElementById('btn-save');
  if (EMBED) save.hidden = true; else save.addEventListener('click', savePrint);
  setTimeout(() => document.getElementById('hint').classList.add('gone'), 14000);
  // マウスで押したあとはボタンからフォーカスを外す(スペースキーをいつでも「止める」に使えるように)
  for (const b of document.querySelectorAll('.tools button')) {
    b.addEventListener('click', (e) => { if (e.detail > 0) b.blur(); });
  }
}

function windowResized() {
  const ox = (windowWidth - W) / 2, oy = (windowHeight - H) / 2;
  resizeCanvas(windowWidth, windowHeight);
  for (const p of polys) {
    for (let i = 0; i < p.x.length; i++) { p.x[i] += ox; p.y[i] += oy; }
  }
  for (const d of drops) { d.cx += ox; d.cy += oy; }
  for (const s of sources) { s.x += ox; s.y += oy; }
  for (const h of hands) if (!sources.includes(h.src)) { h.src.x += ox; h.src.y += oy; }
  W = width; H = height; U = Math.min(W, H);
  clearTimeout(grainTimer);
  grainTimer = setTimeout(buildGrain, 160);
}
