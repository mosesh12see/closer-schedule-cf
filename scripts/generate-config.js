#!/usr/bin/env node
// Generates PINs + master key for a campaign, writes the cfg JSON for KV upload,
// and writes a .secrets file (gitignored) with the plaintext PINs / master URL.
//
// Default behavior PRESERVES existing PINs + master key. Closers already in the
// previous cfg-{slug}.json keep the PIN listed in secrets-{slug}.txt; only NEW
// roster entries (by slug) get a fresh PIN. This keeps text messages stable
// when adding people.
//
// Usage:
//   node scripts/generate-config.js <slug> "<Display Name>"           (default — preserve)
//   node scripts/generate-config.js <slug> "<Display Name>" --rotate-pins
//   node scripts/generate-config.js <slug> "<Display Name>" --rotate-master
//   node scripts/generate-config.js <slug> "<Display Name>" --rotate-all

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const positional = argv.filter(a => !a.startsWith('--'));
const [campaignSlug, ...displayNameParts] = positional;
const displayName = displayNameParts.join(' ') || campaignSlug;
if (!campaignSlug) {
  console.error('usage: node generate-config.js <slug> "<Display Name>" [--rotate-pins] [--rotate-master] [--rotate-all]');
  process.exit(1);
}
const rotateAll = flags.has('--rotate-all');
const rotatePins = rotateAll || flags.has('--rotate-pins');
const rotateMaster = rotateAll || flags.has('--rotate-master');

// Define the closer roster here for the campaign.
// Keep slugs stable — they appear in URLs and KV keys.
const ROSTERS = {
  'solar-exits': [
    { slug: 'mauricio',  name: 'Mauricio Betancourt', defaultTz: 'America/Los_Angeles' },
    { slug: 'elle',      name: 'Elle Haskin',         defaultTz: 'America/Los_Angeles' },
    { slug: 'ej',        name: 'EJ Green',            defaultTz: 'America/Chicago' },
    { slug: 'igor',      name: 'Igor Godoroja',       defaultTz: 'America/New_York' },
    { slug: 'brooke',    name: 'Brooke Russell',      defaultTz: 'America/Chicago' },
    { slug: 'jared',     name: 'Jared Curtis',        defaultTz: 'America/Chicago' },
    { slug: 'dpena',     name: 'Daniel Pena',         defaultTz: 'America/Chicago' },
    { slug: 'draines',   name: 'Daniel Raines',       defaultTz: 'America/Chicago' },
    { slug: 'alexandra', name: 'Alexandra Skouzes',   defaultTz: 'America/Chicago' },
    { slug: 'joshua',    name: 'Joshua S Drillette',  defaultTz: 'America/Chicago' },
  ],
  'capital-energy-az': [
    { slug: 'dayne',     name: 'Dayne Hall',          defaultTz: 'America/Phoenix' },
    { slug: 'thomas',    name: 'Thomas Quist',        defaultTz: 'America/Phoenix' },
  ],
  'steve-iul': [
    { slug: 'steve',     name: 'Steve Lyman',         defaultTz: 'America/Denver' },
  ],
};

const roster = ROSTERS[campaignSlug];
if (!roster) {
  console.error(`No roster defined for "${campaignSlug}". Add one to ROSTERS in this script.`);
  process.exit(1);
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
function randomPin() {
  // 4-digit, not starting with 0 to keep it tactile
  return String(1000 + crypto.randomInt(0, 9000));
}
function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

const outDir = path.resolve(__dirname, '..');
const cfgPath = path.join(outDir, `cfg-${campaignSlug}.json`);
const secretsPath = path.join(outDir, `secrets-${campaignSlug}.txt`);

// Load existing state (if any) so we can preserve PINs + master key + admin code.
function loadExisting() {
  const out = { cfg: null, pinByName: new Map(), masterKey: null, adminCode: null };
  if (fs.existsSync(cfgPath)) {
    try { out.cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  }
  if (fs.existsSync(secretsPath)) {
    const txt = fs.readFileSync(secretsPath, 'utf8');
    const m = txt.match(/master\/([a-f0-9]+)/);
    if (m) out.masterKey = m[1];
    const am = txt.match(/Admin PIN:\s*(\d+)/);
    if (am) out.adminCode = am[1];
    for (const line of txt.split('\n')) {
      const pm = line.match(/^\s*(.+?)\s{2,}https.+PIN:\s*(\d+)/);
      if (pm && !/Admin PIN/.test(pm[1])) out.pinByName.set(pm[1].trim(), pm[2]);
    }
  }
  return out;
}
const existing = loadExisting();

const masterKey = (!rotateMaster && existing.masterKey) ? existing.masterKey : randomToken(12);
const masterKeyHash = sha256Hex(`${campaignSlug}:master:${masterKey}`);

const rotateAdmin = rotateAll || flags.has('--rotate-admin');
const adminCode = (!rotateAdmin && existing.adminCode) ? existing.adminCode : randomPin();
const adminCodeHash = sha256Hex(`${campaignSlug}:admin:${adminCode}`);
const adminCodeIsNew = !existing.adminCode || rotateAdmin;

const newPins = []; // log which closers got fresh PINs
const closers = roster.map(c => {
  let pin;
  if (!rotatePins && existing.cfg) {
    const prev = existing.cfg.closers.find(x => x.slug === c.slug);
    if (prev) {
      // Find PIN in secrets by previous OR current display name.
      pin = existing.pinByName.get(prev.name) || existing.pinByName.get(c.name);
    }
  }
  if (!pin) {
    pin = randomPin();
    newPins.push({ slug: c.slug, name: c.name, pin });
  }
  const pinHash = sha256Hex(`${campaignSlug}:${c.slug}:${pin}`);
  return {
    config: { slug: c.slug, name: c.name, defaultTz: c.defaultTz, pinHash },
    plain: { slug: c.slug, name: c.name, pin }
  };
});

// Preserve previous visibleHours + openAccess if cfg already had them.
const cfg = {
  name: campaignSlug,
  displayName,
  visibleHours: existing.cfg?.visibleHours || [6, 23],
  masterKeyHash,
  adminCodeHash,
  closers: closers.map(c => c.config),
};
if (existing.cfg?.openAccess) cfg.openAccess = true;
// Single-closer rosters are personal dashboards — no PIN, URL = auth.
if (roster.length === 1) cfg.openAccess = true;

fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

const lines = [
  `Closer Schedule Dashboard — ${displayName}`,
  `Generated ${new Date().toISOString()}`,
  '',
  `Master URL:`,
  `  https://transfers.vertacall.net/c/${campaignSlug}/master/${masterKey}`,
  '',
  `Admin URL:    https://transfers.vertacall.net/c/${campaignSlug}/admin`,
  `Admin PIN:    ${adminCode}`,
  '',
  `Closer URLs + PINs:`,
];
for (const c of closers) {
  if (cfg.openAccess) {
    lines.push(`  ${c.plain.name.padEnd(22)}  https://transfers.vertacall.net/c/${campaignSlug}/schedule/${c.plain.slug}        (no PIN — personal link)`);
  } else {
    lines.push(`  ${c.plain.name.padEnd(22)}  https://transfers.vertacall.net/c/${campaignSlug}        PIN: ${c.plain.pin}`);
  }
}
lines.push('');
if (cfg.openAccess) {
  lines.push(`Each closer's link IS their auth — no PIN. Bookmark and go.`);
} else {
  lines.push(`Each closer goes to:  https://transfers.vertacall.net/c/${campaignSlug}`);
  lines.push(`Picks their name, types their PIN, schedules their hours.`);
}
lines.push('');
fs.writeFileSync(secretsPath, lines.join('\n'));

console.log(`✓ Wrote ${cfgPath}`);
console.log(`✓ Wrote ${secretsPath}  (gitignored)`);
if (newPins.length) {
  console.log('');
  console.log('New PINs generated for:');
  for (const p of newPins) console.log(`  ${p.name.padEnd(22)} PIN: ${p.pin}`);
} else if (!rotatePins) {
  console.log('All existing PINs preserved.');
}
if (rotateMaster) console.log('Master key rotated.');
if (adminCodeIsNew) console.log(`Admin PIN ${rotateAdmin ? 'rotated' : 'set'}: ${adminCode}`);
console.log('');
console.log('Next steps:');
console.log(`  npx wrangler kv key put --binding=SCHEDULE_KV --remote "cfg:campaign:${campaignSlug}" --path="${path.basename(cfgPath)}"`);
