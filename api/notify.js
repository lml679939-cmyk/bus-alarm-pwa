/**
 * Vercel Serverless Function — /api/notify
 *
 * 接收前端傳來的 { subscription, title, body }
 * 用 web-push 發送 Web Push Notification 給使用者裝置
 *
 * 環境變數（在 Vercel Dashboard 設定）：
 *   VAPID_EMAIL       - 你的 Email（格式：mailto:you@example.com）
 *   VAPID_PUBLIC_KEY  - VAPID 公鑰
 *   VAPID_PRIVATE_KEY - VAPID 私鑰
 */

'use strict';

const webpush = require('web-push');

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

module.exports = async function handler(req, res) {
  // CORS 設定（允許 GitHub Pages 呼叫）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { subscription, title, body } = req.body ?? {};

  if (!subscription?.endpoint) {
    return res.status(400).json({ error: '缺少 subscription' });
  }

  const payload = JSON.stringify({
    title: title || '🚌 公車快到站了！',
    body:  body  || '請準備下車',
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag:   'bus-alarm',
    renotify: true,
    requireInteraction: true,
  });

  try {
    await webpush.sendNotification(subscription, payload);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Web Push 發送失敗：', err);
    // 410 = subscription 已過期，通知前端清除
    if (err.statusCode === 410) {
      return res.status(410).json({ error: 'subscription_expired' });
    }
    return res.status(500).json({ error: err.message });
  }
};
