/**
 * BXP LiveNet — app.js
 * All application logic. Zero inline scripts in HTML.
 *
 * Responsibilities:
 * - Service worker registration + communication
 * - GPS acquisition
 * - AQ fetching via proxy
 * - All BXP calculations
 * - All rendering
 * - Notification management
 * - Zone learning
 */

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const PROXY   = 'https://bxp-node.onrender.com';
const APP_URL = 'https://bxpprotocol.github.io/livenet.html';

const WHO = { PM2_5:15, PM10:45, NO2:25, O3:100, CO:4, SO2:40, TVOC:500 };
const WHOa= { PM2_5:5,  PM10:15, NO2:10, O3:60 };
const W   = { PM2_5:.35, PM10:.15, NO2:.15, O3:.12, CO:.10, SO2:.05, TVOC:.04 };
const HL  = { PM2_5:168, PM10:72, NO2:4, O3:2, CO:6, SO2:3, TVOC:8 };
const LUNG_AGING = 0.098; // yrs per µg/m³ per year above 5µg/m³ — Hansell et al 2016

const LV = {
  CLEAN:    { c:'#00E676', bg:'rgba(0,230,118,.09)',  l:'CLEAN',    a:'Air quality excellent.' },
  MODERATE: { c:'#FFEB3B', bg:'rgba(255,235,59,.09)', l:'MODERATE', a:'Acceptable for most people.' },
  ELEVATED: { c:'#FF9800', bg:'rgba(255,152,0,.09)',  l:'ELEVATED', a:'Reduce prolonged outdoor exertion.' },
  HIGH:     { c:'#F44336', bg:'rgba(244,67,54,.09)',  l:'HIGH',     a:'Reduce outdoor activity.' },
  VERY_HIGH:{ c:'#9C27B0', bg:'rgba(156,39,176,.09)', l:'VERY HIGH',a:'Avoid outdoors. N95 recommended.' },
  HAZARDOUS:{ c:'#FF1744', bg:'rgba(255,23,68,.09)',  l:'HAZARDOUS',a:'Health emergency. Stay indoors.' },
};

const gl  = h => h>90?'HAZARDOUS':h>75?'VERY_HIGH':h>60?'HIGH':h>40?'ELEVATED':h>20?'MODERATE':'CLEAN';
const col = p => p<50?'#00E676':p<100?'#FF9800':'#F44336';
const $   = id => document.getElementById(id);
const tfmt= ts => new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
const dfmt= ts => new Date(ts).toLocaleDateString([],{month:'short',day:'numeric'});
const desk= () => window.innerWidth >= 900;

// ════════════════════════════════════════════════════════════════════════════
// RUNTIME STATE (non-persisted — reconstructed each session)
// ════════════════════════════════════════════════════════════════════════════

const RT = {
  reading:  null,
  loc:      null,
  locErr:   null,
  busy:     false,
  active:   false,
  timer:    null,
  idleT:    null,
  swReady:  false,
};

// ════════════════════════════════════════════════════════════════════════════
// SERVICE WORKER
// ════════════════════════════════════════════════════════════════════════════

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    RT.swReady = true;

    // Request periodic background sync
    navigator.serviceWorker.controller?.postMessage({ type: 'REGISTER_SYNC' });

    // Listen for records written in background
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'NEW_RECORD') {
        renderNow(); renderLedger(); renderPassport();
        toast('Ledger updated in background');
      }
    });

    // Handle SW updates
    reg.addEventListener('updatefound', () => {
      const newSW = reg.installing;
      newSW?.addEventListener('statechange', () => {
        if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
          toast('BXP updated — refresh to apply');
        }
      });
    });
  } catch (err) {
    console.warn('[BXP] SW registration failed:', err);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// GEOHASH
// ════════════════════════════════════════════════════════════════════════════

function gh(lat, lng, p = 7) {
  const c = '0123456789bcdefghjkmnpqrstuvwxyz';
  let i=0, b=0, e=true, g='', lt=-90, lT=90, lg=-180, lG=180;
  while (g.length < p) {
    if (e) { const m=(lg+lG)/2; if(lng>=m){i=(i<<1)+1;lg=m;}else{i=i<<1;lG=m;} }
    else   { const m=(lt+lT)/2; if(lat>=m){i=(i<<1)+1;lt=m;}else{i=i<<1;lT=m;} }
    e=!e; if(++b===5){g+=c[i];b=0;i=0;}
  }
  return g;
}

// ════════════════════════════════════════════════════════════════════════════
// SHA-256
// ════════════════════════════════════════════════════════════════════════════

async function sha256(s) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf)).map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,16);
  } catch {
    let h=0; for(let i=0;i<s.length;i++){h=((h<<5)-h)+s.charCodeAt(i);h|=0;}
    return Math.abs(h).toString(16).padStart(16,'0');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// GPS
// ════════════════════════════════════════════════════════════════════════════

function getLoc() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) { rej({ code: 0 }); return; }
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      rej,
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

function locErrMsg(e) {
  if (!e)       return { t:'Location unavailable', r:'Could not get position.', s:['Check settings','Tap ↻'] };
  if (e.code===1) return { t:'Location blocked',    r:'BXP reads GPS directly. VPNs have no effect. Your browser is blocking access.', s:['Tap the lock icon in your address bar','Find Location → Allow','Tap ↻'] };
  if (e.code===2) return { t:'GPS unavailable',     r:'Device could not get a fix.', s:['Enable Location Services in Settings','Move near a window','Tap ↻'] };
  if (e.code===3) return { t:'Timed out',           r:'GPS took too long.', s:['Enable Location Services','Tap ↻'] };
  return { t:'Location error', r:'Unexpected error.', s:['Refresh and try again'] };
}

// ════════════════════════════════════════════════════════════════════════════
// AQ FETCH — via Render proxy (token never in frontend)
// ════════════════════════════════════════════════════════════════════════════

async function fetchAQ(lat, lng) {
  try {
    const r = await fetch(
      `${PROXY}/bxp/v2/aq?lat=${lat}&lng=${lng}`,
      { signal: AbortSignal.timeout(12000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.agents?.length) return null;
    const { hri } = calcHRI(d.agents);
    return { ...d, hri, level: gl(hri) };
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// CALCULATIONS
// ════════════════════════════════════════════════════════════════════════════

function calcHRI(agents) {
  let r = 0;
  for (const a of agents) {
    const w = W[a.id], t = WHO[a.id];
    if (w && t) r += Math.min(1, a.value / t) * w;
  }
  return { hri: Math.min(100, Math.round(r * 1000) / 10) };
}

function calcBodyLoad() {
  const ledger = BXP_DB.getLedger();
  if (!ledger.length) return { load: 0, clearH: 0 };
  const now = Date.now();
  let total = 0;
  for (const rec of ledger) {
    const ageH = (now - rec.ts) / 3600000;
    for (const a of (rec.agents || [])) {
      const hl = HL[a.id];
      if (!hl || !WHO[a.id]) continue;
      total += (Math.min(1, a.value / WHO[a.id])) * (W[a.id] || 0) * Math.pow(.5, ageH / hl);
    }
  }
  const load  = Math.min(100, Math.round(total * 100 * 10) / 10);
  const la    = (ledger[ledger.length-1]?.agents || []).map(a => HL[a.id] || 0);
  return { load, clearH: Math.round(Math.max(0, ...la) * 3.32) };
}

function calcDebt() {
  const ledger = BXP_DB.getLedger();
  const now    = Date.now();
  const recs   = ledger.filter(r => now - r.ts < 172800000).sort((a,b) => a.ts-b.ts);
  let debt = 0, clean = 0, prev = null;
  for (const r of recs) {
    if (prev) {
      const h = (r.ts - prev.ts) / 3600000;
      r.hri > 40 ? (debt += h * (r.hri / 100)) : (clean += h);
    }
    prev = r;
  }
  const net = Math.max(0, Math.round((debt - clean * .5) * 10) / 10);
  return { debt: net, recovH: Math.ceil(net * 2), lungCap: Math.max(60, Math.round(100 - net * 3)) };
}

function calcBudget() {
  const ledger  = BXP_DB.getLedger();
  const today   = new Date().toDateString();
  const pm      = ledger.filter(r => new Date(r.ts).toDateString() === today).flatMap(r => r.agents?.filter(a => a.id==='PM2_5') || []);
  const avgToday= pm.length ? Math.round(pm.reduce((s,a)=>s+a.value,0)/pm.length*10)/10 : 0;
  const pct     = Math.min(250, Math.round(avgToday / WHOa.PM2_5 * 100));
  const all     = ledger.flatMap(r => r.agents?.filter(a => a.id==='PM2_5') || []);
  const avg     = all.length ? all.reduce((s,a)=>s+a.value,0)/all.length : avgToday;
  const days    = avg > WHOa.PM2_5 ? Math.round(WHOa.PM2_5 * 365 / avg) : null;
  return { avgToday, pct, days };
}

function calcExpAge() {
  const ledger = BXP_DB.getLedger();
  const pm     = ledger.flatMap(r => r.agents?.filter(a => a.id==='PM2_5') || []);
  if (pm.length < 5) return null;
  const avg    = pm.reduce((s,a) => s+a.value, 0) / pm.length;
  const excess = Math.max(0, avg - WHOa.PM2_5);
  const span   = ledger.length > 1
    ? (ledger[ledger.length-1].ts - ledger[0].ts) / (365 * 86400000)
    : 0.05;
  return { yrs: Math.round(excess * LUNG_AGING * span * 100) / 100, avg: Math.round(avg*10)/10, excess: Math.round(excess*10)/10 };
}

function calcPattern() {
  const ledger = BXP_DB.getLedger();
  if (ledger.length < 10) return null;
  const hrs = Array(24).fill(0).map(() => ({ sum:0, n:0 }));
  for (const r of ledger) { const h = new Date(r.ts).getHours(); hrs[h].sum += r.hri; hrs[h].n++; }
  const filled = hrs.map((h,i) => h.n>0 ? { hr:i, avg:Math.round(h.sum/h.n*10)/10 } : null).filter(Boolean);
  if (filled.length < 4) return null;
  const worst = filled.reduce((a,b) => b.avg > a.avg ? b : a);
  const best  = filled.reduce((a,b) => b.avg < a.avg ? b : a);
  return { worst, best, delta: Math.round(worst.avg - best.avg) };
}

// Zone learning — silent, automatic
function updateZones(geohash, hri, city, ts) {
  const h        = new Date(ts).getHours();
  const knownGHs = BXP_DB.getKnownGHs();
  const zones    = BXP_DB.getZones();
  if (!knownGHs[geohash]) knownGHs[geohash] = { city, visits:0, totalHRI:0, hours:[] };
  const z = knownGHs[geohash];
  z.visits++; z.totalHRI += hri; z.hours.push(h);
  z.avgHRI = Math.round(z.totalHRI / z.visits * 10) / 10;
  const nh = z.hours.filter(h => h>=22||h<=7).length  / z.hours.length;
  const wh = z.hours.filter(h => h>=9&&h<=18).length  / z.hours.length;
  const ch = z.hours.filter(h => (h>=7&&h<=9)||(h>=17&&h<=19)).length / z.hours.length;
  if      (z.visits >= 5 && nh > .5) zones[geohash] = 'home';
  else if (z.visits >= 5 && wh > .6) zones[geohash] = 'work';
  else if (z.visits >= 3 && ch > .4) zones[geohash] = 'commute';
  BXP_DB.setKnownGHs(knownGHs);
  BXP_DB.setZones(zones);
}

function getZones() {
  const zones    = BXP_DB.getZones();
  const knownGHs = BXP_DB.getKnownGHs();
  return Object.entries(zones).map(([g, type]) => {
    const info = knownGHs[g];
    return info ? { geohash:g, type, city:info.city, avgHRI:info.avgHRI, visits:info.visits } : null;
  }).filter(Boolean);
}

function buildRecovery(bl, debt, zones) {
  if (bl.load < 30 && debt.debt < 1) return null;
  const h     = new Date().getHours();
  const night = h >= 20 || h <= 7;
  const home  = zones.find(z => z.type === 'home');
  const steps = [];
  if (debt.debt > 2)          steps.push({ a:'Prioritise indoor air',       d:`Debt is ${debt.debt}h. Indoors is typically 2–5× cleaner.` });
  if (bl.clearH > 0)          steps.push({ a:`${debt.recovH}h in clean air`, d:'Estimated time to clear body load below 10%.' });
  if (home && home.avgHRI<30) steps.push({ a:`Return to ${home.city}`,       d:`Your home zone avg HRI: ${home.avgHRI}.` });
  if (night)                  steps.push({ a:'Windows closed tonight',       d:'Night-time NO₂ is elevated in most cities.' });
  return steps.slice(0, 4);
}

function detectAnomalies() {
  const ledger = BXP_DB.getLedger();
  const recs   = ledger.slice(-15);
  for (let i = 2; i < recs.length; i++) {
    const prev = recs[i-1], curr = recs[i], d = curr.hri - prev.hri;
    if (d > 28 && curr.hri > 60 && Date.now() - curr.ts < 3600000) {
      const pm  = curr.agents?.find(a => a.id==='PM2_5');
      const no2 = curr.agents?.find(a => a.id==='NO2');
      let src   = 'elevated pollution source';
      if (pm  && pm.value  > 150) src = 'possible fire or burning nearby';
      else if (no2 && no2.value > 80) src = 'heavy diesel or generator exhaust';
      else if (pm  && pm.value  > 80)  src = 'cooking, construction, or traffic';
      const anoms = BXP_DB.getAnomalies();
      anoms.push({ ts:curr.ts, hri:curr.hri, city:curr.city, source:src, delta:d });
      BXP_DB.setAnomalies(anoms);
      return anoms[anoms.length-1];
    }
  }
  return null;
}

function generateDigest() {
  const ledger = BXP_DB.getLedger();
  const recs   = ledger.filter(r => Date.now()-r.ts < 86400000).sort((a,b) => a.ts-b.ts);
  if (recs.length < 2) return null;
  const lh = { CLEAN:0, MODERATE:0, ELEVATED:0, HIGH:0, VERY_HIGH:0, HAZARDOUS:0 };
  for (let i=1; i<recs.length; i++) {
    const h = (recs[i].ts - recs[i-1].ts) / 3600000;
    lh[recs[i-1].level] = (lh[recs[i-1].level]||0) + h;
  }
  const agT={}, agC={};
  for (const r of recs) for (const a of (r.agents||[])) { agT[a.id]=(agT[a.id]||0)+a.value; agC[a.id]=(agC[a.id]||0)+1; }
  const agAvg = Object.entries(agT).map(([id,t]) => ({ id, avg:Math.round(t/agC[id]*10)/10, pct:WHO[id]?Math.round(t/agC[id]/WHO[id]*100):0 })).sort((a,b)=>b.pct-a.pct);
  const moments = [];
  for (let i=1; i<recs.length; i++) {
    const d = recs[i].hri - recs[i-1].hri;
    if (Math.abs(d)>20) moments.push({ ts:recs[i].ts, text:`${d>0?'↑':'↓'} ${recs[i-1].hri} → ${recs[i].hri}`, detail:d>0?'spike':'cleared' });
  }
  const avgHRI = Math.round(recs.reduce((s,r)=>s+r.hri,0)/recs.length*10)/10;
  return { date:Date.now(), records:recs.length, lh, agAvg, moments:moments.slice(-5).reverse(), avgHRI };
}

function generateLetter() {
  const ledger = BXP_DB.getLedger();
  if (ledger.length < 5) return null;
  const now    = new Date();
  const avgHRI = Math.round(ledger.reduce((s,r)=>s+r.hri,0)/ledger.length*10)/10;
  const lc     = {};
  for (const r of ledger) lc[r.city] = (lc[r.city]||0)+1;
  const topLoc = Object.entries(lc).sort((a,b)=>b[1]-a[1])[0]?.[0] || 'your area';
  const daysAbove = new Set(ledger.filter(r=>r.hri>40).map(r=>new Date(r.ts).toDateString())).size;
  const pm    = ledger.flatMap(r=>r.agents?.filter(a=>a.id==='PM2_5')||[]);
  const avgPM = pm.length ? Math.round(pm.reduce((s,a)=>s+a.value,0)/pm.length*10)/10 : null;
  const debt  = calcDebt();
  const ea    = calcExpAge();
  const days  = new Set(ledger.map(r=>new Date(r.ts).toDateString())).size;
  const month = now.toLocaleDateString([],{month:'long',year:'numeric'});
  return {
    date: now.getTime(), month, days, avgHRI, daysAbove, avgPM,
    p1: `Over ${days} days, your average BXP Health Risk Index was <strong>${avgHRI}</strong> — <strong>${gl(avgHRI)}</strong> range. Most frequently recorded in <strong>${topLoc}</strong>.`,
    p2: daysAbove > 0
      ? `On <strong>${daysAbove} day${daysAbove>1?'s':''}</strong> your exposure crossed the elevated threshold. These accumulate. The cost compounds over years, not moments.`
      : `Exposure stayed within acceptable limits on most days. Your body had recovery time.`,
    p3: avgPM
      ? `Average PM2.5: <strong>${avgPM} µg/m³</strong>. WHO annual guideline: 5 µg/m³. ${avgPM<=5?'Within the safe limit.':avgPM<=15?`${Math.round(avgPM/5*10)/10}× above WHO guideline.`:`<strong>${Math.round(avgPM/5*10)/10}× above the WHO annual limit.</strong>`}`
      : 'Build more ledger data for a complete picture.',
    p4: ea && ea.yrs > 0.1
      ? `Based on your recorded data, your respiratory system has aged an estimated <strong>${ea.yrs} years beyond your calendar age</strong> from pollution alone. Derived from published dose-response literature applied to your personal ledger. This number has never existed for any person before.`
      : `Exposure-adjusted lung age within normal bounds. More data will sharpen this.`,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ════════════════════════════════════════════════════════════════════════════

async function askNotif() {
  if (!('Notification' in window)) return;
  const p = await Notification.requestPermission().catch(() => 'denied');
  BXP_DB.setNotif(p);
  if (p === 'granted') {
    toast('Alerts enabled');
    // Register periodic sync now that we have permission
    navigator.serviceWorker?.controller?.postMessage({ type: 'REGISTER_SYNC' });
    renderNow();
  }
}

function notify(title, body, tag = 'bxp') {
  if (BXP_DB.getNotif() !== 'granted' || !('Notification' in window)) return;
  try { new Notification(title, { body, tag, renotify: true }); } catch { }
}

function checkAlerts(aq) {
  if (aq.hri >= 60) notify(`🫁 ${aq.level} · HRI ${aq.hri}`, `${aq.city} — ${LV[aq.level]?.a||''}`, 'bxp-danger');
}

function checkDailyDigest() {
  const h     = new Date().getHours();
  const today = new Date().toDateString();
  if (h >= 21 && BXP_DB.getLastDigest() !== today && BXP_DB.getLedgerLength() > 3) {
    const d = generateDigest();
    const l = generateLetter();
    if (d) { BXP_DB.setDigest(d); notify('📊 Daily digest ready', `Avg HRI ${d.avgHRI} · ${d.records} readings — open BXP`, 'bxp-digest'); }
    if (l) { BXP_DB.setLetter(l); }
    BXP_DB.setLastDigest(today);
    renderNow();
  }
}

function checkMilestoneNotifs() {
  const ea      = calcExpAge();
  const lastEA  = BXP_DB.getLastEA();
  if (ea && ea.yrs > .1 && Math.abs(ea.yrs - lastEA) > .05) {
    notify('⏳ Exposure age updated', `Lungs estimated ${ea.yrs}y older than calendar age`, 'bxp-ea');
    BXP_DB.setLastEA(ea.yrs);
  }
  const budget = calcBudget();
  if (budget.days && budget.days < 30 && !BXP_DB.getBudgetWarn()) {
    notify('💸 Annual PM2.5 budget critical', `At current pace your WHO annual limit runs out in ${budget.days} days`, 'bxp-budget');
    BXP_DB.setBudgetWarn();
  }
}

// Idle alert — 15 min in high-exposure zone
function resetIdle() {
  clearTimeout(RT.idleT);
  RT.idleT = setTimeout(() => {
    if (RT.reading?.hri >= 60)
      notify(`Still in ${RT.reading.level} air`, `${RT.reading.city} · HRI ${RT.reading.hri} · 15 min · ${LV[RT.reading.level]?.a||''}`, 'bxp-idle');
  }, 15 * 60 * 1000);
}
['touchstart','click','keydown','mousemove'].forEach(e => document.addEventListener(e, resetIdle, { passive:true }));

// ════════════════════════════════════════════════════════════════════════════
// LEDGER WRITE
// ════════════════════════════════════════════════════════════════════════════

async function maybeWrite(loc, aq) {
  const state = BXP_DB.getState();
  const nowGH = gh(loc.lat, loc.lng, 7);
  const now   = Date.now();
  const sinceMin = (now - state.lastRT) / 60000;

  if (nowGH === state.lastGH && Math.abs(aq.hri - state.lastHRI) < 10 && sinceMin < 60) return false;

  const ledger   = BXP_DB.getLedger();
  const prevHash = ledger.length ? ledger[ledger.length-1].hash : '0000000000000000';
  const hash     = await sha256(prevHash + JSON.stringify({ seq:ledger.length, ts:now, gh:nowGH, hri:aq.hri }));

  const bl     = calcBodyLoad();
  const debt   = calcDebt();
  const budget = calcBudget();

  const record = {
    bxpVersion: '2.0',
    fileType:   'reading',
    seq:        ledger.length,
    ts:         now,
    geohash:    nowGH,
    city:       aq.city,
    lat:        Math.round(loc.lat * 10000) / 10000,
    lng:        Math.round(loc.lng * 10000) / 10000,
    agents:     aq.agents,
    hri:        aq.hri,
    level:      aq.level,
    prevHash,
    hash,
    quality:    { flag:'UNVALIDATED', confidence:.75, source:'AQICN' },
    insights:   { bodyLoad:bl.load, debtH:debt.debt, lungBudgetPct:budget.pct },
  };

  BXP_DB.appendRecord(record);
  BXP_DB.incContrib();
  BXP_DB.setState({ lastGH:nowGH, lastHRI:aq.hri, lastRT:now });
  updateZones(nowGH, aq.hri, aq.city, now);

  // Sync position to service worker for background reads
  navigator.serviceWorker?.controller?.postMessage({
    type: 'SYNC_STATE',
    state: { lat:loc.lat, lng:loc.lng, lastGH:nowGH, lastHRI:aq.hri, lastRT:now },
  });

  return true;
}

// ════════════════════════════════════════════════════════════════════════════
// READ CYCLE
// ════════════════════════════════════════════════════════════════════════════

async function doRead(force = false) {
  if (RT.busy && !force) return;
  RT.busy   = true;
  RT.locErr = null;

  const dot = $('sdot'), txt = $('stext'), rb = $('rbtn');
  dot.className = 'sdot off'; txt.textContent = 'Reading';
  if (rb) { rb.classList.add('spin'); rb.disabled = true; }

  try {
    const loc = await getLoc();
    RT.loc    = loc;
    const aq  = await fetchAQ(loc.lat, loc.lng);
    if (!aq)  { dot.className='sdot err'; txt.textContent='No data'; return; }

    RT.reading    = aq;
    const wrote   = await maybeWrite(loc, aq);
    if (wrote) {
      checkAlerts(aq);
      detectAnomalies();
      checkMilestoneNotifs();
    }
    dot.className = 'sdot'; txt.textContent = 'Live';
    updateSBStats();
    renderNow(); renderLedger(); renderPassport();
    checkDailyDigest(); resetIdle();

  } catch (err) {
    RT.locErr     = err;
    dot.className = 'sdot err'; txt.textContent = 'Blocked';
    renderNow();
  } finally {
    RT.busy = false;
    if (rb) { rb.classList.remove('spin'); rb.disabled = false; }
  }
}

async function manualRead() { await doRead(true); toast('Updated'); }

function updateSBStats() {
  const c  = $('sb-cnt'), ch = $('sb-chain');
  if (c)  c.textContent  = `${BXP_DB.getLedgerLength()} records`;
  if (ch) {
    const { valid } = BXP_DB.verifyChain();
    ch.textContent  = `Chain: ${valid ? 'verified' : 'error'}`;
    ch.style.color  = valid ? 'var(--ac)' : 'var(--da)';
  }
}

// ════════════════════════════════════════════════════════════════════════════
// RENDER: NOW
// ════════════════════════════════════════════════════════════════════════════

function renderNow() {
  const el = $('cn'); let h = '';

  if (RT.locErr) {
    const e = locErrMsg(RT.locErr);
    h += `<div class="le"><div class="le-tit">⚠ ${e.t}</div><div class="le-bod">${e.r}</div><div class="le-st">`;
    e.s.forEach((s,i) => { h += `<div class="le-s"><div class="le-sn">${i+1}.</div><div>${s}</div></div>`; });
    h += `</div><button class="retry" onclick="doRead(true)">Try Again</button></div>`;
    el.innerHTML = h; return;
  }

  if (!RT.reading) {
    el.innerHTML = `<div style="height:55vh;display:flex;align-items:center;justify-content:center"><div style="font-family:var(--mono);font-size:.67rem;color:var(--m2);line-height:1.9;text-align:center">Acquiring GPS...<br>Allow location access when prompted.</div></div>`;
    return;
  }

  const r   = RT.reading, L = LV[r.level] || LV.CLEAN;
  const bl  = calcBodyLoad(), debt = calcDebt(), budget = calcBudget();
  const ea  = calcExpAge(), zones = getZones(), rec = buildRecovery(bl, debt, zones);
  const pat = calcPattern();
  const anom= BXP_DB.getAnomalies().find(a => Date.now()-a.ts < 3600000);
  const d   = desk();

  // Notif prompt
  if (BXP_DB.getNotif() === 'default') {
    h += `<div class="np"><div style="font-size:1rem;flex-shrink:0">🔔</div><div><div class="np-t">Enable alerts</div><div class="np-b">Daily digest at 9pm. Immediate alert in dangerous air. Milestone insights delivered silently when your data crosses a threshold.</div><button class="np-btn" onclick="askNotif()">Enable</button></div></div>`;
  }

  // Anomaly
  if (anom) {
    h += `<div class="card anom cp"><div class="ey" style="color:var(--da)">⚠ Spike · ${tfmt(anom.ts)}</div><div class="ct" style="color:var(--da)">HRI jumped to ${anom.hri}</div><div class="cb">${anom.source} near ${anom.city}.</div></div>`;
  }

  // Body load + current reading
  if (d) h += `<div class="g2">`;
  const circ = 2*Math.PI*54, off = circ*(1-bl.load/100), blC = col(bl.load);
  h += `<div class="card"><div class="bl-wrap">
    <div class="bl-ring"><svg class="bl-svg" viewBox="0 0 120 120"><circle class="bl-tr" cx="60" cy="60" r="54"/><circle class="bl-fi" cx="60" cy="60" r="54" stroke="${blC}" stroke-dasharray="${circ}" stroke-dashoffset="${off}"/></svg><div class="bl-cen"><div class="bl-num" style="color:${blC}">${bl.load}</div><div class="bl-sub">BODY LOAD</div></div></div>
    <div><div class="ct">Pollutant burden</div><div class="cb">${bl.load<20?'Your body has cleared most recent exposure.':bl.load<50?`Processing. <strong>${bl.clearH}h</strong> in clean air to clear.`:`High burden. <strong>~${bl.clearH}h</strong> clean air needed.`}</div></div>
  </div></div>`;
  h += `<div class="card cp"><div class="ey">${tfmt(Date.now())} · ${r.city}</div>
    <div class="hri-row"><div class="hri-n" style="color:${L.c}">${r.hri}</div><div><div class="hri-badge" style="background:${L.bg};color:${L.c}">${L.l}</div><div class="hri-adv">${L.a}</div></div></div>
    <div class="bar-t"><div class="bar-f" style="width:${r.hri}%;background:${L.c}"></div></div>
    <div class="ags">`;
  for (const a of r.agents) { const t=WHO[a.id], p=t?Math.min(100,Math.round(a.value/t*100)):0, c=col(p); h+=`<div class="ag"><div class="ag-id">${a.id}</div><div class="ag-v" style="color:${c}">${a.value.toFixed(1)}</div><div class="ag-p" style="color:${c}">${p}%</div></div>`; }
  h += `</div><div class="loc-row"><span>📍</span><div><div class="loc-n">${r.city}</div><div class="loc-s">${RT.loc?.lat?.toFixed(4)}°, ${RT.loc?.lng?.toFixed(4)}° · ${gh(RT.loc?.lat||0,RT.loc?.lng||0,7)}</div></div></div></div>`;
  if (d) h += `</div><div class="g2">`;

  // Exposure age
  if (ea) { const ac=ea.yrs>0?'var(--wa)':'var(--ac)'; h+=`<div class="card cp"><div class="ey">Exposure Age</div><div style="font-family:var(--serif);font-size:2.4rem;line-height:1;color:${ac};margin-bottom:.5rem">+${ea.yrs}<span style="font-family:var(--mono);font-size:.62rem;color:var(--m2);margin-left:.4rem">yrs</span></div><div class="cb">Lung aging beyond calendar age. Avg PM2.5: <strong>${ea.avg} µg/m³</strong> · <strong>${ea.excess}</strong> above safe limit. Derived from Hansell et al. 2016 applied to your personal ledger.</div></div>`; }

  // Budget
  const bc=budget.pct<100?'var(--ac)':budget.pct<150?'var(--wa)':'var(--da)';
  h += `<div class="card cp"><div class="ey">Daily Lung Budget · PM2.5</div><div class="bud-gauge"><div class="bud-fill" style="width:${Math.min(100,budget.pct)}%;background:${bc}"></div></div><div class="bud-grid"><div class="bs"><div class="bs-n" style="color:${bc}">${budget.avgToday}</div><div class="bs-l">µg/m³ today</div></div><div class="bs"><div class="bs-n" style="color:${bc}">${budget.pct}%</div><div class="bs-l">of WHO limit</div></div><div class="bs"><div class="bs-n" style="color:${budget.days?'var(--da)':'var(--ac)'}">${budget.days||'∞'}</div><div class="bs-l">days to annual cap</div></div></div></div>`;

  if (d) h += `</div><div class="g2">`;

  // Debt
  const dc=debt.debt<1?'var(--ac)':debt.debt<3?'var(--wa)':'var(--da)';
  h += `<div class="card cp"><div class="ey">Exposure Debt</div><div style="display:flex;align-items:flex-end;gap:.25rem;margin-bottom:.5rem"><div style="font-family:var(--mono);font-size:2rem;font-weight:700;color:${dc}">${debt.debt}</div><div style="font-family:var(--mono);font-size:.6rem;color:var(--m2);margin-bottom:.28rem">hours</div></div><div class="bar-t"><div class="bar-f" style="width:${Math.min(100,debt.debt*20)}%;background:${dc}"></div></div><div class="cb">${debt.debt<.5?'No debt. Recent exposure within safe limits.':`Lungs at estimated <strong>${debt.lungCap}% capacity</strong>. <strong>${debt.recovH}h</strong> in clean air to recover.`}</div></div>`;

  // Hourly pattern
  if (pat) {
    h += `<div class="card cp"><div class="ey">Your Exposure Pattern</div><div style="display:flex;gap:.625rem;margin-top:.25rem">
      <div style="flex:1;background:rgba(255,68,102,.06);border:1px solid rgba(255,68,102,.2);border-radius:8px;padding:.75rem;text-align:center"><div style="font-family:var(--mono);font-size:1.3rem;font-weight:700;color:var(--da)">${pat.worst.avg}</div><div style="font-family:var(--mono);font-size:.53rem;color:var(--m2);margin-top:.1rem">${pat.worst.hr}:00</div><div style="font-size:.68rem;color:var(--m2);margin-top:.2rem">worst hour</div></div>
      <div style="flex:1;background:rgba(0,230,118,.06);border:1px solid rgba(0,230,118,.2);border-radius:8px;padding:.75rem;text-align:center"><div style="font-family:var(--mono);font-size:1.3rem;font-weight:700;color:var(--ac)">${pat.best.avg}</div><div style="font-family:var(--mono);font-size:.53rem;color:var(--m2);margin-top:.1rem">${pat.best.hr}:00</div><div style="font-size:.68rem;color:var(--m2);margin-top:.2rem">cleanest hour</div></div>
    </div>${pat.delta>20?`<div class="cb" style="margin-top:.75rem">Air quality swings <strong>${pat.delta} HRI points</strong> across the day. Timing your outdoor activity matters.</div>`:''}</div>`;
  }

  if (d) h += `</div>`;

  // Zones
  if (zones.length > 1) {
    const ic = { home:'🏠', work:'🏢', commute:'🚶' };
    h += `<div class="card cp"><div class="ey">Your exposure zones</div><div class="zone-list">`;
    for (const z of zones) { h+=`<div class="zone-row"><div class="zone-ic">${ic[z.type]||'📍'}</div><div><div class="zone-n">${z.city} <span style="font-family:var(--mono);font-size:.5rem;color:var(--m2)">${z.type}</span></div><div class="zone-s">${z.visits} readings</div></div><div class="zone-hri" style="color:${col(z.avgHRI)}">${z.avgHRI}</div></div>`; }
    h += `</div></div>`;
  }

  // Recovery
  if (rec) {
    h += `<div class="card cp"><div class="ey">Recovery Protocol</div><div class="ps-list">`;
    for (const s of rec) { h+=`<div class="ps-row"><div class="ps-arr">→</div><div class="ps-t"><strong>${s.a}</strong><br><span>${s.d}</span></div></div>`; }
    h += `</div></div>`;
  }

  // Digest
  const dg = BXP_DB.getDigest();
  if (dg) {
    h += `<div class="card"><div class="cp"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem"><div class="ey" style="margin:0">Daily Digest</div><div style="font-family:var(--mono);font-size:.55rem;color:var(--m2)">${dfmt(dg.date)}</div></div>
    <div class="dig-hrs"><div class="dh"><div class="dh-v" style="color:#00E676">${Math.round((dg.lh.CLEAN||0)*10)/10}h</div><div class="dh-l">CLEAN</div></div><div class="dh"><div class="dh-v" style="color:#FFEB3B">${Math.round((dg.lh.MODERATE||0)*10)/10}h</div><div class="dh-l">MOD</div></div><div class="dh"><div class="dh-v" style="color:#FF9800">${Math.round(((dg.lh.ELEVATED||0)+(dg.lh.HIGH||0))*10)/10}h</div><div class="dh-l">HIGH</div></div><div class="dh"><div class="dh-v" style="color:var(--m2)">${dg.avgHRI}</div><div class="dh-l">AVG</div></div></div>`;
    if (dg.agAvg?.length) { for(const a of dg.agAvg.slice(0,4)){const c=col(a.pct);h+=`<div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.3rem"><div style="font-family:var(--mono);font-size:.6rem;font-weight:700;min-width:46px">${a.id}</div><div style="flex:1;height:3px;background:var(--bd);border-radius:999px;overflow:hidden"><div style="height:100%;width:${Math.min(100,a.pct)}%;background:${c};border-radius:999px"></div></div><div style="font-family:var(--mono);font-size:.56rem;color:${c};min-width:28px;text-align:right">${a.pct}%</div></div>`;} }
    h += `</div>`;
    if (dg.moments?.length) { h+=`<div class="div"></div><div class="cp" style="padding-top:.875rem">`; for(const m of dg.moments){h+=`<div class="mom-row"><div class="mom-t">${tfmt(m.ts)}</div><div class="mom-tx">${m.text} <span>— ${m.detail}</span></div></div>`;} h+=`</div>`; }
    h += `</div>`;
  }

  // Monthly letter
  const ml = BXP_DB.getLetter();
  if (ml) {
    h += `<div class="card cp"><div class="let-to">Your exposure record · ${ml.month}</div><div class="let-sub">A letter about the air<br>you breathed.</div><div class="let-body"><p>${ml.p1}</p><p>${ml.p2}</p><p>${ml.p3}</p><p>${ml.p4}</p></div><div class="let-sig">— BXP LiveNet · ${new Date(ml.date).toLocaleDateString()}<br>DOI: 10.5281/zenodo.18906812 · Apache 2.0</div></div>`;
  }

  el.innerHTML = h;
}

// ════════════════════════════════════════════════════════════════════════════
// RENDER: LEDGER
// ════════════════════════════════════════════════════════════════════════════

function renderLedger() {
  const el = $('cl');
  const ledger = BXP_DB.getLedger();
  if (!ledger.length) { el.innerHTML=`<div style="padding:3rem;text-align:center;font-family:var(--mono);font-size:.67rem;color:var(--mu);line-height:1.9;background:var(--sf);border:1px solid var(--bd);border-radius:12px">No records yet.<br><br>BXP writes a record when you move<br>or air quality changes significantly.<br><br>Every record is SHA-256 chained<br>to the one before it.</div>`; return; }
  const { valid } = BXP_DB.verifyChain();
  let h = `<div style="background:var(--sf);border:1px solid ${valid?'rgba(0,255,136,.2)':'rgba(255,68,102,.3)'};border-radius:10px;padding:.7rem 1rem;display:flex;align-items:center;gap:.625rem;margin-bottom:.625rem"><div>${valid?'✓':'⚠'}</div><div><div style="font-size:.77rem;font-weight:700;color:${valid?'var(--ac)':'var(--da)'}">${valid?'Chain integrity verified':'Chain error detected'}</div><div style="font-family:var(--mono);font-size:.53rem;color:var(--m2)">${ledger.length} records · SHA-256</div></div></div><div class="led-list">`;
  for (const rec of [...ledger].reverse().slice(0, 100)) {
    const lv = LV[rec.level] || LV.CLEAN;
    h += `<div class="li"><div class="li-sc" style="color:${lv.c}">${rec.hri}</div><div class="li-in"><div class="li-lc">${rec.city}</div><div class="li-mt"><span>#${rec.seq}</span><span>${dfmt(rec.ts)} ${tfmt(rec.ts)}</span><span style="opacity:.5">sha:${rec.hash}</span></div></div><div class="li-bd" style="background:${lv.bg};color:${lv.c}">${lv.l}</div></div>`;
  }
  h += `</div>`;
  el.innerHTML = h;
}

// ════════════════════════════════════════════════════════════════════════════
// RENDER: PASSPORT
// ════════════════════════════════════════════════════════════════════════════

function renderPassport() {
  const el     = $('cpp');
  const ledger = BXP_DB.getLedger();
  if (!ledger.length) { el.innerHTML=`<div style="padding:3rem;text-align:center;font-family:var(--mono);font-size:.67rem;color:var(--mu);line-height:1.9;background:var(--sf);border:1px solid var(--bd);border-radius:12px">Your passport is being built.<br><br>Every location adds to<br>your permanent record.</div>`; return; }
  const avg  = Math.round(ledger.reduce((s,r)=>s+r.hri,0)/ledger.length*10)/10;
  const peak = Math.max(...ledger.map(r=>r.hri));
  const L    = LV[gl(avg)];
  const days = new Set(ledger.map(r=>new Date(r.ts).toDateString())).size;
  const bl   = calcBodyLoad(), debt=calcDebt(), ea=calcExpAge();
  const agT={}, agC={};
  for(const r of ledger) for(const a of(r.agents||[])){agT[a.id]=(agT[a.id]||0)+a.value;agC[a.id]=(agC[a.id]||0)+1;}
  const avgs = Object.entries(agT).map(([id,t])=>({id,pct:WHO[id]?Math.min(100,Math.round(t/agC[id]/WHO[id]*100)):0})).sort((a,b)=>b.pct-a.pct);
  let h = `<div class="card cp"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;padding-bottom:.875rem;border-bottom:1px solid var(--bd)"><div style="font-size:.95rem;font-weight:700">Exposure Passport</div><div style="font-family:var(--mono);font-size:.55rem;padding:.18rem .45rem;background:rgba(0,255,136,.07);border:1px solid rgba(0,255,136,.18);border-radius:999px;color:var(--ac)">BXP v2.0</div></div>
    <div class="bud-grid" style="margin-bottom:1rem"><div class="bs"><div class="bs-n">${ledger.length}</div><div class="bs-l">Records</div></div><div class="bs"><div class="bs-n">${days}</div><div class="bs-l">Days</div></div><div class="bs"><div class="bs-n">${peak}</div><div class="bs-l">Peak HRI</div></div></div>
    <div style="background:var(--bg);border-radius:9px;padding:.875rem;margin-bottom:.875rem"><div style="font-family:var(--mono);font-size:.53rem;color:var(--m2);letter-spacing:.1em;text-transform:uppercase;margin-bottom:.3rem">Lifetime avg BXP_HRI</div><div style="font-family:var(--mono);font-size:1.5rem;font-weight:700;color:${L.c}">${avg}</div><div style="font-size:.68rem;color:var(--m2);margin-top:.2rem">${L.l}${ea?` · Exp. Age +${ea.yrs}y`:''} · Body Load ${bl.load} · Debt ${debt.debt}h</div></div>
    <button class="sec-btn ac-btn" onclick="exportPassport()">Export full ledger as .bxp.json</button></div>`;
  if (avgs.length) {
    h += `<div class="card"><div style="padding:.7rem 1.25rem;border-bottom:1px solid var(--bd);font-family:var(--mono);font-size:.53rem;color:var(--m2);letter-spacing:.1em;text-transform:uppercase">Lifetime avg vs WHO limits</div>`;
    for(const a of avgs){const c=col(a.pct);h+=`<div style="padding:.6rem 1.25rem;border-bottom:1px solid var(--bd);display:flex;align-items:center;gap:.75rem"><div style="font-family:var(--mono);font-size:.68rem;font-weight:700;min-width:46px">${a.id}</div><div style="flex:1;height:3px;background:var(--bd);border-radius:999px;overflow:hidden"><div style="height:100%;width:${a.pct}%;background:${c};border-radius:999px"></div></div><div style="font-family:var(--mono);font-size:.56rem;color:${c};min-width:28px;text-align:right">${a.pct}%</div></div>`;}
    h += `</div>`;
  }
  h += `<button class="sec-btn" onclick="genAll()">Generate Monthly Letter + Digest</button>`;
  el.innerHTML = h;
}

// ════════════════════════════════════════════════════════════════════════════
// RENDER: SHARE
// ════════════════════════════════════════════════════════════════════════════

function renderShare() {
  $('csh').innerHTML = `
  <div class="card cp" style="margin-bottom:1rem">
    <div class="ey">Network contributions</div>
    <div style="font-family:var(--mono);font-size:2.5rem;font-weight:700;color:var(--ac)">${BXP_DB.getContrib()}</div>
    <div style="font-size:.7rem;color:var(--m2);margin-top:.2rem">BXP records in your ledger</div>
  </div>
  <div class="share-warn"><strong>Review before sharing.</strong> Your readings are personal health data. Each option below shows you exactly what will be shared before anything leaves your device.</div>
  <div class="share-opts">
    <div class="sopt" onclick="confirmShare('wa')"><div class="sopt-ic">💬</div><div class="sopt-inf"><div class="sopt-t">Share current reading</div><div class="sopt-d">City and HRI on WhatsApp — confirm before sending</div></div><div class="sopt-arr">›</div></div>
    <div class="sopt" onclick="copyLink()"><div class="sopt-ic">🔗</div><div class="sopt-inf"><div class="sopt-t">Copy app link</div><div class="sopt-d">The BXP URL only — zero personal data</div></div><div class="sopt-arr">›</div></div>
    <div class="sopt" onclick="showQR()"><div class="sopt-ic">⬛</div><div class="sopt-inf"><div class="sopt-t">QR code</div><div class="sopt-d">Opens the app — not your data</div></div><div class="sopt-arr">›</div></div>
    <div class="sopt" onclick="exportPassport()"><div class="sopt-ic">📦</div><div class="sopt-inf"><div class="sopt-t">Export full ledger</div><div class="sopt-d">Download your .bxp.json passport — for doctors, research, or personal archive</div></div><div class="sopt-arr">›</div></div>
  </div>`;
}

// ════════════════════════════════════════════════════════════════════════════
// SHARE — confirmation before anything leaves the device
// ════════════════════════════════════════════════════════════════════════════

let _pendingShare = null;

function confirmShare(type) {
  const r = RT.reading;
  if (type === 'wa') {
    const txt = r ? `🫁 My air right now — ${r.city}\nBXP HRI: ${r.hri} (${r.level})\n\nTrack yours: ${APP_URL}` : APP_URL;
    $('sm-title').textContent = 'Share on WhatsApp?';
    $('sm-body').textContent  = 'Your city and HRI score will be visible to the recipient.';
    $('sm-prev').textContent  = txt;
    $('sm-ok').textContent    = 'Send on WhatsApp';
    _pendingShare = () => { window.open(`https://wa.me/?text=${encodeURIComponent(txt)}`, '_blank'); closeSM(); };
    $('sm-ok').onclick = _pendingShare;
    $('sm').classList.add('show');
  }
}

function closeSM()   { $('sm').classList.remove('show'); _pendingShare = null; }
function copyLink()  { navigator.clipboard.writeText(APP_URL).then(() => toast('Link copied — no personal data')); }
function showQR()    { $('qrbox').innerHTML=`<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(APP_URL)}" width="200" height="200" style="display:block" alt="QR">`; $('qrm').classList.add('show'); }

function exportPassport() {
  const ea     = calcExpAge();
  const bl     = calcBodyLoad();
  const debt   = calcDebt();
  const budget = calcBudget();
  const ledger = BXP_DB.getLedger();
  BXP_DB.exportPassport({
    exposureAge:    ea,
    bodyLoad:       bl.load,
    debtH:          debt.debt,
    budgetPct:      budget.pct,
    lifetimeAvgHRI: ledger.length ? Math.round(ledger.reduce((s,r)=>s+r.hri,0)/ledger.length*10)/10 : 0,
  });
  toast('Exported — insights embedded in file');
}

function genAll() {
  BXP_DB.setDigest(generateDigest());
  BXP_DB.setLetter(generateLetter());
  go('now', document.querySelector('.sni,.bni'));
  document.querySelectorAll('.sni,.bni').forEach((n,i) => n.classList.toggle('act', i===0));
  renderNow();
  toast('Generated — scroll down in Now');
}

// ════════════════════════════════════════════════════════════════════════════
// STORAGE EVENTS
// ════════════════════════════════════════════════════════════════════════════

window.addEventListener('bxp:storage-full', () => {
  toast('Storage full — exporting your ledger now');
  exportPassport();
});

window.addEventListener('bxp:milestone', e => {
  const { count } = e.detail;
  if ([100, 500, 1000].includes(count)) {
    toast(`${count} records — export your .bxp.json to keep a permanent copy`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// NAV
// ════════════════════════════════════════════════════════════════════════════

function go(t, btn) {
  document.querySelectorAll('.scr').forEach(s => s.classList.remove('act'));
  document.querySelectorAll('.sni,.bni').forEach(n => n.classList.remove('act'));
  $('scr-' + t).classList.add('act');
  if (btn) btn.classList.add('act');
  if (t === 'share') renderShare();
}

// ════════════════════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════════════════════

function showShell() {
  $('scr-entry').classList.remove('act');
  $('scr-now').classList.add('act');
  if (desk()) { $('sidebar').style.display='flex'; $('nav').style.display='none'; }
  else        { $('nav').style.display='flex'; $('sidebar').style.display='none'; }
}

async function startApp() {
  showShell();
  setLoad(true, 'Reading location...');
  await registerSW();
  await doRead(true);
  setLoad(false);
  RT.timer  = setInterval(() => doRead(false), 5 * 60 * 1000);
  RT.active = true;
  BXP_DB.setStarted();
}

// Resume if previously started
if (BXP_DB.isStarted()) {
  setTimeout(async () => {
    showShell();
    updateSBStats();
    renderNow(); renderLedger(); renderPassport();
    await registerSW();
    await doRead(true);
    RT.timer  = setInterval(() => doRead(false), 5 * 60 * 1000);
    RT.active = true;
  }, 80);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && RT.active) doRead(false); });

window.addEventListener('resize', () => {
  if (!RT.active) return;
  if (desk()) { $('sidebar').style.display='flex'; $('nav').style.display='none'; }
  else        { $('nav').style.display='flex'; $('sidebar').style.display='none'; }
});

// ════════════════════════════════════════════════════════════════════════════
// UTILITY
// ════════════════════════════════════════════════════════════════════════════

function toast(m) { const t=$('tst'); t.textContent=m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),3200); }
function setLoad(s,t='') { $('lov').classList.toggle('show',s); $('ltxt').textContent=t; }
