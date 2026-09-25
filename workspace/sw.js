/* 谢意行 Service Worker：iOS 桌面 PWA 系统通知（Web Push）。
   职责只有两件事：收 push 显示系统通知；点通知把用户带回目标会话现场。
   不缓存页面资源（聊天页自身带 no-cache 头，恢复靠页面 re-fetch server truth）。 */
'use strict';

self.addEventListener('push', function (event) {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = (data && data.title) || '谢意行';
  event.waitUntil(self.registration.showNotification(title, {
    body: (data && data.body) || '',
    icon: '/push-icon-192.png',
    badge: '/push-icon-192.png',
    tag: 'dylan-chat',
    data: { url: (data && data.url) || '/chat' }
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/chat';
  event.waitUntil((async function () {
    // 已有本 PWA 窗口 → 原地 navigate 到目标现场并聚焦；没有 → 冷启动打开目标 URL。
    // URL 本身就是恢复线索（/chat?from_push=1&session_id=xxx），页面起来后自己 re-fetch 服务器状态。
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if ('navigate' in client) {
        try { await client.navigate(target); } catch (e) { /* navigate 失败则退回 openWindow */ }
        try { await client.focus(); } catch (e) {}
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
