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
let polys = [];         // { x: [], y: [], fill: 'rgba(...)' か null(透明な液), kids: [] } 古い順 = 描く順
let drops = [];         // 広がっている最中のしずく
let sources = [];       // 筆を置く場所
let hands = [];         // 二本の筆
let modes = [];         // 風を作る波
let T = 0, phase = 'drop', phaseT = 0, windDur = 700;
let wind = 0, windTarget = 0;
let budget = 0, spent = 0, dropCount = 0, accentAt = new Set();
let coarse = 1, coarseBase = 1, vertCap = 24000; // coarse: 線の粗さ(1 = いちばん細かい)
let guards = [];         // この近くは頂点を細かく保つ、という場所
let dirty = true;        // 描き直しが必要か
let slowAcc = 0, slowN = 0, settle = 40;
let paused = false, skipping = false, lastTouch = -1e9;
let pointerDown = false, ppx = 0, ppy = 0, holdT = 0, userInk = true, userK = 0;

/* ------------------------------------------------------------ setup */

function setup() {
  // 画面の細かさ。画素の総数が増えすぎないように上限をかける(あとは watchSpeed が自動で下げる)
  const fit = Math.sqrt(6e6 / (windowWidth * windowHeight));
  const pd = Math.min(window.devicePixelRatio || 1, 2, Math.floor(fit * 4) / 4);
  pixelDensity(Math.max(pd, 1));
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
  polys = []; drops = []; guards = [];
  coarse = coarseBase;
  dirty = true;

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
  phase = p; phaseT = 0; dirty = true;
  windTarget = { drop: 0.3, wind: 1, still: 0, lift: 0 }[p];
}

/* ------------------------------------------------------------- draw */

function draw() {
  // 60コマ/秒を1とした経過時間。遅い端末でも作品の進む速さは変えない(15コマ/秒までは追従)
  const dt = Math.min((deltaTime || 16.667) / 16.667, 4);

  if (skipping) {
    // 早送り: 画面には出さずに、1フレームあたり約24ミリ秒ぶんだけ計算を進める
    const t0 = performance.now();
    while (skipping && performance.now() - t0 < 24) {
      conduct(2); step(2);
      if (phase === 'still' && phaseT > 300) { skipping = false; wind = 0; setPaused(true); }
    }
    document.getElementById('wait').hidden = !skipping;
    dirty = true;
    if (skipping) { background(pal.paper); return; }
  }

  handlePointer(dt);
  conduct(dt);
  // 何も動いていないコマは描き直さない(止まっているあいだは負荷ほぼゼロ)
  const moving = dirty || wind > 0 || drops.length > 0 || phase === 'lift';
  if (dt > 1.6) { step(dt / 2); step(dt / 2); } else step(dt); // コマが飛んだぶんは2回に分けて計算する
  if (moving) { render(); dirty = false; watchSpeed(); }
}

// コマ落ちが続いたら、まず画面の細かさを、次に線の細かさを一段ずつ下げる
function watchSpeed() {
  if (deltaTime > 250) return; // タブが裏に回っていた等は数えない
  if (settle > 0) { settle--; return; }
  slowAcc += deltaTime; slowN++;
  if (slowN < 30) return;
  const avg = slowAcc / slowN; // 1コマにかかった平均ミリ秒(60コマ/秒なら約16.7)
  slowAcc = 0; slowN = 0;
  if (avg < 21) return;
  const pd = pixelDensity();
  if (pd > 1) {
    pixelDensity(Math.max(1, pd - 0.5));
  } else if (avg > 30 && pd > 0.75) {
    pixelDensity(0.75); // 最後の手段: 少しぼけるが、なめらかさを優先する
  } else if (avg > 30 && coarseBase < 2.4) {
    coarseBase *= 1.3; vertCap *= 0.75;
    coarse = Math.max(coarse, coarseBase);
  } else return;
  settle = 40; dirty = true;
}

function render() {
  background(pal.paper);
  const c = drawingContext;
  for (const p of polys) {
    if (!p.fill) continue; // 透明な液は紙の色そのものなので描かない
    c.fillStyle = p.fill;
    c.beginPath();
    trace(c, p);
    holes(c, p); // 内側の透明な液を「穴」としてくり抜く → 輪の部分だけを塗るので速い
    c.fill('evenodd');
  }
  if (phase === 'lift') {
    // 紙を引き上げる: 次の紙の色でゆっくり覆う
    const t = constrain(phaseT / 150, 0, 1);
    c.globalAlpha = t * t * (3 - 2 * t);
    c.fillStyle = PALETTES[(palIndex + 1) % PALETTES.length].paper;
    c.fillRect(0, 0, W, H);
    c.globalAlpha = 1;
  }
}

// p の内側に落ちた透明な液の輪郭をたどる。墨の中に落ちた墨は上から重ね塗りするので穴にせず、
// そのさらに内側の透明な液だけを穴にする
function holes(c, p) {
  for (const k of p.kids) {
    if (k.fill) holes(c, k); else trace(c, k);
  }
}

// 頂点を通るなめらかな曲線(3次ベジェ)で輪郭をなぞる。
// 各頂点での向きは「前後の頂点を結ぶ向き」、ハンドルの長さは辺の3分の1。
function trace(c, p) {
  const x = p.x, y = p.y, n = x.length;
  let bx = x[0], by = y[0], cx = x[1], cy = y[1];
  let tx = cx - x[n - 1], ty = cy - y[n - 1];
  let tl = Math.sqrt(tx * tx + ty * ty) || 1;
  tx /= tl; ty /= tl;
  c.moveTo(bx, by);
  for (let i = 0; i < n; i++) {
    const k = i + 2 < n ? i + 2 : i + 2 - n;
    const dx = x[k], dy = y[k];
    let ux = dx - bx, uy = dy - by;
    const ul = Math.sqrt(ux * ux + uy * uy) || 1;
    ux /= ul; uy /= ul;
    const l = Math.sqrt((cx - bx) * (cx - bx) + (cy - by) * (cy - by)) / 3;
    c.bezierCurveTo(bx + tx * l, by + ty * l, cx - ux * l, cy - uy * l, cx, cy);
    bx = cx; by = cy; cx = dx; cy = dy; tx = ux; ty = uy;
  }
  c.closePath();
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
  let fill = null; // null = 透明な液
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
  refineNear(cx, cy, 22);
  let parent = null;
  const n = 12, x = [], y = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TWO_PI;
    x.push(cx + EPS * Math.cos(a));
    y.push(cy + EPS * Math.sin(a));
  }
  // このしずくがどの輪の内側に落ちたか。包んでいる輪のうち、いちばん新しいものが直接の親
  for (let i = polys.length - 1; i >= 0; i--) {
    if (inside(polys[i], cx, cy)) { parent = polys[i]; break; }
  }
  const p = { x, y, fill, kids: [] };
  if (parent) parent.kids.push(p);
  polys.push(p);
  const g = 1.3 * r + 12; // 広がりきるまで、この半径の内側は頂点を細かく保つ
  drops.push({ cx, cy, q: r * r, s: 0, t: 0, g2: g * g });
  guards = drops;
  dirty = true;
}

function inside(p, px, py) {
  const x = p.x, y = p.y;
  let c = false;
  for (let i = 0, j = x.length - 1; i < x.length; j = i++) {
    if ((y[i] > py) !== (y[j] > py) && px < ((x[j] - x[i]) * (py - y[i])) / (y[j] - y[i]) + x[i]) c = !c;
  }
  return c;
}

function step(dt) {
  T += dt;
  const target = paused ? 0 : windTarget;
  wind += (target - wind) * Math.min(0.012 * dt, 1);
  if (wind < 0.004 && target === 0) wind = 0;

  if (wind === 0 && drops.length === 0) return; // 水面が静かなら計算しない

  if (wind > 0) advect(wind * dt, dt);

  for (const d of drops) {
    d.t += dt;
    const t = Math.min(d.t / DROP_DUR, 1);
    const s = t * t * (3 - 2 * t);
    expand(d.cx, d.cy, d.q * (s - d.s));
    d.s = s;
  }
  if (drops.length) drops = drops.filter((d) => d.t < DROP_DUR);
  guards = drops;

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
  const sig = U * 0.05, sig2 = sig * sig, lim = sig2 * 9;
  // なぞる道すじの近くは、動かす前に頂点を細かくしておく
  const g = len / 2 + sig * 2.5;
  guards = drops.concat({ cx: (ax + bx) / 2, cy: (ay + by) / 2, g2: g * g });
  resampleAll(); resampleAll();
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
    if (s % 3 === 2 || s === steps - 1) resampleAll();
  }
  guards = drops;
  dirty = true;
}

/* ------------------------------------------------ 頂点の足し引き */
// 輪郭は「頂点を通るなめらかな曲線」なので、頂点は
// まっすぐな所ではまばらに、曲がりのきつい所でだけ細かく置けば足りる。

const SAG = 4;      // 「辺の長さ × 曲がり角」がこれを超えたら頂点を足す(弧のふくらみ 約0.5px に相当)
const L_MAX = 30;   // 辺の長さの上限(px)
let LEN = new Float64Array(2048), TURN = new Float64Array(2048), RM = new Uint8Array(2048);

function visible(x, y) {
  return x > -140 && x < W + 140 && y > -140 && y < H + 140;
}

function guarded(x, y) {
  for (let i = 0; i < guards.length; i++) {
    const g = guards[i], dx = x - g.cx, dy = y - g.cy;
    if (dx * dx + dy * dy < g.g2) return true;
  }
  return false;
}

function resampleAll() {
  let total = 0;
  for (const p of polys) { resample(p); total += p.x.length; }
  if (total > vertCap) coarse = Math.min(coarse * 1.04, 3); // 頂点が増えすぎたら全体を少し粗くする
}

// 辺 i→j に頂点を足すべきか
function needSplit(x, y, i, j, sag, lmax) {
  const l = LEN[i];
  if (l <= 4) return false;
  const bend = l > lmax || l * Math.max(TURN[i], TURN[j]) > sag;
  if (!bend && !(l > 6 * coarse && guards.length && guarded((x[i] + x[j]) / 2, (y[i] + y[j]) / 2))) return false;
  return visible(x[i], y[i]) || visible(x[j], y[j]);
}

function resample(p) {
  const x = p.x, y = p.y, n = x.length;
  if (n > LEN.length) {
    LEN = new Float64Array(n * 2); TURN = new Float64Array(n * 2); RM = new Uint8Array(n * 2);
  }
  const sag = SAG * coarse, lmax = L_MAX * coarse;

  // 各辺の長さと、各頂点での曲がり角(小さい角ではラジアンとほぼ同じ値)
  for (let i = 0; i < n; i++) {
    const j = i + 1 < n ? i + 1 : 0, dx = x[j] - x[i], dy = y[j] - y[i];
    LEN[i] = Math.sqrt(dx * dx + dy * dy);
  }
  for (let i = 0; i < n; i++) {
    const h = i > 0 ? i - 1 : n - 1, j = i + 1 < n ? i + 1 : 0;
    const ax = x[i] - x[h], ay = y[i] - y[h], bx = x[j] - x[i], by = y[j] - y[i];
    const ll = LEN[h] * LEN[i];
    TURN[i] = ll < 1e-12 ? 0 : ax * bx + ay * by > 0 ? Math.abs(ax * by - ay * bx) / ll : 2;
  }

  // 間引く頂点を決める(となり合う2つを同時には消さない)
  let change = false, prev = false;
  for (let i = 0; i < n; i++) {
    RM[i] = 0;
    if (prev || n <= 8) { prev = false; continue; }
    const h = i > 0 ? i - 1 : n - 1, j = i + 1 < n ? i + 1 : 0;
    const l1 = LEN[h], l2 = LEN[i], L = l1 + l2;
    let rm = false;
    if ((l1 < 0.9 || l2 < 0.9) && TURN[i] < 0.5) rm = true; // 詰まりすぎ
    else if (L < lmax * 0.7 && L * (Math.max(TURN[h], TURN[j]) + TURN[i]) < sag * 0.5) {
      rm = !(guards.length && guarded(x[i], y[i])); // ほぼまっすぐ
    } else if (L < 90 && !visible(x[i], y[i]) && !visible(x[h], y[h]) && !visible(x[j], y[j])) rm = true; // 画面の外
    if (rm) { RM[i] = 1; prev = true; change = true; }
  }
  if (RM[0] && RM[n - 1]) RM[0] = 0;

  if (!change) {
    for (let i = 0; i < n; i++) {
      if (needSplit(x, y, i, i + 1 < n ? i + 1 : 0, sag, lmax)) { change = true; break; }
    }
    if (!change) return;
  }

  const nx = [], ny = [];
  for (let i = 0; i < n; i++) {
    if (RM[i]) continue;
    nx.push(x[i]); ny.push(y[i]);
    const j = i + 1 < n ? i + 1 : 0;
    if (RM[j] || !needSplit(x, y, i, j, sag, lmax)) continue;
    edgePoint(x, y, n, i, 0.5);
    nx.push(CPX); ny.push(CPY);
  }
  p.x = nx; p.y = ny;
}

// 辺 i→i+1 の曲線上の点(t = 0〜1)。trace() が描く曲線と同じ式
let CPX = 0, CPY = 0;
function edgePoint(x, y, n, i, t) {
  const h = i > 0 ? i - 1 : n - 1, j = i + 1 < n ? i + 1 : 0, k = j + 1 < n ? j + 1 : 0;
  const bx = x[i], by = y[i], cx = x[j], cy = y[j];
  let tx = cx - x[h], ty = cy - y[h], ux = x[k] - bx, uy = y[k] - by;
  const tl = Math.sqrt(tx * tx + ty * ty) || 1, ul = Math.sqrt(ux * ux + uy * uy) || 1;
  const l = Math.sqrt((cx - bx) * (cx - bx) + (cy - by) * (cy - by)) / 3;
  const p1x = bx + (tx / tl) * l, p1y = by + (ty / tl) * l;
  const p2x = cx - (ux / ul) * l, p2y = cy - (uy / ul) * l;
  const s = 1 - t, a = s * s * s, b = 3 * s * s * t, c = 3 * s * t * t, d = t * t * t;
  CPX = a * bx + b * p1x + c * p2x + d * cx;
  CPY = a * by + b * p1y + c * p2y + d * cy;
}

// しずくが落ちる場所のすぐ近くだけ、あらかじめ頂点を細かくしておく
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
        const k = Math.min(Math.ceil(Math.hypot(bx - ax, by - ay) / 1.5), 24);
        for (let s = 1; s < k; s++) {
          edgePoint(x, y, n, i, s / k);
          nx.push(CPX); ny.push(CPY);
        }
      }
    }
    p.x = nx; p.y = ny;
  }
}

/* ------------------------------------------------------- 紙の質感 */

// 紙の粒・繊維・ふちの陰りを、作品の上に重ねる別のキャンバスに一度だけ描く。
// 毎コマ描き直さず、重ね合わせはブラウザに任せる。
function buildGrain() {
  if (!grain) {
    grain = document.createElement('canvas');
    grain.id = 'grain';
    grain.setAttribute('aria-hidden', 'true');
    document.getElementById('sheet').appendChild(grain);
  }
  grain.width = W; grain.height = H;
  const g = grain.getContext('2d');
  const img = g.createImageData(W, H), px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const v = Math.random() < 0.5 ? 0 : 255, a = Math.random();
    px[i] = px[i + 1] = px[i + 2] = v;
    px[i + 3] = a * a * 21;
  }
  g.putImageData(img, 0, 0);

  // 和紙の繊維
  const count = Math.floor((W * H) / 2600);
  for (let i = 0; i < count; i++) {
    const x = Math.random() * W, y = Math.random() * H;
    const a = Math.random() * Math.PI * 2, l = 6 + Math.random() * 26;
    const b = a + (Math.random() - 0.5) * 1.6;
    g.strokeStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.1)' : 'rgba(70,55,35,0.08)';
    g.lineWidth = 0.4 + Math.random() * 0.5;
    g.beginPath();
    g.moveTo(x, y);
    g.bezierCurveTo(
      x + Math.cos(a) * l * 0.33, y + Math.sin(a) * l * 0.33,
      x + Math.cos(b) * l * 0.66, y + Math.sin(b) * l * 0.66,
      x + Math.cos(b) * l, y + Math.sin(b) * l
    );
    g.stroke();
  }

  // ふちをほんの少し暗くする
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
  addDrop(mouseX, mouseY, r, userInk ? inkTone(777, userK++) : null);
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

function savePrint() {
  render();
  drawingContext.drawImage(grain, 0, 0, W, H); // 保存する画像にだけ紙の質感を焼きこむ
  saveCanvas(`suminagashi-${seed}-${pal.name}`, 'png');
  dirty = true;
}

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
  dirty = true;
  clearTimeout(grainTimer);
  grainTimer = setTimeout(buildGrain, 160);
}
