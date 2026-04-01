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
  silentAudio:         null,      // iOS 靜音音頻節點（背景保活用）
  silentAudioTimer:    null,      // 定期重啟靜音音頻的 timer
  gpsRetryTimer:       null,      // GPS 中斷後自動重試 timer
  lastPositionTime:    0,         // 上次收到 GPS 的時間戳
  mapSelectMode:       false,
  audioCtx:            null,
  vibrateLoop:         null,
  searchDebounce:      null,      // 搜尋防抖 timer
  selectedSound:       'melody',  // 選取的音效 key
  headphoneMode:       false,     // 耳機模式開關
  headphonesConnected: false,     // 目前是否偵測到耳機
  volume:              80,        // 主音量 0~100
  soundLoop:           null,      // 警報音效循環 timer
  masterGain:          null,      // Web Audio 主音量 GainNode
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

  // Flexbox 版面下 Leaflet 需要在 CSS 完成後重算容器大小
  setTimeout(() => map.invalidateSize(), 200);
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
  if (val.trim().length < 2) { clearSearchResults(); return; }
  State.searchDebounce = setTimeout(() => searchPlace(), 600);
}

/** 執行搜尋（Nominatim 地址 + Overpass POI 雙引擎並行） */
async function searchPlace() {
  const input = document.getElementById('searchInput');
  const query = input.value.trim();
  if (!query) { showToast('請輸入地址或公車站名稱'); return; }

  const btn = document.getElementById('searchBtn');
  btn.textContent = '⏳';
  btn.disabled = true;
  clearSearchResults();

  try {
    // 兩個 API 並行搜尋，任一完成就先顯示
    const [nomResult, overpassResult] = await Promise.allSettled([
      fetchNominatim(query),
      State.currentLoc
        ? fetchOverpass(query, State.currentLoc.lat, State.currentLoc.lng)
        : Promise.resolve([]),
    ]);

    const nomItems      = nomResult.status === 'fulfilled'      ? nomResult.value      : [];
    const overpassItems = overpassResult.status === 'fulfilled' ? overpassResult.value : [];

    // 合併：Overpass 結果優先（更精確的 POI），再加 Nominatim
    const merged = deduplicateResults([...overpassItems, ...nomItems]);
    renderSearchResults(merged);
  } catch (err) {
    showToast('❌ 搜尋失敗，請確認網路連線');
    console.error('搜尋錯誤：', err);
  } finally {
    btn.textContent = '🔍';
    btn.disabled = false;
  }
}

/** Nominatim 地址/地名搜尋 */
async function fetchNominatim(query) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format',          'json');
  url.searchParams.set('q',               query);
  url.searchParams.set('limit',           '5');
  url.searchParams.set('addressdetails',  '1');
  url.searchParams.set('extratags',       '1');
  url.searchParams.set('accept-language', 'zh-TW,zh,en');
  // 優先台灣範圍（不強制限制，讓使用者也能搜尋其他地區）
  url.searchParams.set('viewbox',  '119.5,21.5,122.5,25.5');
  url.searchParams.set('bounded',  '0');
  if (State.currentLoc) {
    url.searchParams.set('lat', State.currentLoc.lat);
    url.searchParams.set('lon', State.currentLoc.lng);
  }
  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const data = await res.json();
  return data.map(item => ({
    lat:    parseFloat(item.lat),
    lng:    parseFloat(item.lon),
    name:   buildDisplayName(item),
    type:   item.type   || item.class || '',
    class:  item.class  || '',
    source: 'nominatim',
    tags:   item.extratags || {},
  }));
}

/**
 * Overpass API POI 搜尋
 * 依名稱模糊搜尋周邊 15km 內的 OSM 節點/路徑，
 * 可找到捷運站、健身房、餐廳、學校等各類地標
 */
async function fetchOverpass(query, lat, lng) {
  // 跳脫 query 中的特殊字元，避免 Overpass QL 注入
  const safe = query.replace(/[\\"\[\]()]/g, '\\$&');

  const ql = `
[out:json][timeout:20];
(
  node["name"~"${safe}",i](around:15000,${lat},${lng});
  way["name"~"${safe}",i](around:15000,${lat},${lng});
  relation["name"~"${safe}",i](around:15000,${lat},${lng});
);
out center 8;`.trim();

  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `data=${encodeURIComponent(ql)}`,
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const data = await res.json();

  return (data.elements || [])
    .filter(el => el.tags?.name)
    .map(el => {
      const elLat = el.lat ?? el.center?.lat;
      const elLng = el.lon ?? el.center?.lon;
      if (!elLat || !elLng) return null;
      return {
        lat:    elLat,
        lng:    elLng,
        name:   el.tags.name,
        type:   el.tags.amenity || el.tags.shop || el.tags.leisure ||
                el.tags.public_transport || el.tags.railway || el.type || '',
        class:  'overpass',
        source: 'overpass',
        tags:   el.tags,
      };
    })
    .filter(Boolean);
}

/** 去重：以座標距離 < 50m 視為同一地點 */
function deduplicateResults(items) {
  const out = [];
  for (const item of items) {
    const dup = out.some(o =>
      haversineDistance(item.lat, item.lng, o.lat, o.lng) < 50
    );
    if (!dup) out.push(item);
  }
  return out.slice(0, 8);
}

/** 建立顯示名稱（Nominatim 版，去掉過長的縣市後綴） */
function buildDisplayName(item) {
  const addr = item.address || {};
  const parts = [
    item.namedetails?.name || item.display_name?.split(',')[0],
    addr.road, addr.suburb, addr.city || addr.town || addr.village,
  ].filter(Boolean);
  // 若第一個已是完整名稱（>4字），就只回傳前兩段
  return parts.slice(0, parts[0]?.length > 4 ? 2 : 3).join('，');
}

/** 渲染搜尋結果列表 */
function renderSearchResults(results) {
  const container = document.getElementById('searchResults');
  container.innerHTML = '';

  if (!results || results.length === 0) {
    container.innerHTML = '<div class="search-empty">找不到結果，請嘗試其他關鍵字或直接在地圖點選</div>';
    return;
  }

  results.forEach(item => {
    const shortName = item.name.length > 40 ? item.name.substring(0, 40) + '…' : item.name;
    const icon      = getTypeIcon(item.type, item.class, item.tags);
    const sourceTag = item.source === 'overpass'
      ? '<span class="source-tag poi">地標</span>'
      : '<span class="source-tag addr">地址</span>';

    const btn = document.createElement('button');
    btn.className = 'result-item';
    btn.innerHTML = `
      <span class="result-icon">${icon}</span>
      <div class="result-text">
        <div class="result-name">${shortName}${sourceTag}</div>
        <div class="result-meta">${formatTypeMeta(item.type, item.tags)}</div>
      </div>`;
    btn.onclick = () => {
      setDestination(item.lat, item.lng, item.name);
      clearSearchResults();
      document.getElementById('searchInput').value = '';
    };
    container.appendChild(btn);
  });
}

/** 根據 OSM type/class/tags 回傳 emoji icon */
function getTypeIcon(type, cls, tags = {}) {
  const t = (type || '').toLowerCase();
  const c = (cls  || '').toLowerCase();
  if (tags.railway === 'station' || tags.public_transport === 'station' || t === 'station') return '🚉';
  if (tags.public_transport || t === 'bus_stop' || t === 'stop_position') return '🚌';
  if (t === 'gym' || t === 'sports_centre' || tags.leisure === 'fitness_centre') return '🏋️';
  if (t === 'school' || t === 'university' || t === 'college') return '🏫';
  if (t === 'hospital' || t === 'clinic')  return '🏥';
  if (t === 'restaurant' || t === 'cafe')  return '🍽️';
  if (t === 'convenience' || t === 'supermarket') return '🏪';
  if (t === 'park' || t === 'playground')  return '🌳';
  if (c === 'highway')                     return '🛣️';
  if (c === 'building')                    return '🏢';
  return '📌';
}

/** 格式化類型描述文字 */
function formatTypeMeta(type, tags = {}) {
  const mapping = {
    station:        '捷運/火車站',
    bus_stop:       '公車站',
    stop_position:  '公車站',
    gym:            '健身房',
    sports_centre:  '運動中心',
    fitness_centre: '健身房',
    school:         '學校',
    university:     '大學',
    hospital:       '醫院',
    restaurant:     '餐廳',
    cafe:           '咖啡廳',
    convenience:    '便利商店',
    supermarket:    '超市',
    park:           '公園',
  };
  return mapping[type] || type || '地點';
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
  startSilentAudio();     // iOS 背景保活：持續播放靜音音頻
  startGpsWatchdog();     // GPS 看門狗：偵測訊號中斷並自動重試
  updateAllUI();
  showIosBackgroundBanner();
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
  stopSilentAudio();
  stopGpsWatchdog();
  stopVibrateLoop();
  stopSoundLoop();
  hideAlertOverlay();
  hideIosBackgroundBanner();
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
  State.currentLoc    = { lat, lng, accuracy: acc };
  State.lastPositionTime = Date.now(); // 看門狗：更新最後收到 GPS 的時間

  drawCurrentMarker(lat, lng);
  updateCurrentLocUI({ lat, lng }, null, acc);
  updateGpsStatusUI('ok');

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
  if (document.getElementById('chkSound').checked) {
    stopSoundLoop(); // 先停止前一段的循環（如果有）
    playAlertSound(phase, false, true);
  }
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
   音效系統（Web Audio API）v2
   - 五種音效，音色各異（真實鐘聲、銅管、火警警報等）
   - 主音量 GainNode 統一控制
   - 警報觸發後循環播放，直到使用者停止
   ============================================================ */

/* ---- 取得/建立主音量節點 ---- */
function getMasterGain() {
  const ctx = getAudioCtx();
  if (!State.masterGain || State.masterGain.context.state === 'closed') {
    State.masterGain = ctx.createGain();
    State.masterGain.connect(ctx.destination);
  }
  State.masterGain.gain.value = State.volume / 100;
  return State.masterGain;
}

function getAudioCtx() {
  if (!State.audioCtx)
    State.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (State.audioCtx.state === 'suspended') State.audioCtx.resume();
  return State.audioCtx;
}

/* ---- 五種音效定義 ---- */
const SOUNDS = {

  /**
   * 🎵 上升音階：四音 Do-Mi-Sol-Do 漸升，悅耳清晰
   * 頻率降低至 C4~C5 範圍，耳機聽起來飽滿
   */
  melody: {
    name: '🎵 上升音階',
    duration: 2.0,
    fn(ctx, dest, phase) {
      const freqs = phase === 1
        ? [261.6, 329.6, 392.0, 523.2]           // C4 E4 G4 C5
        : [261.6, 329.6, 392.0, 523.2, 659.3, 783.9]; // + E5 G5
      freqs.forEach((f, i) => {
        sineNote(ctx, dest, ctx.currentTime + i * 0.32, 0.28, f);
      });
    },
  },

  /**
   * 🚨 急促警報：連續鋸齒波頻率掃描，模擬消防警報
   * 從 700Hz 升至 1100Hz 再降回，持續重複
   */
  alarm: {
    name: '🚨 急促警報',
    duration: 3.0,
    fn(ctx, dest, phase) {
      const totalDur = phase === 1 ? 3.0 : 5.0;
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(dest);
      osc.type = 'sawtooth';
      gain.gain.value = 0.55;

      const now    = ctx.currentTime;
      const cycles = Math.ceil(totalDur / 0.45);
      for (let i = 0; i < cycles; i++) {
        const t = now + i * 0.45;
        osc.frequency.setValueAtTime(700, t);
        osc.frequency.linearRampToValueAtTime(1100, t + 0.22);
        osc.frequency.linearRampToValueAtTime(700, t + 0.45);
      }
      osc.start(now);
      osc.stop(now + totalDur + 0.05);
    },
  },

  /**
   * 🔔 鈴聲：真實鐘聲泛音結構（基頻 + 2.756x + 5.404x 分音）
   * 瞬間起音，緩慢衰減，帶有金屬共鳴感
   */
  bell: {
    name: '🔔 鈴聲',
    duration: 4.5,
    fn(ctx, dest, phase) {
      const count   = phase === 1 ? 3 : 5;
      const baseHz  = 523.2; // C5（清脆中頻）
      for (let i = 0; i < count; i++) {
        ringBell(ctx, dest, ctx.currentTime + i * 1.1, baseHz);
      }
    },
  },

  /**
   * 📯 號角：鋸齒波 + 低通濾波器模擬銅管樂器音色
   * 吹奏感起音（80ms attack），Do-Sol-Do-Sol 軍號旋律
   */
  bugle: {
    name: '📯 號角',
    duration: 2.5,
    fn(ctx, dest, phase) {
      // Do(C4) Sol(G4) Do(C5) Sol(G4) Do(C5) — 軍號衝鋒號
      const seq = phase === 1
        ? [[261.6, 0.18], [392.0, 0.18], [523.2, 0.18], [523.2, 0.45]]
        : [[261.6, 0.14], [392.0, 0.14], [523.2, 0.14], [392.0, 0.14],
           [523.2, 0.14], [392.0, 0.14], [523.2, 0.55]];
      let t = ctx.currentTime;
      seq.forEach(([f, d]) => {
        brassNote(ctx, dest, t, f, d);
        t += d + 0.04;
      });
    },
  },

  /**
   * 🌊 溫柔喚醒：五聲音階，正弦波，音量較低，適合淺眠
   * C4-D4-E4-G4-A4，間隔較長，輕柔漸升
   */
  gentle: {
    name: '🌊 溫柔喚醒',
    duration: 3.5,
    fn(ctx, dest, phase) {
      const freqs = phase === 1
        ? [261.6, 293.7, 329.6, 392.0, 440.0]         // C4 D4 E4 G4 A4
        : [261.6, 293.7, 329.6, 392.0, 440.0, 523.2, 587.3]; // + C5 D5
      freqs.forEach((f, i) => {
        sineNote(ctx, dest, ctx.currentTime + i * 0.55, 0.5, f, 0.42);
      });
    },
  },
};

/* ---- 基礎音效積木 ---- */

/** 正弦波單音，含快速起音與指數衰減 */
function sineNote(ctx, dest, t, dur, freq, vol = 0.75) {
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(dest);
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.001, t);
  gain.gain.linearRampToValueAtTime(vol, t + 0.012);    // 12ms attack
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.start(t);
  osc.stop(t + dur + 0.06);
}

/**
 * 真實鐘聲：三個泛音疊加
 * 鐘聲的特徵分音比例：1x、2.756x（小三度泛音）、5.404x
 */
function ringBell(ctx, dest, t, baseFreq) {
  [[1.0, 0.9], [2.756, 0.55], [5.404, 0.25]].forEach(([ratio, relVol]) => {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(dest);
    osc.type = 'sine';
    osc.frequency.value = baseFreq * ratio;
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(relVol, t + 0.004); // 極快起音（4ms）
    gain.gain.exponentialRampToValueAtTime(0.001, t + 1.6); // 緩慢衰減 1.6s
    osc.start(t);
    osc.stop(t + 1.7);
  });
}

/**
 * 銅管音符：鋸齒波 + 低通濾波器，模擬號角音色
 * 帶有明顯的吹奏感起音（80ms）與自然收尾
 */
function brassNote(ctx, dest, t, freq, dur) {
  const osc    = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const gain   = ctx.createGain();

  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(freq * 0.98, t);         // 起音略低（模擬吹氣）
  osc.frequency.exponentialRampToValueAtTime(freq, t + 0.06);

  filter.type            = 'lowpass';
  filter.frequency.value = 2200;   // 截掉刺耳高頻
  filter.Q.value         = 1.8;

  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.82, t + 0.08);   // 80ms attack
  gain.gain.setValueAtTime(0.75, t + dur - 0.08);
  gain.gain.linearRampToValueAtTime(0, t + dur);        // 自然收尾

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(dest);
  osc.start(t);
  osc.stop(t + dur + 0.06);
}

/* ---- 主播放入口 ---- */

/**
 * 播放警報音效
 * @param {1|2}    phase     第幾段警報
 * @param {boolean} isPreview 試聽模式（跳過耳機限制）
 * @param {boolean} startLoop 是否啟動循環（預設 true）
 */
function playAlertSound(phase, isPreview = false, startLoop = true) {
  if (!isPreview && State.headphoneMode && !State.headphonesConnected) {
    showToast('🎧 未偵測到耳機，已略過音效');
    return;
  }
  try {
    const ctx  = getAudioCtx();
    const dest = getMasterGain();
    const def  = SOUNDS[State.selectedSound] ?? SOUNDS.melody;
    def.fn(ctx, dest, phase);

    // 警報觸發後持續循環，直到使用者停止
    if (startLoop) startSoundLoop(phase, def.duration ?? 3.0);
  } catch (e) {
    console.warn('音效播放失敗：', e);
  }
}

/* ---- 音效循環（觸發後持續重複） ---- */
function startSoundLoop(phase, soundDuration) {
  stopSoundLoop();
  const interval = (soundDuration + 2.0) * 1000; // 音效結束後停 2s 再重複
  State.soundLoop = setInterval(() => {
    if (!State.isMonitoring) { stopSoundLoop(); return; }
    try {
      const ctx  = getAudioCtx();
      const dest = getMasterGain();
      const def  = SOUNDS[State.selectedSound] ?? SOUNDS.melody;
      def.fn(ctx, dest, phase);
    } catch (e) { console.warn('循環音效失敗：', e); }
  }, interval);
}

function stopSoundLoop() {
  if (State.soundLoop) {
    clearInterval(State.soundLoop);
    State.soundLoop = null;
  }
}

/* ---- 音量控制 ---- */
function onVolumeChange(val) {
  State.volume = parseInt(val, 10);
  document.getElementById('volumeValue').textContent = State.volume;
  if (State.masterGain) State.masterGain.gain.value = State.volume / 100;
  saveSettings();
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
   iOS 背景保活：靜音音頻 Hack
   原理：讓 AudioContext 持續輸出靜音，使 iOS 將 Safari
         視為「媒體播放中」，降低系統中斷 GPS 的機率。
   限制：無法 100% 保證，iOS 版本不同效果有差異。
   ============================================================ */
function startSilentAudio() {
  if (!State.audioCtx) return;
  stopSilentAudio(); // 避免重複啟動

  const ctx = State.audioCtx;

  /**
   * 建立一個靜音的 oscillator（音量 = 0）
   * 每 25 秒重新建立一次，避免 iOS 偵測到長時間靜音而關閉
   */
  function createSilentNode() {
    if (!State.isMonitoring) return;
    if (ctx.state === 'suspended') ctx.resume();

    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001; // 極低音量（幾乎靜音，但非 0，確保音頻流不被切斷）
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();

    // 25 秒後停止這個節點並重建，持續保持音頻流活躍
    setTimeout(() => {
      try { osc.stop(); } catch (_) {}
      if (State.isMonitoring) createSilentNode();
    }, 25000);

    State.silentAudio = osc;
  }

  // 初始化 AudioContext（需要在使用者點擊後）
  try {
    createSilentNode();
    console.log('🎵 靜音音頻已啟動（iOS 背景保活）');
  } catch (e) {
    console.warn('靜音音頻啟動失敗：', e);
  }
}

function stopSilentAudio() {
  if (State.silentAudio) {
    try { State.silentAudio.stop(); } catch (_) {}
    State.silentAudio = null;
  }
}

/* ============================================================
   GPS 看門狗：自動偵測 GPS 中斷並重啟 watchPosition
   當超過 45 秒沒收到 GPS 更新，自動重新呼叫 watchPosition
   ============================================================ */
function startGpsWatchdog() {
  stopGpsWatchdog();
  State.lastPositionTime = Date.now();

  State.gpsRetryTimer = setInterval(() => {
    if (!State.isMonitoring) { stopGpsWatchdog(); return; }

    const elapsed = Date.now() - State.lastPositionTime;

    if (elapsed > 45000) {
      // 超過 45 秒沒訊號，嘗試重啟 watchPosition
      console.warn(`GPS 中斷 ${Math.round(elapsed/1000)}s，自動重試...`);
      updateGpsStatusUI('retry');

      if (State.watchId !== null) {
        navigator.geolocation.clearWatch(State.watchId);
      }

      // 重新啟動 watchPosition
      State.watchId = navigator.geolocation.watchPosition(
        onPositionUpdate,
        onPositionError,
        { enableHighAccuracy: true, timeout: 30000, maximumAge: 10000 }
      );

      State.lastPositionTime = Date.now(); // 重置計時
      showToast('⚡ GPS 訊號恢復中，重新定位…');
    }
  }, 15000); // 每 15 秒檢查一次
}

function stopGpsWatchdog() {
  if (State.gpsRetryTimer) {
    clearInterval(State.gpsRetryTimer);
    State.gpsRetryTimer = null;
  }
}

/* ============================================================
   iOS 背景提示 Banner（啟動監聽後顯示）
   ============================================================ */
function showIosBackgroundBanner() {
  const banner = document.getElementById('iosBackgroundBanner');
  if (banner) banner.style.display = 'block';
}

function hideIosBackgroundBanner() {
  const banner = document.getElementById('iosBackgroundBanner');
  if (banner) banner.style.display = 'none';
}

/** GPS 狀態 UI 更新（看門狗用） */
function updateGpsStatusUI(state) {
  const el = document.getElementById('gpsStatusPill');
  if (!el) return;
  if (state === 'ok') {
    el.textContent    = '📡 GPS 訊號正常';
    el.dataset.status = 'ok';
  } else if (state === 'retry') {
    el.textContent    = '⚡ GPS 重新連線中…';
    el.dataset.status = 'retry';
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
  stopSoundLoop();
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
    volume:           State.volume,
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
    if (d.volume !== undefined) State.volume = d.volume;

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

      // 還原音量滑桿
      const volSlider = document.getElementById('volumeSlider');
      const volValue  = document.getElementById('volumeValue');
      if (volSlider) volSlider.value         = State.volume;
      if (volValue)  volValue.textContent    = State.volume;

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
