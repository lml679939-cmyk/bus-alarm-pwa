/**
 * 公車到站提醒 — Service Worker
 *
 * 策略：
 *  - 本機檔案（HTML/CSS/JS/圖示）→ Cache First（優先快取，離線可用）
 *  - Leaflet CDN 資源  → Cache First + 網路 fallback
 *  - OpenStreetMap 地圖圖磚 → Network First（需要即時地圖）+ 快取備援
 *  - 其他請求 → Network Only
 */

'use strict';

/* ---- 版本號：每次更新靜態資源時遞增，觸發快取更新 ---- */
const CACHE_VERSION   = 'v2.5.3';
const CACHE_STATIC    = `bus-alarm-static-${CACHE_VERSION}`;
const CACHE_CDN       = `bus-alarm-cdn-${CACHE_VERSION}`;
const CACHE_TILES     = 'bus-alarm-tiles';   // 地圖圖磚（不帶版本，長期共用）

/* ---- 安裝時預先快取的本機資源 ---- */
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

/* ---- CDN 資源（Leaflet） ---- */
const CDN_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
];

/* ============================================================
   Install — 預先快取靜態資源
   ============================================================ */
self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      // 快取本機靜態資源
      const staticCache = await caches.open(CACHE_STATIC);
      await staticCache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('[SW] 部分靜態資源快取失敗：', err);
      });

      // 快取 CDN 資源
      const cdnCache = await caches.open(CACHE_CDN);
      await Promise.allSettled(
        CDN_ASSETS.map(url =>
          cdnCache.add(url).catch(e =>
            console.warn('[SW] CDN 快取失敗：', url, e)
          )
        )
      );

      console.log('[SW] 安裝完成，靜態資源已快取');
      // 立即接管頁面（不等舊 SW 自然失效）
      await self.skipWaiting();
    })()
  );
});

/* ============================================================
   Activate — 清除舊快取
   ============================================================ */
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const validCaches = [CACHE_STATIC, CACHE_CDN, CACHE_TILES];
      const keys = await caches.keys();

      await Promise.all(
        keys
          .filter(key => !validCaches.includes(key))
          .map(key => {
            console.log('[SW] 刪除舊快取：', key);
            return caches.delete(key);
          })
      );

      // 立即控制所有已開啟的頁面
      await self.clients.claim();
      console.log('[SW] 啟動完成，已接管所有頁面');
    })()
  );
});

/* ============================================================
   Fetch — 攔截請求
   ============================================================ */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // 只處理 GET 請求
  if (request.method !== 'GET') return;

  // 1. OpenStreetMap 地圖圖磚 → Network First（有快取備援）
  if (url.hostname.includes('tile.openstreetmap.org')) {
    event.respondWith(networkFirstWithCache(request, CACHE_TILES));
    return;
  }

  // 2. Leaflet CDN → Cache First
  if (url.hostname === 'unpkg.com') {
    event.respondWith(cacheFirst(request, CACHE_CDN));
    return;
  }

  // 3. 本機靜態資源 → Cache First
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, CACHE_STATIC));
    return;
  }

  // 4. 其他請求 → 直接走網路
  // （不攔截，讓瀏覽器自行處理）
});

/* ============================================================
   快取策略函式
   ============================================================ */

/**
 * Cache First：先讀快取，快取沒有才走網路，並更新快取
 */
async function cacheFirst(request, cacheName) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    console.warn('[SW] 離線且快取未命中：', request.url);
    return new Response('離線中，此資源無法載入', { status: 503 });
  }
}

/**
 * Network First：先走網路，失敗時讀快取
 * 適合地圖圖磚（希望即時更新，但離線時仍可顯示舊圖磚）
 */
async function networkFirstWithCache(request, cacheName) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request);
    if (response.ok) {
      // 圖磚快取上限：每 cache 最多 500 張，避免佔用太多空間
      await trimCache(cache, 500);
      cache.put(request, response.clone());
    }
    return response;
  } catch (_err) {
    // 網路失敗，嘗試讀快取
    const cached = await cache.match(request);
    if (cached) return cached;
    // 完全無法取得時回傳透明 1x1 PNG
    return new Response(EMPTY_PNG, {
      headers: { 'Content-Type': 'image/png' }
    });
  }
}

/**
 * 限制快取大小（超過上限時刪除最舊的 entry）
 */
async function trimCache(cache, maxItems) {
  const keys = await cache.keys();
  if (keys.length > maxItems) {
    // 刪除最舊的 10 筆
    const toDelete = keys.slice(0, keys.length - maxItems + 10);
    await Promise.all(toDelete.map(k => cache.delete(k)));
  }
}

/* 1x1 透明 PNG（Base64），用於離線時的地圖圖磚 fallback */
const EMPTY_PNG =
  Uint8Array.from(atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  ), c => c.charCodeAt(0));

/* ============================================================
   Push 通知處理（預留擴充用）
   ============================================================ */
self.addEventListener('push', event => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch (_) { data = { title: '公車到站提醒', body: event.data.text() }; }

  event.waitUntil(
    self.registration.showNotification(data.title || '🚌 公車快到站了！', {
      body:               data.body  || '請準備下車！',
      icon:               './icons/icon-192.png',
      badge:              './icons/icon-192.png',
      tag:                'bus-alarm-push',
      renotify:           true,
      requireInteraction: true,          // 通知持續顯示不自動消失
      vibrate:            [400, 100, 400, 100, 600],
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      if (clientList.length > 0) {
        return clientList[0].focus();
      }
      return clients.openWindow('./');
    })
  );
});
