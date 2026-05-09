#!/usr/bin/env node
// Pre-launch schedule check.
// Usage:  node scripts/whos-on.js [campaign] [--no-confirm]
//         (campaign defaults to "solar-exits")
//
// Reads today's schedule for the campaign, prints who's scheduled, who's
// live RIGHT NOW (CT), and asks for a y/N confirmation. Exit code 0 on
// confirm, 1 on abort. Use in pre-launch flows so the dialer roster
// matches what closers actually committed to.

const readline = require('readline');

const args = process.argv.slice(2).filter(Boolean);
const noConfirm = args.includes('--no-confirm');
const positional = args.filter(a => !a.startsWith('--'));
const campaign = positional[0] || 'solar-exits';

const HOST = process.env.SCHEDULE_HOST || 'https://schedule.cancelmysolar.info';
const TZ = 'America/Chicago';

function ctParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: +parts.hour,
    minute: +parts.minute,
  };
}

function slotLabel(slot) {
  const h = Math.floor(slot / 4);
  const m = (slot % 4) * 15;
  const ampm = h >= 12 ? 'p' : 'a';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m === 0 ? '' : ':' + String(m).padStart(2, '0')}${ampm}`;
}

function bucketRanges(slots) {
  if (!slots || !slots.length) return [];
  const sorted = [...slots].sort((a, b) => a - b);
  const out = [];
  let start = sorted[0], prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) { prev = sorted[i]; continue; }
    out.push([start, prev]); start = sorted[i]; prev = sorted[i];
  }
  out.push([start, prev]);
  return out;
}

function rangeLabel([s, e]) {
  // e is the last covered slot; end-time is the slot AFTER it.
  return `${slotLabel(s)}–${slotLabel(e + 1)}`;
}

async function main() {
  const now = ctParts();
  const nowSlot = now.hour * 4 + Math.floor(now.minute / 15);
  const url = `${HOST}/api/state/${encodeURIComponent(campaign)}/${now.date}`;

  const r = await fetch(url);
  if (!r.ok) {
    console.error(`✗ ${url} → ${r.status}`);
    process.exit(2);
  }
  const data = await r.json();
  if (!data.ok) {
    console.error(`✗ API: ${data.error || 'unknown error'}`);
    process.exit(2);
  }

  console.log('');
  console.log(`  Campaign: ${campaign}`);
  console.log(`  Today (CT): ${now.date}`);
  console.log(`  Now (CT):   ${slotLabel(nowSlot)} (slot ${nowSlot})`);
  console.log('');

  const liveNow = [];
  const onToday = [];
  const empty = [];

  for (const c of data.closers) {
    const cs = data.state?.[c.slug];
    const slots = cs?.slots || [];
    const confirmed = !!cs?.confirmedAt;
    if (!slots.length) { empty.push(c.name); continue; }

    const ranges = bucketRanges(slots).map(rangeLabel).join(', ');
    const isLive = slots.includes(nowSlot);
    const tag = (isLive ? '🟢 LIVE NOW ' : '         ') +
                (confirmed ? '✓' : '·');
    const line = `  ${tag}  ${c.name.padEnd(22)} ${ranges}`;
    onToday.push(line);
    if (isLive) liveNow.push(c.name);
  }

  if (onToday.length) {
    console.log('  Scheduled today:');
    for (const l of onToday) console.log(l);
    console.log('');
  }
  if (empty.length) {
    console.log(`  No hours set: ${empty.join(', ')}`);
    console.log('');
  }

  console.log(`  Live right now: ${liveNow.length ? liveNow.join(', ') : '— nobody —'}`);
  console.log('');

  if (noConfirm) {
    process.exit(liveNow.length ? 0 : 1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise(res => rl.question('  Launch campaign with these closers? (y/N) ', res));
  rl.close();
  if (ans.trim().toLowerCase().startsWith('y')) {
    console.log('  ✅ Confirmed.');
    process.exit(0);
  } else {
    console.log('  ❌ Aborted.');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(2); });
