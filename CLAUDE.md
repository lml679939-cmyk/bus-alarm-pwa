# 公車到站 GPS 提醒 PWA — 專案交接文件

> 供下一個 Claude 對話框快速了解專案現況，無需重新詢問使用者。

---

## 專案概述

**名稱**：公車睡過站 GPS 震動提醒 PWA  
**目標**：使用者搭公車時設定目的地，接近時自動震動 + 音效 + 通知提醒，避免睡過站  
**前端**：GitHub Pages → `https://lml679939-cmyk.github.io/bus-alarm-pwa/`  
**後端**：Vercel → `https://bus-alarm-pwa.vercel.app/api/notify`  
**Repository**：`https://github.com/lml679939-cmyk/bus-alarm-pwa`

---

## 本機路徑

```
C:\Users\user\Downloads\生成式AI人文導論\我自己想要開發的專案\bus-alarm-pwa\
```

### 常用指令

```bash
# 推上 GitHub（自動觸發 GitHub Pages 更新）
cd "C:\Users\user\Downloads\生成式AI人文導論\我自己想要開發的專案\bus-alarm-pwa"
git add .
git commit -m "說明"
git push origin main

# 本機預覽伺服器（launch.json 已設定，port 8766）
# 使用 Claude Preview 工具啟動
```

---

## 檔案結構

```
bus-alarm-pwa/
├── index.html          # 主頁面（Tailwind CSS 卡片風格 UI）
├── app.js              # 主要邏輯（GPS、搜尋、音效、Web Push）
├── sw.js               # Service Worker（快取 + Push 處理）
├── style.css           # 補充樣式（Tailwind 已處理大部分）
├── manifest.json       # PWA 設定
├── vercel.json         # Vercel Serverless 設定
├── package.json        # Node 依賴（web-push）
├── api/
│   └── notify.js       # Vercel Serverless：發送 Web Push
└── icons/
    ├── icon-192.png
    ├── icon-512.png
    └── icon.svg
```

---

## 技術架構

### 前端（純 Vanilla JS + Leaflet.js）

| 功能 | 實作方式 |
|------|---------|
| GPS 追蹤 | `navigator.geolocation.watchPosition()` |
| 距離計算 | Haversine 公式 |
| 地圖 | Leaflet.js + OpenStreetMap（cdnjs CDN） |
| 搜尋 | Nominatim API + Overpass API 雙引擎並行 |
| 到站估算 | OSRM 免費路徑 API（每 30 秒更新） |
| 音效 | Web Audio API（5 種音效，合成音） |
| 震動 | `navigator.vibrate()`（Android 支援，iOS 不支援） |
| 螢幕保持亮 | Wake Lock API |
| iOS 背景保活 | 靜音音頻 Hack（AudioContext 持續輸出極低音量） |
| GPS 看門狗 | setInterval 每 15s 檢查，45s 無訊號則重啟 |
| UI | Tailwind CSS CDN + Journal-app 風格（米色背景、黃色主色、全 SVG 圖示） |

### 後端（Vercel Serverless）

| 項目 | 說明 |
|------|------|
| 函式 | `api/notify.js`（Node.js） |
| 套件 | `web-push ^3.6.7` |
| 用途 | 接收前端 POST 請求，發送 Web Push 通知給 iOS |
| CORS | `Access-Control-Allow-Origin: *` |

### Vercel 環境變數（已設定）

| 名稱 | 說明 |
|------|------|
| `VAPID_EMAIL` | `mailto:使用者信箱`（格式必須含 mailto: 前綴） |
| `VAPID_PUBLIC_KEY` | `BEG51OWRlSPYAmzkUs7Rg5oQmUvISgK4EtHwtpxdFMdYdGIssaBOeCQGPIGzbJHxPtMFOGslABC-L-1ioUm_hVs` |
| `VAPID_PRIVATE_KEY` | （私鑰，保密） |

---

## app.js 重要常數（頂部）

```js
const VAPID_PUBLIC_KEY = 'BEG51OWRlSPYAmzkUs7Rg5oQmUvISgK4EtHwtpxdFMdYdGIssaBOeCQGPIGzbJHxPtMFOGslABC-L-1ioUm_hVs';
const PUSH_API_URL     = 'https://bus-alarm-pwa.vercel.app/api/notify';
```

---

## 核心邏輯流程

### 警報觸發（三階段）

```
GPS 更新距離
    ↓
距離 ≤ 500m → triggerScreenWake()
    │ Wake Lock + Web Push + 短震動 + Toast
    ↓
距離 ≤ 設定半徑（預設 500m）→ triggerAlert(phase=1)
    │ 震動 P1 + 音效 + 系統通知 + Web Push + 警報 UI
    ↓
距離 ≤ 200m → triggerAlert(phase=2)
    │ 震動 P2（加強）+ 音效 + 系統通知 + Web Push + 警報 UI
```

### iOS 背景保活策略

1. `startSilentAudio()` — AudioContext 持續輸出 0.0001 音量，讓 iOS 視為媒體播放
2. `startGpsWatchdog()` — 每 15s 檢查 GPS，45s 無訊號自動重啟 watchPosition
3. `onSilentAudioVisibility()` — 回到前景時 resume AudioContext（聽音樂後會 suspend）
4. Web Push — GPS 偵測到接近時呼叫 Vercel API，iOS 鎖屏也能收到通知

### OSRM 到站估算

```
watchPosition 每次回呼
    ↓ 距離上次 OSRM 呼叫 > 30s
fetchOsrmEta(currentLat, currentLng, destLat, destLng)
    ↓ OSRM 回傳道路距離（m）
ETA = 道路距離 / 公車速度（預設 20 km/h）
    ↓ OSRM 失敗時
fallback：直線距離 × 1.3 / 公車速度
```

---

## State 物件（app.js 全域狀態）

```js
const State = {
  destination,         // { lat, lng, name }
  currentLoc,          // { lat, lng, accuracy }
  radius,              // 第1段警報半徑（公尺，預設 500）
  INNER_RADIUS: 200,   // 第2段警報固定半徑
  isMonitoring,
  alertPhase,          // 0=未觸發 1=第1段 2=第2段
  watchId,             // GPS watchPosition ID
  wakeLock,
  silentAudio,         // iOS 靜音音頻節點
  silentAudioTimer,
  gpsRetryTimer,
  lastPositionTime,    // 上次 GPS 時間戳（看門狗用）
  mapSelectMode,
  audioCtx,
  vibrateLoop,
  searchDebounce,
  selectedSound,       // 'melody'|'bell'|'alarm'|'horn'|'digital'
  headphoneMode,
  headphonesConnected,
  volume,              // 0~100
  soundLoop,
  masterGain,
  pushSubscription,    // Web Push 訂閱物件
  etaMinutes,
  etaRoadDist,
  etaLastFetch,
  busSpeedKmh,         // 預設 20
  screenWakeTriggered, // 500m 喚醒是否已觸發（避免重複）
}
```

---

## Service Worker 快取版本

目前版本：`v2.5.0`

> **重要**：每次修改靜態資源（html/css/js）後，必須更新 `sw.js` 頂部的 `CACHE_VERSION` 才能讓使用者強制更新快取。

```js
const CACHE_VERSION = 'v2.5.0';  // 改這裡
```

---

## 已知限制

| 平台 | 限制 |
|------|------|
| iOS Safari | 不支援 `navigator.vibrate()`（完全無效） |
| iOS 鎖定畫面 | 需 Web Push 才能喚醒（需 iOS 16.4+ 且安裝到主畫面） |
| Android 背景 | `navigator.vibrate()` 在頁面不在前景時可能被系統封鎖 |
| OSRM API | 免費公開服務，偶爾會慢或無回應，有 fallback 機制 |

---

## UI 設計系統（v2.5.0 大改版）

參考 Journal-app 設計風格全面重構 `index.html`。

### 色彩調色盤

| 變數名 | 色碼 | 用途 |
|--------|------|------|
| `canvas` | `#EDEAE3` | 主背景米色 |
| `sunshine` | `#F5C543` | 主色黃（CTA、今日日期圈、Toggle on） |
| `forest` | `#7A9A5C` | 綠色（GPS、位置、目的地） |
| `lilac` | `#E3DBF1` | 紫色（音效、通知） |
| `blush` | `#F7D7D1` | 粉色（距離快速卡） |
| `slate` | `#2E2A26` | 主文字深棕 |
| `muted` | `#857F75` | 次要文字 |

### 版面元件

- **頂部**：「Hi, 旅客」問候 + 一週日期條（今日黃色圓圈高亮）
- **英雄卡**：黃色漸層 + 公車插畫 SVG（山丘、公車、太陽笑臉、白雲）
- **Quick Settings**：兩張小卡（粉色靶心 / 紫色音符）
- **距離大數字**：5.5rem 粗體，對應 journal-app「420」風格
- **底部導航**：5欄固定 nav（Home/Explore/+/Journey/Profile），中央黃色浮動圓鈕

### SVG 圖示系統（全部自製，無 emoji）

所有圖示均為純 SVG，不使用 emoji。音符圖示使用外部提供的 path 資料：

```
音符 viewBox="130 140 475 475"
path 完整 d 值在 index.html 中（搜尋 "441.910217" 即可定位）
原始來源：736×736 單一八分音符形狀，莖+旗+音符頭一體成形
```

鈴鐺結構（聲音按鈕 & 通知 toggle 一致）：
```
手柄 rect → 鈴身 path（左右對稱）→ 底邊 ellipse → 鈴舌 circle（小）
```

---

## 已完成功能清單

- [x] GPS 自動定位 + 目的地搜尋（Nominatim + Overpass 雙引擎）
- [x] 地圖點選設定目的地
- [x] 兩段式警報（設定半徑 → 200m 加強）
- [x] 五種音效（旋律、鈴聲、急促警報、號角、電子音）
- [x] 震動提醒（safeVibrate，iOS 靜默失敗）
- [x] 耳機模式（只有插耳機才發聲）
- [x] Wake Lock 螢幕保持常亮
- [x] iOS 靜音音頻背景保活
- [x] GPS 看門狗自動重啟
- [x] 500m 預備螢幕喚醒
- [x] OSRM 到站時間估算（含公車速度調整）
- [x] Web Push 通知（Vercel 後端，iOS 16.4+ 支援）
- [x] PWA（manifest + Service Worker + 可安裝）
- [x] 震動測試按鈕（含診斷訊息）
- [x] 頁面可正常滑動（修復 touch-action + overflow 衝突）
- [x] **UI 全面改版**：Journal-app 風格，一週日期條、英雄插畫卡、底部 5 欄 nav、全 SVG 圖示（v2.5.0）

---

## 使用者互動偏好

- 喜歡清楚說明「為什麼」再做決定，不希望直接被推銷方案
- 遇到問題先問清楚再動手
- 習慣透過截圖展示問題
- 在 Windows 環境開發，用終端機執行 git 指令
- GitHub 帳號：`lml679939-cmyk`

---

## 待辦 / 可能的下一步

- [ ] iOS 測試：確認 Web Push 通知在鎖屏下是否正確跳出
- [ ] 考慮升級 TDX API（台灣公車即時資料）提升 ETA 準確度
- [ ] 考慮上架 App Store / Play 商店（需包成 React Native 或 Capacitor）
