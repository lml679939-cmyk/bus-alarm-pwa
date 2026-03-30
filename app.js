/**
 * 公車到站 GPS 震動提醒 — 主程式 app.js
 * 技術：Vanilla JS + Leaflet.js + Web APIs
 *
 * 功能：
 *  - 地圖顯示（Leaflet + OpenStreetMap）
 *  - GPS 監聽（watchPosition + 錯誤處理）
 *  - 兩段式距離警報（第1段：設定半徑；第2段：200m 加強）
 *  - 震動 / 通知 / 音效
 *  - Wake Lock API（避免螢幕自動熄滅）
 *  - localStorage 持久化設定
 */

'use strict';

/* ============================================================
   全域狀態
   ============================================================ */
const State = {
  homeLocation:  null,    // { lat, lng } 家門口座標
  currentLoc:    null,    // { lat, lng, accuracy } 目前位置
  radius:        500,     // 第1段提醒半徑（公尺）
  INNER_RADIUS:  200,     // 第2段加強半徑（固定）
  isMonitoring:  false,   // 是否啟動監聽
  alertPhase:    0,       // 0=未觸發 1=已第1段 2=已第2段
  watchId:       null,    // geolocation.watchPosition ID
  wakeLock:      null,    // Screen Wake Lock 物件
  mapSelectMode: false,   // 地圖選點模式
  audioCtx:      null,    // Web Audio Context（延遲初始化）
  vibrateLoop:   null,    // setInterval for repeated vibration
};

/* ---- 震動 Pattern ---- */
const VIBRATE_PHASE1 = [800, 200, 800, 200, 500, 200, 500, 200, 300, 200, 300];
const VIBRATE_PHASE2 = [1500, 150, 1500, 150, 1500, 150, 800, 150, 800, 150, 500, 150, 500];

/* ---- 地圖物件 ---- */
let map           = null;
let homeMarker    = null;
let currentMarker = null;
let radiusCircle  = null;
let innerCircle   = null;  // 200m 加強圓圈

/* ---- 家 / 目前位置的自訂 Leaflet Icon ---- */
const HOME_ICON = L.divIcon({
  html: '<div style="font-size:28px;line-height:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,.4))">🏠</div>',
  iconSize:   [36, 36],
  iconAnchor: [18, 32],
  popupAnchor:[0, -32],
  className:  '',
});

const MY_ICON = L.divIcon({
  html: '<div style="font-size:24px;line-height:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,.4))">📍</div>',
  iconSize:   [30, 30],
  iconAnchor: [15, 28],
  popupAnchor:[0, -28],
  className:  '',
});

/* ============================================================
   初始化
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  initMap();
  updateAllUI();
  registerServiceWorker();
  updateRadiusSliderGradient();
});

/* ============================================================
   地圖初始化
   ============================================================ */
function initMap() {
  // 預設中心：台北車站
  const defaultCenter = State.homeLocation
    ? [State.homeLocation.lat, State.homeLocation.lng]
    : [25.0478, 121.5170];

  map = L.map('map', {
    center:          defaultCenter,
    zoom:            15,
    zoomControl:     true,
    attributionControl: true,
  });

  // OpenStreetMap 圖磚
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  // 若已有家的位置，繪製標記與圓圈
  if (State.homeLocation) {
    drawHomeMarker(State.homeLocation.lat, State.homeLocation.lng);
  }

  // 地圖點擊事件（地圖選點模式）
  map.on('click', onMapClick);
}

/* 地圖點擊：選取家門口位置 */
function onMapClick(e) {
  if (!State.mapSelectMode) return;
  setHome(e.latlng.lat, e.latlng.lng, '地圖選點');
  cancelMapSelect();
}

/* ============================================================
   繪製地圖圖層
   ============================================================ */
function drawHomeMarker(lat, lng) {
  // 移除舊標記
  if (homeMarker) map.removeLayer(homeMarker);
  if (radiusCircle) map.removeLayer(radiusCircle);
  if (innerCircle)  map.removeLayer(innerCircle);

  homeMarker = L.marker([lat, lng], { icon: HOME_ICON })
    .addTo(map)
    .bindPopup('🏠 家門口');

  // 第1段提醒半徑圓圈（藍色）
  radiusCircle = L.circle([lat, lng], {
    radius:      State.radius,
    color:       '#1565c0',
    fillColor:   '#1565c0',
    fillOpacity: 0.08,
    weight:      2,
    dashArray:   '6,4',
  }).addTo(map);

  // 第2段加強半徑圓圈（橘色）
  innerCircle = L.circle([lat, lng], {
    radius:      State.INNER_RADIUS,
    color:       '#e65100',
    fillColor:   '#e65100',
    fillOpacity: 0.10,
    weight:      2,
    dashArray:   '4,3',
  }).addTo(map);
}

function drawCurrentMarker(lat, lng) {
  if (currentMarker) {
    currentMarker.setLatLng([lat, lng]);
  } else {
    currentMarker = L.marker([lat, lng], { icon: MY_ICON })
      .addTo(map)
      .bindPopup('📍 我的位置');
  }
}

function updateRadiusCircle() {
  if (!radiusCircle || !State.homeLocation) return;
  radiusCircle.setRadius(State.radius);
}

/* ============================================================
   地圖選點模式
   ============================================================ */
function toggleMapSelect() {
  if (State.mapSelectMode) {
    cancelMapSelect();
  } else {
    State.mapSelectMode = true;
    document.getElementById('mapHintBar').style.display = 'flex';
    document.getElementById('map').style.cursor = 'crosshair';
    document.getElementById('btnSetHomeMap').textContent = '✖ 取消選點';
    showToast('請點擊地圖選擇家門口位置');
  }
}

function cancelMapSelect() {
  State.mapSelectMode = false;
  document.getElementById('mapHintBar').style.display = 'none';
  document.getElementById('map').style.cursor = '';
  document.getElementById('btnSetHomeMap').textContent = '🗺️ 在地圖上選取';
}

/* ============================================================
   設定家門口位置
   ============================================================ */

/** 用目前 GPS 位置設定家門口 */
function setHomeFromGPS() {
  const btn = document.getElementById('btnSetHomeGPS');
  btn.disabled = true;
  btn.textContent = '📡 取得中...';
  showToast('正在取得目前位置…');

  if (!navigator.geolocation) {
    showToast('❌ 您的瀏覽器不支援 GPS');
    btn.disabled = false;
    btn.textContent = '📡 用目前位置設定';
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setHome(pos.coords.latitude, pos.coords.longitude, '目前位置');
      btn.disabled = false;
      btn.textContent = '📡 用目前位置設定';
    },
    (err) => {
      btn.disabled = false;
      btn.textContent = '📡 用目前位置設定';
      handleGeoError(err, '取得目前位置失敗');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

/** 設定家門口（統一入口） */
function setHome(lat, lng, method) {
  State.homeLocation = { lat, lng };
  saveSettings();
  drawHomeMarker(lat, lng);
  map.setView([lat, lng], 16, { animate: true });
  updateHomeCoordsUI();
  showToast(`✅ 家門口已設定（${method}）`);
}

/* ============================================================
   半徑設定
   ============================================================ */
function onRadiusChange(val) {
  State.radius = parseInt(val, 10);
  document.getElementById('radiusValue').textContent = State.radius;
  updateRadiusCircle();
  updatePresetButtons();
  updateRadiusSliderGradient();
  saveSettings();
}

function setRadius(r) {
  State.radius = r;
  document.getElementById('radiusSlider').value = r;
  document.getElementById('radiusValue').textContent = r;
  updateRadiusCircle();
  updatePresetButtons();
  updateRadiusSliderGradient();
  saveSettings();
}

function updatePresetButtons() {
  document.querySelectorAll('.preset-btn').forEach(btn => {
    const r = parseInt(btn.dataset.r, 10);
    btn.classList.toggle('active', r === State.radius);
  });
}

/** 更新滑桿的進度漸層（讓已選部分顯示顏色） */
function updateRadiusSliderGradient() {
  const slider = document.getElementById('radiusSlider');
  const min = parseInt(slider.min, 10);
  const max = parseInt(slider.max, 10);
  const val = parseInt(slider.value, 10);
  const pct = ((val - min) / (max - min)) * 100;
  slider.style.background =
    `linear-gradient(to right, #1565c0 ${pct}%, var(--border) ${pct}%)`;
}

/* ============================================================
   GPS 監聽
   ============================================================ */
function startMonitoring() {
  if (!State.homeLocation) {
    showToast('❌ 請先設定家門口位置！');
    return;
  }

  if (!navigator.geolocation) {
    showToast('❌ 您的瀏覽器不支援 GPS');
    return;
  }

  State.isMonitoring = true;
  State.alertPhase   = 0;

  // 啟動 watchPosition（高精度，最多 30 秒 timeout）
  State.watchId = navigator.geolocation.watchPosition(
    onPositionUpdate,
    onPositionError,
    {
      enableHighAccuracy: true,
      timeout:            30000,
      maximumAge:         10000, // 允許最多 10 秒的快取位置
    }
  );

  requestWakeLock();
  updateAllUI();
  showToast('🚀 已啟動回家模式，祝好眠！');
}

function stopMonitoring() {
  if (State.watchId !== null) {
    navigator.geolocation.clearWatch(State.watchId);
    State.watchId = null;
  }

  State.isMonitoring = false;
  State.alertPhase   = 0;

  releaseWakeLock();
  stopVibrateLoop();
  hideAlertOverlay();
  updateAllUI();
  showToast('⏹ 已停止監聽');
}

/** watchPosition 成功回呼 */
function onPositionUpdate(pos) {
  const lat = pos.coords.latitude;
  const lng = pos.coords.longitude;
  const acc = pos.coords.accuracy;

  State.currentLoc = { lat, lng, accuracy: acc };

  // 更新地圖上的目前位置標記
  drawCurrentMarker(lat, lng);

  // 計算距離
  const dist = haversineDistance(lat, lng,
    State.homeLocation.lat, State.homeLocation.lng);

  updateDistanceUI(dist, acc);
  checkAlert(dist);
}

/** watchPosition 錯誤回呼 */
function onPositionError(err) {
  handleGeoError(err, 'GPS 監聽');
}

/* ============================================================
   距離計算（Haversine 公式）
   ============================================================ */
/**
 * 計算兩點間距離（公尺）
 * @param {number} lat1 緯度1
 * @param {number} lon1 經度1
 * @param {number} lat2 緯度2
 * @param {number} lon2 經度2
 * @returns {number} 距離（公尺）
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // 地球半徑（公尺）
  const toRad = deg => deg * Math.PI / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2))
    * Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ============================================================
   警報觸發邏輯（兩段式）
   ============================================================ */
function checkAlert(distMeters) {
  if (!State.isMonitoring) return;

  // 第2段：200m 加強警報（前提：已觸發第1段）
  if (State.alertPhase === 1 && distMeters <= State.INNER_RADIUS) {
    triggerAlert(2, distMeters);
    return;
  }

  // 第1段：設定半徑警報（前提：尚未觸發）
  if (State.alertPhase === 0 && distMeters <= State.radius) {
    triggerAlert(1, distMeters);
  }
}

/**
 * 觸發警報
 * @param {1|2} phase 第幾段
 * @param {number} dist 目前距離（公尺）
 */
function triggerAlert(phase, dist) {
  State.alertPhase = phase;

  const distText = Math.round(dist);
  const isUrgent = phase === 2;

  // 1. 震動
  if (document.getElementById('chkVibrate').checked && 'vibrate' in navigator) {
    const pattern = isUrgent ? VIBRATE_PHASE2 : VIBRATE_PHASE1;
    navigator.vibrate(pattern);
    // 持續重複震動（每 4 秒）
    startVibrateLoop(pattern);
  }

  // 2. 聲音
  if (document.getElementById('chkSound').checked) {
    playAlertSound(phase);
  }

  // 3. 系統通知
  if (document.getElementById('chkNotification').checked) {
    sendNotification(phase, distText);
  }

  // 4. 顯示 Overlay
  showAlertOverlay(phase, distText);

  // 5. 更新 UI 狀態
  updateStatusBadge('triggered');
  updateDistanceCardStatus('triggered');
}

/* ---- 持續震動迴圈 ---- */
function startVibrateLoop(pattern) {
  stopVibrateLoop();
  const totalMs = pattern.reduce((a, b) => a + b, 0) + 1000;
  State.vibrateLoop = setInterval(() => {
    if ('vibrate' in navigator) navigator.vibrate(pattern);
  }, totalMs);
}

function stopVibrateLoop() {
  if (State.vibrateLoop) {
    clearInterval(State.vibrateLoop);
    State.vibrateLoop = null;
  }
  if ('vibrate' in navigator) navigator.vibrate(0); // 立即停止震動
}

/* ============================================================
   音效（Web Audio API）
   ============================================================ */
/**
 * 播放警報音效
 * @param {1|2} phase 第幾段（phase 2 為加強版）
 */
function playAlertSound(phase) {
  try {
    // AudioContext 必須在使用者互動後初始化（或在第一次播放時）
    if (!State.audioCtx) {
      State.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    const ctx = State.audioCtx;

    /**
     * 播放單個 Beep
     * @param {number} startTime ctx.currentTime 的偏移秒數
     * @param {number} duration  持續秒數
     * @param {number} freq      Hz
     * @param {number} vol       0~1
     */
    const beep = (startTime, duration, freq, vol = 0.6) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(vol, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
      osc.start(startTime);
      osc.stop(startTime + duration + 0.05);
    };

    const now = ctx.currentTime;

    if (phase === 1) {
      // 三聲上升提示音
      beep(now + 0.0, 0.25, 880);
      beep(now + 0.35, 0.25, 1100);
      beep(now + 0.70, 0.40, 1320, 0.8);
    } else {
      // 緊急警報：快速 5 聲高頻
      for (let i = 0; i < 5; i++) {
        beep(now + i * 0.45, 0.35, 1500, 0.9);
      }
    }
  } catch (e) {
    console.warn('playAlertSound 失敗：', e);
  }
}

/* ============================================================
   系統通知（Notification API）
   ============================================================ */
function sendNotification(phase, distMeters) {
  if (Notification.permission !== 'granted') return;

  const isUrgent = phase === 2;
  const title = isUrgent ? '🚨 快要到站了！趕快醒來！' : '🏠 快到家了！準備下車！';
  const body  = `距離家門口僅剩約 ${distMeters} 公尺，請準備下車！`;

  try {
    const notif = new Notification(title, {
      body,
      icon:    'icons/icon-192.png',
      badge:   'icons/icon-192.png',
      vibrate: isUrgent ? VIBRATE_PHASE2 : VIBRATE_PHASE1,
      tag:     'bus-alarm',         // 同 tag 會覆蓋舊通知，避免洗版
      renotify: true,
      requireInteraction: true,     // 通知不會自動消失（Android）
    });

    // 點擊通知時切換回 App
    notif.onclick = () => {
      window.focus();
      notif.close();
    };
  } catch (e) {
    console.warn('Notification 發送失敗：', e);
  }
}

/** 請求通知權限 */
async function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    // 延遲請求，避免頁面一載入就彈出
    setTimeout(async () => {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        showToast('✅ 通知權限已開啟');
      }
    }, 2000);
  }
}

function onNotificationToggle() {
  const chk = document.getElementById('chkNotification');
  if (chk.checked && Notification.permission !== 'granted') {
    Notification.requestPermission().then(p => {
      if (p !== 'granted') {
        chk.checked = false;
        showToast('❌ 通知權限被拒絕，請在瀏覽器設定中開啟');
      } else {
        showToast('✅ 通知已開啟');
      }
    });
  }
  saveSettings();
}

/* ============================================================
   Wake Lock API
   ============================================================ */
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    // 不支援時顯示手動提示
    document.getElementById('wakeLockWarning').style.display = 'block';
    return;
  }
  try {
    State.wakeLock = await navigator.wakeLock.request('screen');
    console.log('✅ Wake Lock 已啟用');

    // 頁面重新可見時重新取得 Wake Lock（切 App 再切回來）
    document.addEventListener('visibilitychange', onVisibilityChange);

    // Wake Lock 被釋放時更新提示
    State.wakeLock.addEventListener('release', () => {
      console.log('Wake Lock 已釋放');
      document.getElementById('wakeLockWarning').style.display = 'block';
    });

    document.getElementById('wakeLockWarning').style.display = 'none';
  } catch (err) {
    console.warn('Wake Lock 失敗：', err);
    document.getElementById('wakeLockWarning').style.display = 'block';
  }
}

function releaseWakeLock() {
  if (State.wakeLock) {
    State.wakeLock.release();
    State.wakeLock = null;
  }
  document.removeEventListener('visibilitychange', onVisibilityChange);
  document.getElementById('wakeLockWarning').style.display = 'none';
}

async function onVisibilityChange() {
  if (document.visibilityState === 'visible' && State.isMonitoring) {
    // 回到前景後嘗試重新取得 Wake Lock
    await requestWakeLock();
  }
}

/* ============================================================
   Alert Overlay UI
   ============================================================ */
function showAlertOverlay(phase, distMeters) {
  const isUrgent = phase === 2;
  document.getElementById('alertIcon').textContent    = isUrgent ? '🚨' : '🏠';
  document.getElementById('alertTitle').textContent   = isUrgent ? '快要到站！趕快醒來！' : '快到家了！';
  document.getElementById('alertMessage').textContent =
    `距離家門口僅剩約 ${distMeters} 公尺，請準備下車！`;

  // 第2段警報不再顯示「繼續監聽」（已是最後一段）
  const btnContinue = document.getElementById('btnContinue');
  btnContinue.style.display = isUrgent ? 'none' : 'block';

  document.getElementById('alertOverlay').style.display = 'flex';
}

function hideAlertOverlay() {
  document.getElementById('alertOverlay').style.display = 'none';
}

/** 使用者按「我已醒來，停止提醒」 */
function dismissAlert() {
  stopVibrateLoop();
  hideAlertOverlay();
  stopMonitoring();
  showToast('✅ 提醒已停止，平安到家！');
}

/** 使用者按「繼續監聽」（等待 200m 加強） */
function continueMonitoring() {
  stopVibrateLoop();
  hideAlertOverlay();
  // alertPhase 已設為 1，下次進入 checkAlert 會等待 200m
  showToast('🔄 繼續監聽中，200m 時加強提醒');
  updateStatusBadge('nearby');
  updateDistanceCardStatus('nearby');
}

/* ============================================================
   錯誤處理
   ============================================================ */
function handleGeoError(err, context) {
  let msg = '';
  switch (err.code) {
    case err.PERMISSION_DENIED:
      msg = '❌ GPS 權限被拒絕，請至瀏覽器設定開啟位置權限';
      if (State.isMonitoring) stopMonitoring();
      break;
    case err.POSITION_UNAVAILABLE:
      msg = '⚠️ GPS 訊號不穩定，請移至開放空間';
      break;
    case err.TIMEOUT:
      msg = '⏱️ 取得位置逾時，自動重試中…';
      break;
    default:
      msg = `❌ GPS 錯誤（${context}）：${err.message}`;
  }
  showToast(msg, 4000);
  console.warn(`[${context}] GPS Error ${err.code}: ${err.message}`);
}

/* ============================================================
   Service Worker 註冊
   ============================================================ */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.register('sw.js')
    .then(reg => console.log('✅ Service Worker 已註冊：', reg.scope))
    .catch(err => console.warn('Service Worker 註冊失敗：', err));
}

/* ============================================================
   localStorage 設定讀寫
   ============================================================ */
const STORAGE_KEY = 'bus-alarm-settings';

function saveSettings() {
  const data = {
    homeLocation: State.homeLocation,
    radius:       State.radius,
    chkVibrate:   document.getElementById('chkVibrate').checked,
    chkSound:     document.getElementById('chkSound').checked,
    chkNotification: document.getElementById('chkNotification').checked,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);

    if (data.homeLocation) State.homeLocation = data.homeLocation;
    if (data.radius)       State.radius = data.radius;

    // 還原 checkbox 狀態（延遲等 DOM 就緒）
    requestAnimationFrame(() => {
      if (data.chkVibrate   !== undefined)
        document.getElementById('chkVibrate').checked       = data.chkVibrate;
      if (data.chkSound     !== undefined)
        document.getElementById('chkSound').checked         = data.chkSound;
      if (data.chkNotification !== undefined)
        document.getElementById('chkNotification').checked  = data.chkNotification;
    });
  } catch (e) {
    console.warn('讀取設定失敗：', e);
  }
}

/* ============================================================
   UI 更新函式
   ============================================================ */

/** 一次更新所有 UI 元件 */
function updateAllUI() {
  updateHomeCoordsUI();
  updateRadiusUI();
  updateMonitoringButtons();
  updateStatusBadge(State.isMonitoring ? 'monitoring' : 'idle');
}

/** 更新家門口座標顯示 */
function updateHomeCoordsUI() {
  const el = document.getElementById('homeCoords');
  if (State.homeLocation) {
    const { lat, lng } = State.homeLocation;
    el.textContent = `緯度 ${lat.toFixed(6)}，經度 ${lng.toFixed(6)}`;
  } else {
    el.textContent = '尚未設定家門口位置';
  }
}

/** 更新半徑滑桿與顯示 */
function updateRadiusUI() {
  document.getElementById('radiusSlider').value   = State.radius;
  document.getElementById('radiusValue').textContent = State.radius;
  updatePresetButtons();
  updateRadiusSliderGradient();
}

/** 更新啟動 / 停止按鈕顯示 */
function updateMonitoringButtons() {
  const btnStart = document.getElementById('btnStart');
  const btnStop  = document.getElementById('btnStop');
  const mapEl    = document.getElementById('map');

  if (State.isMonitoring) {
    btnStart.style.display = 'none';
    btnStop.style.display  = 'block';
    mapEl.classList.add('monitoring');
  } else {
    btnStart.style.display = 'block';
    btnStop.style.display  = 'none';
    mapEl.classList.remove('monitoring');
  }
}

/** 更新頂部狀態徽章 */
function updateStatusBadge(status) {
  const badge = document.getElementById('statusBadge');
  const labels = {
    idle:       '待機中',
    monitoring: '監聽中 ●',
    nearby:     '已接近 ⚡',
    triggered:  '已觸發 🔔',
  };
  badge.dataset.status = status;
  badge.textContent    = labels[status] || '待機中';
}

/** 更新距離數字顯示 */
function updateDistanceUI(dist, accuracy) {
  const valEl   = document.getElementById('distanceValue');
  const labelEl = document.getElementById('distanceLabel');
  const accEl   = document.getElementById('accuracyLabel');

  const distRound = Math.round(dist);
  valEl.textContent = distRound;

  // 判斷接近狀態
  if (dist <= State.INNER_RADIUS) {
    labelEl.textContent = '⚡ 已非常接近！';
    updateDistanceCardStatus('triggered');
    updateStatusBadge('triggered');
  } else if (dist <= State.radius) {
    labelEl.textContent = '⚠️ 即將到站！';
    updateDistanceCardStatus('nearby');
    updateStatusBadge('nearby');
  } else {
    labelEl.textContent = `距家門口（半徑 ${State.radius}m）`;
    updateDistanceCardStatus('monitoring');
    updateStatusBadge('monitoring');
  }

  accEl.textContent = accuracy ? `GPS 精度 ±${Math.round(accuracy)} 公尺` : '';
}

function updateDistanceCardStatus(status) {
  document.getElementById('distanceCard').dataset.status = status;
}

/* ============================================================
   Toast 訊息
   ============================================================ */
let toastTimer = null;

/**
 * 顯示底部 Toast 訊息
 * @param {string} msg     訊息內容
 * @param {number} duration 顯示毫秒數（預設 2500）
 */
function showToast(msg, duration = 2500) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}
