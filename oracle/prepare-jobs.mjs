// Turns oracle cases (written by lcr) into engine jobs: synthesized DOM, state-rewritten sheets,
// validity probes. Runs in the analysis image (css-tree available).
//
// usage: node prepare-jobs.mjs --cases cases.jsonl --out jobs.jsonl
//        node prepare-jobs.mjs --legacy --jobs jobs.jsonl --results results-latest.jsonl --out legacy-jobs.jsonl
import { synthesize, rewriteStates, validityProbe, collectPseudos, undefinedCustomProperties, canonicalText } from './dom.mjs';
import { readJsonl, jsonlWriter } from './jsonl.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);

const SCHEME_RE = /light-dark\(|color-scheme|prefers-color-scheme|--lightningcss-(light|dark)/i;

export function sheetJob(c) {
  const variants = Object.entries(c.sheets).filter(([, css]) => typeof css === 'string');
  // domFrom: the changed blocks of a large sheet; synthesize elements for those selectors only.
  // A `dom:` override replaces the HTML only: pseudo-elements are still read where the CSS uses them.
  const dom = c.dom
    ? { html: c.dom, pseudos: collectPseudos(variants.map(([, css]) => css)), rootAttrs: {}, selectors: 0, synthesized: 0, unsupported: 0, generic: false, override: true }
    : synthesize(c.domFrom ? [c.domFrom] : variants.map(([, css]) => css));
  if (c.domFrom) dom.focused = true;
  const injected = typeof c.sheets.input === 'string' ? undefinedCustomProperties(c.sheets.input) : [];
  const define = injected.length ? `\n:root{${injected.map(([name, value]) => `${name}:${value}`).join(';')}}` : '';
  const sheets = { empty: define.trim() };
  let rewrites = 0;
  const probe = {};
  for (const [name, css] of variants) {
    const r = rewriteStates(css + define);
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
  const inputText = canonicalText(c.sheets.input);
  const sameAsInput = inputText === null ? [] : variants.filter(([name, css]) => name !== 'input' && canonicalText(css) === inputText).map(([name]) => name);
  if (sameAsInput.length) job.sameAsInput = sameAsInput;
  const meta = { id: c.id, dom: { selectors: dom.selectors, synthesized: dom.synthesized, unsupported: dom.unsupported, generic: dom.generic, override: Boolean(dom.override), focused: Boolean(dom.focused) }, rewrites };
  if (injected.length) meta.injectedVars = injected.map(([name]) => name);
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

async function legacyJobs() {
  // Same sheets, but each engine reads only the elements and properties its reference engine
  // saw the input touch (that is all the lowering comparison looks at).
  const jobs = new Map();
  for await (const j of readJsonl(opt('--jobs'))) jobs.set(j.id, j);
  const wanted = new Set((opt('--ids', '') || '').split(',').filter(Boolean));
  const byId = new Map();
  for await (const r of readJsonl(opt('--results'))) {
    if (!r.result || !r.result.variants) continue;
    if (!byId.has(r.id)) byId.set(r.id, { props: {}, keys: {} });
    const touched = (r.result.variants.input && r.result.variants.input.touched) || {};
    const props = new Set();
    Object.values(touched).forEach((vals) => Object.keys(vals).forEach((p) => props.add(p)));
    byId.get(r.id).props[r.engine] = [...props].sort();
    byId.get(r.id).keys[r.engine] = Object.keys(touched).sort();
  }
  const out = jsonlWriter(opt('--out'));
  for (const id of [...byId.keys()].sort()) {
    if (wanted.size && !wanted.has(id.replace(/~dark$/, ''))) continue;
    const job = jobs.get(id);
    if (!job || job.kind !== 'sheet') continue;
    out.write({ ...job, visual: false, propsByEngine: byId.get(id).props, keysByEngine: byId.get(id).keys });
  }
  await out.end();
}

async function referenceJobs() {
  const out = jsonlWriter(opt('--out'));
  const metaOut = jsonlWriter(opt('--meta', opt('--out') + '.meta'));
  for await (const c of readJsonl(opt('--cases'))) {
    let built;
    try {
      built = c.kind === 'property' ? propertyJob(c) : sheetJob(c);
    } catch (e) {
      metaOut.write({ id: c.id, error: String(e && e.message ? e.message : e) });
      continue;
    }
    built.jobs.forEach((j) => out.write(j));
    metaOut.write(built.meta);
  }
  await Promise.all([out.end(), metaOut.end()]);
}

if (opt('--out')) await (args.includes('--legacy') ? legacyJobs() : referenceJobs());
