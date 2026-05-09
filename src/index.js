// Closer Schedule Dashboard — Cloudflare Worker
// Per-campaign daily availability board with PIN auth, 15-min granularity,
// pre-submit + day-of confirm, manager Gantt view in Central Time.

const CT = 'America/Chicago';
const SLOT_MINUTES = 15;
const SLOTS_PER_DAY = 96; // 24h * 4
const SESSION_TTL = 300;
const PIN_BAN_TTL = 900;
const PIN_BAN_THRESHOLD = 5;
const DAY_TTL = 9 * 24 * 3600;
const VIEW_AHEAD_DAYS = 7;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // ─── API routes ───
      if (path === '/api/auth' && method === 'POST') return apiAuth(request, env);
      if (path === '/api/save' && method === 'POST') return apiSave(request, env);
      if (path === '/api/confirm' && method === 'POST') return apiConfirm(request, env);

      const stateMatch = path.match(/^\/api\/state\/([^/]+)\/(\d{4}-\d{2}-\d{2})(?:\/([^/]+))?$/);
      if (stateMatch && method === 'GET') {
        return apiState(env, stateMatch[1], stateMatch[2], stateMatch[3]);
      }

      // ─── HTML routes ───
      const closerMatch = path.match(/^\/c\/([^/]+)\/closer\/([^/]+)$/);
      if (closerMatch && method === 'GET') {
        return htmlCloser(env, closerMatch[1], closerMatch[2], url);
      }

      const masterMatch = path.match(/^\/c\/([^/]+)\/master\/([^/]+)$/);
      if (masterMatch && method === 'GET') {
        return htmlMaster(env, masterMatch[1], masterMatch[2]);
      }

      const landingMatch = path.match(/^\/c\/([^/]+)\/?$/);
      if (landingMatch && method === 'GET') {
        return htmlLanding(env, landingMatch[1]);
      }

      if (path === '/' && method === 'GET') {
        return new Response('Closer Schedule Dashboard. Add /c/{campaign} to URL.', {
          status: 200, headers: { 'Content-Type': 'text/plain' }
        });
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      return new Response(`Error: ${err.message}`, { status: 500 });
    }
  }
};

// ═══════════════════════════════════════════════════════════════════
// Crypto + auth
// ═══════════════════════════════════════════════════════════════════

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(bytes = 16) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

async function getCampaign(env, slug) {
  const raw = await env.SCHEDULE_KV.get(`cfg:campaign:${slug}`);
  return raw ? JSON.parse(raw) : null;
}

async function checkSession(env, token) {
  if (!token) return null;
  const raw = await env.SCHEDULE_KV.get(`session:${token}`);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function ipBanned(env, campaign, ip) {
  const v = await env.SCHEDULE_KV.get(`ratelimit:pin:${campaign}:${ip}`);
  if (!v) return false;
  return parseInt(v, 10) >= PIN_BAN_THRESHOLD;
}

async function ipFail(env, campaign, ip) {
  const key = `ratelimit:pin:${campaign}:${ip}`;
  const cur = parseInt(await env.SCHEDULE_KV.get(key) || '0', 10);
  await env.SCHEDULE_KV.put(key, String(cur + 1), { expirationTtl: PIN_BAN_TTL });
}

// ═══════════════════════════════════════════════════════════════════
// Time zone math
// ═══════════════════════════════════════════════════════════════════

// Get wall-clock parts for a Date in a given TZ.
function partsInTz(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(date)) p[type] = value;
  return {
    year: parseInt(p.year, 10),
    month: parseInt(p.month, 10),
    day: parseInt(p.day, 10),
    hour: parseInt(p.hour, 10) % 24,
    minute: parseInt(p.minute, 10),
    second: parseInt(p.second, 10)
  };
}

// Compute the UTC instant that corresponds to a given wall-clock time in a given TZ.
// Iterates twice to handle DST transitions.
function utcFromWallClock(year, month, day, hour, minute, tz) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 2; i++) {
    const p = partsInTz(new Date(guess), tz);
    const targetMs = Date.UTC(year, month - 1, day, hour, minute, 0);
    const guessMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    const drift = targetMs - guessMs;
    if (drift === 0) return guess;
    guess += drift;
  }
  return guess;
}

// Convert wall-clock (date+slotIndex) in srcTz → list of (CT date, CT slot index).
// One source slot may map to one CT slot (always — slot is 15min, no DST 15min jump).
function srcSlotToCt(dateStr, slotIdx, srcTz) {
  const [y, m, d] = dateStr.split('-').map(n => parseInt(n, 10));
  const hh = Math.floor(slotIdx / 4);
  const mm = (slotIdx % 4) * 15;
  const utcMs = utcFromWallClock(y, m, d, hh, mm, srcTz);
  const ctParts = partsInTz(new Date(utcMs), CT);
  const ctDateStr = `${String(ctParts.year).padStart(4, '0')}-${String(ctParts.month).padStart(2, '0')}-${String(ctParts.day).padStart(2, '0')}`;
  const ctSlot = ctParts.hour * 4 + Math.floor(ctParts.minute / 15);
  return { date: ctDateStr, slot: ctSlot };
}

// Inverse: CT date+slot → wall-clock in destTz, returns { date, slot }.
function ctSlotToTz(ctDateStr, ctSlotIdx, destTz) {
  const [y, m, d] = ctDateStr.split('-').map(n => parseInt(n, 10));
  const hh = Math.floor(ctSlotIdx / 4);
  const mm = (ctSlotIdx % 4) * 15;
  const utcMs = utcFromWallClock(y, m, d, hh, mm, CT);
  const tzParts = partsInTz(new Date(utcMs), destTz);
  const dateStr = `${String(tzParts.year).padStart(4, '0')}-${String(tzParts.month).padStart(2, '0')}-${String(tzParts.day).padStart(2, '0')}`;
  const slot = tzParts.hour * 4 + Math.floor(tzParts.minute / 15);
  return { date: dateStr, slot };
}

// "Today" in CT, ISO date.
function ctToday() {
  const p = partsInTz(new Date(), CT);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function addDaysIso(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(n => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════
// API: auth
// ═══════════════════════════════════════════════════════════════════

async function apiAuth(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const body = await request.json().catch(() => ({}));
  const { campaign, closerSlug, pin } = body;

  if (!campaign || !closerSlug || !pin) {
    return jsonResp({ ok: false, error: 'missing fields' }, 400);
  }
  if (await ipBanned(env, campaign, ip)) {
    return jsonResp({ ok: false, error: 'too many attempts, try again later' }, 429);
  }

  const cfg = await getCampaign(env, campaign);
  if (!cfg) return jsonResp({ ok: false, error: 'campaign not found' }, 404);

  const closer = cfg.closers.find(c => c.slug === closerSlug);
  if (!closer) return jsonResp({ ok: false, error: 'closer not found' }, 404);

  const pinHash = await sha256Hex(`${campaign}:${closerSlug}:${pin}`);
  if (pinHash !== closer.pinHash) {
    await ipFail(env, campaign, ip);
    return jsonResp({ ok: false, error: 'wrong pin' }, 401);
  }

  const token = randomToken(16);
  await env.SCHEDULE_KV.put(`session:${token}`, JSON.stringify({
    campaign, closerSlug, exp: Date.now() + SESSION_TTL * 1000
  }), { expirationTtl: SESSION_TTL });

  return jsonResp({ ok: true, token, defaultTz: closer.defaultTz || CT, name: closer.name });
}

// ═══════════════════════════════════════════════════════════════════
// API: save
// Body: { token, date (in srcTz), srcTz, slots: [int 0..95 in srcTz], notes }
// Effect: converts to CT slots, writes to day:{campaign}:{ctDate}:{slug}.
//         Range may straddle two CT dates → writes both keys with relevant slots.
// ═══════════════════════════════════════════════════════════════════

async function apiSave(request, env) {
  const body = await request.json().catch(() => ({}));
  const { token, date, srcTz, slots, notes } = body;

  const sess = await checkSession(env, token);
  if (!sess) return jsonResp({ ok: false, error: 'session expired' }, 401);
  if (!date || !srcTz || !Array.isArray(slots)) {
    return jsonResp({ ok: false, error: 'missing fields' }, 400);
  }

  // Map src slots → CT (date, slot) pairs.
  const byCtDate = new Map();
  for (const s of slots) {
    if (typeof s !== 'number' || s < 0 || s >= SLOTS_PER_DAY) continue;
    const { date: ctDate, slot: ctSlot } = srcSlotToCt(date, s, srcTz);
    if (!byCtDate.has(ctDate)) byCtDate.set(ctDate, new Set());
    byCtDate.get(ctDate).add(ctSlot);
  }

  // We also need to *clear* prior slots that the user removed.
  // Strategy: for each CT date this submission touches, REPLACE that closer's slot list
  // with what was submitted, but only if the source date+srcTz could land slots there.
  // For straddle handling: a save for src date "2026-05-09" in PT can land slots on
  // CT 2026-05-09 and CT 2026-05-10 (since PT 11pm = CT 1am next day).
  // We compute the candidate CT date span and replace those.
  const ctSpan = computeCtDateSpanFromSrc(date, srcTz);

  // Existing data we may need to merge with: a user might submit a single src date
  // that maps to two CT dates. The OTHER src date's submission also might write
  // to the same CT date. To avoid clobbering, when we replace a CT date we ONLY
  // overwrite the slots whose CT-time falls within the src-date+srcTz wall-clock range.
  // Simplest correct approach: track a `srcDateSpan` per slot. We do per-day writes:
  //   day:{c}:{ctDate}:{slug}.slotsBySrcDate[srcDate] = [ctSlots]
  // Then compute "all slots" as union across srcDate keys. This is the schema we use.

  const nowIso = new Date().toISOString();

  for (const ctDate of ctSpan) {
    const k = `day:${sess.campaign}:${ctDate}:${sess.closerSlug}`;
    const prevRaw = await env.SCHEDULE_KV.get(k);
    const prev = prevRaw ? JSON.parse(prevRaw) : { slotsBySrcDate: {}, confirmedAt: null, notes: '' };
    prev.slotsBySrcDate = prev.slotsBySrcDate || {};
    prev.slotsBySrcDate[date] = Array.from(byCtDate.get(ctDate) || []).sort((a, b) => a - b);

    // Submission metadata
    prev.lastSrcTz = srcTz;
    prev.submittedAt = nowIso;
    prev.notes = (typeof notes === 'string') ? notes : (prev.notes || '');

    // If this CT date is in the past relative to NOW in CT, we don't auto-clear confirmedAt.
    // But if the closer is editing, we *do* invalidate confirmedAt because the schedule changed.
    if (prev.confirmedAt && ctDate >= ctToday()) {
      prev.confirmedAt = null;
    }

    // Compute combined slots for convenience
    prev.slots = combinedSlots(prev.slotsBySrcDate);

    await env.SCHEDULE_KV.put(k, JSON.stringify(prev), { expirationTtl: DAY_TTL });
  }

  return jsonResp({ ok: true });
}

function combinedSlots(slotsBySrcDate) {
  const set = new Set();
  for (const arr of Object.values(slotsBySrcDate || {})) {
    for (const n of arr) set.add(n);
  }
  return Array.from(set).sort((a, b) => a - b);
}

// What CT dates can a given (srcDate, srcTz) span? Answer: at most 2 — the slots for
// 00:00–23:45 in srcTz on srcDate map to UTC instants whose CT wall-clock dates differ
// by at most 1 day depending on offset. We compute and dedupe.
function computeCtDateSpanFromSrc(srcDate, srcTz) {
  const dates = new Set();
  for (const slot of [0, 95]) {
    const { date } = srcSlotToCt(srcDate, slot, srcTz);
    dates.add(date);
  }
  return Array.from(dates).sort();
}

// ═══════════════════════════════════════════════════════════════════
// API: confirm
// ═══════════════════════════════════════════════════════════════════

async function apiConfirm(request, env) {
  const body = await request.json().catch(() => ({}));
  const { token } = body;

  const sess = await checkSession(env, token);
  if (!sess) return jsonResp({ ok: false, error: 'session expired' }, 401);

  const today = ctToday();
  const k = `day:${sess.campaign}:${today}:${sess.closerSlug}`;
  const raw = await env.SCHEDULE_KV.get(k);
  if (!raw) return jsonResp({ ok: false, error: 'no hours saved for today' }, 404);

  const obj = JSON.parse(raw);
  obj.confirmedAt = new Date().toISOString();
  await env.SCHEDULE_KV.put(k, JSON.stringify(obj), { expirationTtl: DAY_TTL });

  return jsonResp({ ok: true, confirmedAt: obj.confirmedAt });
}

// ═══════════════════════════════════════════════════════════════════
// API: state read
// ═══════════════════════════════════════════════════════════════════

async function apiState(env, campaign, date, closerSlug) {
  const cfg = await getCampaign(env, campaign);
  if (!cfg) return jsonResp({ ok: false, error: 'campaign not found' }, 404);

  if (closerSlug) {
    const k = `day:${campaign}:${date}:${closerSlug}`;
    const raw = await env.SCHEDULE_KV.get(k);
    return jsonResp({ ok: true, date, closer: closerSlug, data: raw ? JSON.parse(raw) : null });
  }

  const closers = cfg.closers.map(c => c.slug);
  const results = {};
  for (const slug of closers) {
    const k = `day:${campaign}:${date}:${slug}`;
    const raw = await env.SCHEDULE_KV.get(k);
    results[slug] = raw ? JSON.parse(raw) : null;
  }

  return jsonResp({
    ok: true,
    date,
    today: ctToday(),
    visibleHours: cfg.visibleHours || [6, 23],
    closers: cfg.closers.map(c => ({ slug: c.slug, name: c.name })),
    state: results
  });
}

// ═══════════════════════════════════════════════════════════════════
// HTML
// ═══════════════════════════════════════════════════════════════════

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function htmlResp(html, status = 200) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

async function htmlLanding(env, campaign) {
  const cfg = await getCampaign(env, campaign);
  if (!cfg) return new Response('Campaign not found', { status: 404 });
  return htmlResp(LANDING_HTML(campaign, cfg));
}

async function htmlCloser(env, campaign, closerSlug, url) {
  const cfg = await getCampaign(env, campaign);
  if (!cfg) return new Response('Campaign not found', { status: 404 });
  const closer = cfg.closers.find(c => c.slug === closerSlug);
  if (!closer) return new Response('Closer not found', { status: 404 });
  return htmlResp(CLOSER_HTML(campaign, cfg, closer));
}

async function htmlMaster(env, campaign, masterKey) {
  const cfg = await getCampaign(env, campaign);
  if (!cfg) return new Response('Campaign not found', { status: 404 });
  const supplied = await sha256Hex(`${campaign}:master:${masterKey}`);
  if (supplied !== cfg.masterKeyHash) {
    return new Response('Not authorized', { status: 401 });
  }
  return htmlResp(MASTER_HTML(campaign, cfg));
}

// ─── Landing (PIN gate) ─────────────────────────────────────────────
function LANDING_HTML(campaign, cfg) {
  const closers = cfg.closers.map(c => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(cfg.displayName)} — Schedule</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1419;color:#e8eaed;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:1rem}
  .card{background:#1a2028;border-radius:12px;padding:2rem;width:100%;max-width:380px;box-shadow:0 8px 32px rgba(0,0,0,0.4)}
  h1{margin:0 0 0.25rem;font-size:1.25rem;font-weight:600}
  p.sub{margin:0 0 1.5rem;color:#9aa0a6;font-size:0.875rem}
  label{display:block;margin:0 0 0.4rem;font-size:0.8rem;color:#9aa0a6;text-transform:uppercase;letter-spacing:0.04em}
  select,input{width:100%;padding:0.75rem;background:#0f1419;color:#e8eaed;border:1px solid #2a3038;border-radius:8px;font-size:1rem;box-sizing:border-box;margin-bottom:1rem;font-family:inherit}
  input:focus,select:focus{outline:none;border-color:#3b82f6}
  button{width:100%;padding:0.875rem;background:#3b82f6;color:white;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}
  button:hover{background:#2563eb}
  button:disabled{background:#475569;cursor:not-allowed}
  .err{color:#f87171;font-size:0.875rem;margin-top:-0.5rem;margin-bottom:1rem;min-height:1.2em}
</style></head>
<body><div class="card">
  <h1>${esc(cfg.displayName)}</h1>
  <p class="sub">Pick yourself, enter your PIN.</p>
  <label>Closer</label>
  <select id="closer"><option value="">— choose —</option>${closers}</select>
  <label>4-digit PIN</label>
  <input id="pin" type="tel" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" autocomplete="off">
  <div class="err" id="err"></div>
  <button id="go">Enter</button>
</div>
<script>
const campaign = ${JSON.stringify(campaign)};
const goBtn = document.getElementById('go');
const errEl = document.getElementById('err');
goBtn.onclick = async () => {
  const closerSlug = document.getElementById('closer').value;
  const pin = document.getElementById('pin').value;
  if (!closerSlug) { errEl.textContent = 'Pick your name first'; return; }
  if (!/^\\d{4}$/.test(pin)) { errEl.textContent = 'PIN is 4 digits'; return; }
  errEl.textContent = '';
  goBtn.disabled = true; goBtn.textContent = '…';
  try {
    const r = await fetch('/api/auth', { method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ campaign, closerSlug, pin }) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Auth failed');
    sessionStorage.setItem('schedToken_' + campaign + '_' + closerSlug, j.token);
    sessionStorage.setItem('schedDefaultTz_' + campaign + '_' + closerSlug, j.defaultTz);
    sessionStorage.setItem('schedName_' + campaign + '_' + closerSlug, j.name);
    location.href = '/c/' + campaign + '/closer/' + closerSlug;
  } catch(e) {
    errEl.textContent = e.message;
    goBtn.disabled = false; goBtn.textContent = 'Enter';
  }
};
document.getElementById('pin').addEventListener('keydown', e => { if (e.key === 'Enter') goBtn.click(); });
</script></body></html>`;
}

// ─── Closer scheduling page ─────────────────────────────────────────
function CLOSER_HTML(campaign, cfg, closer) {
  const visibleHours = cfg.visibleHours || [6, 23];
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(closer.name)} — Schedule</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1419;color:#e8eaed;-webkit-tap-highlight-color:transparent}
  header{background:#1a2028;padding:1rem;border-bottom:1px solid #2a3038;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;position:sticky;top:0;z-index:10}
  header h1{margin:0;font-size:1rem;font-weight:600}
  header .meta{font-size:0.75rem;color:#9aa0a6}
  select{padding:0.4rem 0.6rem;background:#0f1419;color:#e8eaed;border:1px solid #2a3038;border-radius:6px;font-size:0.875rem}
  .tabs{display:flex;overflow-x:auto;background:#1a2028;border-bottom:1px solid #2a3038;padding:0 0.5rem;scrollbar-width:none}
  .tabs::-webkit-scrollbar{display:none}
  .tab{padding:0.75rem 1rem;cursor:pointer;border-bottom:2px solid transparent;color:#9aa0a6;white-space:nowrap;font-size:0.875rem;flex-shrink:0}
  .tab.active{color:#e8eaed;border-bottom-color:#3b82f6}
  .tab.has-hours::after{content:' •';color:#3b82f6}
  .tab.confirmed::after{content:' ✓';color:#22c55e}
  main{padding:1rem;padding-bottom:6rem}
  .banner{background:#422006;border:1px solid #92400e;color:#fbbf24;padding:1rem;border-radius:8px;margin-bottom:1rem;display:flex;flex-direction:column;gap:0.5rem}
  .banner.confirmed{background:#052e1c;border-color:#166534;color:#86efac}
  .banner button{padding:0.5rem 1rem;background:#fbbf24;color:#1a1004;border:none;border-radius:6px;font-weight:600;cursor:pointer;align-self:flex-start}
  .banner.confirmed button{background:transparent;color:#86efac;border:1px solid #166534}
  .grid{display:flex;flex-direction:column;gap:0.25rem;user-select:none;-webkit-user-select:none;touch-action:none}
  .row{display:grid;grid-template-columns:3rem 1fr 1fr 1fr 1fr;gap:0.25rem;align-items:stretch}
  .row .hr{font-size:0.75rem;color:#9aa0a6;display:flex;align-items:center;justify-content:flex-end;padding-right:0.4rem}
  .cell{height:2.4rem;background:#1a2028;border-radius:4px;cursor:pointer;border:1px solid transparent;transition:background 0.05s,border-color 0.05s}
  .cell.on{background:#3b82f6;border-color:#60a5fa}
  .cell.painting{border-color:#fbbf24}
  textarea{width:100%;padding:0.6rem;margin-top:0.75rem;background:#0f1419;color:#e8eaed;border:1px solid #2a3038;border-radius:6px;font-family:inherit;font-size:0.875rem;resize:vertical;min-height:60px}
  .saveBar{position:fixed;bottom:0;left:0;right:0;background:#1a2028;border-top:1px solid #2a3038;padding:0.75rem 1rem;display:flex;gap:0.5rem;align-items:center;z-index:5}
  .saveBar .summary{flex:1;font-size:0.875rem;color:#9aa0a6}
  .saveBar button{padding:0.6rem 1.25rem;border-radius:6px;border:none;font-weight:600;cursor:pointer;font-size:0.875rem}
  .saveBar .save{background:#3b82f6;color:white}
  .saveBar .clear{background:transparent;color:#9aa0a6;border:1px solid #2a3038}
  .save.dirty{background:#16a34a}
  .toast{position:fixed;top:1rem;right:1rem;background:#16a34a;color:white;padding:0.6rem 1rem;border-radius:6px;font-size:0.875rem;opacity:0;transition:opacity 0.2s;pointer-events:none;z-index:20}
  .toast.show{opacity:1}
  .toast.err{background:#dc2626}
  @media (min-width: 640px){
    .row{grid-template-columns:4rem repeat(4, 1fr)}
    .cell{height:2.8rem}
  }
</style></head>
<body>
<header>
  <div>
    <h1>${esc(closer.name)}</h1>
    <div class="meta">${esc(cfg.displayName)}</div>
  </div>
  <select id="tz">
    <option value="America/Chicago">Central (CT)</option>
    <option value="America/New_York">Eastern (ET)</option>
    <option value="America/Denver">Mountain (MT)</option>
    <option value="America/Los_Angeles">Pacific (PT)</option>
    <option value="America/Phoenix">Arizona (no-DST)</option>
    <option value="Pacific/Honolulu">Hawaii (HT)</option>
    <option value="America/Anchorage">Alaska (AKT)</option>
  </select>
</header>

<div class="tabs" id="tabs"></div>

<main>
  <div id="banner"></div>
  <div class="grid" id="grid"></div>
  <textarea id="notes" placeholder="Notes (e.g. 'breaking 5–5:30 for kids', 'hard out at 8:45')"></textarea>
</main>

<div class="saveBar">
  <button class="clear" id="clear">Clear</button>
  <span class="summary" id="summary">No hours selected</span>
  <button class="save" id="save">Save</button>
</div>

<div class="toast" id="toast"></div>

<script>
const campaign = ${JSON.stringify(campaign)};
const closerSlug = ${JSON.stringify(closer.slug)};
const visibleHours = ${JSON.stringify(visibleHours)};
const tokenKey = 'schedToken_' + campaign + '_' + closerSlug;
const defaultTzKey = 'schedDefaultTz_' + campaign + '_' + closerSlug;

const token = sessionStorage.getItem(tokenKey);
if (!token) { location.href = '/c/' + campaign; }

const tzSel = document.getElementById('tz');
tzSel.value = sessionStorage.getItem(defaultTzKey) || ${JSON.stringify(closer.defaultTz || CT)};

const SLOTS_PER_DAY = 96;
const state = {
  selectedDate: null,         // ISO date in tz
  daySlots: new Map(),        // dateIso -> Set<slotIdx>  (in current tz)
  dayConfirmed: new Map(),    // dateIso -> ISO timestamp or null
  notes: new Map(),           // dateIso -> string
  dirty: new Set()            // set of dateIso that have unsaved changes
};

// Compute today + next 6 days in current tz.
function todayInTz(tz) {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
  return dtf.format(new Date()); // en-CA gives YYYY-MM-DD
}
function addDays(d, n) {
  const [y,m,da] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m-1, da));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth()+1).padStart(2,'0') + '-' + String(dt.getUTCDate()).padStart(2,'0');
}
function fmtTab(dateIso, n) {
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  const [y,m,d] = dateIso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m-1, d));
  return dt.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', timeZone:'UTC' });
}

function renderTabs() {
  const tz = tzSel.value;
  const t0 = todayInTz(tz);
  const tabsEl = document.getElementById('tabs');
  tabsEl.innerHTML = '';
  for (let i = 0; i < ${VIEW_AHEAD_DAYS}; i++) {
    const d = addDays(t0, i);
    const tab = document.createElement('div');
    tab.className = 'tab' + (d === state.selectedDate ? ' active' : '');
    if ((state.daySlots.get(d) || new Set()).size > 0) tab.classList.add('has-hours');
    if (state.dayConfirmed.get(d)) tab.classList.add('confirmed');
    tab.textContent = fmtTab(d, i);
    tab.onclick = () => { state.selectedDate = d; renderAll(); };
    tabsEl.appendChild(tab);
  }
}

function renderGrid() {
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  const slots = state.daySlots.get(state.selectedDate) || new Set();
  for (let h = visibleHours[0]; h <= visibleHours[1]; h++) {
    const row = document.createElement('div');
    row.className = 'row';
    const lbl = document.createElement('div');
    lbl.className = 'hr';
    lbl.textContent = (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? 'a' : 'p');
    row.appendChild(lbl);
    for (let q = 0; q < 4; q++) {
      const slotIdx = h * 4 + q;
      const cell = document.createElement('div');
      cell.className = 'cell' + (slots.has(slotIdx) ? ' on' : '');
      cell.dataset.slot = slotIdx;
      row.appendChild(cell);
    }
    grid.appendChild(row);
  }
  attachPainter();
}

function renderBanner() {
  const banner = document.getElementById('banner');
  banner.innerHTML = '';
  const tz = tzSel.value;
  const t0 = todayInTz(tz);
  const slots = state.daySlots.get(state.selectedDate) || new Set();
  if (state.selectedDate === t0 && slots.size > 0) {
    const div = document.createElement('div');
    if (state.dayConfirmed.get(state.selectedDate)) {
      div.className = 'banner confirmed';
      div.innerHTML = '<div>✓ Confirmed for today: ' + summarizeSlots(slots, tz) + '</div>';
    } else {
      div.className = 'banner';
      div.innerHTML = '<div>Confirm today\\'s hours: <strong>' + summarizeSlots(slots, tz) + '</strong></div><button id="confirmBtn">Confirm</button>';
    }
    banner.appendChild(div);
    const btn = document.getElementById('confirmBtn');
    if (btn) btn.onclick = doConfirm;
  }
}

function renderNotes() {
  document.getElementById('notes').value = state.notes.get(state.selectedDate) || '';
}

function renderSummary() {
  const slots = state.daySlots.get(state.selectedDate) || new Set();
  const tz = tzSel.value;
  const sum = document.getElementById('summary');
  sum.textContent = slots.size === 0 ? 'No hours selected' : summarizeSlots(slots, tz);
  document.getElementById('save').classList.toggle('dirty', state.dirty.has(state.selectedDate));
}

function renderAll() { renderTabs(); renderGrid(); renderBanner(); renderNotes(); renderSummary(); }

function summarizeSlots(slots, tz) {
  if (slots.size === 0) return 'No hours';
  const sorted = Array.from(slots).sort((a,b)=>a-b);
  const ranges = [];
  let start = sorted[0], prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) { prev = sorted[i]; continue; }
    ranges.push([start, prev]); start = sorted[i]; prev = sorted[i];
  }
  ranges.push([start, prev]);
  return ranges.map(([s, e]) => slotLabel(s) + '–' + slotLabel(e+1)).join(', ');
}
function slotLabel(slotIdx) {
  const h = Math.floor(slotIdx / 4) % 24;
  const m = (slotIdx % 4) * 15;
  const ap = h < 12 ? 'a' : 'p';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + (m > 0 ? ':' + String(m).padStart(2,'0') : '') + ap;
}

// Click-and-drag painter
function attachPainter() {
  const grid = document.getElementById('grid');
  let painting = false, paintMode = null; // 'add' | 'remove'
  const slots = state.daySlots.get(state.selectedDate) || new Set();
  state.daySlots.set(state.selectedDate, slots);

  function onDown(e) {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    e.preventDefault();
    painting = true;
    const idx = +cell.dataset.slot;
    paintMode = slots.has(idx) ? 'remove' : 'add';
    apply(idx);
  }
  function onMove(e) {
    if (!painting) return;
    const t = e.touches ? e.touches[0] : e;
    const el = document.elementFromPoint(t.clientX, t.clientY);
    if (!el) return;
    const cell = el.closest && el.closest('.cell');
    if (!cell || !grid.contains(cell)) return;
    apply(+cell.dataset.slot);
  }
  function onUp() {
    if (painting) { state.dirty.add(state.selectedDate); renderTabs(); renderSummary(); }
    painting = false;
  }
  function apply(idx) {
    if (paintMode === 'add') slots.add(idx); else slots.delete(idx);
    const cell = grid.querySelector('[data-slot="' + idx + '"]');
    if (cell) cell.classList.toggle('on', slots.has(idx));
  }
  grid.addEventListener('mousedown', onDown);
  grid.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  grid.addEventListener('touchstart', onDown, { passive: false });
  grid.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onUp);
}

function toast(msg, err) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  setTimeout(() => { t.className = 'toast'; }, 2500);
}

async function doSave() {
  const slots = Array.from(state.daySlots.get(state.selectedDate) || new Set());
  const notes = document.getElementById('notes').value;
  state.notes.set(state.selectedDate, notes);
  const r = await fetch('/api/save', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ token, date: state.selectedDate, srcTz: tzSel.value, slots, notes }) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || 'Save failed', true); return; }
  state.dirty.delete(state.selectedDate);
  state.dayConfirmed.set(state.selectedDate, null); // edits invalidate confirm
  toast('Saved');
  renderAll();
}

async function doConfirm() {
  const r = await fetch('/api/confirm', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ token }) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || 'Confirm failed', true); return; }
  state.dayConfirmed.set(state.selectedDate, j.confirmedAt);
  toast('Confirmed');
  renderAll();
}

async function doClear() {
  state.daySlots.set(state.selectedDate, new Set());
  state.dirty.add(state.selectedDate);
  renderAll();
}

async function loadStateForTz(tz) {
  // Convert all CT-stored data into the current tz view.
  // Strategy: query each visible CT date's neighborhood (today CT, ±1) plus the
  // tz-tab dates, and re-bucket into tz dates.
  const ctToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  const dates = new Set();
  // Cover the union of CT dates that could correspond to tz dates in the next 7 days
  const t0 = todayInTz(tz);
  for (let i = -1; i <= ${VIEW_AHEAD_DAYS}; i++) {
    dates.add(addDays(t0, i));
    dates.add(addDays(ctToday, i));
  }
  state.daySlots.clear();
  state.dayConfirmed.clear();
  state.notes.clear();
  for (const d of dates) {
    const r = await fetch('/api/state/' + campaign + '/' + d + '/' + closerSlug);
    const j = await r.json();
    if (!j.ok || !j.data) continue;
    const data = j.data;
    const ctSlots = data.slots || [];
    // Bucket slots into tz dates
    for (const ctSlot of ctSlots) {
      const { tzDate, tzSlot } = ctToTz(d, ctSlot, tz);
      if (!state.daySlots.has(tzDate)) state.daySlots.set(tzDate, new Set());
      state.daySlots.get(tzDate).add(tzSlot);
    }
    if (data.confirmedAt) state.dayConfirmed.set(d, data.confirmedAt); // confirm tracked by CT date
    if (data.notes) state.notes.set(d, data.notes);
  }
  renderAll();
}

// Client-side TZ conversion using the same trick as server
function ctToTz(ctDate, ctSlot, destTz) {
  const [y,m,d] = ctDate.split('-').map(Number);
  const hh = Math.floor(ctSlot / 4), mm = (ctSlot % 4) * 15;
  const utcMs = utcFromWall(y, m, d, hh, mm, 'America/Chicago');
  const p = wallParts(new Date(utcMs), destTz);
  return { tzDate: p.year + '-' + String(p.month).padStart(2,'0') + '-' + String(p.day).padStart(2,'0'),
           tzSlot: p.hour * 4 + Math.floor(p.minute/15) };
}
function wallParts(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false });
  const p = {};
  for (const x of dtf.formatToParts(date)) p[x.type] = x.value;
  return { year:+p.year, month:+p.month, day:+p.day, hour:(+p.hour)%24, minute:+p.minute, second:+p.second };
}
function utcFromWall(y, m, d, hh, mm, tz) {
  let g = Date.UTC(y, m-1, d, hh, mm, 0);
  for (let i = 0; i < 2; i++) {
    const p = wallParts(new Date(g), tz);
    const tgt = Date.UTC(y, m-1, d, hh, mm, 0);
    const got = Date.UTC(p.year, p.month-1, p.day, p.hour, p.minute, 0);
    const drift = tgt - got;
    if (drift === 0) return g;
    g += drift;
  }
  return g;
}

document.getElementById('save').onclick = doSave;
document.getElementById('clear').onclick = doClear;
tzSel.onchange = async () => { state.selectedDate = todayInTz(tzSel.value); await loadStateForTz(tzSel.value); };

state.selectedDate = todayInTz(tzSel.value);
loadStateForTz(tzSel.value);
</script>
</body></html>`;
}

// ─── Manager Gantt view ─────────────────────────────────────────────
function MASTER_HTML(campaign, cfg) {
  const visibleHours = cfg.visibleHours || [6, 23];
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(cfg.displayName)} — Manager</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1419;color:#e8eaed}
  header{background:#1a2028;padding:1rem;border-bottom:1px solid #2a3038;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap}
  h1{margin:0;font-size:1.125rem;font-weight:600}
  .meta{font-size:0.75rem;color:#9aa0a6}
  .tabs{display:flex;overflow-x:auto;background:#1a2028;border-bottom:1px solid #2a3038;padding:0 0.5rem;scrollbar-width:none}
  .tabs::-webkit-scrollbar{display:none}
  .tab{padding:0.75rem 1rem;cursor:pointer;border-bottom:2px solid transparent;color:#9aa0a6;white-space:nowrap;font-size:0.875rem;flex-shrink:0}
  .tab.active{color:#e8eaed;border-bottom-color:#3b82f6}
  main{padding:1rem;overflow-x:auto}
  .gantt{display:grid;grid-template-columns:7rem 1fr;gap:0.5rem;align-items:center;min-width:fit-content}
  .closer{font-size:0.875rem;font-weight:500;padding-right:0.5rem;text-align:right;white-space:nowrap}
  .track{position:relative;height:2rem;background:#1a2028;border-radius:4px;overflow:hidden;min-width:60rem}
  .bar{position:absolute;top:0.2rem;bottom:0.2rem;background:#3b82f6;border-radius:3px;cursor:default}
  .bar.pending{background:repeating-linear-gradient(45deg,#3b82f6 0,#3b82f6 4px,#1e40af 4px,#1e40af 8px);opacity:0.7}
  .axis{display:grid;grid-template-columns:7rem 1fr;gap:0.5rem;align-items:center;margin-bottom:0.5rem;font-size:0.7rem;color:#9aa0a6}
  .axis .axis-track{position:relative;height:1.25rem;min-width:60rem}
  .axis .tick{position:absolute;top:0;border-left:1px solid #2a3038;height:100%;padding-left:0.2rem}
  .axis .tick.hour{border-left-color:#475569}
  .coverage{margin-top:0.75rem;display:grid;grid-template-columns:7rem 1fr;gap:0.5rem;align-items:center}
  .cov-track{position:relative;height:1.5rem;background:#0f1419;border-radius:4px;overflow:hidden;min-width:60rem;display:flex}
  .cov-cell{flex:1;border-right:1px solid #1a2028}
  .legend{margin-top:1rem;font-size:0.75rem;color:#9aa0a6;display:flex;gap:1rem;flex-wrap:wrap}
  .legend .box{display:inline-block;width:1rem;height:0.75rem;vertical-align:middle;margin-right:0.3rem;border-radius:2px}
  .empty{color:#9aa0a6;font-style:italic;padding:2rem 0;text-align:center}
  .tip{position:fixed;background:#0f1419;border:1px solid #2a3038;padding:0.5rem 0.75rem;border-radius:6px;font-size:0.75rem;pointer-events:none;display:none;z-index:30;max-width:18rem}
</style></head>
<body>
<header>
  <div>
    <h1>${esc(cfg.displayName)} — Manager</h1>
    <div class="meta">All times Central • Auto-refresh 30s</div>
  </div>
  <div class="meta" id="lastSync"></div>
</header>
<div class="tabs" id="tabs"></div>
<main>
  <div class="axis" id="axis"></div>
  <div class="gantt" id="gantt"></div>
  <div class="coverage" id="coverage"></div>
  <div class="legend">
    <span><span class="box" style="background:#3b82f6"></span>Confirmed</span>
    <span><span class="box" style="background:repeating-linear-gradient(45deg,#3b82f6 0,#3b82f6 4px,#1e40af 4px,#1e40af 8px)"></span>Pending</span>
    <span><span class="box" style="background:#16a34a"></span>Coverage heat</span>
  </div>
</main>
<div class="tip" id="tip"></div>
<script>
const campaign = ${JSON.stringify(campaign)};
const visibleHours = ${JSON.stringify(visibleHours)};
const SLOTS_PER_DAY = 96;
const SLOT_START = visibleHours[0] * 4;
const SLOT_END = (visibleHours[1] + 1) * 4;
const SLOT_COUNT = SLOT_END - SLOT_START;
let selectedDate = null;

function ctToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone:'America/Chicago' }).format(new Date());
}
function addDays(d, n) {
  const [y,m,da] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m-1, da));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth()+1).padStart(2,'0') + '-' + String(dt.getUTCDate()).padStart(2,'0');
}
function fmtDate(d, n) {
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  const [y,m,da] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m-1, da)).toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', timeZone:'UTC' });
}
function slotLabel(s) {
  const h = Math.floor(s/4) % 24;
  const m = (s%4)*15;
  const ap = h < 12 ? 'a' : 'p';
  const h12 = h%12 === 0 ? 12 : h%12;
  return h12 + (m>0 ? ':' + String(m).padStart(2,'0') : '') + ap;
}

function renderTabs() {
  const t0 = ctToday();
  const tabsEl = document.getElementById('tabs');
  tabsEl.innerHTML = '';
  for (let i = 0; i < ${VIEW_AHEAD_DAYS}; i++) {
    const d = addDays(t0, i);
    const tab = document.createElement('div');
    tab.className = 'tab' + (d === selectedDate ? ' active' : '');
    tab.textContent = fmtDate(d, i);
    tab.onclick = () => { selectedDate = d; loadDay(); };
    tabsEl.appendChild(tab);
  }
}

function renderAxis() {
  const axis = document.getElementById('axis');
  axis.innerHTML = '<div></div><div class="axis-track" id="axisTrack"></div>';
  const track = document.getElementById('axisTrack');
  for (let h = visibleHours[0]; h <= visibleHours[1]; h++) {
    const x = ((h*4 - SLOT_START) / SLOT_COUNT) * 100;
    const tick = document.createElement('div');
    tick.className = 'tick hour';
    tick.style.left = x + '%';
    tick.textContent = slotLabel(h*4);
    track.appendChild(tick);
  }
}

function bucket(slots) {
  // Compress sorted slot indices into [start, end) ranges.
  if (!slots || !slots.length) return [];
  const s = slots.slice().sort((a,b)=>a-b);
  const out = [];
  let start = s[0], prev = s[0];
  for (let i = 1; i < s.length; i++) {
    if (s[i] === prev + 1) { prev = s[i]; continue; }
    out.push([start, prev+1]); start = s[i]; prev = s[i];
  }
  out.push([start, prev+1]);
  return out;
}

function pct(slot) {
  return ((slot - SLOT_START) / SLOT_COUNT) * 100;
}

function showTip(e, html) {
  const tip = document.getElementById('tip');
  tip.innerHTML = html;
  tip.style.display = 'block';
  const x = Math.min(e.clientX + 10, window.innerWidth - 250);
  const y = e.clientY + 10;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}
function hideTip() { document.getElementById('tip').style.display = 'none'; }

function renderGantt(state, today) {
  const gantt = document.getElementById('gantt');
  gantt.innerHTML = '';
  const closers = state.closers;
  // Sort by earliest slot today (closers with no hours at the bottom)
  const sorted = closers.slice().sort((a, b) => {
    const sa = state.state[a.slug]?.slots || [];
    const sb = state.state[b.slug]?.slots || [];
    const minA = sa.length ? Math.min(...sa) : 999;
    const minB = sb.length ? Math.min(...sb) : 999;
    return minA - minB;
  });
  for (const c of sorted) {
    const data = state.state[c.slug];
    const lbl = document.createElement('div');
    lbl.className = 'closer'; lbl.textContent = c.name;
    const track = document.createElement('div');
    track.className = 'track';
    if (data) {
      const ranges = bucket(data.slots || []);
      const isConfirmed = !!data.confirmedAt;
      for (const [s, e] of ranges) {
        if (e <= SLOT_START || s >= SLOT_END) continue;
        const cs = Math.max(s, SLOT_START), ce = Math.min(e, SLOT_END);
        const bar = document.createElement('div');
        bar.className = 'bar' + (isConfirmed ? '' : ' pending');
        bar.style.left = pct(cs) + '%';
        bar.style.width = ((ce - cs) / SLOT_COUNT * 100) + '%';
        const tip = '<strong>' + c.name + '</strong><br>' + slotLabel(cs) + '–' + slotLabel(ce) + ' CT' +
          (isConfirmed ? '<br>✓ Confirmed' : '<br>Pending confirm') +
          (data.lastSrcTz && data.lastSrcTz !== 'America/Chicago' ? '<br>Submitted from ' + data.lastSrcTz : '') +
          (data.notes ? '<br>"' + data.notes.replace(/[<>"]/g,'') + '"' : '');
        bar.onmouseenter = (e) => showTip(e, tip);
        bar.onmousemove = (e) => showTip(e, tip);
        bar.onmouseleave = hideTip;
        track.appendChild(bar);
      }
    }
    gantt.appendChild(lbl);
    gantt.appendChild(track);
  }
  if (sorted.length === 0) {
    gantt.innerHTML = '<div class="empty" style="grid-column:1/-1">No closers configured.</div>';
  }
}

function renderCoverage(state) {
  const cov = document.getElementById('coverage');
  cov.innerHTML = '<div class="closer">Coverage</div><div class="cov-track" id="covTrack"></div>';
  const track = document.getElementById('covTrack');
  // Per-15-min cell, count confirmed available
  const counts = new Array(SLOT_COUNT).fill(0);
  for (const c of state.closers) {
    const data = state.state[c.slug];
    if (!data || !data.confirmedAt) continue;
    for (const s of (data.slots || [])) {
      const idx = s - SLOT_START;
      if (idx >= 0 && idx < SLOT_COUNT) counts[idx]++;
    }
  }
  const max = Math.max(1, ...counts);
  for (let i = 0; i < SLOT_COUNT; i++) {
    const cell = document.createElement('div');
    cell.className = 'cov-cell';
    const ratio = counts[i] / max;
    if (counts[i] > 0) {
      const alpha = 0.25 + 0.55 * ratio;
      cell.style.background = 'rgba(34, 197, 94, ' + alpha + ')';
      cell.title = slotLabel(i + SLOT_START) + ' — ' + counts[i] + ' on';
    }
    track.appendChild(cell);
  }
}

async function loadDay() {
  if (!selectedDate) selectedDate = ctToday();
  renderTabs();
  renderAxis();
  const r = await fetch('/api/state/' + campaign + '/' + selectedDate);
  const j = await r.json();
  if (!j.ok) return;
  renderGantt(j, j.today);
  renderCoverage(j);
  document.getElementById('lastSync').textContent = 'Last sync ' + new Date().toLocaleTimeString();
}

selectedDate = ctToday();
loadDay();
setInterval(loadDay, 30000);
</script></body></html>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
}
