/**
 * Spec data from W3C webref (@webref/css: curated extracts of every CSS spec).
 *
 * Stage: oracle (analysis image, spec-cards.mjs; used by `lcr report` and `lcr spec-coverage`).
 * Pure functions over the data `listAll()` returns, so they can be tested without the package.
 * - specCards: grammar, initial value, inheritance, computed value… for the properties a PR
 *   touches, with the syntax of every type their grammar references.
 * - specInventory: every property, at-rule, selector and function name webref knows.
 */

/** @import { WebrefData, WebrefEntry } from '@webref/css' */

/**
 * @typedef {object} SpecCard A property's card (spec-cards.json `cards.<property>`).
 * @property {boolean} [missing] webref does not know the property.
 * @property {string} [href]
 * @property {string} [syntax]
 * @property {string} [initial]
 * @property {string} [inherited]
 * @property {string} [computedValue]
 * @property {string} [animationType]
 * @property {string} [percentages]
 * @property {string} [appliesTo]
 * @property {string} [canonicalOrder]
 * @property {string[] | null} [longhands]
 * @property {string | null} [legacyAliasOf]
 * @property {Record<string, string>} [types] Referenced type -> its grammar.
 */

/** Vendor prefixes stripped to find the standard property. */
const VENDOR_PREFIX = /^-(webkit|moz|ms|o)-/;

/** `<type>`, `<'property'>`, `<fn()>` and `<type [range]>` references in a value grammar. */
const TYPE_REFERENCE = /<'?([a-z0-9-]+(?:\(\))?)'?(?:\s*\[[^\]]*\])?>/gi;

/**
 * The type and function names a grammar references, in first-use order.
 *
 * @param {unknown} syntax
 * @returns {string[]}
 */
export function refsOf(syntax) {
  const names = new Set();

  for (const match of String(syntax || '').matchAll(TYPE_REFERENCE)) {
    names.add(match[1]);
  }

  return [...names];
}

/**
 * Types and functions by name (functions win on a name clash, as they are listed last).
 *
 * @param {WebrefData} data
 * @returns {Map<string, WebrefEntry>}
 */
function typeIndex(data) {
  /** @type {Map<string, WebrefEntry>} */
  const index = new Map();

  for (const type of data.types || []) {
    index.set(type.name, type);
  }

  for (const fn of data.functions || []) {
    index.set(fn.name, fn);
  }

  return index;
}

/**
 * One property's card.
 *
 * @param {WebrefEntry} property
 * @param {Map<string, WebrefEntry>} types
 * @returns {SpecCard}
 */
function propertyCard(property, types) {
  /** @type {Record<string, string>} */
  const referenced = {};

  for (const name of refsOf(property.syntax)) {
    const type = types.get(name) || types.get(`<${name}>`);

    if (type && type.syntax) {
      referenced[name] = type.syntax;
    }
  }

  return {
    href: property.href,
    syntax: property.syntax,
    initial: property.initial,
    inherited: property.inherited,
    computedValue: property.computedValue,
    animationType: property.animationType,
    percentages: property.percentages,
    appliesTo: property.appliesTo,
    canonicalOrder: property.canonicalOrder,
    longhands: property.longhands || null,
    legacyAliasOf: property.legacyAliasOf || null,
    types: referenced,
  };
}

/**
 * Property cards for the given names (prefixed names fall back to the standard property;
 * unknown names get `{missing: true}`).
 *
 * @param {WebrefData} data
 * @param {string[]} names
 * @returns {Record<string, SpecCard>}
 */
export function specCards(data, names) {
  const properties = new Map(data.properties.map((property) => [property.name, property]));
  const types = typeIndex(data);
  /** @type {Record<string, SpecCard>} */
  const cards = {};

  for (const name of names) {
    const property = properties.get(name) || properties.get(name.replace(VENDOR_PREFIX, ''));

    cards[name] = property ? propertyCard(property, types) : { missing: true };
  }

  return cards;
}

/**
 * @param {{ name: string }} a
 * @param {{ name: string }} b
 * @returns {number}
 */
function byName(a, b) {
  return a.name.localeCompare(b.name);
}

/**
 * Every name webref knows, for the parser coverage report.
 *
 * @param {WebrefData} data
 * @returns {{ properties: { name: string, href?: string, legacyAliasOf: string | null }[],
 *   atrules: { name: string, href?: string, descriptors: string[] }[],
 *   selectors: { name: string, href?: string }[], functions: string[] }}
 */
export function specInventory(data) {
  return {
    properties: (data.properties || [])
      .map((p) => ({ name: p.name, href: p.href, legacyAliasOf: p.legacyAliasOf || null }))
      .sort(byName),
    atrules: (data.atrules || [])
      .map((r) => ({ name: r.name, href: r.href, descriptors: (r.descriptors || []).map((d) => d.name) }))
      .sort(byName),
    selectors: (data.selectors || []).map((s) => ({ name: s.name, href: s.href })).sort(byName),
    functions: [...new Set((data.functions || []).map((f) => f.name))].sort(),
  };
}
