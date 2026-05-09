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

  const ctSpan = computeCtDateSpanFromSrc(date, srcTz);
  const nowIso = new Date().toISOString();

  for (const ctDate of ctSpan) {
    const k = `day:${sess.campaign}:${ctDate}:${sess.closerSlug}`;
    const prevRaw = await env.SCHEDULE_KV.get(k);
    const prev = prevRaw ? JSON.parse(prevRaw) : { slotsBySrcDate: {}, confirmedAt: null, notes: '' };
    prev.slotsBySrcDate = prev.slotsBySrcDate || {};
    prev.slotsBySrcDate[date] = Array.from(byCtDate.get(ctDate) || []).sort((a, b) => a - b);

    prev.lastSrcTz = srcTz;
    prev.submittedAt = nowIso;
    prev.notes = (typeof notes === 'string') ? notes : (prev.notes || '');

    if (prev.confirmedAt && ctDate >= ctToday()) {
      prev.confirmedAt = null;
    }

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

// ─── Shared brand tokens ──────────────────────────────────────────────
const BRAND_HEAD = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,wght@0,400..600;1,400&family=Geist:wght@300..600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
`;

const BRAND_VARS = `
:root {
  --bg: #F6EBDC;
  --bg-deep: #EFDDC4;
  --paper: #FBF6EC;
  --ink: #2A1B10;
  --ink-soft: rgba(42,27,16,0.62);
  --ink-faint: rgba(42,27,16,0.18);
  --rule: rgba(42,27,16,0.14);
  --accent: #C8431D;
  --accent-2: #E8893A;
  --glow: #FFB070;
  --good: #2D7A5F;
  --serif: "Newsreader", Georgia, serif;
  --sans: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
}
* { box-sizing: border-box; }
body { font-feature-settings: "ss01", "cv11"; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
`;

// ─── Landing (PIN gate) ─────────────────────────────────────────────
function LANDING_HTML(campaign, cfg) {
  const closers = cfg.closers.map(c => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(cfg.displayName)} — Schedule</title>
${BRAND_HEAD}
<style>
${BRAND_VARS}
body{margin:0;font-family:var(--sans);background:var(--bg);color:var(--ink);display:flex;min-height:100vh;align-items:center;justify-content:center;padding:1.5rem}
.card{background:var(--paper);border:1px solid var(--rule);border-radius:18px;padding:2.25rem;width:100%;max-width:380px;box-shadow:0 24px 60px -24px rgba(82,40,15,0.30),0 1px 0 rgba(255,255,255,0.55) inset}
h1{margin:0 0 0.25rem;font-family:var(--serif);font-size:1.875rem;font-weight:500;letter-spacing:-0.01em;line-height:1.1}
h1 em{font-style:italic;color:var(--accent);font-weight:400}
.sub{margin:0.4rem 0 1.75rem;color:var(--ink-soft);font-size:0.875rem;line-height:1.4}
label{display:block;margin:0 0 0.5rem;font-family:var(--mono);font-size:0.6875rem;color:var(--ink-soft);text-transform:uppercase;letter-spacing:0.08em;font-weight:500}
select,input{width:100%;padding:0.8rem 0.95rem;background:var(--bg);color:var(--ink);border:1px solid var(--rule);border-radius:10px;font-size:0.9375rem;font-family:inherit;box-sizing:border-box;margin-bottom:1.125rem;transition:border-color 0.15s,box-shadow 0.15s}
select:focus,input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in oklab,var(--accent) 18%,transparent)}
button{width:100%;padding:0.875rem;background:var(--ink);color:var(--paper);border:none;border-radius:999px;font-size:0.9375rem;font-weight:500;cursor:pointer;font-family:inherit;letter-spacing:-0.005em;transition:background 0.15s,transform 0.05s}
button:hover{background:var(--accent)}
button:active{transform:translateY(1px)}
button:disabled{background:var(--ink-faint);cursor:not-allowed}
.err{color:var(--accent);font-size:0.875rem;margin-top:-0.5rem;margin-bottom:1.125rem;min-height:1.2em;font-weight:500}
</style></head>
<body><div class="card">
<h1>${esc(cfg.displayName)}</h1>
<p class="sub">Pick yourself, enter your <em>4-digit PIN</em>.</p>
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

// ─── Closer scheduling page (multi-day grid) ────────────────────────
function CLOSER_HTML(campaign, cfg, closer) {
  const visibleHours = cfg.visibleHours || [6, 23];
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(closer.name)} — Schedule</title>
${BRAND_HEAD}
<style>
${BRAND_VARS}
body{margin:0;font-family:var(--sans);background:var(--bg);color:var(--ink);-webkit-tap-highlight-color:transparent}
header{background:color-mix(in oklab,var(--bg) 78%,white);backdrop-filter:saturate(140%) blur(8px);-webkit-backdrop-filter:saturate(140%) blur(8px);border-bottom:1px solid var(--rule);padding:0.875rem 1.125rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.6rem;position:sticky;top:0;z-index:10}
header h1{margin:0;font-family:var(--serif);font-size:1.375rem;font-weight:500;letter-spacing:-0.01em;line-height:1}
header .meta{font-size:0.6875rem;color:var(--ink-soft);font-family:var(--mono);letter-spacing:0.08em;text-transform:uppercase;margin-top:4px}
select{padding:0.5rem 0.85rem;background:var(--paper);color:var(--ink);border:1px solid var(--rule);border-radius:999px;font-size:0.8125rem;font-family:inherit;cursor:pointer;transition:border-color 0.15s}
select:hover{border-color:var(--ink-soft)}
main{padding:1.25rem 1rem 6rem;max-width:1400px;margin:0 auto}
.banner{background:color-mix(in oklab,var(--accent-2) 16%,var(--paper));border:1px solid color-mix(in oklab,var(--accent-2) 35%,var(--rule));color:var(--ink);padding:1rem 1.125rem;border-radius:14px;margin-bottom:1rem;display:flex;flex-direction:column;gap:0.75rem;font-size:0.9375rem}
.banner.confirmed{background:color-mix(in oklab,var(--good) 14%,var(--paper));border-color:color-mix(in oklab,var(--good) 35%,var(--rule))}
.banner button{padding:0.55rem 1.25rem;background:var(--accent);color:var(--paper);border:none;border-radius:999px;font-weight:500;font-family:inherit;cursor:pointer;align-self:flex-start;font-size:0.875rem;transition:background 0.15s}
.banner button:hover{background:color-mix(in oklab,var(--accent) 80%,var(--ink))}
.banner.confirmed button{background:transparent;color:var(--ink);border:1px solid var(--rule);cursor:default}
.schedule-card{background:var(--paper);border:1px solid var(--rule);border-radius:14px;padding:0.625rem;overflow-x:auto;scrollbar-width:thin;scrollbar-color:var(--ink-faint) transparent;box-shadow:0 1px 0 rgba(255,255,255,0.5) inset}
.schedule-grid{display:grid;grid-template-columns:2.4rem repeat(7,minmax(74px,1fr));gap:4px;user-select:none;-webkit-user-select:none;touch-action:pan-y;min-width:600px}
.day-header{text-align:center;padding:9px 4px 11px;cursor:pointer;border-radius:8px 8px 0 0;border-bottom:2px solid transparent;transition:background 0.15s,border-color 0.15s;display:flex;flex-direction:column;align-items:center;gap:3px}
.day-header:hover{background:color-mix(in oklab,var(--bg) 65%,white)}
.day-header.today .day-name{color:var(--accent)}
.day-header.has-hours .marker{background:var(--accent)}
.day-header.confirmed .marker{background:var(--good)}
.day-header.selected{background:color-mix(in oklab,var(--accent) 10%,var(--paper));border-bottom-color:var(--accent)}
.day-header .day-name{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:var(--ink-soft);font-weight:500;line-height:1}
.day-header .day-date{font-family:var(--serif);font-size:14px;font-weight:500;color:var(--ink);letter-spacing:-0.01em;line-height:1.1}
.day-header .marker{display:inline-block;width:5px;height:5px;border-radius:999px;background:transparent;margin-top:1px}
.hour-corner{position:sticky;left:0;background:var(--paper);z-index:2}
.hour-label{display:flex;align-items:center;justify-content:flex-end;padding-right:6px;font-family:var(--mono);font-size:11px;color:var(--ink-soft);position:sticky;left:0;background:var(--paper);z-index:1;font-variant-numeric:tabular-nums}
.day-cell{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;padding:1px}
.quarter{height:28px;background:color-mix(in oklab,var(--bg-deep) 55%,white);border:1px solid transparent;border-radius:3px;cursor:pointer;transition:background 0.05s,border-color 0.05s}
.quarter:hover{background:color-mix(in oklab,var(--glow) 60%,var(--bg-deep))}
.quarter.on{background:var(--accent);border-color:color-mix(in oklab,var(--accent) 60%,var(--ink));box-shadow:0 1px 0 rgba(0,0,0,0.05)}
.quarter.on:hover{background:color-mix(in oklab,var(--accent) 85%,var(--ink))}
@media (min-width:760px){.quarter{height:32px}}
.notes-card{background:var(--paper);border:1px solid var(--rule);border-radius:14px;padding:0.875rem 1rem;margin-top:1rem}
.notes-card .lbl{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--ink-soft);font-weight:500;display:block;margin-bottom:0.5rem}
.notes-card .lbl strong{color:var(--accent);font-weight:500;font-style:italic;font-family:var(--serif);text-transform:none;font-size:13px;letter-spacing:0;margin-left:2px}
textarea{width:100%;padding:0.7rem 0.85rem;background:var(--bg);color:var(--ink);border:1px solid var(--rule);border-radius:8px;font-family:inherit;font-size:0.875rem;resize:vertical;min-height:56px;transition:border-color 0.15s,box-shadow 0.15s}
textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in oklab,var(--accent) 18%,transparent)}
.save-bar{position:fixed;bottom:0;left:0;right:0;background:color-mix(in oklab,var(--bg) 80%,white);backdrop-filter:saturate(140%) blur(8px);-webkit-backdrop-filter:saturate(140%) blur(8px);border-top:1px solid var(--rule);padding:0.75rem 1rem;z-index:5}
.save-bar-inner{max-width:1400px;margin:0 auto;display:flex;gap:0.5rem;align-items:center}
.save-bar .summary{flex:1;font-size:0.8125rem;color:var(--ink-soft);font-family:var(--mono);font-variant-numeric:tabular-nums}
.save-bar .summary .num{color:var(--ink);font-weight:500}
.save-bar button{padding:0.625rem 1.25rem;border-radius:999px;border:none;font-weight:500;cursor:pointer;font-size:0.875rem;font-family:inherit;transition:background 0.15s,transform 0.05s,color 0.15s}
.save-bar button:active{transform:translateY(1px)}
.save-bar .save{background:var(--ink);color:var(--paper)}
.save-bar .save:hover{background:var(--accent)}
.save-bar .save.dirty{background:var(--accent);color:var(--paper)}
.save-bar .save.dirty:hover{background:color-mix(in oklab,var(--accent) 80%,var(--ink))}
.save-bar .clear{background:transparent;color:var(--ink-soft);border:1px solid var(--rule)}
.save-bar .clear:hover{color:var(--ink);border-color:var(--ink-soft)}
.toast{position:fixed;top:1rem;right:1rem;background:var(--ink);color:var(--paper);padding:0.65rem 1.125rem;border-radius:999px;font-size:0.875rem;font-family:inherit;opacity:0;transition:opacity 0.2s,transform 0.2s;pointer-events:none;z-index:30;box-shadow:0 10px 30px -10px rgba(82,40,15,0.35);transform:translateY(-4px)}
.toast.show{opacity:1;transform:translateY(0)}
.toast.err{background:var(--accent)}
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

<main>
  <div id="banner"></div>
  <div class="schedule-card">
    <div class="schedule-grid" id="grid"></div>
  </div>
  <div class="notes-card">
    <span class="lbl">Notes for <strong id="notesDayLbl">today</strong></span>
    <textarea id="notes" placeholder="e.g. 'breaking 5–5:30 for kids', 'hard out at 8:45'"></textarea>
  </div>
</main>

<div class="save-bar">
  <div class="save-bar-inner">
    <button class="clear" id="clear">Clear day</button>
    <span class="summary" id="summary">No hours</span>
    <button class="save" id="save">Save</button>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const campaign = ${JSON.stringify(campaign)};
const closerSlug = ${JSON.stringify(closer.slug)};
const visibleHours = ${JSON.stringify(visibleHours)};
const VIEW_DAYS = ${VIEW_AHEAD_DAYS};
const tokenKey = 'schedToken_' + campaign + '_' + closerSlug;
const defaultTzKey = 'schedDefaultTz_' + campaign + '_' + closerSlug;

const token = sessionStorage.getItem(tokenKey);
if (!token) { location.href = '/c/' + campaign; }

const tzSel = document.getElementById('tz');
tzSel.value = sessionStorage.getItem(defaultTzKey) || ${JSON.stringify(closer.defaultTz || CT)};

const SLOTS_PER_DAY = 96;
const state = {
  selectedDate: null,
  daySlots: new Map(),
  dayConfirmed: new Map(),
  notes: new Map(),
  dirty: new Set()
};

function todayInTz(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}
function addDays(d, n) {
  const [y,m,da] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m-1, da));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth()+1).padStart(2,'0') + '-' + String(dt.getUTCDate()).padStart(2,'0');
}
function fmtDayName(n, iso) {
  if (n === 0) return 'TODAY';
  if (n === 1) return 'TOMORROW';
  const [y,m,da] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m-1, da));
  return dt.toLocaleDateString('en-US', { weekday:'short', timeZone:'UTC' }).toUpperCase();
}
function fmtDayDate(iso) {
  const [y,m,da] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m-1, da));
  return dt.toLocaleDateString('en-US', { month:'short', day:'numeric', timeZone:'UTC' });
}
function fmtNotesLbl(n, iso) {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  const [y,m,da] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m-1, da));
  return dt.toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric', timeZone:'UTC' });
}
function slotLabel(slot) {
  const h = Math.floor(slot/4) % 24;
  const m = (slot%4)*15;
  const ap = h < 12 ? 'a' : 'p';
  const h12 = h%12 === 0 ? 12 : h%12;
  return h12 + (m>0 ? ':' + String(m).padStart(2,'0') : '') + ap;
}
function dayDates() {
  const t0 = todayInTz(tzSel.value);
  return Array.from({length: VIEW_DAYS}, (_, i) => ({ iso: addDays(t0, i), n: i }));
}

function renderGrid() {
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  const days = dayDates();

  // Header row
  const corner = document.createElement('div');
  corner.className = 'hour-corner';
  grid.appendChild(corner);
  for (const {iso, n} of days) {
    const h = document.createElement('div');
    h.className = 'day-header' + (n === 0 ? ' today' : '') + (iso === state.selectedDate ? ' selected' : '');
    if ((state.daySlots.get(iso) || new Set()).size > 0) h.classList.add('has-hours');
    if (state.dayConfirmed.get(iso)) h.classList.add('confirmed');
    h.innerHTML = '<span class="day-name">' + fmtDayName(n, iso) + '</span>' +
                  '<span class="day-date">' + fmtDayDate(iso) + '</span>' +
                  '<span class="marker"></span>';
    h.dataset.date = iso;
    h.onclick = () => { state.selectedDate = iso; renderAll(); };
    grid.appendChild(h);
  }

  // Hour rows
  for (let h = visibleHours[0]; h <= visibleHours[1]; h++) {
    const lbl = document.createElement('div');
    lbl.className = 'hour-label';
    lbl.textContent = (h%12===0?12:h%12) + (h<12?'a':'p');
    grid.appendChild(lbl);
    for (const {iso} of days) {
      const cell = document.createElement('div');
      cell.className = 'day-cell';
      cell.dataset.date = iso;
      const slots = state.daySlots.get(iso) || new Set();
      for (let q = 0; q < 4; q++) {
        const slotIdx = h*4 + q;
        const quarter = document.createElement('div');
        quarter.className = 'quarter' + (slots.has(slotIdx) ? ' on' : '');
        quarter.dataset.slot = slotIdx;
        quarter.dataset.date = iso;
        cell.appendChild(quarter);
      }
      grid.appendChild(cell);
    }
  }
  attachPainter();
}

function renderBanner() {
  const banner = document.getElementById('banner');
  banner.innerHTML = '';
  const tz = tzSel.value;
  const t0 = todayInTz(tz);
  const slots = state.daySlots.get(t0) || new Set();
  if (slots.size === 0) return;
  const div = document.createElement('div');
  if (state.dayConfirmed.get(t0)) {
    div.className = 'banner confirmed';
    div.innerHTML = '<div><strong>✓ Confirmed for today:</strong> ' + summarizeSlots(slots) + '</div>';
  } else {
    div.className = 'banner';
    div.innerHTML = '<div>Lock in today\\'s hours: <strong>' + summarizeSlots(slots) + '</strong></div><button id="confirmBtn">Confirm Today</button>';
  }
  banner.appendChild(div);
  const btn = document.getElementById('confirmBtn');
  if (btn) btn.onclick = doConfirm;
}

function renderNotes() {
  document.getElementById('notes').value = state.notes.get(state.selectedDate) || '';
  const days = dayDates();
  const sel = days.find(d => d.iso === state.selectedDate);
  const lbl = document.getElementById('notesDayLbl');
  if (sel) {
    lbl.textContent = fmtNotesLbl(sel.n, sel.iso);
  } else {
    lbl.textContent = 'today';
  }
}

function renderSummary() {
  let totalSlots = 0, dayCount = 0;
  for (const [, s] of state.daySlots) {
    if (s.size > 0) { totalSlots += s.size; dayCount++; }
  }
  const sum = document.getElementById('summary');
  if (totalSlots === 0) {
    sum.textContent = 'No hours';
  } else {
    const hrs = (totalSlots * 0.25);
    const hrsStr = (hrs % 1 === 0) ? String(hrs) : hrs.toFixed(2).replace(/0+$/,'').replace(/\\.$/, '');
    sum.innerHTML = '<span class="num">' + hrsStr + ' hr</span> across <span class="num">' + dayCount + '</span> day' + (dayCount===1?'':'s');
  }
  document.getElementById('save').classList.toggle('dirty', state.dirty.size > 0);
}

function renderAll() { renderGrid(); renderBanner(); renderNotes(); renderSummary(); }

function summarizeSlots(slots) {
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

function attachPainter() {
  const grid = document.getElementById('grid');
  let painting = false, paintMode = null, paintDate = null;

  function quarterAt(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    if (!el) return null;
    return el.closest && el.closest('.quarter');
  }
  function onDown(e) {
    const q = e.target.closest && e.target.closest('.quarter');
    if (!q) return;
    e.preventDefault();
    painting = true;
    paintDate = q.dataset.date;
    state.selectedDate = paintDate;
    if (!state.daySlots.has(paintDate)) state.daySlots.set(paintDate, new Set());
    const slots = state.daySlots.get(paintDate);
    const idx = +q.dataset.slot;
    paintMode = slots.has(idx) ? 'remove' : 'add';
    apply(q, idx);
    renderNotes();
  }
  function onMove(e) {
    if (!painting) return;
    const t = e.touches ? e.touches[0] : e;
    const q = quarterAt(t.clientX, t.clientY);
    if (!q) return;
    if (q.dataset.date !== paintDate) return;
    apply(q, +q.dataset.slot);
  }
  function onUp() {
    if (painting) {
      state.dirty.add(paintDate);
      renderGrid();
      renderSummary();
    }
    painting = false; paintDate = null;
  }
  function apply(q, idx) {
    const slots = state.daySlots.get(paintDate);
    if (paintMode === 'add') slots.add(idx); else slots.delete(idx);
    q.classList.toggle('on', slots.has(idx));
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
  // Ensure notes for selected day are captured
  if (state.selectedDate) {
    state.notes.set(state.selectedDate, document.getElementById('notes').value);
  }
  const dirtyDays = Array.from(state.dirty);
  if (dirtyDays.length === 0) { toast('Nothing to save'); return; }

  const tasks = dirtyDays.map(d => {
    const slots = Array.from(state.daySlots.get(d) || new Set());
    const notes = state.notes.get(d) || '';
    return fetch('/api/save', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token, date: d, srcTz: tzSel.value, slots, notes }) }).then(r => r.json());
  });

  const results = await Promise.all(tasks);
  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) { toast('Some saves failed', true); return; }
  state.dirty.clear();
  for (const d of dirtyDays) state.dayConfirmed.set(d, null);
  toast('Saved ' + dirtyDays.length + ' day' + (dirtyDays.length===1?'':'s'));
  renderAll();
}

async function doConfirm() {
  const r = await fetch('/api/confirm', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ token }) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || 'Confirm failed', true); return; }
  state.dayConfirmed.set(todayInTz(tzSel.value), j.confirmedAt);
  toast('Confirmed today');
  renderAll();
}

async function doClear() {
  if (!state.selectedDate) return;
  state.daySlots.set(state.selectedDate, new Set());
  state.dirty.add(state.selectedDate);
  renderAll();
}

document.getElementById('notes').addEventListener('input', (e) => {
  if (state.selectedDate) {
    state.notes.set(state.selectedDate, e.target.value);
    state.dirty.add(state.selectedDate);
    document.getElementById('save').classList.add('dirty');
  }
});

async function loadStateForTz(tz) {
  const ctTodayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  const dates = new Set();
  const t0 = todayInTz(tz);
  for (let i = -1; i <= VIEW_DAYS; i++) {
    dates.add(addDays(t0, i));
    dates.add(addDays(ctTodayStr, i));
  }
  state.daySlots.clear();
  state.dayConfirmed.clear();
  state.notes.clear();
  state.dirty.clear();
  for (const d of dates) {
    const r = await fetch('/api/state/' + campaign + '/' + d + '/' + closerSlug);
    const j = await r.json();
    if (!j.ok || !j.data) continue;
    const data = j.data;
    const ctSlots = data.slots || [];
    for (const ctSlot of ctSlots) {
      const { tzDate, tzSlot } = ctToTz(d, ctSlot, tz);
      if (!state.daySlots.has(tzDate)) state.daySlots.set(tzDate, new Set());
      state.daySlots.get(tzDate).add(tzSlot);
    }
    if (data.confirmedAt) state.dayConfirmed.set(d, data.confirmedAt);
    if (data.notes) state.notes.set(d, data.notes);
  }
  renderAll();
}

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
tzSel.onchange = async () => {
  state.selectedDate = todayInTz(tzSel.value);
  await loadStateForTz(tzSel.value);
};

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
${BRAND_HEAD}
<style>
${BRAND_VARS}
body{margin:0;font-family:var(--sans);background:var(--bg);color:var(--ink)}
header{background:color-mix(in oklab,var(--bg) 78%,white);backdrop-filter:saturate(140%) blur(8px);-webkit-backdrop-filter:saturate(140%) blur(8px);padding:1rem 1.25rem;border-bottom:1px solid var(--rule);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.6rem;position:sticky;top:0;z-index:10}
h1{margin:0;font-family:var(--serif);font-size:1.375rem;font-weight:500;letter-spacing:-0.01em;line-height:1}
.meta{font-size:0.6875rem;color:var(--ink-soft);font-family:var(--mono);letter-spacing:0.08em;text-transform:uppercase;margin-top:4px}
.day-pills{display:flex;overflow-x:auto;gap:0.5rem;padding:0.875rem 1.25rem;background:var(--bg);border-bottom:1px solid var(--rule);scrollbar-width:none}
.day-pills::-webkit-scrollbar{display:none}
.pill{flex-shrink:0;padding:0.55rem 1rem;border-radius:999px;background:var(--paper);border:1px solid var(--rule);color:var(--ink-soft);cursor:pointer;font-size:0.8125rem;font-weight:500;font-family:inherit;white-space:nowrap;transition:all 0.15s;display:flex;flex-direction:column;align-items:center;gap:1px;line-height:1.1}
.pill:hover{border-color:var(--ink-soft);color:var(--ink)}
.pill.active{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.pill .pn{font-family:var(--mono);font-size:9.5px;text-transform:uppercase;letter-spacing:0.1em;font-weight:500;opacity:0.85}
.pill .pd{font-family:var(--serif);font-size:13px;letter-spacing:-0.01em}
main{padding:1.25rem;overflow-x:auto;max-width:1600px;margin:0 auto}
.board{background:var(--paper);border:1px solid var(--rule);border-radius:14px;padding:1rem;box-shadow:0 1px 0 rgba(255,255,255,0.5) inset}
.axis{display:grid;grid-template-columns:8rem 1fr;gap:0.5rem;align-items:center;margin-bottom:0.5rem;font-size:0.6875rem;color:var(--ink-soft);font-family:var(--mono);font-variant-numeric:tabular-nums}
.axis .axis-track{position:relative;height:1.25rem;min-width:60rem}
.axis .tick{position:absolute;top:0;border-left:1px solid var(--rule);height:100%;padding-left:0.3rem}
.axis .tick.hour{border-left-color:var(--ink-faint);color:var(--ink)}
.gantt{display:grid;grid-template-columns:8rem 1fr;gap:0.5rem;align-items:center;min-width:fit-content}
.closer{font-size:0.875rem;font-weight:500;padding-right:0.5rem;text-align:right;white-space:nowrap;color:var(--ink);font-family:var(--serif);letter-spacing:-0.005em}
.track{position:relative;height:2.25rem;background:color-mix(in oklab,var(--bg-deep) 45%,white);border-radius:6px;overflow:hidden;min-width:60rem;border:1px solid var(--rule)}
.bar{position:absolute;top:0.2rem;bottom:0.2rem;background:var(--accent);border-radius:4px;cursor:default;box-shadow:0 1px 2px rgba(200,67,29,0.25);transition:background 0.1s}
.bar.pending{background:repeating-linear-gradient(45deg,var(--accent-2) 0,var(--accent-2) 5px,var(--glow) 5px,var(--glow) 10px);opacity:0.85;box-shadow:none}
.bar:hover{background:color-mix(in oklab,var(--accent) 80%,var(--ink))}
.coverage{margin-top:1rem;display:grid;grid-template-columns:8rem 1fr;gap:0.5rem;align-items:center}
.coverage .closer{color:var(--ink-soft);font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:0.08em}
.cov-track{position:relative;height:1.25rem;background:color-mix(in oklab,var(--bg-deep) 50%,white);border-radius:5px;overflow:hidden;min-width:60rem;display:flex;border:1px solid var(--rule)}
.cov-cell{flex:1;border-right:1px solid var(--rule)}
.legend{margin-top:1.25rem;font-size:0.75rem;color:var(--ink-soft);display:flex;gap:1.25rem;flex-wrap:wrap;font-family:var(--mono);text-transform:uppercase;letter-spacing:0.06em}
.legend .box{display:inline-block;width:1rem;height:0.75rem;vertical-align:middle;margin-right:0.4rem;border-radius:3px}
.empty{color:var(--ink-soft);font-style:italic;font-family:var(--serif);padding:2.5rem 0;text-align:center;font-size:1.125rem}
.tip{position:fixed;background:var(--paper);border:1px solid var(--rule);padding:0.65rem 0.85rem;border-radius:8px;font-size:0.75rem;pointer-events:none;display:none;z-index:30;max-width:18rem;color:var(--ink);box-shadow:0 12px 28px -8px rgba(82,40,15,0.30),0 1px 0 rgba(255,255,255,0.55) inset;line-height:1.5;font-family:var(--sans)}
.tip strong{font-family:var(--serif);font-weight:500}
</style></head>
<body>
<header>
  <div>
    <h1>${esc(cfg.displayName)}</h1>
    <div class="meta">Manager · all times Central · auto-refresh 30s</div>
  </div>
  <div class="meta" id="lastSync"></div>
</header>
<div class="day-pills" id="pills"></div>
<main>
  <div class="board">
    <div class="axis" id="axis"></div>
    <div class="gantt" id="gantt"></div>
    <div class="coverage" id="coverage"></div>
    <div class="legend">
      <span><span class="box" style="background:var(--accent)"></span>Confirmed</span>
      <span><span class="box" style="background:repeating-linear-gradient(45deg,var(--accent-2) 0,var(--accent-2) 5px,var(--glow) 5px,var(--glow) 10px)"></span>Pending</span>
      <span><span class="box" style="background:var(--good)"></span>Coverage heat</span>
    </div>
  </div>
</main>
<div class="tip" id="tip"></div>
<script>
const campaign = ${JSON.stringify(campaign)};
const visibleHours = ${JSON.stringify(visibleHours)};
const VIEW_DAYS = ${VIEW_AHEAD_DAYS};
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
function fmtPillName(n, iso) {
  if (n === 0) return 'TODAY';
  if (n === 1) return 'TOMORROW';
  const [y,m,da] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m-1, da)).toLocaleDateString('en-US', { weekday:'short', timeZone:'UTC' }).toUpperCase();
}
function fmtPillDate(iso) {
  const [y,m,da] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m-1, da)).toLocaleDateString('en-US', { month:'short', day:'numeric', timeZone:'UTC' });
}
function slotLabel(s) {
  const h = Math.floor(s/4) % 24;
  const m = (s%4)*15;
  const ap = h < 12 ? 'a' : 'p';
  const h12 = h%12 === 0 ? 12 : h%12;
  return h12 + (m>0 ? ':' + String(m).padStart(2,'0') : '') + ap;
}

function renderPills() {
  const t0 = ctToday();
  const pills = document.getElementById('pills');
  pills.innerHTML = '';
  for (let i = 0; i < VIEW_DAYS; i++) {
    const d = addDays(t0, i);
    const p = document.createElement('div');
    p.className = 'pill' + (d === selectedDate ? ' active' : '');
    p.innerHTML = '<span class="pn">' + fmtPillName(i, d) + '</span><span class="pd">' + fmtPillDate(d) + '</span>';
    p.onclick = () => { selectedDate = d; loadDay(); };
    pills.appendChild(p);
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

function pct(slot) { return ((slot - SLOT_START) / SLOT_COUNT) * 100; }

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

function renderGantt(state) {
  const gantt = document.getElementById('gantt');
  gantt.innerHTML = '';
  const closers = state.closers;
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
      const alpha = 0.30 + 0.55 * ratio;
      cell.style.background = 'rgba(45, 122, 95, ' + alpha + ')';
      cell.title = slotLabel(i + SLOT_START) + ' — ' + counts[i] + ' on';
    }
    track.appendChild(cell);
  }
}

async function loadDay() {
  if (!selectedDate) selectedDate = ctToday();
  renderPills();
  renderAxis();
  const r = await fetch('/api/state/' + campaign + '/' + selectedDate);
  const j = await r.json();
  if (!j.ok) return;
  renderGantt(j);
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
