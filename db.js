/**
 * BXP — db.js
 * Bulletproof localStorage manager.
 *
 * Strategy:
 * - Every write goes to PRIMARY and BACKUP simultaneously
 * - Every read checks PRIMARY first, falls back to BACKUP
 * - Corruption detected by JSON parse failure → auto-recover from backup
 * - Versioned keys prevent stale data conflicts across app updates
 * - Auto-export prompt when approaching storage limits
 * - Milestone export prompts at 100, 500, 1000 records
 * - Storage quota monitoring
 *
 * Why localStorage and not IndexedDB:
 * localStorage is synchronous, universally supported, and survives
 * service worker restarts. The bulletproofing below makes it
 * genuinely reliable for a personal ledger of this scale.
 * ~1000 records × ~400 bytes = ~400KB. localStorage limit is ~5-10MB.
 * We are well within bounds with monitoring to catch edge cases.
 */

const DB_VERSION = 'v2';

// Key constants — never hardcode these elsewhere
const KEYS = {
  LEDGER:       `bxp_ledger_${DB_VERSION}`,
  LEDGER_BK:    `bxp_ledger_backup_${DB_VERSION}`,
  STATE:        `bxp_state_${DB_VERSION}`,
  STATE_BK:     `bxp_state_backup_${DB_VERSION}`,
  ZONES:        `bxp_zones_${DB_VERSION}`,
  KNOWN_GHS:    `bxp_known_ghs_${DB_VERSION}`,
  DIGEST:       `bxp_digest_${DB_VERSION}`,
  LETTER:       `bxp_letter_${DB_VERSION}`,
  ANOMALIES:    `bxp_anomalies_${DB_VERSION}`,
  NOTIF:        'bxp_notif',
  STARTED:      'bxp_started',
  CONTRIB:      'bxp_contrib',
  LAST_DIGEST:  'bxp_last_digest_date',
  LAST_EA:      'bxp_last_ea',
  BUDGET_WARN:  'bxp_budget_warn',
  EXPORT_COUNT: 'bxp_export_count',
  QUOTA_WARN:   'bxp_quota_warned',
};

// ─── WRITE ──────────────────────────────────────────────────────────────────
function dbWrite(key, backupKey, value) {
  const serialised = JSON.stringify(value);
  try {
    localStorage.setItem(key, serialised);
  } catch (e) {
    // Storage full — trigger emergency export
    handleStorageFull();
    return false;
  }
  // Always write backup after primary succeeds
  try { localStorage.setItem(backupKey, serialised); } catch { /* backup failure is non-fatal */ }
  return true;
}

// ─── READ ───────────────────────────────────────────────────────────────────
function dbRead(key, backupKey, fallback = null) {
  // Try primary
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      return parsed;
    }
  } catch {
    // Primary corrupted — try backup
    console.warn(`[BXP DB] Primary key ${key} corrupted, recovering from backup`);
    try {
      const bk = localStorage.getItem(backupKey);
      if (bk !== null) {
        const parsed = JSON.parse(bk);
        // Restore primary from backup
        try { localStorage.setItem(key, bk); } catch { }
        return parsed;
      }
    } catch {
      console.error(`[BXP DB] Both ${key} and ${backupKey} corrupted. Data loss.`);
    }
  }
  return fallback;
}

// ─── PUBLIC API ─────────────────────────────────────────────────────────────

const DB = {

  // ── LEDGER ────────────────────────────────────────────────────────────────

  getLedger() {
    return dbRead(KEYS.LEDGER, KEYS.LEDGER_BK, []);
  },

  appendRecord(record) {
    const ledger = this.getLedger();
    ledger.push(record);
    // Keep max 2000 records — prompt export before this point
    const trimmed = ledger.slice(-2000);
    const ok = dbWrite(KEYS.LEDGER, KEYS.LEDGER_BK, trimmed);
    if (ok) this.checkMilestones(trimmed.length);
    return ok;
  },

  getLedgerLength() {
    return this.getLedger().length;
  },

  verifyChain() {
    const ledger = this.getLedger();
    if (ledger.length < 2) return { valid: true, errors: [] };
    const errors = [];
    for (let i = 1; i < ledger.length; i++) {
      if (ledger[i].prevHash !== ledger[i - 1].hash) {
        errors.push({ seq: ledger[i].seq, expected: ledger[i - 1].hash, got: ledger[i].prevHash });
      }
    }
    return { valid: errors.length === 0, errors };
  },

  // ── APP STATE ─────────────────────────────────────────────────────────────

  getState() {
    return dbRead(KEYS.STATE, KEYS.STATE_BK, {
      notif:    'default',
      lastGH:   null,
      lastHRI:  0,
      lastRT:   0,
      contrib:  0,
      started:  false,
    });
  },

  setState(patch) {
    const current = this.getState();
    return dbWrite(KEYS.STATE, KEYS.STATE_BK, { ...current, ...patch });
  },

  // ── ZONES ─────────────────────────────────────────────────────────────────

  getZones()        { return dbRead(KEYS.ZONES, KEYS.ZONES + '_bk', {}); },
  setZones(z)       { return dbWrite(KEYS.ZONES, KEYS.ZONES + '_bk', z); },
  getKnownGHs()     { return dbRead(KEYS.KNOWN_GHS, KEYS.KNOWN_GHS + '_bk', {}); },
  setKnownGHs(g)    { return dbWrite(KEYS.KNOWN_GHS, KEYS.KNOWN_GHS + '_bk', g); },

  // ── DIGEST + LETTER ───────────────────────────────────────────────────────

  getDigest()       { return dbRead(KEYS.DIGEST,    KEYS.DIGEST    + '_bk', null); },
  setDigest(d)      { return dbWrite(KEYS.DIGEST,   KEYS.DIGEST    + '_bk', d); },
  getLetter()       { return dbRead(KEYS.LETTER,    KEYS.LETTER    + '_bk', null); },
  setLetter(l)      { return dbWrite(KEYS.LETTER,   KEYS.LETTER    + '_bk', l); },

  // ── ANOMALIES ─────────────────────────────────────────────────────────────

  getAnomalies()    { return dbRead(KEYS.ANOMALIES, KEYS.ANOMALIES + '_bk', []); },
  setAnomalies(a)   { return dbWrite(KEYS.ANOMALIES, KEYS.ANOMALIES + '_bk', a.slice(-20)); },

  // ── SIMPLE FLAGS ──────────────────────────────────────────────────────────

  getNotif()        { return localStorage.getItem(KEYS.NOTIF) || 'default'; },
  setNotif(p)       { localStorage.setItem(KEYS.NOTIF, p); },
  isStarted()       { return !!localStorage.getItem(KEYS.STARTED); },
  setStarted()      { localStorage.setItem(KEYS.STARTED, '1'); },
  getContrib()      { return parseInt(localStorage.getItem(KEYS.CONTRIB) || '0'); },
  incContrib()      { localStorage.setItem(KEYS.CONTRIB, this.getContrib() + 1); },
  getLastDigest()   { return localStorage.getItem(KEYS.LAST_DIGEST); },
  setLastDigest(d)  { localStorage.setItem(KEYS.LAST_DIGEST, d); },
  getLastEA()       { return parseFloat(localStorage.getItem(KEYS.LAST_EA) || '0'); },
  setLastEA(v)      { localStorage.setItem(KEYS.LAST_EA, v); },
  getBudgetWarn()   { return !!localStorage.getItem(KEYS.BUDGET_WARN); },
  setBudgetWarn()   { localStorage.setItem(KEYS.BUDGET_WARN, '1'); },

  // ── STORAGE HEALTH ────────────────────────────────────────────────────────

  async getStorageInfo() {
    if (navigator.storage?.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      return {
        usedMB:  Math.round(usage  / 1024 / 1024 * 100) / 100,
        quotaMB: Math.round(quota  / 1024 / 1024 * 100) / 100,
        pct:     Math.round(usage / quota * 100),
      };
    }
    // Fallback estimate from localStorage size
    let total = 0;
    for (const k in localStorage) {
      if (localStorage.hasOwnProperty(k)) total += localStorage[k].length * 2;
    }
    return { usedMB: Math.round(total / 1024 / 1024 * 100) / 100, quotaMB: 5, pct: Math.round(total / (5 * 1024 * 1024) * 100) };
  },

  checkMilestones(count) {
    // Prompt export at key milestones
    const milestones = [50, 100, 250, 500, 1000];
    if (milestones.includes(count)) {
      // Dispatch event for UI to handle
      window.dispatchEvent(new CustomEvent('bxp:milestone', { detail: { count } }));
    }
  },

  // ── EXPORT — the real thing ────────────────────────────────────────────────
  // Insights are embedded in the file — the file IS the record, not just the UI

  exportPassport(insights = {}) {
    const ledger  = this.getLedger();
    const state   = this.getState();
    const letter  = this.getLetter();
    const digest  = this.getDigest();

    const passport = {
      bxpVersion:   '2.0',
      fileType:     'aggregate',
      exportedAt:   new Date().toISOString(),
      totalRecords: ledger.length,
      // Insights live in the file — not just the UI
      insights: {
        exposureAge:     insights.exposureAge     || null,
        bodyLoad:        insights.bodyLoad        || null,
        debtH:           insights.debtH           || null,
        budgetPct:       insights.budgetPct       || null,
        lifetimeAvgHRI:  insights.lifetimeAvgHRI  || null,
        monthlyLetter:   letter,
        latestDigest:    digest,
      },
      ledger,
    };

    const blob = new Blob(
      [JSON.stringify(passport, null, 2)],
      { type: 'application/json' }
    );
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = `bxp-passport-${Date.now()}.bxp.json`;
    a.click();
    URL.revokeObjectURL(url);

    // Track export count
    const count = parseInt(localStorage.getItem(KEYS.EXPORT_COUNT) || '0') + 1;
    localStorage.setItem(KEYS.EXPORT_COUNT, count);

    return passport;
  },

  // ── FULL WIPE (only on explicit user request) ──────────────────────────────

  wipe() {
    Object.values(KEYS).forEach(k => {
      try { localStorage.removeItem(k); } catch { }
      try { localStorage.removeItem(k + '_bk'); } catch { }
    });
  },

};

// ─── STORAGE FULL HANDLER ───────────────────────────────────────────────────
function handleStorageFull() {
  window.dispatchEvent(new CustomEvent('bxp:storage-full'));
  // Try to free space by removing old backup keys
  try {
    // Remove keys from older versions
    ['v1', 'v0'].forEach(v => {
      localStorage.removeItem(`bxp_ledger_${v}`);
      localStorage.removeItem(`bxp_ledger_backup_${v}`);
    });
  } catch { }
}

// ─── SYNC DB → SERVICE WORKER ──────────────────────────────────────────────
// Keep the service worker's KV store in sync with the main thread DB
// Called after every write so SW always has current state

DB.syncToSW = function() {
  if (!navigator.serviceWorker?.controller) return;
  const state  = this.getState();
  const ledger = this.getLedger();
  navigator.serviceWorker.controller.postMessage({
    type:   'SYNC_STATE',
    state,
    ledgerLength: ledger.length,
    lastHash: ledger.length ? ledger[ledger.length - 1].hash : null,
  });
};

// ─── RECEIVE FROM SERVICE WORKER ───────────────────────────────────────────
// SW writes records in background — merge them into main thread DB

navigator.serviceWorker?.addEventListener('message', e => {
  if (!e.data) return;
  if (e.data.type === 'NEW_RECORD') {
    // SW wrote a record in background — append it to our ledger
    DB.appendRecord(e.data.record);
    // Trigger re-render
    window.dispatchEvent(new CustomEvent('bxp:new-record', { detail: e.data.record }));
  }
});

// Export for use in app.js
window.BXP_DB = DB;
window.BXP_KEYS = KEYS;
