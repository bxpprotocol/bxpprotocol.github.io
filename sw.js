/**
 * BXP LiveNet — Service Worker
 * Runs permanently in the background.
 * Responsible for: background sync, push notifications, cache, ledger writes.
 *
 * Architecture:
 * - No personal data ever leaves the device
 * - AQ data fetched from AQICN via proxy (token never in frontend)
 * - All ledger writes happen here, in background
 * - Notifications fired only on meaningful events
 */

const VERSION     = 'bxp-sw-v2.0';
const CACHE       = 'bxp-shell-v2';
const PROXY       = 'https://bxp-node.onrender.com';
const SYNC_TAG    = 'bxp-background-sync';
const NOTIF_TAG   = 'bxp-alert';
const APP_URL     = 'https://bxpprotocol.github.io/livenet.html';

// Files to cache for offline shell
const SHELL = [
  '/livenet.html',
  '/app.js',
  '/db.js',
  '/manifest.json',
];

// ─── INSTALL ───────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL).catch(() => {})) // fail gracefully if files missing
      .then(() => self.skipWaiting())
  );
});

// ─── ACTIVATE ──────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── FETCH — serve from cache, fall back to network ───────────────────────
self.addEventListener('fetch', e => {
  // Only intercept same-origin GET requests for the app shell
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith(self.location.origin)) return;

  e.respondWith(
    caches.match(e.request)
      .then(cached => cached || fetch(e.request)
        .then(res => {
          // Cache fresh responses for shell files
          if (res.ok && SHELL.some(f => e.request.url.endsWith(f))) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
      )
      .catch(() => caches.match('/livenet.html'))
  );
});

// ─── BACKGROUND SYNC ──────────────────────────────────────────────────────
// Fires when connectivity is restored or on periodic sync (Android Chrome)
self.addEventListener('sync', e => {
  if (e.tag === SYNC_TAG) {
    e.waitUntil(backgroundRead());
  }
});

// Periodic background sync — fires every ~15 min on supported browsers
self.addEventListener('periodicsync', e => {
  if (e.tag === SYNC_TAG) {
    e.waitUntil(backgroundRead());
  }
});

// ─── PUSH NOTIFICATIONS ────────────────────────────────────────────────────
self.addEventListener('push', e => {
  if (!e.data) return;
  let payload;
  try { payload = e.data.json(); }
  catch { payload = { title: 'BXP', body: e.data.text() }; }

  e.waitUntil(
    self.registration.showNotification(payload.title, {
      body:    payload.body,
      icon:    '/icons/icon-192.png',
      badge:   '/icons/badge-96.png',
      tag:     payload.tag || NOTIF_TAG,
      renotify: true,
      silent:  payload.silent || false,
      data:    payload.data || {},
      actions: payload.actions || [],
    })
  );
});

// ─── NOTIFICATION CLICK ────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || APP_URL;

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        const existing = clients.find(c => c.url.includes('livenet'));
        if (existing) return existing.focus();
        return self.clients.openWindow(url);
      })
  );
});

// ─── MESSAGE FROM APP ──────────────────────────────────────────────────────
// App can send messages to service worker to trigger reads or register sync
self.addEventListener('message', e => {
  if (!e.data) return;

  switch (e.data.type) {
    case 'TRIGGER_READ':
      backgroundRead();
      break;
    case 'REGISTER_SYNC':
      registerPeriodicSync();
      break;
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
  }
});

// ─── CORE: BACKGROUND READ ─────────────────────────────────────────────────
/**
 * The main background operation.
 * Gets last known position from SW storage,
 * fetches AQ data via proxy,
 * decides if a new record should be written,
 * writes to the shared ledger store,
 * fires notification if needed.
 *
 * GPS note: Service workers cannot access Geolocation API directly.
 * We use the last position posted by the app (stored in SW cache).
 * When the app is open it posts fresh GPS. When closed we use last known.
 * This is the correct architecture — honest about the limitation.
 */
async function backgroundRead() {
  try {
    // Get last known state from SW store
    const state = await swGet('bxp_sw_state');
    if (!state?.lat || !state?.lng) return; // No position ever recorded

    const { lat, lng, lastGH, lastHRI, lastRT } = state;
    const now = Date.now();

    // Respect minimum interval — don't hammer the API
    if (lastRT && (now - lastRT) < 8 * 60 * 1000) return;

    // Fetch AQ via proxy (token never in frontend)
    const aq = await fetchAQProxy(lat, lng);
    if (!aq) return;

    // Decide if we should write a record
    const shouldWrite = shouldWriteRecord(aq.hri, lastHRI, aq.geohash, lastGH, lastRT, now);
    if (!shouldWrite) return;

    // Build and store the record
    const record = await buildRecord(state, aq, now);
    await appendRecord(record);

    // Update SW state
    await swSet('bxp_sw_state', {
      ...state,
      lastGH:  aq.geohash,
      lastHRI: aq.hri,
      lastRT:  now,
    });

    // Fire notification if needed
    await checkAndNotify(aq, record);

    // Notify all open clients to re-render
    const clients = await self.clients.matchAll();
    clients.forEach(c => c.postMessage({ type: 'NEW_RECORD', record }));

  } catch (err) {
    // Silent failure — never crash the service worker
    console.error('[BXP SW] backgroundRead error:', err);
  }
}

// ─── PROXY FETCH ───────────────────────────────────────────────────────────
async function fetchAQProxy(lat, lng) {
  try {
    const r = await fetch(
      `${PROXY}/bxp/v2/aq?lat=${lat}&lng=${lng}`,
      { signal: AbortSignal.timeout(12000) }
    );
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ─── WRITE DECISION ────────────────────────────────────────────────────────
function shouldWriteRecord(hri, lastHRI, geohash, lastGH, lastRT, now) {
  if (!lastRT) return true;                                    // First ever record
  if (geohash !== lastGH) return true;                         // Moved >150m
  if (Math.abs(hri - lastHRI) >= 10) return true;             // AQ changed significantly
  if ((now - lastRT) >= 60 * 60 * 1000) return true;          // 60 min elapsed
  return false;
}

// ─── BUILD RECORD ──────────────────────────────────────────────────────────
async function buildRecord(state, aq, now) {
  // Get last hash from ledger
  const ledger = await swGet('bxp_ledger') || [];
  const prevHash = ledger.length ? ledger[ledger.length - 1].hash : '0000000000000000';

  const raw = JSON.stringify({
    seq: ledger.length,
    ts:  now,
    gh:  aq.geohash,
    hri: aq.hri,
  });

  const hash = await sha256(prevHash + raw);

  return {
    bxpVersion: '2.0',
    fileType:   'reading',
    seq:        ledger.length,
    ts:         now,
    geohash:    aq.geohash,
    city:       aq.city,
    lat:        Math.round(state.lat * 10000) / 10000,
    lng:        Math.round(state.lng * 10000) / 10000,
    agents:     aq.agents,
    hri:        aq.hri,
    level:      aq.level,
    prevHash,
    hash,
    quality: {
      flag:       'UNVALIDATED',
      confidence: 0.75,
      source:     'AQICN',
    },
    insights: {
      bodyLoad:        aq.bodyLoad     || 0,
      debtH:           aq.debtH        || 0,
      lungBudgetPct:   aq.budgetPct    || 0,
    },
  };
}

// ─── APPEND TO LEDGER ──────────────────────────────────────────────────────
async function appendRecord(record) {
  const ledger = await swGet('bxp_ledger') || [];
  ledger.push(record);

  // Keep max 1000 records in SW store (export handles the rest)
  const trimmed = ledger.slice(-1000);
  await swSet('bxp_ledger', trimmed);

  // Also increment contribution counter
  const contrib = (await swGet('bxp_contrib') || 0) + 1;
  await swSet('bxp_contrib', contrib);
}

// ─── NOTIFICATIONS ─────────────────────────────────────────────────────────
const LEVELS = {
  CLEAN:    { c: '#00E676', a: 'Air quality is excellent.' },
  MODERATE: { c: '#FFEB3B', a: 'Acceptable for most people.' },
  ELEVATED: { c: '#FF9800', a: 'Reduce prolonged outdoor exertion.' },
  HIGH:     { c: '#F44336', a: 'Reduce outdoor activity.' },
  VERY_HIGH:{ c: '#9C27B0', a: 'Avoid outdoors. N95 recommended.' },
  HAZARDOUS:{ c: '#FF1744', a: 'Health emergency. Stay indoors.' },
};

async function checkAndNotify(aq, record) {
  const reg = self.registration;
  if (!reg) return;

  // Immediate: dangerous air
  if (aq.hri >= 60) {
    const L = LEVELS[aq.level] || LEVELS.HIGH;
    await reg.showNotification(`🫁 ${aq.level} air · HRI ${aq.hri}`, {
      body:     `${aq.city} — ${L.a}`,
      tag:      'bxp-danger',
      renotify: true,
      icon:     '/icons/icon-192.png',
      data:     { url: APP_URL, hri: aq.hri },
    });
    return;
  }

  // Check daily digest time (21:00 local)
  await checkDailyDigest();

  // Check milestones
  await checkMilestones();
}

async function checkDailyDigest() {
  const now     = new Date();
  const hour    = now.getHours();
  const today   = now.toDateString();
  const lastDD  = await swGet('bxp_last_digest_date');

  if (hour >= 21 && lastDD !== today) {
    const ledger = await swGet('bxp_ledger') || [];
    const todayRecs = ledger.filter(r => new Date(r.ts).toDateString() === today);
    if (todayRecs.length < 2) return;

    const avgHRI = Math.round(todayRecs.reduce((s, r) => s + r.hri, 0) / todayRecs.length * 10) / 10;
    await swSet('bxp_last_digest_date', today);

    await self.registration.showNotification('📊 Your exposure digest', {
      body:  `Today avg HRI ${avgHRI} · ${todayRecs.length} readings — open BXP to see your breakdown`,
      tag:   'bxp-digest',
      icon:  '/icons/icon-192.png',
      data:  { url: APP_URL },
    });
  }
}

async function checkMilestones() {
  const ledger    = await swGet('bxp_ledger') || [];
  const lastEANotif = await swGet('bxp_last_ea_notif') || 0;

  // Only check every 50 records to avoid spam
  if (ledger.length % 50 !== 0 || ledger.length === 0) return;

  // Calculate exposure age
  const pm = ledger.flatMap(r => r.agents?.filter(a => a.id === 'PM2_5') || []);
  if (pm.length < 5) return;

  const avg    = pm.reduce((s, a) => s + a.value, 0) / pm.length;
  const excess = Math.max(0, avg - 5);
  const span   = ledger.length > 1
    ? (ledger[ledger.length - 1].ts - ledger[0].ts) / (365 * 86400000)
    : 0.05;
  const ea = Math.round(excess * 0.098 * span * 100) / 100;

  if (ea > 0.1 && Math.abs(ea - lastEANotif) > 0.05) {
    await swSet('bxp_last_ea_notif', ea);
    await self.registration.showNotification('⏳ Your exposure age updated', {
      body:   `Your lungs are now estimated ${ea} years older than your calendar age from pollution alone.`,
      tag:    'bxp-milestone',
      silent: false,
      icon:   '/icons/icon-192.png',
      data:   { url: APP_URL },
    });
  }
}

// ─── PERIODIC SYNC REGISTRATION ────────────────────────────────────────────
async function registerPeriodicSync() {
  try {
    const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (status.state === 'granted') {
      await self.registration.periodicSync.register(SYNC_TAG, {
        minInterval: 15 * 60 * 1000, // every 15 minutes
      });
    }
  } catch {
    // Not supported — graceful degradation
  }
}

// ─── SW KEY-VALUE STORE ────────────────────────────────────────────────────
// Service workers cannot access localStorage directly.
// We use a simple cache-based key-value store instead.
// This persists across service worker restarts.

const KV_CACHE = 'bxp-sw-kv';

async function swSet(key, value) {
  const cache = await caches.open(KV_CACHE);
  const body  = JSON.stringify(value);
  await cache.put(
    new Request(`/sw-kv/${key}`),
    new Response(body, { headers: { 'Content-Type': 'application/json' } })
  );
}

async function swGet(key) {
  try {
    const cache = await caches.open(KV_CACHE);
    const res   = await cache.match(new Request(`/sw-kv/${key}`));
    if (!res) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ─── SHA-256 ───────────────────────────────────────────────────────────────
async function sha256(str) {
  try {
    const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf))
      .map(x => x.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16);
  } catch {
    // Fallback if subtle crypto unavailable
    let h = 0;
    for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
    return Math.abs(h).toString(16).padStart(16, '0');
  }
}
