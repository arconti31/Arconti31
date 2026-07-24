/* ========================================
   ARCONTI31 CMS - Service Worker
   PWA per gestione menù offline-ready
   ======================================== */

// Version updated on each deploy to bust stale SW cache
const CACHE_VERSION = '2026-07-24-cacheswitch';
const CACHE_NAME = `arconti31-cms-${CACHE_VERSION}`;
const STATIC_CACHE = `arconti31-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `arconti31-dynamic-${CACHE_VERSION}`;

// Risorse da cacheare immediatamente
const STATIC_ASSETS = [
  '/admin/',
  '/admin/index.html',
  '/admin/cms-simple.js',
  '/admin/cms-styles.css',
  '/admin/manifest.json',
  '/images/loghi/logo_arconti31.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'
];

// Install: Cache static assets
self.addEventListener('install', event => {
  console.log('[SW] Installing Service Worker...');
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => {
        console.log('[SW] Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => self.skipWaiting())
      .catch(err => console.log('[SW] Cache error:', err))
  );
});

// Activate: Clean old caches
self.addEventListener('activate', event => {
  console.log('[SW] Activating Service Worker...');
  event.waitUntil(
    caches.keys()
      .then(keys => {
        return Promise.all(
          keys.filter(key => key !== STATIC_CACHE && key !== DYNAMIC_CACHE)
            .map(key => {
              console.log('[SW] Removing old cache:', key);
              return caches.delete(key);
            })
        );
      })
      .then(() => self.clients.claim())
  );
});

// Fetch: Network first for API/admin shell, Cache first for other assets
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }
  
  // Skip non-http(s) requests (chrome-extension, etc.)
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // API calls - Network only (no cache for dynamic data)
  if (url.pathname.includes('/.netlify/functions/') || 
      url.pathname.includes('/api/') ||
      url.hostname === 'api.github.com') {
    event.respondWith(networkOnly(request));
    return;
  }

  // Admin shell (JS/CSS/HTML): network-first so deploys non restano in cache-first
  if (isAdminShellAsset(url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Other static assets - Cache first
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Everything else - Network first with cache fallback
  event.respondWith(networkFirst(request));
});

// Admin app code/styles/HTML must prefer network (evita CMS stale post-deploy)
function isAdminShellAsset(url) {
  const path = url.pathname;
  if (!path.startsWith('/admin')) return false;
  if (path === '/admin' || path === '/admin/' || path.endsWith('/admin/index.html') || path.endsWith('/index.html')) {
    return true;
  }
  return path.endsWith('.js') || path.endsWith('.css') || path.endsWith('.html');
}

// Check if request is for static asset (immagini/font)
function isStaticAsset(url) {
  const staticExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.woff', '.woff2', '.ttf', '.ico'];
  return staticExtensions.some(ext => url.pathname.endsWith(ext)) ||
         url.hostname === 'fonts.googleapis.com' ||
         url.hostname === 'fonts.gstatic.com';
}

// Cache first strategy
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    // Update cache in background
    fetchAndCache(request);
    return cached;
  }
  return fetchAndCache(request);
}

// Network first strategy
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(DYNAMIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }
    // Return offline page for navigation requests
    if (request.mode === 'navigate') {
      return caches.match('/admin/index.html');
    }
    throw error;
  }
}

// Network only strategy
async function networkOnly(request) {
  return fetch(request);
}

// Fetch and cache helper
async function fetchAndCache(request) {
  try {
    const response = await fetch(request);
    // Solo cache per richieste http/https
    const url = new URL(request.url);
    if (response.ok && url.protocol.startsWith('http')) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    console.log('[SW] Fetch failed:', error);
    throw error;
  }
}

// Background sync for offline operations
self.addEventListener('sync', event => {
  console.log('[SW] Background sync:', event.tag);
  if (event.tag === 'sync-changes') {
    event.waitUntil(syncPendingChanges());
  }
});

// Sync pending changes when back online (notifica solo; no promise di sync CMS)
async function syncPendingChanges() {
  try {
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({ type: 'SYNC_COMPLETE' });
    });
  } catch (error) {
    console.error('[SW] Sync failed:', error);
  }
}

// Push notifications (future feature)
self.addEventListener('push', event => {
  if (event.data) {
    const data = event.data.json();
    const options = {
      body: data.body || 'Nuova notifica da Arconti31 CMS',
      icon: '/images/loghi/logo_arconti31.png',
      badge: '/images/loghi/logo_arconti31.png',
      vibrate: [100, 50, 100],
      data: {
        dateOfArrival: Date.now(),
        primaryKey: 1
      }
    };
    event.waitUntil(
      self.registration.showNotification(data.title || 'Arconti31 CMS', options)
    );
  }
});

// Handle notification click
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.openWindow('/admin/')
  );
});

// Message handler for cache updates
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    caches.keys().then(keys => {
      keys.forEach(key => caches.delete(key));
    });
  }
});
