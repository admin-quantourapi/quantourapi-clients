self.addEventListener('install', () => {
  console.log('[Service Worker] Installing...')
})

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request))
})
