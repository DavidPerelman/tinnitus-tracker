const CACHE_NAME      = 'tinnitus-tracker-v6';
const REMINDERS_CACHE = 'tinnitus-reminders-data';
const FIRED_CACHE     = 'tinnitus-fired-log';

const ASSETS = [
  '/tinnitus-tracker/',
  '/tinnitus-tracker/index.html',
  '/tinnitus-tracker/manifest.json',
  '/tinnitus-tracker/icon.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== REMINDERS_CACHE && k !== FIRED_CACHE)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Network-first fetch; fall back to cache
self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// App posts { type: 'SET_REMINDERS', reminders } whenever list changes.
// Store in Cache API so it persists across SW restarts.
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SET_REMINDERS') {
    caches.open(REMINDERS_CACHE).then(cache =>
      cache.put(
        '/tinnitus-reminders',
        new Response(JSON.stringify(e.data.reminders), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
  }
});

async function getReminders() {
  try {
    const cache = await caches.open(REMINDERS_CACHE);
    const res   = await cache.match('/tinnitus-reminders');
    if (!res) return [];
    return await res.json();
  } catch { return []; }
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function fireReminders() {
  const reminders = await getReminders();
  if (!reminders.length) return;

  const now      = new Date();
  const day      = now.getDay();
  const nowMin   = now.getHours() * 60 + now.getMinutes();
  const today    = dateKey(now);
  const firedCache = await caches.open(FIRED_CACHE);

  for (const r of reminders) {
    // Check day-of-week
    const days = r.days && r.days.length ? r.days : [0,1,2,3,4,5,6];
    if (!days.includes(day)) continue;

    // Check within ±8 minutes of scheduled time
    const [rh, rm] = r.time.split(':').map(Number);
    if (Math.abs((rh * 60 + rm) - nowMin) > 8) continue;

    // Deduplicate: at most once per reminder per calendar day
    const firedKey = `/fired/${r.id}/${today}`;
    if (await firedCache.match(firedKey)) continue;

    await self.registration.showNotification('מעקב טינטון', {
      body: r.label
        ? `${r.label} — זמן לרשום את עוצמת הטינטון`
        : 'זמן לרשום את עוצמת הטינטון',
      icon: '/tinnitus-tracker/icon.svg',
      tag:  `reminder-${r.id}`,
      requireInteraction: false
    });

    await firedCache.put(firedKey, new Response('1'));
  }

  // Prune fired-log entries older than yesterday
  const yesterday  = dateKey(new Date(now.getTime() - 86400000));
  const firedKeys  = await firedCache.keys();
  for (const req of firedKeys) {
    const parts = new URL(req.url).pathname.split('/');
    const ds    = parts[parts.length - 1];
    if (ds < yesterday) await firedCache.delete(req);
  }
}

// Periodic Background Sync — fires even when the app is closed
self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-reminders') {
    e.waitUntil(fireReminders());
  }
});

// Tap on notification → bring app to foreground
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        for (const client of clientList) {
          if (client.url.includes('tinnitus-tracker') && 'focus' in client) {
            return client.focus();
          }
        }
        return self.clients.openWindow('/tinnitus-tracker/index.html');
      })
  );
});
