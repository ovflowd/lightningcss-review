// Turns raw engine results into per-case verdicts. Runs in the analysis image.
//
// usage: node compare.mjs --cases cases.jsonl --jobs jobs.jsonl --env env.json --out verdicts.jsonl
//        --results latest=results-latest.jsonl [--results legacy-2023=results-legacy-2023.jsonl ...]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { compareValues, worstLevel } from './normalize.mjs';

// Screenshot comparison: identical hashes are identical; otherwise decode and allow anti-aliasing
// noise (per-channel delta <= 3 on <= 0.1% of pixels) before calling it a visual difference.
let PNG = null;
try {
  PNG = createRequire(import.meta.url)('pngjs').PNG;
} catch {}
function pixelCompare(dir, id, engine, variant, ref) {
  if (!PNG || !dir) return 'pixel-different';
  try {
    const a = PNG.sync.read(fs.readFileSync(path.join(dir, `${id}.${engine}.${ref}.png`)));
    const b = PNG.sync.read(fs.readFileSync(path.join(dir, `${id}.${engine}.${variant}.png`)));
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
const SHOTS = (() => {
  const i = process.argv.indexOf('--shots');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const many = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);

const ENGINE_TARGET = { chromium: 'chrome', firefox: 'firefox', webkit: 'safari' };
const FOREIGN = {
  chromium: /-(moz|ms|o)-/i,
  webkit: /-(moz|ms|o)-/i,
  firefox: /-(webkit|ms|o)-/i,
};

const cases = new Map(readJsonl(opt('--cases')).map((c) => [c.id, c]));
const jobs = new Map(readJsonl(opt('--jobs')).map((j) => [j.id, j]));
const env = JSON.parse(fs.readFileSync(opt('--env'), 'utf8'));
const profiles = many('--results').map((spec) => {
  const [name, file] = spec.split('=');
  return { name, role: (env.profiles && env.profiles[name] && env.profiles[name].role) || (name === 'latest' ? 'reference' : 'legacy'), results: readJsonl(file) };
});

function encode(version) {
  const p = String(version).split('.').map((x) => parseInt(x, 10) || 0);
  return ((p[0] || 0) << 16) | ((p[1] || 0) << 8) | (p[2] || 0);
}

function statusOf(level) {
  if (level === 'equal' || level === 'noise') return 'equivalent';
  if (level === 'space-changed' || level === 'near' || level === 'custom-changed') return 'near';
  return 'different';
}

const STATUS_RANK = { equivalent: 0, 'no-coverage': 1, near: 2, unknown: 1, different: 3, error: 3 };
const worstStatus = (list) => list.reduce((w, s) => (STATUS_RANK[s] > STATUS_RANK[w] ? s : w), 'equivalent');

function validity(engine, job, info, inputInfo) {
  const out = { rejectedDecls: [], rejectedSelectors: [], rejectedPreludes: [] };
  if (!info || !inputInfo || !job.probe) return out;
  const variantProbe = (name) => job.probe[name] || { decls: [], selectors: [], preludes: [] };
  return out;
}

function sheetVerdict(engine, job, result, mode, refTouched) {
  // mode 'same-engine': compare variant diffs against this engine's input.
  // mode 'lowering': compare this (legacy) engine's variant values to the reference engine input.
  const variants = result.variants || {};
  const input = variants.input || {};
  const out = {};
  const touched = mode === 'same-engine' ? input.touched || {} : refTouched || {};
  const touchedCount = Object.values(touched).reduce((n, vals) => n + Object.keys(vals).length, 0);
  for (const name of ['base', 'head']) {
    const v = variants[name];
    if (!v) {
      out[name] = { status: 'unknown', reason: 'no-output' };
      continue;
    }
    const diffs = [];
    if (mode === 'same-engine') {
      for (const [key, prop, ref, val] of v.diff || []) {
        // LightningCSS's own polyfill toggles (light-dark(): --lightningcss-light/-dark) are not
        // author CSS; their effect is judged through the properties that consume them.
        if (prop.startsWith('--lightningcss-')) continue;
        const r = compareValues(prop, ref, val, 'same-engine');
        if (r.level !== 'equal') diffs.push({ key, prop, ref, val, level: r.level, details: r.details });
      }
    } else {
      const values = v.values || {};
      for (const [key, vals] of Object.entries(touched)) {
        for (const [prop, ref] of Object.entries(vals)) {
          const val = values[key] ? values[key][prop] : undefined;
          if (val === undefined || val === '') continue; // property unknown to this engine
          if (prop.startsWith('--lightningcss-')) continue;
          const r = compareValues(prop, ref, val, 'lowering');
          if (r.level !== 'equal') diffs.push({ key, prop, ref, val, level: r.level, details: r.details });
        }
      }
    }
    const level = worstLevel(diffs.map((d) => d.level));
    let status = statusOf(level);
    if (status === 'equivalent' && touchedCount === 0) status = 'no-coverage';
    // validity: declarations/selectors/preludes the engine rejects in this output but not in input
    const probe = job.probe || {};
    const accepted = v.info || {};
    const inAccepted = input.info || {};
    const rejected = { decls: [], selectors: [], preludes: [] };
    const foreign = FOREIGN[engine];
    const inputRejectedDecls = new Set();
    (probe.input ? probe.input.decls : []).forEach((d, i) => {
      if (inAccepted.decls && inAccepted.decls[i] === false) inputRejectedDecls.add(d[0] + ':' + d[1]);
    });
    const inputProps = new Set((probe.input ? probe.input.decls : []).map((d) => d[0]));
    const varDecls = probe[name] ? probe[name].decls : [];
    const acceptedProps = new Set();
    varDecls.forEach((d, i) => {
      if (accepted.decls && accepted.decls[i]) acceptedProps.add(d[0]);
    });
    varDecls.forEach((d, i) => {
      if (!accepted.decls || accepted.decls[i] !== false) return;
      if (d[0].startsWith('--') || foreign.test(d[0]) || foreign.test(d[1])) return;
      if (inputRejectedDecls.has(d[0] + ':' + d[1])) return;
      // A rejected declaration is a fallback chain member when another declaration of the same
      // property is accepted; only report it when nothing for that property survives.
      rejected.decls.push({ prop: d[0], value: d[1], important: d[2], fallbackSurvives: acceptedProps.has(d[0]), inInput: inputProps.has(d[0]) });
    });
    (probe[name] ? probe[name].selectors : []).forEach((s, i) => {
      if (accepted.selectors && accepted.selectors[i] === false && !foreign.test(s)) {
        const inInput = (probe.input ? probe.input.selectors : []).some((t, j) => t === s && inAccepted.selectors && inAccepted.selectors[j] === false);
        if (!inInput) rejected.selectors.push(s);
      }
    });
    (probe[name] ? probe[name].preludes : []).forEach((p, i) => {
      if (accepted.preludes && accepted.preludes[i] === false && !foreign.test(p[1])) {
        const inInput = (probe.input ? probe.input.preludes : []).some((t, j) => t[0] === p[0] && t[1] === p[1] && inAccepted.preludes && inAccepted.preludes[j] === false);
        if (!inInput) rejected.preludes.push(p);
      }
    });
    const hardRejected = rejected.decls.filter((d) => !d.fallbackSurvives);
    // Keep the worst diffs (different before near before noise), not the first in DOM order.
    const RANKED = { different: 0, near: 1, 'custom-changed': 2, 'space-changed': 3, noise: 4 };
    diffs.sort((x, y) => (RANKED[x.level] ?? 9) - (RANKED[y.level] ?? 9) || (x.prop < y.prop ? -1 : x.prop > y.prop ? 1 : 0) || (x.key < y.key ? -1 : 1));
    const levels = {};
    for (const d of diffs) levels[d.level] = (levels[d.level] || 0) + 1;
    // Signature of what differs from the input; equal base/head signatures mean the PR changed
    // the output text without changing how any element computes relative to the input.
    const sig = diffs
      .filter((d) => d.level !== 'noise')
      .map((d) => `${d.key}|${d.prop}|${d.level}|${d.val}`)
      .sort()
      .join('\n');
    out[name] = {
      status,
      diffs: diffs.slice(0, 12),
      diffCount: diffs.length,
      levels,
      sig,
      rejected: { decls: rejected.decls.slice(0, 12), selectors: rejected.selectors.slice(0, 8), preludes: rejected.preludes.slice(0, 8) },
      hardRejected: hardRejected.length + rejected.selectors.length + rejected.preludes.length,
    };
  }
  return { touched: touchedCount, variants: out };
}

const PROPERTY_STATUS = {
  pass: 'equivalent',
  'contextual-match': 'equivalent',
  'computed-difference': 'different',
  'valid-became-invalid': 'different',
  'invalid-became-valid': 'different',
  'fallback-changed': 'different',
  'shorthand-reset-changed': 'different',
  'context-required': 'unknown',
  'unsupported-input': 'unknown',
  'both-unsupported': 'unknown',
  'baseline-unsupported-property': 'unknown',
  'no-output': 'unknown',
};

function propertyVerdict(result) {
  const out = { baseline: result.baseline || null, variants: {} };
  for (const name of ['base', 'head']) {
    const r = result.variants ? result.variants[name] : null;
    if (!r) {
      out.variants[name] = { status: 'unknown' };
      continue;
    }
    let status = PROPERTY_STATUS[r.status] || 'unknown';
    if (result.baseline && status !== 'different') status = 'unknown';
    out.variants[name] = { status, detail: r };
  }
  return out;
}

function transition(base, head) {
  if (base === 'unknown' || head === 'unknown') return 'unverified';
  if (base === 'no-coverage' && head === 'no-coverage') return 'unverified';
  const bad = (s) => s === 'different' || s === 'error';
  if (!bad(base) && !bad(head)) return base === 'near' || head === 'near' ? (head === 'near' && base !== 'near' ? 'near-introduced' : 'both-equivalent') : 'both-equivalent';
  if (bad(base) && !bad(head)) return 'fixed';
  if (!bad(base) && bad(head)) return 'regressed';
  return 'still-different';
}

const out = fs.createWriteStream(opt('--out'));
const reference = profiles.find((p) => p.role === 'reference');
const refByKey = new Map();
if (reference) for (const r of reference.results) refByKey.set(r.id + '|' + r.engine, r);

const ids = [...new Set([...jobs.keys()])].sort();
for (const id of ids) {
  const job = jobs.get(id);
  const caseId = id.replace(/~dark$/, '');
  const c = cases.get(caseId) || {};
  const verdict = { id, case: caseId, kind: job.kind, scheme: id.endsWith('~dark') ? 'dark' : 'light', latest: {}, legacy: {} };
  for (const profile of profiles) {
    for (const r of profile.results.filter((x) => x.id === id)) {
      const engineVersion = r.version;
      let entry;
      if (r.error) entry = { version: engineVersion, error: r.error, variants: { base: { status: 'error' }, head: { status: 'error' } } };
      else if (job.kind === 'property') entry = { version: engineVersion, ...propertyVerdict(r.result) };
      else if (profile.role === 'reference') entry = { version: engineVersion, ...sheetVerdict(r.engine, job, r.result, 'same-engine') };
      else {
        const target = c.targets ? c.targets[ENGINE_TARGET[r.engine]] : undefined;
        const ref = refByKey.get(id + '|' + r.engine);
        if (target === undefined) entry = { version: engineVersion, skipped: 'engine-not-in-targets' };
        else if (encode(engineVersion) < target) entry = { version: engineVersion, skipped: 'engine-older-than-targets' };
        else if (!ref || !ref.result || !ref.result.variants) entry = { version: engineVersion, skipped: 'no-reference' };
        else entry = { version: engineVersion, ...sheetVerdict(r.engine, job, r.result, 'lowering', ref.result.variants.input && ref.result.variants.input.touched) };
      }
      if (r.shots) {
        const s = r.shots;
        const judge = (v) => (s[v] && s.input ? (s[v] === s.input ? 'pixel-identical' : pixelCompare(SHOTS, id, r.engine, v, 'input')) : null);
        entry.visual = { base: judge('base'), head: judge('head') };
      }
      const bucket = profile.role === 'reference' ? verdict.latest : (verdict.legacy[profile.name] = verdict.legacy[profile.name] || {});
      bucket[r.engine] = entry;
    }
  }
  const summarize = (bucket) => {
    const named = Object.entries(bucket).filter(([, e]) => e.variants);
    const engines = named.map(([, e]) => e);
    const base = engines.length ? worstStatus(engines.map((e) => e.variants.base.status)) : 'unknown';
    const head = engines.length ? worstStatus(engines.map((e) => e.variants.head.status)) : 'unknown';
    // Engines disagreeing about the same output means the input itself is engine-dependent:
    // equivalence to "the input" is undefined there and the spec has to decide.
    const split = (side) => {
      const ok = named.filter(([, e]) => ['equivalent', 'near'].includes(e.variants[side].status)).map(([n]) => n).sort();
      const bad = named.filter(([, e]) => ['different'].includes(e.variants[side].status)).map(([n]) => n).sort();
      return { ok, bad, divergent: ok.length > 0 && bad.length > 0 };
    };
    const enginesBase = split('base');
    const enginesHead = split('head');
    const neutral = engines.length > 0 && engines.every((e) => e.variants.base.sig !== undefined && e.variants.base.sig === e.variants.head.sig && e.variants.base.status === e.variants.head.status);
    const hardBase = engines.reduce((n, e) => n + (e.variants.base.hardRejected || 0), 0);
    const hardHead = engines.reduce((n, e) => n + (e.variants.head.hardRejected || 0), 0);
    const visualHead = Object.values(bucket).some((e) => e.visual && e.visual.head === 'pixel-different');
    const visualBase = Object.values(bucket).some((e) => e.visual && e.visual.base === 'pixel-different');
    return { base, head, transition: transition(base, head), rejectedBase: hardBase, rejectedHead: hardHead, visualBase, visualHead, enginesBase, enginesHead, divergent: enginesBase.divergent || enginesHead.divergent, neutral };
  };
  verdict.summary = { latest: summarize(verdict.latest), legacy: {} };
  for (const [name, bucket] of Object.entries(verdict.legacy)) verdict.summary.legacy[name] = summarize(bucket);
  out.write(JSON.stringify(verdict) + '\n');
}
out.end();
