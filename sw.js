// App shell service worker: makes the site installable and opens instantly.
// The app needs internet for live data, so pages and API calls go to the network first;
// the cached copy is only a fallback when the connection drops.
const VERSION = 'sportpicks-v1'
const SHELL = ['/', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)

  // Saved analyses and the Reto Escalera must always be fresh; never serve them from the cache
  if (url.origin === location.origin && /^\/api\/(analyses|ladder)/.test(url.pathname)) return

  // Page navigations and ESPN data: network first, cached copy if offline
  if (request.mode === 'navigate' || (url.origin === location.origin && url.pathname.startsWith('/api/sports'))) {
    event.respondWith(
      fetch(request)
        .then(res => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(VERSION).then(cache => cache.put(request.mode === 'navigate' ? '/' : request, copy))
          }
          return res
        })
        .catch(() => caches.match(request.mode === 'navigate' ? '/' : request).then(r => r ?? Response.error()))
    )
    return
  }

  // Static assets (icons, CDN scripts, fonts, team logos): cache first, refresh in the background
  const cacheable = url.origin === location.origin || /(cdn\.tailwindcss\.com|cdn\.jsdelivr\.net|unpkg\.com|fonts\.(googleapis|gstatic)\.com|espncdn\.com)$/.test(url.hostname)
  if (!cacheable) return
  event.respondWith(
    caches.open(VERSION).then(async cache => {
      const cached = await cache.match(request)
      const network = fetch(request)
        .then(res => {
          if (res.ok || res.type === 'opaque') cache.put(request, res.clone())
          return res
        })
        .catch(() => cached ?? Response.error())
      return cached ?? network
    })
  )
})
