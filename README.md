# 金幣飛向錢包（coin-fly）

把「領獎 → 金幣噴出 → 飛進右上角餘額 → 數字往上跳」這個效果做成可重用的零依賴模組。

| 檔案 | 內容 |
| --- | --- |
| `coin-fly.js` | 引擎。`flyCoins({ from, to, ... })`，沒有任何相依套件 |
| `coin-burst.html` | 完整示範場景：禮物盒、光線、餘額膠囊、綠色 toast |
| `index.html` | 另一支練習：用 SVG stroke-dasharray 把 "Design" 畫出來 |

## 跑起來

```bash
python3 -m http.server 8000
# http://localhost:8000/coin-burst.html
```

用 `file://` 直接開會被 CORS 擋（ES module 的限制），頁面會顯示提示。

## 效果拆解

參考影片是 120fps 螢幕錄影，逐格量出來的數字都寫進預設值了：

| 項目 | 量到的值 |
| --- | --- |
| 單顆金幣飛行時間 | 270–330ms |
| 抵達時間窗 | 約 800ms |
| 弧線鼓起幅度 | 弦長的 6–8% |
| 縮放 | 1 → 約 0.4 |
| 自轉 | 約 500–600ms 一圈（rotateY，畫面上表現為寬度來回收縮）|
| 數字增量 | 6,6,6,4,4,2,2,1 —— 先跳大格、後跳小格 |

最後那一項是關鍵：數字不是等速跑上去的。金幣的發射延遲用 **ease-in 分佈**（前段密、後段疏），
抵達自然就由密漸疏，數字就會呈現那種「先猛跳、後收斂」的手感。等距 stagger 做不出來。

## API

```js
import { flyCoins } from './coin-fly.js';

const { finished, cancel } = flyCoins({
  from: chestEl,          // Element / DOMRect / {x, y}（視窗座標）
  to: walletIconEl,
  count: 30,
  duration: 360,          // 單顆飛行時間
  stagger: 34,            // 發射間隔
  spread: 42,             // 起點抖動半徑
  size: 24,
  signal,                 // AbortSignal，可中途取消
  onArrive: (i, n) => {}, // 每顆抵達時觸發 → 拿來推數字、讓目標彈一下
});
await finished;
```

`finished` 一定會 resolve（取消也算結束，不會 reject）。取消或正常結束都會把 DOM 節點和動畫清乾淨。

## 為什麼是 WAAPI + 取樣貝茲

每顆金幣的整段旅程是**一條三次貝茲曲線**：起點抖動 → 控制點 1 決定往哪炸開 →
控制點 2 在弦的 65% 處往法線鼓出 → 終點。曲線在 JS 取樣成一串 `transform` keyframe（每 24ms 一個，預設 360ms 就是 16 個），
交給 `element.animate()` 播放，中間由瀏覽器內插。

三個關鍵決定：

1. **只動 `transform` 和 `opacity`。** 這兩個是唯一能丟給合成執行緒的屬性。
   碰到 `top/left/width/filter` 就會掉回主執行緒每幀重算。
2. **位移＋縮放放外層，3D 翻轉放內層。** 同一個元素上兩個動畫搶同一個 `transform` 會互相覆蓋，
   分兩層才不會打架。
3. **粒子畫在掛在 `<body>` 的 `position: fixed` overlay 裡。**
   這樣座標直接等於 `getBoundingClientRect()` 的視窗座標，不必管捲動容器、
   `overflow: hidden` 或 z-index 堆疊脈絡。

代價是 keyframes 必須在動畫開始前就全部算好，所以**飛行途中目標若會移動，落點會歪**。
那種情境才需要換做法。

### 其他做法，什麼時候比較好

| 做法 | 弧線怎麼來 | 主執行緒成本 | 適合 |
| --- | --- | --- | --- |
| **WAAPI + 取樣貝茲**（本專案） | JS 算貝茲 → transform keyframes | 開場算一次，之後 0 | 起訖點要在執行期量測的 UI 反饋 |
| CSS `offset-path` | `path()` + `offset-distance` | 同上 | 路徑固定、寫死在 CSS 裡時最簡潔 |
| CSS-only + `@property` | 兩層各自 ease 疊出弧線 | 0 | 起訖點也固定，JS 只丟幾個變數 |
| rAF 手寫物理 | 每幀積分 | 每幀 N 次 DOM 寫入 | **目標會移動**、要碰撞或拖尾 |
| Canvas / WebGL | 每幀自己畫 | 每幀一次繪製 | 上百顆以上的粒子 |

實務門檻：**幾十顆用 DOM，破百顆再考慮 canvas。**
這個效果只有 20–30 顆，DOM 完全夠用，而且金幣可以直接用 CSS 漸層畫，不必準備圖檔。

## 驗證到哪裡

在 headless Chromium 實測過：

- 連點取消 6 次 → 0 個殘留節點、0 個殘留動畫、餘額正確、按鈕回到可用
- `prefers-reduced-motion` → 不放粒子，但數字照樣跑完並用 live region 播報
- 起點在捲動過的 `overflow` 容器裡 → 發射位置正確
- `count: 0`、事前 abort、飛行中 abort、缺 `from` → 都正常
- **把 renderer 主執行緒用忙迴圈鎖死 900ms，金幣照樣逐格前進** → 確認飛行真的跑在合成執行緒

沒驗證到：**Safari 與 Firefox 沒測過**（這個環境只裝得到 Chromium，其他引擎的下載被網路政策擋掉）。
用到的特性都有 fallback（`adoptedStyleSheets` 退回 `<style>`、`overflow: clip` 退回 `hidden`、
`backdrop-filter` 有加 `-webkit-` 前綴），但沒有實機證據。

## 美術

`coin-burst.html` 裡的禮物盒是手刻 SVG，只是為了讓 demo 自給自足。
真的要上線，這裡應該換成設計師給的 PNG 或 Lottie —— 動態邏輯不受影響，
`flyCoins` 只認 `from` / `to` 兩個元素在哪裡。
