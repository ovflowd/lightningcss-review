// Spec data from W3C webref (@webref/css, curated extracts of every CSS spec).
//   node spec-cards.mjs cards <names.json> <out.json>     property cards for the report
//   node spec-cards.mjs inventory <out.json>             every property/at-rule/selector/function name
import fs from 'node:fs';
import css from '@webref/css';

const [mode, a, b] = process.argv.slice(2);
const all = await css.listAll();

const typeIndex = new Map();
for (const t of all.types || []) typeIndex.set(t.name, t);
for (const f of all.functions || []) typeIndex.set(f.name, f);

function refsOf(syntax) {
  const out = new Set();
  for (const m of String(syntax || '').matchAll(/<'?([a-z0-9-]+(?:\(\))?)'?(?:\s*\[[^\]]*\])?>/gi)) out.add(m[1]);
  return [...out];
}

if (mode === 'cards') {
  const names = JSON.parse(fs.readFileSync(a, 'utf8'));
  const props = new Map(all.properties.map((p) => [p.name, p]));
  const cards = {};
  for (const name of names) {
    const p = props.get(name) || props.get(name.replace(/^-(webkit|moz|ms|o)-/, ''));
    if (!p) {
      cards[name] = { missing: true };
      continue;
    }
    const types = {};
    for (const r of refsOf(p.syntax)) {
      const t = typeIndex.get(r) || typeIndex.get(`<${r}>`);
      if (t && t.syntax) types[r] = t.syntax;
    }
    cards[name] = {
      href: p.href, syntax: p.syntax, initial: p.initial, inherited: p.inherited, computedValue: p.computedValue,
      animationType: p.animationType, percentages: p.percentages, appliesTo: p.appliesTo, canonicalOrder: p.canonicalOrder,
      longhands: p.longhands || null, legacyAliasOf: p.legacyAliasOf || null, types,
    };
  }
  fs.writeFileSync(b, JSON.stringify(cards, null, 2) + '\n');
} else if (mode === 'inventory') {
  const pick = (list) => [...new Set((list || []).map((x) => x.name))].sort();
  fs.writeFileSync(a, JSON.stringify({
    properties: (all.properties || []).map((p) => ({ name: p.name, href: p.href, legacyAliasOf: p.legacyAliasOf || null })).sort((x, y) => x.name.localeCompare(y.name)),
    atrules: (all.atrules || []).map((r) => ({ name: r.name, href: r.href, descriptors: (r.descriptors || []).map((d) => d.name) })).sort((x, y) => x.name.localeCompare(y.name)),
    selectors: (all.selectors || []).map((s) => ({ name: s.name, href: s.href })).sort((x, y) => x.name.localeCompare(y.name)),
    functions: pick(all.functions),
  }, null, 2) + '\n');
} else {
  console.error('usage: spec-cards.mjs cards <names.json> <out.json> | inventory <out.json>');
  process.exit(2);
}
