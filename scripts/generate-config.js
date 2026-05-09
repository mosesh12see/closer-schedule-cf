#!/usr/bin/env node
// Generates PINs + master key for a campaign, writes the cfg JSON for KV upload,
// and writes a .secrets file (gitignored) with the plaintext PINs / master URL.
//
// Usage:  node scripts/generate-config.js solar-exits "Solar Elite Recovery"

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [campaignSlug, ...displayNameParts] = process.argv.slice(2);
const displayName = displayNameParts.join(' ') || campaignSlug;
if (!campaignSlug) {
  console.error('usage: node generate-config.js <slug> "<Display Name>"');
  process.exit(1);
}

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

const masterKey = randomToken(12); // 24 hex chars
const masterKeyHash = sha256Hex(`${campaignSlug}:master:${masterKey}`);

const closers = roster.map(c => {
  const pin = randomPin();
  const pinHash = sha256Hex(`${campaignSlug}:${c.slug}:${pin}`);
  return {
    config: { slug: c.slug, name: c.name, defaultTz: c.defaultTz, pinHash },
    plain: { slug: c.slug, name: c.name, pin }
  };
});

const cfg = {
  name: campaignSlug,
  displayName,
  visibleHours: [6, 23],
  masterKeyHash,
  closers: closers.map(c => c.config)
};

const outDir = path.resolve(__dirname, '..');
const cfgPath = path.join(outDir, `cfg-${campaignSlug}.json`);
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

const secretsPath = path.join(outDir, `secrets-${campaignSlug}.txt`);
const lines = [
  `Closer Schedule Dashboard — ${displayName}`,
  `Generated ${new Date().toISOString()}`,
  '',
  `Master URL:`,
  `  https://schedule.cancelmysolar.info/c/${campaignSlug}/master/${masterKey}`,
  '',
  `Closer URLs + PINs:`,
];
for (const c of closers) {
  lines.push(`  ${c.plain.name.padEnd(22)}  https://schedule.cancelmysolar.info/c/${campaignSlug}        PIN: ${c.plain.pin}`);
}
lines.push('');
lines.push(`Each closer goes to:  https://schedule.cancelmysolar.info/c/${campaignSlug}`);
lines.push(`Picks their name, types their PIN, schedules their hours.`);
lines.push('');
fs.writeFileSync(secretsPath, lines.join('\n'));

console.log(`✓ Wrote ${cfgPath}`);
console.log(`✓ Wrote ${secretsPath}  (gitignored)`);
console.log('');
console.log('Next steps:');
console.log(`  1. Create KV namespace + put cfg into it:`);
console.log(`     wrangler kv namespace create SCHEDULE_KV`);
console.log(`     wrangler kv key put --binding=SCHEDULE_KV "cfg:campaign:${campaignSlug}" --path="${path.basename(cfgPath)}"`);
console.log(`  2. wrangler deploy`);
