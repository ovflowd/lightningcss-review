// Per-engine verdicts and per-case summaries (transitions). Pure functions: compare.mjs does the I/O.
import { compareValues, worstLevel } from './normalize.mjs';

export const ENGINE_TARGET = { chromium: 'chrome', firefox: 'firefox', webkit: 'safari' };
const FOREIGN = {
  chromium: /-(moz|ms|o)-/i,
  webkit: /-(moz|ms|o)-/i,
  firefox: /-(webkit|ms|o)-/i,
};

export function encode(version) {
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
const OK = new Set(['equivalent', 'near']);

// Long :lang() lists (lowered :dir()) repeat in every stored selector; keep their length only.
export const compactSelector = (s) => String(s).replace(/:lang\(([^()]*)\)/gi, (m, list) => {
  const n = list.split(',').length;
  return n > 4 ? `:lang(<${n} languages>)` : m;
});

function rawDiffs(mode, v, touched) {
  const diffs = [];
  if (mode === 'same-engine') {
    for (const [key, prop, ref, val] of v.diff || []) {
      // LightningCSS's own polyfill toggles (light-dark(): --lightningcss-light/-dark) are not
      // author CSS; their effect is judged through the properties that consume them.
      if (prop.startsWith('--lightningcss-')) continue;
      const r = compareValues(prop, ref, val, 'same-engine');
      if (r.level !== 'equal') diffs.push({ key, prop, ref, val, level: r.level, details: r.details });
    }
    return diffs;
  }
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
  return diffs;
}

const squash = (v) => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/\s*([(),\/])\s*/g, '$1').trim();

const falseIndexes = (list) => (list || []).flatMap((ok, i) => (ok === false ? [i] : []));

export function sheetVerdict(engine, job, result, mode, refTouched) {
  // mode 'same-engine': compare variant diffs against this engine's input.
  // mode 'lowering': compare this (legacy) engine's variant values to the reference engine input.
  const variants = result.variants || {};
  const input = variants.input || {};
  const out = {};
  const touched = mode === 'same-engine' ? input.touched || {} : refTouched || {};
  const touchedCount = Object.values(touched).reduce((n, vals) => n + Object.keys(vals).length, 0);
  const diffsBySide = {};
  for (const name of ['base', 'head']) if (variants[name]) diffsBySide[name] = rawDiffs(mode, variants[name], touched);
  // Lowering: a difference base and head share exactly comes from the engine version spread (L3)
  // or predates the PR; either way it cannot decide the transition. When nothing else differs the
  // shared differences stay, so a defect both sides have is still reported (as neutral).
  let shared = 0;
  if (mode === 'lowering' && diffsBySide.base && diffsBySide.head) {
    const k = (d) => JSON.stringify([d.key, d.prop, d.ref, d.val]);
    const inHead = new Set(diffsBySide.head.map(k));
    const common = new Set(diffsBySide.base.map(k).filter((x) => inHead.has(x)));
    const base = diffsBySide.base.filter((d) => !common.has(k(d)));
    const head = diffsBySide.head.filter((d) => !common.has(k(d)));
    if ([...base, ...head].some((d) => d.level === 'different')) {
      shared = common.size;
      diffsBySide.base = base;
      diffsBySide.head = head;
    }
  }
  for (const name of ['base', 'head']) {
    const v = variants[name];
    if (!v) {
      out[name] = { status: 'unknown', reason: 'no-output' };
      continue;
    }
    const diffs = diffsBySide[name];
    const level = worstLevel(diffs.map((d) => d.level));
    let status = statusOf(level);
    if (status === 'equivalent' && touchedCount === 0) status = 'no-coverage';
    // validity: declarations/selectors/preludes the engine rejects in this output but not in input
    const probe = job.probe || {};
    const accepted = v.info || {};
    const inAccepted = input.info || {};
    const rejected = { decls: [], selectors: [], preludes: [] };
    const foreign = FOREIGN[engine] || /^$/;
    const inputRejectedDecls = new Set();
    const rejectedCarriers = [];
    (probe.input ? probe.input.decls : []).forEach((d, i) => {
      if (inAccepted.decls && inAccepted.decls[i] === false) {
        inputRejectedDecls.add(d[0] + ':' + d[1]);
        rejectedCarriers.push([d[0], squash(d[1])]);
      }
    });
    // The input already carried this value inside a declaration the engine rejects (a rejected
    // shorthand whose part is now printed as a longhand): the rejection predates the output.
    const carried = (prop, value) => {
      const v = squash(value);
      return v !== '' && rejectedCarriers.some(([p, cv]) => (prop === p || prop.startsWith(p + '-')) && cv.includes(v));
    };
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
      const entry = { prop: d[0], value: d[1], important: d[2], fallbackSurvives: acceptedProps.has(d[0]), inInput: inputProps.has(d[0]) };
      if (carried(d[0], d[1])) entry.carrierRejected = true;
      rejected.decls.push(entry);
    });
    (probe[name] ? probe[name].selectors : []).forEach((s, i) => {
      if (accepted.selectors && accepted.selectors[i] === false && !foreign.test(s)) {
        const inInput = (probe.input ? probe.input.selectors : []).some((t, j) => t === s && inAccepted.selectors && inAccepted.selectors[j] === false);
        if (!inInput) rejected.selectors.push(compactSelector(s));
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
  const entry = { touched: touchedCount, variants: out };
  if (mode === 'lowering') entry.shared = shared;
  if (diffsBySide.base && diffsBySide.head) {
    // Which (element, property) pairs are different on one side only: head strictly adding to
    // base's differences is a `worsened` case, not a pre-existing one.
    const keys = (list) => new Set(list.filter((d) => d.level === 'different').map((d) => `${d.key}|${d.prop}`));
    const b = keys(diffsBySide.base);
    const h = keys(diffsBySide.head);
    entry.overlap = { baseOnly: [...b].filter((x) => !h.has(x)).length, headOnly: [...h].filter((x) => !b.has(x)).length };
  }
  // Which parts of the input this engine rejects: engines that disagree here read the input differently.
  if (mode === 'same-engine') {
    const info = input.info || {};
    const rejectedParts = [falseIndexes(info.decls), falseIndexes(info.selectors), falseIndexes(info.preludes)];
    entry.inputSig = rejectedParts.map((l) => l.join(',')).join('/');
    entry.inputRejected = rejectedParts.some((l) => l.length > 0);
  }
  return entry;
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

export function propertyVerdict(result) {
  const out = { baseline: result.baseline || null, variants: {}, inputSig: result.baseline ? result.baseline.status : 'ok' };
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

/** One engine's entry for one job. `refTouched`: the reference engine's input `touched`, for lowering. */
export function engineEntry(role, r, job, c, refTouched) {
  const version = r.version;
  if (r.error) return { version, error: r.error, variants: { base: { status: 'error' }, head: { status: 'error' } } };
  if (job.kind === 'property') return { version, ...propertyVerdict(r.result) };
  if (role === 'reference') return { version, ...sheetVerdict(r.engine, job, r.result, 'same-engine') };
  const target = c.targets ? c.targets[ENGINE_TARGET[r.engine]] : undefined;
  if (target === undefined) return { version, skipped: 'engine-not-in-targets' };
  if (encode(version) < target) return { version, skipped: 'engine-older-than-targets' };
  if (!refTouched) return { version, skipped: 'no-reference' };
  return { version, ...sheetVerdict(r.engine, job, r.result, 'lowering', refTouched) };
}

/** Transition over the engines that can judge the case (not errored, input not inert). */
export function transition(base, head, judged = [], { introduced = false } = {}) {
  if (introduced) return head === 'unknown' ? 'unverified' : 'introduced';
  if (base === 'unknown' || head === 'unknown') return 'unverified';
  if (base === 'no-coverage' && head === 'no-coverage') return 'unverified';
  const bad = (s) => s === 'different';
  if (!bad(base) && !bad(head)) return head === 'near' && base !== 'near' ? 'near-introduced' : 'both-equivalent';
  if (bad(base) && !bad(head)) return 'fixed';
  // Base fine in every engine and head wrong in any: the PR broke it, whatever the other engines say.
  if (!bad(base)) return 'regressed';
  const sum = (k) => judged.reduce((n, e) => n + ((e.overlap && e.overlap[k]) || 0), 0);
  return sum('baseOnly') === 0 && sum('headOnly') > 0 ? 'worsened' : 'still-different';
}

// Whether an engine that is wrong on one side reads the input differently from an engine that is
// fine on that side, on a property where it is wrong (e.g. one engine still implements an older
// spec rule). `touched`: {engine: input touched map} of the reference profile.
function readsDiffer(judged, touched) {
  if (!touched) return false;
  for (const side of ['base', 'head']) {
    const ok = judged.filter(([, e]) => OK.has(e.variants[side].status)).map(([n]) => n);
    for (const [, e] of judged) {
      if (e.variants[side].status !== 'different') continue;
      for (const d of e.variants[side].diffs || []) {
        if (d.level !== 'different' || d.ref === null || d.ref === undefined) continue;
        for (const n of ok) {
          const value = touched[n] && touched[n][d.key] ? touched[n][d.key][d.prop] : undefined;
          if (value !== undefined && compareValues(d.prop, d.ref, value, 'same-engine').level === 'different') return true;
        }
      }
    }
  }
  return false;
}

/** Case summary for one profile bucket ({engine: entry}). */
export function summarize(bucket, { introduced = false, touched = null } = {}) {
  const named = Object.keys(bucket).sort().map((n) => [n, bucket[n]]).filter(([, e]) => e.variants);
  const errored = named.filter(([, e]) => e.error).map(([n]) => n);
  const live = named.filter(([, e]) => !e.error);
  // An engine that rejects (part of) the input and sees it touch nothing cannot judge whether an
  // output behaves like it. Valid input that only sets initial values still judges: an output
  // that changes something there is wrong.
  const isInert = (e) => e.touched === 0 && e.inputRejected !== false;
  const inert = live.filter(([, e]) => isInert(e)).map(([n]) => n);
  const judged = live.filter(([, e]) => !isInert(e));
  const worst = (list, side) => (list.length ? worstStatus(list.map(([, e]) => e.variants[side].status)) : 'unknown');
  let base = worst(judged, 'base');
  let head = worst(judged, 'head');
  let t;
  if (!live.length) t = errored.length ? 'errored' : 'unverified';
  else if (!judged.length) {
    base = worst(live, 'base');
    head = worst(live, 'head');
    const acts = live.some(([, e]) => e.variants.base.status === 'different' || e.variants.head.status === 'different');
    t = acts ? 'input-rejected' : 'unverified';
  } else t = transition(base, head, judged.map(([, e]) => e), { introduced });
  // A missing engine leaves the case undecided unless the engines that ran already show head broke it.
  if (errored.length && !(t === 'regressed' || t === 'worsened' || (t === 'introduced' && head === 'different'))) t = 'errored';
  const split = (side) => {
    const ok = judged.filter(([, e]) => OK.has(e.variants[side].status)).map(([n]) => n);
    const bad = judged.filter(([, e]) => e.variants[side].status === 'different').map(([n]) => n);
    return { ok, bad, divergent: ok.length > 0 && bad.length > 0 };
  };
  const enginesBase = split('base');
  const enginesHead = split('head');
  // Engines splitting on the same output only point at the input when they read the input
  // differently: one rejects part of it, it does nothing in one of them, or it computes differently.
  const inputDependent = inert.length > 0 || new Set(judged.map(([, e]) => e.inputSig || '')).size > 1 || readsDiffer(judged, touched);
  const divergent = !['regressed', 'errored', 'input-rejected', 'unverified'].includes(t) && (enginesBase.divergent || enginesHead.divergent) && inputDependent;
  const neutral = live.length > 0 && live.every(([, e]) => e.variants.base.sig !== undefined && e.variants.base.sig === e.variants.head.sig && e.variants.base.status === e.variants.head.status);
  const engines = {};
  for (const [n, e] of named) engines[n] = { base: e.variants.base.status, head: e.variants.head.status };
  const entries = Object.values(bucket);
  return {
    base,
    head,
    transition: t,
    rejectedBase: live.reduce((n, [, e]) => n + (e.variants.base.hardRejected || 0), 0),
    rejectedHead: live.reduce((n, [, e]) => n + (e.variants.head.hardRejected || 0), 0),
    visualBase: entries.some((e) => e.visual && e.visual.base === 'pixel-different'),
    visualHead: entries.some((e) => e.visual && e.visual.head === 'pixel-different'),
    visualErrors: Object.keys(bucket).sort().filter((n) => bucket[n].visualError),
    enginesBase,
    enginesHead,
    engines,
    errored,
    inert,
    inputDependent,
    divergent,
    neutral,
  };
}
