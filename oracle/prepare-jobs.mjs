// Turns oracle cases (written by lcr) into engine jobs: synthesized DOM, state-rewritten sheets,
// validity probes. Runs in the analysis image (css-tree available).
//
// usage: node prepare-jobs.mjs --cases cases.jsonl --out jobs.jsonl
//        node prepare-jobs.mjs --legacy --jobs jobs.jsonl --results results-latest.jsonl --out legacy-jobs.jsonl
import fs from 'node:fs';
import { synthesize, rewriteStates, validityProbe } from './dom.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const readJsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const SCHEME_RE = /light-dark\(|color-scheme|prefers-color-scheme|--lightningcss-(light|dark)/i;

function sheetJob(c) {
  const variants = Object.entries(c.sheets).filter(([, css]) => typeof css === 'string');
  // domFrom: the changed blocks of a large sheet; synthesize elements for those selectors only.
  const dom = c.dom
    ? { html: c.dom, pseudos: [], rootAttrs: {}, selectors: 0, synthesized: 0, unsupported: 0, generic: false, override: true }
    : synthesize(c.domFrom ? [c.domFrom] : variants.map(([, css]) => css));
  if (c.domFrom) dom.focused = true;
  const sheets = { empty: '' };
  let rewrites = 0;
  const probe = {};
  for (const [name, css] of variants) {
    const r = rewriteStates(css);
    rewrites += r.rewrites;
    sheets[name] = r.css;
    probe[name] = validityProbe(r.css);
  }
  const job = {
    id: c.id,
    kind: 'sheet',
    html: dom.html,
    rootAttrs: dom.rootAttrs,
    pseudos: dom.pseudos,
    sheets,
    probe,
    reference: 'input',
    visual: Boolean(c.visual),
  };
  const meta = { id: c.id, dom: { selectors: dom.selectors, synthesized: dom.synthesized, unsupported: dom.unsupported, generic: dom.generic, override: Boolean(dom.override), focused: Boolean(dom.focused) }, rewrites };
  const jobs = [job];
  if (variants.some(([, css]) => SCHEME_RE.test(css))) {
    jobs.push({ ...job, id: c.id + '~dark', colorScheme: 'dark', visual: false });
    meta.dark = true;
  }
  return { jobs, meta };
}

function propertyJob(c) {
  return {
    jobs: [{ id: c.id, kind: 'property', property: c.property, value: c.value, wptKind: c.wptKind, expected: c.expected, outputs: c.outputs }],
    meta: { id: c.id },
  };
}

if (args.includes('--legacy')) {
  // Build legacy jobs: same sheets, but only read properties the reference engine saw touched.
  const jobs = new Map(readJsonl(opt('--jobs')).map((j) => [j.id, j]));
  const results = readJsonl(opt('--results'));
  const wanted = new Set((opt('--ids', '') || '').split(',').filter(Boolean));
  const byId = new Map();
  for (const r of results) {
    if (!r.result || !r.result.variants) continue;
    if (!byId.has(r.id)) byId.set(r.id, {});
    const touched = r.result.variants.input && r.result.variants.input.touched;
    const props = new Set();
    if (touched) Object.values(touched).forEach((vals) => Object.keys(vals).forEach((p) => props.add(p)));
    byId.get(r.id)[r.engine] = [...props].sort();
  }
  const out = fs.createWriteStream(opt('--out'));
  for (const [id, propsByEngine] of byId) {
    if (wanted.size && !wanted.has(id.replace(/~dark$/, ''))) continue;
    const job = jobs.get(id);
    if (!job || job.kind !== 'sheet') continue;
    out.write(JSON.stringify({ ...job, visual: false, propsByEngine }) + '\n');
  }
  out.end();
} else {
  const cases = readJsonl(opt('--cases'));
  const out = fs.createWriteStream(opt('--out'));
  const metaOut = fs.createWriteStream(opt('--meta', opt('--out') + '.meta'));
  for (const c of cases) {
    let built;
    try {
      built = c.kind === 'property' ? propertyJob(c) : sheetJob(c);
    } catch (e) {
      metaOut.write(JSON.stringify({ id: c.id, error: String(e && e.message ? e.message : e) }) + '\n');
      continue;
    }
    built.jobs.forEach((j) => out.write(JSON.stringify(j) + '\n'));
    metaOut.write(JSON.stringify(built.meta) + '\n');
  }
  out.end();
  metaOut.end();
}
