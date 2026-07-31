'use strict';
// Build-time tool (NOT shipped). Downloads every item icon referenced by
// renderer/assets/items.json from the community item DB, resizes to 64px and
// converts to WebP, writing them into renderer/assets/items/<name>.webp so they
// can be bundled into the app (no runtime fetch). Resumable: skips files that
// already exist. Run: node tools/build-icons.js
const fs = require('fs');
const path = require('path');
const https = require('https');
const sharp = require('sharp');

const HOST = 'https://ool.iota-plus.com';
const APP = path.join(__dirname, '..');
const OUT = path.join(APP, 'renderer', 'assets', 'items');
const DB = path.join(APP, 'renderer', 'assets', 'items.json');
const CONCURRENCY = 3;       // gentle — the CDN rate-limits aggressive concurrency
const REQ_DELAY = 60;        // ms between requests per worker
const RETRIES = 3;
const TARGET = 64;

const base = (f) => f.replace(/^.*\//, '').replace(/\.[a-z0-9]+$/i, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve a buffer; HTTP errors carry .status so callers can branch on 404.
function get(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'PlaT-RCON-Admin' }, timeout: 12000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = res.headers.location.startsWith('http') ? res.headers.location : HOST + res.headers.location;
        return resolve(get(next, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); const err = new Error('HTTP ' + res.statusCode); err.status = res.statusCode; return reject(err); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

// Retry network errors / 5xx / 429 with backoff; never retry a 404.
async function fetchWithRetry(url) {
  let lastErr;
  for (let i = 0; i <= RETRIES; i++) {
    try { return await get(url); }
    catch (e) { lastErr = e; if (e.status === 404) throw e; await sleep(300 + i * 500); }
  }
  throw lastErr;
}

// Most icons live at /static/img/items/; dlc_* and absolute-path icons live at
// /static/icons/. Try items first, fall back to /static/icons on 404.
async function fetchIcon(file) {
  const candidates = file.startsWith('/') ? [file] : ['/static/img/items/' + file, '/static/icons/' + file];
  let lastErr;
  for (const p of candidates) {
    try { return await fetchWithRetry(HOST + p); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
  const icons = [...new Set(Object.values(db).map((v) => v && v.i).filter(Boolean))];
  console.log(`Unique icons referenced: ${icons.length}`);

  let done = 0, downloaded = 0, skipped = 0;
  const failed = [];
  let cursor = 0;

  async function worker() {
    while (cursor < icons.length) {
      const file = icons[cursor++];
      const outPath = path.join(OUT, base(file) + '.webp');
      if (fs.existsSync(outPath)) { skipped++; done++; continue; }
      try {
        const buf = await fetchIcon(file);
        const webp = await sharp(buf).resize(TARGET, TARGET, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
        fs.writeFileSync(outPath, webp);
        downloaded++;
      } catch (e) {
        failed.push(`${file}\t${e.status || e.message}`);
      }
      done++;
      await sleep(REQ_DELAY);
      if (done % 200 === 0) console.log(`  ${done}/${icons.length} (dl ${downloaded}, skip ${skipped}, fail ${failed.length})`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (failed.length) fs.writeFileSync(path.join(__dirname, 'icon-failures.txt'), failed.join('\n'));
  let bytes = 0;
  for (const f of fs.readdirSync(OUT)) bytes += fs.statSync(path.join(OUT, f)).size;
  console.log(`\nDone. downloaded=${downloaded} skipped=${skipped} failed=${failed.length}`);
  console.log(`Output: ${fs.readdirSync(OUT).length} webp files, ${(bytes / 1048576).toFixed(1)} MB`);
  if (failed.length) console.log(`Failures written to tools/icon-failures.txt (first few): ${failed.slice(0, 5).map((x) => x.split('\t')[0]).join(', ')}`);
})();
