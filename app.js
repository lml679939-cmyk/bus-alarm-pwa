/**
 * 公車到站 GPS 提醒 — app.js（v2）
 *
 * 新流程：
 *  1. 頁面載入 → 自動 GPS 定位目前位置，顯示在地圖上
 *  2. 使用者搜尋目的地（地址/公車站）或在地圖上點選
 *  3. 啟動監聽 → watchPosition 持續追蹤，計算與目的地距離
 *  4. 接近時震動 + 音效 + 通知（兩段式：設定半徑 → 200m 加強）
 */

'use strict';

/* ============================================================
   全域狀態
   ============================================================ */
const State = {
  destination:         null,      // { lat, lng, name } 目的地
  currentLoc:          null,      // { lat, lng, accuracy } 目前 GPS 位置
  radius:              500,       // 第1段提醒半徑（公尺）
  INNER_RADIUS:        200,       // 第2段加強半徑（固定）
  isMonitoring:        false,
  alertPhase:          0,         // 0=未觸發 1=第1段 2=第2段
  watchId:             null,
  wakeLock:            null,
  mapSelectMode:       false,
  audioCtx:            null,
  vibrateLoop:         null,
  searchDebounce:      null,      // 搜尋防抖 timer
  selectedSound:       'melody',  // 選取的音效 key
  headphoneMode:       false,     // 耳機模式開關
  headphonesConnected: false,     // 目前是否偵測到耳機
};

/* ---- 震動 Pattern ---- */
const VIBRATE_P1 = [800, 200, 800, 200, 500, 200, 500, 200, 300, 200, 300];
const VIBRATE_P2 = [1500,150,1500,150,1500,150,800,150,800,150,500,150,500];

/* ---- 地圖物件 ---- */
let map           = null;
let destMarker    = null;   // 目的地標記
let currentMarker = null;   // 目前位置標記
let radiusCircle  = null;   // 第1段半徑圓
let innerCircle   = null;   // 第2段 200m 圓

/* ---- 自訂 Icon ---- */
const DEST_ICON = L.divIcon({
  html: '<div style="font-size:30px;line-height:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5))">🎯</div>',
  iconSize: [36, 36], iconAnchor: [18, 30], popupAnchor: [0, -30], className: '',
});
const MY_ICON = L.divIcon({
  html: '<div style="font-size:26px;line-height:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5))">📍</div>',
  iconSize: [30, 30], iconAnchor: [15, 26], popupAnchor: [0, -26], className: '',
});

/* ============================================================
   初始化
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  initMap();
  autoLocate();          // 頁面載入時立即取得目前位置
  updateAllUI();
  registerServiceWorker();
  requestNotificationPermission();
});

/* ============================================================
   地圖初始化
   ============================================================ */
function initMap() {
  map = L.map('map', {
    center: [25.0478, 121.5170], // 台北車站（未取得 GPS 前的預設中心）
    zoom: 14,
    zoomControl: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  // 若已有儲存的目的地，重繪
  if (State.destination) {
    drawDestMarker(State.destination.lat, State.destination.lng, State.destination.name);
  }

  // 地圖點擊事件（選點模式才生效）
  map.on('click', onMapClick);
}

function onMapClick(e) {
  if (!State.mapSelectMode) return;
  const { lat, lng } = e.latlng;
  // 用 Nominatim 反查地址
  reverseGeocode(lat, lng).then(name => {
    setDestination(lat, lng, name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
  });
  cancelMapSelect();
}

/* ============================================================
   自動取得目前位置（頁面載入時）
   ============================================================ */
function autoLocate() {
  if (!navigator.geolocation) {
    updateCurrentLocUI(null, '您的瀏覽器不支援 GPS');
    return;
  }
  updateCurrentLocUI(null, '🔍 定位中…');
  navigator.geolocation.getCurrentPosition(
    (pos) => onInitialPosition(pos),
    (err) => {
      handleGeoError(err, '自動定位');
      updateCurrentLocUI(null, '❌ 無法取得位置，請確認位置權限');
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
  );
}

/** 初次取得位置 → 置中地圖，顯示標記 */
function onInitialPosition(pos) {
  const { latitude: lat, longitude: lng, accuracy: acc } = pos.coords;
  State.currentLoc = { lat, lng, accuracy: acc };
  drawCurrentMarker(lat, lng);
  map.setView([lat, lng], 15, { animate: true });
  updateCurrentLocUI({ lat, lng }, null, acc);
}

/** 手動重新定位按鈕 */
function relocate() {
  updateCurrentLocUI(null, '🔍 重新定位中…');
  navigator.geolocation.getCurrentPosition(
    (pos) => onInitialPosition(pos),
    (err) => handleGeoError(err, '重新定位'),
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
  );
}

/* ============================================================
   目的地搜尋（Nominatim OpenStreetMap 免費 API）
   ============================================================ */

/** 搜尋框 input 事件：防抖 600ms */
function onSearchInput(val) {
  clearTimeout(State.searchDebounce);
  if (val.trim().length < 2) {
    clearSearchResults();
    return;
  }
  State.searchDebounce = setTimeout(() => searchPlace(), 600);
}

/** 執行搜尋 */
async function searchPlace() {
  const input = document.getElementById('searchInput');
  const query = input.value.trim();
  if (!query) { showToast('請輸入地址或公車站名稱'); return; }

  const btn = document.getElementById('searchBtn');
  btn.textContent = '⏳';
  btn.disabled = true;

  try {
    // Nominatim geocoding API（免費，不需要 API key）
    // viewbox 加上台灣範圍讓結果優先在台灣
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('format', 'json');
    url.searchParams.set('q', query);
    url.searchParams.set('limit', '6');
    url.searchParams.set('accept-language', 'zh-TW,zh,en');
    // 若目前有 GPS 位置，用它作為搜尋中心（提升本地結果）
    if (State.currentLoc) {
      url.searchParams.set('lat', State.currentLoc.lat);
      url.searchParams.set('lon', State.currentLoc.lng);
    }

    const res = await fetch(url.toString(), {
      headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const results = await res.json();
    renderSearchResults(results);
  } catch (err) {
    showToast('❌ 搜尋失敗，請確認網路連線');
    console.error('搜尋錯誤：', err);
  } finally {
    btn.textContent = '🔍';
    btn.disabled = false;
  }
}

/** 渲染搜尋結果列表 */
function renderSearchResults(results) {
  const container = document.getElementById('searchResults');
  container.innerHTML = '';

  if (!results || results.length === 0) {
    container.innerHTML = '<div class="search-empty">找不到結果，請嘗試其他關鍵字</div>';
    return;
  }

  results.forEach(item => {
    const lat  = parseFloat(item.lat);
    const lng  = parseFloat(item.lon);
    // 顯示名稱：優先用 display_name，截短至 50 字
    const name = item.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    const shortName = name.length > 50 ? name.substring(0, 50) + '…' : name;

    // 判斷類型 icon
    const typeIcon = getTypeIcon(item.type, item.class);

    const btn = document.createElement('button');
    btn.className = 'result-item';
    btn.innerHTML = `
      <span class="result-icon">${typeIcon}</span>
      <div class="result-text">
        <div class="result-name">${shortName}</div>
        <div class="result-meta">${item.type || ''} · ${item.class || ''}</div>
      </div>
    `;
    btn.onclick = () => {
      setDestination(lat, lng, name);
      clearSearchResults();
      document.getElementById('searchInput').value = '';
    };
    container.appendChild(btn);
  });
}

/** 根據 Nominatim 類型回傳對應 emoji */
function getTypeIcon(type, cls) {
  if (cls === 'highway' || type === 'bus_stop') return '🚌';
  if (cls === 'railway' || type === 'station')  return '🚉';
  if (cls === 'amenity'  || type === 'school')  return '🏫';
  if (cls === 'shop')                           return '🏪';
  if (type === 'hospital')                      return '🏥';
  if (cls === 'building')                       return '🏢';
  return '📌';
}

function clearSearchResults() {
  document.getElementById('searchResults').innerHTML = '';
}

/* ============================================================
   Nominatim 反向地理編碼（地圖點選 → 取得地址名稱）
   ============================================================ */
async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=zh-TW,zh,en`;
    const res  = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const data = await res.json();
    return data.display_name || null;
  } catch (_) {
    return null;
  }
}

/* ============================================================
   設定目的地
   ============================================================ */
function setDestination(lat, lng, name) {
  State.destination = { lat, lng, name };
  saveSettings();
  drawDestMarker(lat, lng, name);
  map.setView([lat, lng], 15, { animate: true });
  updateDestUI();
  showToast(`✅ 目的地已設定：${name.substring(0, 30)}…`);
}

function clearDestination() {
  State.destination = null;
  saveSettings();
  if (destMarker)   { map.removeLayer(destMarker);   destMarker   = null; }
  if (radiusCircle) { map.removeLayer(radiusCircle); radiusCircle = null; }
  if (innerCircle)  { map.removeLayer(innerCircle);  innerCircle  = null; }
  updateDestUI();
  showToast('🗑️ 目的地已清除');
}

/* ============================================================
   地圖選點模式
   ============================================================ */
function toggleMapSelect() {
  if (State.mapSelectMode) { cancelMapSelect(); return; }
  State.mapSelectMode = true;
  document.getElementById('mapHintBar').style.display = 'flex';
  document.getElementById('map').style.cursor = 'crosshair';
  document.getElementById('btnMapSelect').textContent = '✖ 取消地圖選點';
  showToast('請點擊地圖上的目的地位置');
}

function cancelMapSelect() {
  State.mapSelectMode = false;
  document.getElementById('mapHintBar').style.display = 'none';
  document.getElementById('map').style.cursor = '';
  document.getElementById('btnMapSelect').textContent = '🗺️ 或在地圖上直接點選目的地';
}

/* ============================================================
   地圖繪製
   ============================================================ */
function drawDestMarker(lat, lng, name) {
  if (destMarker)   map.removeLayer(destMarker);
  if (radiusCircle) map.removeLayer(radiusCircle);
  if (innerCircle)  map.removeLayer(innerCircle);

  destMarker = L.marker([lat, lng], { icon: DEST_ICON })
    .addTo(map)
    .bindPopup(`🎯 ${name || '目的地'}`);

  // 第1段半徑圓（藍色虛線）
  radiusCircle = L.circle([lat, lng], {
    radius: State.radius, color: '#1565c0', fillColor: '#1565c0',
    fillOpacity: 0.08, weight: 2, dashArray: '6,4',
  }).addTo(map);

  // 第2段 200m 加強圓（橘色虛線）
  innerCircle = L.circle([lat, lng], {
    radius: State.INNER_RADIUS, color: '#e65100', fillColor: '#e65100',
    fillOpacity: 0.10, weight: 2, dashArray: '4,3',
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
  if (radiusCircle) radiusCircle.setRadius(State.radius);
}

/* ============================================================
   GPS 監聽（啟動 / 停止）
   ============================================================ */
function startMonitoring() {
  if (!State.destination) {
    showToast('❌ 請先設定目的地！');
    return;
  }
  if (!navigator.geolocation) {
    showToast('❌ 瀏覽器不支援 GPS');
    return;
  }

  State.isMonitoring = true;
  State.alertPhase   = 0;

  State.watchId = navigator.geolocation.watchPosition(
    onPositionUpdate,
    onPositionError,
    { enableHighAccuracy: true, timeout: 30000, maximumAge: 10000 }
  );

  requestWakeLock();
  updateAllUI();
  showToast('🚀 已啟動！接近目的地時會提醒你');
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

  // 重置距離卡片
  document.getElementById('distanceValue').textContent = '--';
  document.getElementById('distanceLabel').textContent = '距目的地';
  document.getElementById('distanceCard').dataset.status = 'idle';
  showToast('⏹ 已停止監聽');
}

/** watchPosition 成功回呼 */
function onPositionUpdate(pos) {
  const { latitude: lat, longitude: lng, accuracy: acc } = pos.coords;
  State.currentLoc = { lat, lng, accuracy: acc };

  drawCurrentMarker(lat, lng);
  updateCurrentLocUI({ lat, lng }, null, acc);

  const dist = haversineDistance(lat, lng, State.destination.lat, State.destination.lng);
  updateDistanceUI(dist, acc);
  checkAlert(dist);
}

function onPositionError(err) {
  handleGeoError(err, 'GPS 監聽');
}

/* ============================================================
   Haversine 距離計算
   ============================================================ */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R    = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/* ============================================================
   兩段式警報
   ============================================================ */
function checkAlert(dist) {
  if (!State.isMonitoring) return;
  if (State.alertPhase === 1 && dist <= State.INNER_RADIUS) {
    triggerAlert(2, dist); return;
  }
  if (State.alertPhase === 0 && dist <= State.radius) {
    triggerAlert(1, dist);
  }
}

function triggerAlert(phase, dist) {
  State.alertPhase = phase;
  const distText = Math.round(dist);
  const isUrgent = phase === 2;

  if (document.getElementById('chkVibrate').checked && 'vibrate' in navigator) {
    const pattern = isUrgent ? VIBRATE_P2 : VIBRATE_P1;
    navigator.vibrate(pattern);
    startVibrateLoop(pattern);
  }
  if (document.getElementById('chkSound').checked) playAlertSound(phase);
  if (document.getElementById('chkNotification').checked) sendNotification(phase, distText);
  showAlertOverlay(phase, distText);
  updateStatusBadge('triggered');
  updateDistanceCardStatus('triggered');
}

function startVibrateLoop(pattern) {
  stopVibrateLoop();
  const delay = pattern.reduce((a, b) => a + b, 0) + 1000;
  State.vibrateLoop = setInterval(() => {
    if ('vibrate' in navigator) navigator.vibrate(pattern);
  }, delay);
}

function stopVibrateLoop() {
  if (State.vibrateLoop) { clearInterval(State.vibrateLoop); State.vibrateLoop = null; }
  if ('vibrate' in navigator) navigator.vibrate(0);
}

/* ============================================================
   音效系統（Web Audio API）
   五種音效 + 耳機偵測模式
   ============================================================ */

/* ---- 音效目錄（key → { name, fn(ctx, phase) }） ---- */
const SOUNDS = {

  /** 🎵 上升音階：三音漸升，第2段五音 */
  melody: {
    name: '🎵 上升音階',
    fn(ctx, phase) {
      const notes = phase === 1
        ? [880, 1100, 1320]
        : [880, 1047, 1320, 1568, 1760];
      notes.forEach((f, i) =>
        oscBeep(ctx, ctx.currentTime + i * 0.32, 0.28, f, 'sine', 0.65));
    },
  },

  /** 🚨 急促警報：方波快速交替，像電子鬧鐘 */
  alarm: {
    name: '🚨 急促警報',
    fn(ctx, phase) {
      const count = phase === 1 ? 5 : 10;
      for (let i = 0; i < count; i++) {
        oscBeep(ctx, ctx.currentTime + i * 0.22, 0.16,
          i % 2 === 0 ? 1500 : 1100, 'square', 0.38);
      }
    },
  },

  /** 🔔 鈴聲：正弦波帶長尾音，模擬門鈴 */
  bell: {
    name: '🔔 鈴聲',
    fn(ctx, phase) {
      const count = phase === 1 ? 3 : 5;
      for (let i = 0; i < count; i++) {
        bellTone(ctx, ctx.currentTime + i * 0.6, 1046.5, 0.72);
      }
    },
  },

  /** 📯 號角：三角波模擬銅管，Do-Mi-Sol-Do arpeggio */
  bugle: {
    name: '📯 號角',
    fn(ctx, phase) {
      // C4 → E4 → G4 → C5（第2段多一次 C5 強調）
      const seq = phase === 1
        ? [[523, 0.14], [659, 0.14], [784, 0.14], [1047, 0.38]]
        : [[523, 0.12], [659, 0.12], [784, 0.12], [1047, 0.22],
           [1047, 0.12], [784, 0.12], [1047, 0.42]];
      let t = ctx.currentTime;
      seq.forEach(([f, d]) => {
        oscBeep(ctx, t, d, f, 'triangle', 0.7);
        t += d + 0.025;
      });
    },
  },

  /** 🌊 溫柔喚醒：低音量五聲音階漸升，適合淺眠者 */
  gentle: {
    name: '🌊 溫柔喚醒',
    fn(ctx, phase) {
      const notes = phase === 1
        ? [523, 659, 784, 880]
        : [523, 659, 784, 880, 1047, 1175];
      notes.forEach((f, i) =>
        oscBeep(ctx, ctx.currentTime + i * 0.52, 0.48, f, 'sine', 0.32));
    },
  },
};

/* ---- 基礎音效積木 ---- */

/**
 * 播放單一振盪器 beep（含淡出）
 * @param {AudioContext} ctx
 * @param {number} t    開始時間（ctx.currentTime 偏移秒數）
 * @param {number} dur  持續秒數
 * @param {number} freq 頻率 Hz
 * @param {OscillatorType} type  sine / square / triangle / sawtooth
 * @param {number} vol  音量 0~1
 */
function oscBeep(ctx, t, dur, freq, type = 'sine', vol = 0.6) {
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.start(t);
  osc.stop(t + dur + 0.06);
}

/**
 * 鈴聲音效：快速起音 + 緩慢衰減，模擬鐘聲
 */
function bellTone(ctx, t, freq, vol = 0.7) {
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = 'sine';
  osc.frequency.value = freq;
  // 快速起音（Attack 0.01s）→ 長尾衰減（Decay ~1s）
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(vol, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
  osc.start(t);
  osc.stop(t + 1.05);
}

/* ---- 音效路由：判斷耳機模式 + 呼叫選取音效 ---- */

/**
 * 主播放入口
 * @param {1|2} phase 第幾段警報
 * @param {boolean} [isPreview=false] 試聽模式（跳過耳機檢查）
 */
function playAlertSound(phase, isPreview = false) {
  // 耳機模式：未插耳機則靜音（試聽時跳過此限制）
  if (!isPreview && State.headphoneMode && !State.headphonesConnected) {
    showToast('🎧 未偵測到耳機，已略過音效');
    return;
  }

  try {
    if (!State.audioCtx)
      State.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // iOS Safari 需要在使用者互動後 resume
    if (State.audioCtx.state === 'suspended')
      State.audioCtx.resume();

    const soundDef = SOUNDS[State.selectedSound] ?? SOUNDS.melody;
    soundDef.fn(State.audioCtx, phase);
  } catch (e) {
    console.warn('音效播放失敗：', e);
  }
}

/* ---- 音效選擇 ---- */
function selectSound(key) {
  if (!SOUNDS[key]) return;
  State.selectedSound = key;
  saveSettings();

  // 更新按鈕樣式
  document.querySelectorAll('.sound-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sound === key);
  });

  showToast(`已選擇：${SOUNDS[key].name}`);
}

/** 試聽按鈕 */
function previewSound() {
  const btn = document.getElementById('previewBtn');
  btn.disabled = true;
  btn.textContent = '🔊 播放中…';

  playAlertSound(1, true); // isPreview = true，不受耳機限制

  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = '▶️ 試聽選取音效';
  }, 2500);
}

/* ---- 耳機偵測 ---- */

/**
 * 透過 MediaDevices API 偵測是否有耳機連接
 * 原理：audiooutput 裝置數 ≥ 2 時，推測有額外輸出裝置（耳機/藍牙）
 * 限制：無法百分之百確定是耳機（也可能是 HDMI / 藍牙喇叭）
 * @returns {Promise<boolean|null>} true=可能有耳機, false=只有喇叭, null=無法判斷
 */
async function detectHeadphones() {
  if (!navigator.mediaDevices?.enumerateDevices) return null;
  try {
    const devices  = await navigator.mediaDevices.enumerateDevices();
    const outputs  = devices.filter(d => d.kind === 'audiooutput');
    // 有些裝置的 label 含 "headphone"/"earphone" 可直接判斷
    const hasLabel = outputs.some(d =>
      /headphone|earphone|headset|耳機|ear/i.test(d.label));
    if (hasLabel) return true;
    // 沒有 label 時（未授權），用數量推估
    return outputs.length >= 2;
  } catch {
    return null;
  }
}

/** 更新耳機狀態 UI */
async function refreshHeadphoneStatus() {
  const statusDiv  = document.getElementById('headphoneStatus');
  const iconEl     = document.getElementById('headphoneStatusIcon');
  const textEl     = document.getElementById('headphoneStatusText');

  if (!State.headphoneMode) {
    statusDiv.style.display = 'none';
    return;
  }

  statusDiv.style.display = 'flex';
  textEl.textContent = '偵測中…';

  const connected = await detectHeadphones();
  State.headphonesConnected = connected ?? false;

  if (connected === null) {
    iconEl.textContent = '❓';
    textEl.textContent = '無法偵測耳機（試聽確認音效是否正常）';
    statusDiv.dataset.state = 'unknown';
  } else if (connected) {
    iconEl.textContent = '🎧';
    textEl.textContent = '已偵測到耳機裝置，警報將透過耳機播放';
    statusDiv.dataset.state = 'ok';
  } else {
    iconEl.textContent = '⚠️';
    textEl.textContent = '未偵測到耳機，請插入耳機後再啟動';
    statusDiv.dataset.state = 'warn';
  }
}

/** 耳機模式 Toggle 事件 */
function onHeadphoneModeToggle() {
  State.headphoneMode = document.getElementById('chkHeadphone').checked;
  saveSettings();
  refreshHeadphoneStatus();
}

/** 監聽耳機插拔事件（devicechange） */
if (navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    if (!State.headphoneMode) return;
    const prev = State.headphonesConnected;
    const now  = await detectHeadphones();
    State.headphonesConnected = now ?? false;

    if (now !== null && now !== prev) {
      showToast(now ? '🎧 耳機已連接' : '⚠️ 耳機已拔除');
    }
    refreshHeadphoneStatus();
  });
}

/* ============================================================
   系統通知
   ============================================================ */
function sendNotification(phase, distM) {
  if (Notification.permission !== 'granted') return;
  const urgent = phase === 2;
  try {
    const n = new Notification(
      urgent ? '🚨 快到站！趕快醒來！' : '🎯 快到目的地了！',
      {
        body: `距離目的地僅剩約 ${distM} 公尺，請準備下車！`,
        icon: 'icons/icon-192.png',
        tag: 'bus-alarm', renotify: true, requireInteraction: true,
      }
    );
    n.onclick = () => { window.focus(); n.close(); };
  } catch (e) { console.warn('通知失敗：', e); }
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    setTimeout(async () => {
      const p = await Notification.requestPermission();
      if (p === 'granted') showToast('✅ 通知權限已開啟');
    }, 2000);
  }
}

function onNotificationToggle() {
  const chk = document.getElementById('chkNotification');
  if (chk.checked && Notification.permission !== 'granted') {
    Notification.requestPermission().then(p => {
      if (p !== 'granted') { chk.checked = false; showToast('❌ 通知權限被拒絕'); }
      else showToast('✅ 通知已開啟');
    });
  }
  saveSettings();
}

/* ============================================================
   Wake Lock API
   ============================================================ */
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    document.getElementById('wakeLockWarning').style.display = 'block'; return;
  }
  try {
    State.wakeLock = await navigator.wakeLock.request('screen');
    State.wakeLock.addEventListener('release', () => {
      document.getElementById('wakeLockWarning').style.display = 'block';
    });
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.getElementById('wakeLockWarning').style.display = 'none';
  } catch (e) {
    console.warn('Wake Lock 失敗：', e);
    document.getElementById('wakeLockWarning').style.display = 'block';
  }
}

function releaseWakeLock() {
  if (State.wakeLock) { State.wakeLock.release(); State.wakeLock = null; }
  document.removeEventListener('visibilitychange', onVisibilityChange);
  document.getElementById('wakeLockWarning').style.display = 'none';
}

async function onVisibilityChange() {
  if (document.visibilityState === 'visible' && State.isMonitoring) {
    await requestWakeLock();
  }
}

/* ============================================================
   Alert Overlay
   ============================================================ */
function showAlertOverlay(phase, distM) {
  const urgent = phase === 2;
  document.getElementById('alertIcon').textContent    = urgent ? '🚨' : '🎯';
  document.getElementById('alertTitle').textContent   = urgent ? '快到站！趕快醒來！' : '快到目的地了！';
  document.getElementById('alertMessage').textContent =
    `距離「${State.destination?.name?.substring(0,20) || '目的地'}」僅剩約 ${distM} 公尺！`;
  document.getElementById('btnContinue').style.display = urgent ? 'none' : 'block';
  document.getElementById('alertOverlay').style.display = 'flex';
}

function hideAlertOverlay() {
  document.getElementById('alertOverlay').style.display = 'none';
}

function dismissAlert() {
  stopVibrateLoop();
  hideAlertOverlay();
  stopMonitoring();
  showToast('✅ 提醒已停止，平安抵達！');
}

function continueMonitoring() {
  stopVibrateLoop();
  hideAlertOverlay();
  showToast('🔄 繼續監聽，200m 時加強提醒');
  updateStatusBadge('nearby');
  updateDistanceCardStatus('nearby');
}

/* ============================================================
   錯誤處理
   ============================================================ */
function handleGeoError(err, ctx) {
  const msgs = {
    1: '❌ GPS 權限被拒絕，請到瀏覽器設定開啟位置權限',
    2: '⚠️ GPS 訊號不穩定，請移至室外空曠處',
    3: '⏱️ 取得位置逾時，請稍候重試',
  };
  showToast(msgs[err.code] || `❌ GPS 錯誤（${ctx}）`);
  console.warn(`[${ctx}] GPS ${err.code}: ${err.message}`);
}

/* ============================================================
   Service Worker
   ============================================================ */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js')
    .then(r => console.log('✅ SW 已註冊：', r.scope))
    .catch(e => console.warn('SW 註冊失敗：', e));
}

/* ============================================================
   localStorage 設定讀寫
   ============================================================ */
const STORAGE_KEY = 'bus-alarm-v2';

function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    destination:      State.destination,
    radius:           State.radius,
    selectedSound:    State.selectedSound,
    headphoneMode:    State.headphoneMode,
    chkVibrate:       document.getElementById('chkVibrate')?.checked,
    chkSound:         document.getElementById('chkSound')?.checked,
    chkNotification:  document.getElementById('chkNotification')?.checked,
  }));
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);

    if (d.destination)   State.destination   = d.destination;
    if (d.radius)        State.radius        = d.radius;
    if (d.selectedSound) State.selectedSound = d.selectedSound;
    if (d.headphoneMode) State.headphoneMode = d.headphoneMode;

    requestAnimationFrame(() => {
      // 一般 Toggles
      if (d.chkVibrate      !== undefined)
        document.getElementById('chkVibrate').checked      = d.chkVibrate;
      if (d.chkSound        !== undefined)
        document.getElementById('chkSound').checked        = d.chkSound;
      if (d.chkNotification !== undefined)
        document.getElementById('chkNotification').checked = d.chkNotification;

      // 耳機模式 Toggle
      if (d.headphoneMode !== undefined)
        document.getElementById('chkHeadphone').checked = d.headphoneMode;

      // 音效按鈕 active 狀態
      document.querySelectorAll('.sound-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.sound === State.selectedSound);
      });

      // 初始化耳機狀態顯示
      if (State.headphoneMode) refreshHeadphoneStatus();
    });
  } catch (e) { console.warn('讀取設定失敗：', e); }
}

/* ============================================================
   半徑控制
   ============================================================ */
function onRadiusChange(val) {
  State.radius = parseInt(val, 10);
  document.getElementById('radiusValue').textContent = State.radius;
  updateRadiusCircle();
  updatePresetButtons();
  updateSliderGradient();
  saveSettings();
}

function setRadius(r) {
  State.radius = r;
  document.getElementById('radiusSlider').value = r;
  document.getElementById('radiusValue').textContent = r;
  updateRadiusCircle();
  updatePresetButtons();
  updateSliderGradient();
  saveSettings();
}

function updatePresetButtons() {
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.r, 10) === State.radius);
  });
}

function updateSliderGradient() {
  const s = document.getElementById('radiusSlider');
  const pct = ((State.radius - 200) / 600) * 100;
  s.style.background = `linear-gradient(to right,#1565c0 ${pct}%,var(--border) ${pct}%)`;
}

/* ============================================================
   UI 更新函式群
   ============================================================ */
function updateAllUI() {
  updateDestUI();
  updateRadiusUI();
  updateMonitoringButtons();
  updateStatusBadge(State.isMonitoring ? 'monitoring' : 'idle');
}

function updateDestUI() {
  const box    = document.getElementById('destInfoBox');
  const noInfo = !State.destination;
  box.style.display = noInfo ? 'none' : 'flex';
  if (!noInfo) {
    const shortName = State.destination.name.length > 50
      ? State.destination.name.substring(0, 50) + '…'
      : State.destination.name;
    document.getElementById('destName').textContent   = shortName;
    document.getElementById('destCoords').textContent =
      `${State.destination.lat.toFixed(5)}, ${State.destination.lng.toFixed(5)}`;
  }
}

function updateCurrentLocUI(coords, statusText, accuracy) {
  const el = document.getElementById('currentLocText');
  const pill = document.getElementById('accuracyPill');
  if (statusText) {
    el.textContent = statusText;
    pill.textContent = '';
    return;
  }
  if (coords) {
    el.textContent = `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`;
    pill.textContent = accuracy ? `GPS 精度 ±${Math.round(accuracy)} 公尺` : '';
  }
}

function updateRadiusUI() {
  document.getElementById('radiusSlider').value      = State.radius;
  document.getElementById('radiusValue').textContent = State.radius;
  updatePresetButtons();
  updateSliderGradient();
}

function updateMonitoringButtons() {
  const s = State.isMonitoring;
  document.getElementById('btnStart').style.display = s ? 'none' : 'block';
  document.getElementById('btnStop').style.display  = s ? 'block' : 'none';
  document.getElementById('map').classList.toggle('monitoring', s);
}

function updateStatusBadge(status) {
  const badge  = document.getElementById('statusBadge');
  const labels = { idle:'待機中', monitoring:'監聽中 ●', nearby:'已接近 ⚡', triggered:'已觸發 🔔' };
  badge.dataset.status = status;
  badge.textContent    = labels[status] || '待機中';
}

function updateDistanceUI(dist, acc) {
  document.getElementById('distanceValue').textContent = Math.round(dist);
  document.getElementById('accuracyLabel').textContent = acc ? `GPS 精度 ±${Math.round(acc)}m` : '';

  const name = State.destination?.name?.substring(0, 15) || '目的地';
  if (dist <= State.INNER_RADIUS) {
    document.getElementById('distanceLabel').textContent = '⚡ 非常接近目的地！';
    updateDistanceCardStatus('triggered');
    updateStatusBadge('triggered');
  } else if (dist <= State.radius) {
    document.getElementById('distanceLabel').textContent = `⚠️ 即將到達${name}！`;
    updateDistanceCardStatus('nearby');
    updateStatusBadge('nearby');
  } else {
    document.getElementById('distanceLabel').textContent = `距「${name}」`;
    updateDistanceCardStatus('monitoring');
    updateStatusBadge('monitoring');
  }
}

function updateDistanceCardStatus(s) {
  document.getElementById('distanceCard').dataset.status = s;
}

/* ============================================================
   Toast 訊息
   ============================================================ */
let toastTimer = null;
function showToast(msg, duration = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}
