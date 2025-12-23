self.addEventListener('install', event => {
  console.log('✅ Service Worker installed');
  self.skipWaiting(); // ทำให้ SW ใช้งานได้ทันที
});

self.addEventListener('activate', event => {
  console.log('✅ Service Worker activated');
  self.clients.claim(); // ทำให้ครอบคลุมทุก tab
});
