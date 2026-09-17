/**
 * coin-fly.js — 「金幣從 A 飛到 B」的零依賴動畫引擎
 *
 * 用法：
 *   import { flyCoins } from './coin-fly.js';
 *   await flyCoins({
 *     from: chestEl,          // 起點：Element / DOMRect / {x, y}（視窗座標）
 *     to: balanceEl,          // 終點：同上
 *     count: 24,
 *     onArrive: (i, n) => bumpCounter(i, n),
 *   }).finished;
 *
 * 設計重點（為什麼這樣寫）：
 *  1. 每顆金幣「整段旅程」＝ 一條三次貝茲曲線，先往外噴、再弧線收進目標。
 *     曲線在 JS 取樣成 transform keyframes，交給 Web Animations API 播放
 *     → 動畫跑在合成執行緒（compositor），主執行緒每幀 0 成本。
 *  2. 位移 / 縮放放在「外層」元素，3D 翻轉放在「內層」元素。
 *     同一個元素上兩個動畫搶同一個 transform 會互相覆蓋，分兩層才不會打架。
 *  3. 粒子畫在 body 底下一層 position:fixed 的 overlay
 *     → 座標直接等於 getBoundingClientRect() 的視窗座標，
 *       不受捲動容器、overflow:hidden、z-index 堆疊脈絡影響。
 */

const LAYER_CLASS = 'coinfly-layer';
const COIN_CLASS = 'coinfly-coin';
const FACE_CLASS = 'coinfly-face';

const DEFAULTS = {
  count: 24,
  /** 單顆金幣從噴出到抵達的時間（ms）。實測參考影片約 270–330ms。 */
  duration: 360,
  /** 兩顆金幣發射的間隔（ms）。實際間隔會套 ease-out，讓抵達由密漸疏。 */
  stagger: 42,
  /** 起點抖動半徑（px），讓金幣不是從同一點冒出來。 */
  spread: 46,
  /** 噴出的初速長度（px），決定「炸開」的力道。 */
  burst: [70, 170],
  /** 弧線相對弦長的鼓起比例，越大彎越誇張。 */
  bulge: [0.05, 0.16],
  /** 金幣直徑（px）。 */
  size: 26,
  /** 起始 / 結束縮放。接近目標時縮小，做出遠近感。 */
  scale: [1, 0.42],
  /** 自轉一圈的時間（ms）。 */
  spin: [380, 720],
  /** from / to 的落點錨點，[0,0] 是左上、[1,1] 是右下。 */
  fromAnchor: [0.5, 0.5],
  toAnchor: [0.5, 0.5],
  /** 曲線取樣密度：每幾 ms 一個 keyframe。 */
  sampleEvery: 24,
  easing: 'cubic-bezier(.22,.61,.36,1)',
  zIndex: 2147483000,
  onArrive: null,
  signal: null,
};

const CSS = `
.${LAYER_CLASS}{
  position:fixed; inset:0;
  pointer-events:none;
  contain:layout style;
  overflow:clip;
}
.${COIN_CLASS}{
  position:absolute; top:0; left:0;
  width:var(--coinfly-size); height:var(--coinfly-size);
  perspective:600px;
  will-change:transform,opacity;
}
.${FACE_CLASS}{
  width:100%; height:100%;
  border-radius:50%;
  will-change:transform;
  background:
    radial-gradient(circle at 34% 26%, #fffbe0 0 10%, rgba(255,251,224,0) 46%),
    conic-gradient(from 212deg,
      #a9670f 0deg, #ffe98a 62deg, #f3c64b 118deg,
      #b8791a 190deg, #ffdf7e 264deg, #e8b53c 320deg, #a9670f 360deg);
  box-shadow:
    inset 0 0 0 1.5px rgba(255,238,168,.9),
    inset 0 -2px 5px rgba(120,60,0,.55),
    inset 0 2px 4px rgba(255,255,255,.35),
    0 2px 8px rgba(0,0,0,.45);
}
.${FACE_CLASS}::after{
  content:""; position:absolute; inset:21%;
  border-radius:50%;
  background:linear-gradient(150deg,#f7d867,#c98d21 55%,#f3cd5e);
  box-shadow:inset 0 1px 2px rgba(255,255,255,.55), inset 0 -1px 2px rgba(120,60,0,.5);
}
@media (prefers-reduced-motion: reduce){
  .${LAYER_CLASS}{ display:none; }
}
`;

let sheetReady = false;
function ensureStyle() {
  if (sheetReady) return;
  sheetReady = true;
  if ('adoptedStyleSheets' in document && 'replaceSync' in CSSStyleSheet.prototype) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } else {
    const el = document.createElement('style');
    el.textContent = CSS;
    document.head.append(el);
  }
}

let layer = null;
function ensureLayer(zIndex) {
  if (layer?.isConnected) return layer;
  ensureStyle();
  layer = document.createElement('div');
  layer.className = LAYER_CLASS;
  layer.style.zIndex = String(zIndex);
  layer.setAttribute('aria-hidden', 'true');
  document.body.append(layer);
  return layer;
}

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const randOf = (r) => (Array.isArray(r) ? rand(r[0], r[1]) : r);

/** Element / DOMRect / {x,y} → 視窗座標的點。 */
function toPoint(ref, anchor) {
  if (ref == null) throw new TypeError('flyCoins: from / to 不可為空');
  if (typeof ref.getBoundingClientRect === 'function') {
    const r = ref.getBoundingClientRect();
    return { x: r.left + r.width * anchor[0], y: r.top + r.height * anchor[1] };
  }
  if (typeof ref.left === 'number' && typeof ref.width === 'number') {
    return { x: ref.left + ref.width * anchor[0], y: ref.top + ref.height * anchor[1] };
  }
  if (typeof ref.x === 'number' && typeof ref.y === 'number') return { x: ref.x, y: ref.y };
  throw new TypeError('flyCoins: 無法解析座標，請傳 Element、DOMRect 或 {x, y}');
}

function cubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/**
 * 為一顆金幣產生 transform / opacity keyframes。
 * 曲線控制點：
 *   P0 起點（抖動過）
 *   P1 P0 + 噴出向量 → 決定一開始往哪炸開
 *   P2 弦的 65% 處，往法線方向鼓出 → 決定弧度
 *   P3 目標
 */
function buildKeyframes(p0, p3, cfg, size) {
  const chord = { x: p3.x - p0.x, y: p3.y - p0.y };
  const len = Math.hypot(chord.x, chord.y) || 1;

  // 噴出方向：以「指向目標的反方向」為中心的扇形，並偏向上方
  const away = Math.atan2(-chord.y, -chord.x);
  const angle = away + rand(-0.9, 0.9);
  const burst = randOf(cfg.burst);
  const p1 = {
    x: p0.x + Math.cos(angle) * burst,
    y: p0.y + Math.sin(angle) * burst - rand(20, 90), // 再往上抬一點，做出重力感
  };

  // 法線方向鼓起，正負隨機讓每顆金幣的弧不一樣
  const sign = Math.random() < 0.5 ? 1 : -1;
  const bulge = randOf(cfg.bulge) * len * sign;
  const p2 = {
    x: p0.x + chord.x * 0.65 + (-chord.y / len) * bulge,
    y: p0.y + chord.y * 0.65 + (chord.x / len) * bulge,
  };

  const steps = Math.max(12, Math.round(cfg.duration / cfg.sampleEvery));
  const s0 = randOf(cfg.scale[0]) * rand(0.82, 1.18);
  const s1 = randOf(cfg.scale[1]);
  const half = size / 2;
  const frames = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const { x, y } = cubic(p0, p1, p2, p3, t);
    const s = s0 + (s1 - s0) * (t * t); // 後段才明顯縮小
    frames.push({
      offset: t,
      transform: `translate3d(${(x - half).toFixed(2)}px, ${(y - half).toFixed(2)}px, 0) scale(${s.toFixed(3)})`,
      opacity: t < 0.06 ? t / 0.06 : t > 0.9 ? (1 - t) / 0.1 : 1,
    });
  }
  return frames;
}

/**
 * 讓抵達「由密漸疏」：延遲用 ease-in 分佈，而不是等距。
 * 前段延遲增加得慢 → 金幣密集出發；後段延遲拉開 → 抵達越來越稀疏，
 * 數字自然就會「先跳大格、後跳小格」，和參考影片一致。
 */
const spreadDelay = (i, n) => Math.pow(i / Math.max(1, n - 1), 1.7);

/**
 * @returns {{ finished: Promise<void>, cancel: () => void }}
 */
export function flyCoins(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const { signal, onArrive } = cfg;

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animations = [];
  const nodes = [];
  let settled = false;
  let resolveFinished;
  const finished = new Promise((r) => { resolveFinished = r; });

  const cleanup = () => {
    for (const n of nodes) n.remove();
    nodes.length = 0;
    signal?.removeEventListener('abort', cancel);
  };
  const settle = () => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveFinished();
  };
  const cancel = () => {
    for (const a of animations) a.cancel();
    animations.length = 0;
    settle();
  };

  if (signal?.aborted) { settle(); return { finished, cancel }; }
  signal?.addEventListener('abort', cancel, { once: true });

  // 減少動態偏好：不放粒子，但「資訊」照給——
  // 仍在同樣的時間窗內依序觸發 onArrive，數字照樣往上跳。
  if (reduced) {
    const span = cfg.duration + cfg.stagger * cfg.count;
    let i = 0;
    const id = setInterval(() => {
      if (settled) return clearInterval(id);
      onArrive?.(i, cfg.count);
      if (++i >= cfg.count) { clearInterval(id); settle(); }
    }, Math.max(16, span / cfg.count));
    return { finished, cancel: () => { clearInterval(id); cancel(); } };
  }

  const host = ensureLayer(cfg.zIndex);
  const totalDelay = cfg.stagger * Math.max(0, cfg.count - 1);
  const frag = document.createDocumentFragment();
  let landed = 0;

  for (let i = 0; i < cfg.count; i++) {
    const coin = document.createElement('div');
    coin.className = COIN_CLASS;
    coin.style.setProperty('--coinfly-size', cfg.size + 'px');
    const face = document.createElement('div');
    face.className = FACE_CLASS;
    coin.append(face);
    frag.append(coin);
    nodes.push(coin);

    const delay = totalDelay * spreadDelay(i, cfg.count);

    // 起點在每顆金幣「自己發射的當下」量測，慢速捲動時也不會歪掉
    const jitter = () => {
      const a = rand(0, Math.PI * 2);
      const r = Math.sqrt(Math.random()) * cfg.spread;
      const p = toPoint(cfg.from, cfg.fromAnchor);
      return { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r };
    };

    const frames = buildKeyframes(jitter(), toPoint(cfg.to, cfg.toAnchor), cfg, cfg.size);

    const flight = coin.animate(frames, {
      duration: cfg.duration,
      delay,
      easing: cfg.easing,
      fill: 'backwards',
    });
    // 自轉獨立一層，才不會和位移搶同一個 transform
    const spin = face.animate(
      [{ transform: 'rotateY(0deg)' }, { transform: `rotateY(${Math.random() < 0.5 ? 360 : -360}deg)` }],
      { duration: randOf(cfg.spin), delay, iterations: Infinity, easing: 'linear' },
    );
    animations.push(flight, spin);

    flight.finished.then(
      () => {
        spin.cancel();
        coin.remove();
        onArrive?.(i, cfg.count);
        if (++landed >= cfg.count) settle();
      },
      () => {}, // cancel() 會 reject，已由 cancel 統一收尾
    );
  }

  host.append(frag);
  if (cfg.count === 0) settle();
  return { finished, cancel };
}

export default flyCoins;
