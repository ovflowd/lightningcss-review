// Turns raw engine results into per-case verdicts. Runs in the analysis image.
//
// usage: node compare.mjs --cases cases.jsonl --jobs jobs.jsonl --env env.json --out verdicts.jsonl
//        --results latest=results-latest.jsonl [--results legacy-2023=results-legacy-2023.jsonl ...]
//        [--shots DIR]
// Result files are streamed (they can exceed V8's string limit); `.gz` files are read transparently.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { engineEntry, summarize } from './verdict.mjs';
import { readJsonl, jsonlWriter } from './jsonl.mjs';

// Screenshot comparison: identical hashes are identical; otherwise decode and allow anti-aliasing
// noise (per-channel delta <= 3 on <= 0.1% of pixels) before calling it a visual difference.
let PNG = null;
try {
  PNG = createRequire(import.meta.url)('pngjs').PNG;
} catch {}
// Same naming as engine-runner.cjs: `/` in ids never becomes a directory.
const shotFile = (dir, id, engine, variant) => path.join(dir, `${id.replace(/[\\/]/g, '__')}.${engine}.${variant}.png`);
function pixelCompare(dir, id, engine, variant, ref) {
  if (!PNG || !dir) return 'pixel-different';
  try {
    const a = PNG.sync.read(fs.readFileSync(shotFile(dir, id, engine, ref)));
    const b = PNG.sync.read(fs.readFileSync(shotFile(dir, id, engine, variant)));
    if (a.width !== b.width || a.height !== b.height) return 'pixel-different';
    let bad = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]), Math.abs(a.data[i + 3] - b.data[i + 3]));
      if (d > 3) bad++;
    }
    return bad / (a.width * a.height) <= 0.001 ? 'pixel-near' : 'pixel-different';
  } catch {
    return 'pixel-different';
  }
}

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const many = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const SHOTS = opt('--shots', null);

const cases = new Map();
for await (const c of readJsonl(opt('--cases'))) cases.set(c.id, c);
const jobs = new Map();
for await (const j of readJsonl(opt('--jobs'))) jobs.set(j.id, j);
const env = JSON.parse(fs.readFileSync(opt('--env'), 'utf8'));
const profiles = many('--results').map((spec) => {
  const [name, file] = spec.split('=');
  return { name, file, role: (env.profiles && env.profiles[name] && env.profiles[name].role) || (name === 'latest' ? 'reference' : 'legacy') };
});
// The reference profile goes first: lowering verdicts need its input `touched`.
profiles.sort((a, b) => (a.role === 'reference' ? 0 : 1) - (b.role === 'reference' ? 0 : 1));

const buckets = new Map(); // id -> {latest: {engine: entry}, legacy: {profile: {engine: entry}}}
const refTouched = new Map(); // `${id}|${engine}` -> reference input touched
for (const profile of profiles) {
  for await (const r of readJsonl(profile.file)) {
    const job = jobs.get(r.id);
    if (!job) continue;
    const c = cases.get(r.id.replace(/~dark$/, '')) || {};
    if (profile.role === 'reference') {
      const touched = r.result && r.result.variants && r.result.variants.input ? r.result.variants.input.touched : null;
      refTouched.set(r.id + '|' + r.engine, touched || null);
    }
    const entry = engineEntry(profile.role, r, job, c, refTouched.get(r.id + '|' + r.engine));
    if (r.shots) {
      const s = r.shots;
      const judge = (v) => (s[v] && s.input ? (s[v] === s.input ? 'pixel-identical' : pixelCompare(SHOTS, r.id, r.engine, v, 'input')) : null);
      entry.visual = { base: judge('base'), head: judge('head') };
    }
    if (r.visualError) entry.visualError = r.visualError;
    if (!buckets.has(r.id)) buckets.set(r.id, { latest: {}, legacy: {} });
    const b = buckets.get(r.id);
    const bucket = profile.role === 'reference' ? b.latest : (b.legacy[profile.name] = b.legacy[profile.name] || {});
    bucket[r.engine] = entry;
  }
}

const sortKeys = (obj) => Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
const out = jsonlWriter(opt('--out'));
for (const id of [...jobs.keys()].sort()) {
  const job = jobs.get(id);
  const caseId = id.replace(/~dark$/, '');
  const c = cases.get(caseId) || {};
  const b = buckets.get(id) || { latest: {}, legacy: {} };
  const legacy = {};
  for (const p of profiles) if (b.legacy[p.name]) legacy[p.name] = sortKeys(b.legacy[p.name]);
  const verdict = { id, case: caseId, kind: job.kind, scheme: id.endsWith('~dark') ? 'dark' : 'light', latest: sortKeys(b.latest), legacy };
  // `introduced`: base cannot run the request (a flag or option the PR adds), so head is judged
  // against the input alone.
  const opts = { introduced: Boolean(c.introduced) };
  const touched = Object.fromEntries(Object.keys(verdict.latest).map((engine) => [engine, refTouched.get(id + '|' + engine)]));
  verdict.summary = { latest: summarize(verdict.latest, { ...opts, touched }), legacy: {} };
  for (const [name, bucket] of Object.entries(verdict.legacy)) verdict.summary.legacy[name] = summarize(bucket, opts);
  out.write(verdict);
}
await out.end();
