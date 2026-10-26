/**
 * Oracle cases -> engine jobs.
 *
 * Stage: oracle (analysis image, prepare-jobs.mjs). A sheet case becomes one job (two when the
 * CSS depends on the color scheme): a synthesized DOM, the sheets after state rewriting and
 * custom-property stand-ins, and the validity probes of each sheet. A property case (WPT parsing)
 * becomes one job as it is. Legacy jobs reuse the reference jobs, narrowed to what the reference
 * engine saw the input touch.
 *
 * Invariants: deterministic (same case, same job bytes); every sheet of a case gets the same DOM
 * and the same rewrites, so base and head are judged symmetrically against the input.
 */
import { canonicalText } from './css.mjs';
import { collectPseudos, synthesize } from './dom.mjs';
import { validityProbe } from './probes.mjs';
import { rewriteStates, undefinedCustomProperties } from './sheets.mjs';

/** @import { SheetCase, PropertyCase, SheetJob, PropertyJob, Job, JobMeta, SynthesizedDom, ValidityProbe, EngineResult } from './types.mjs' */

/** CSS that computes differently in the dark color scheme: such cases also run with `~dark`. */
const SCHEME_RE = /light-dark\(|color-scheme|prefers-color-scheme|--lightningcss-(light|dark)/i;

/** Suffix of the dark color-scheme twin of a job. */
export const DARK_SUFFIX = '~dark';

/**
 * The case id of a job id (`<case>~dark` -> `<case>`).
 *
 * @param {string} jobId
 * @returns {string}
 */
export function caseIdOf(jobId) {
  return jobId.replace(/~dark$/, '');
}

/**
 * @typedef {object} BuiltJobs
 * @property {Job[]} jobs
 * @property {JobMeta} meta
 */

/**
 * The DOM of a sheet case: the case's own HTML (`dom:` override; pseudo-elements the sheets use
 * are still read), or one synthesized from `domFrom` (the changed blocks of a large sheet) or from
 * every sheet.
 *
 * @param {SheetCase} sheetCase
 * @param {string[]} sheets
 * @returns {SynthesizedDom}
 */
function caseDom(sheetCase, sheets) {
  /** @type {SynthesizedDom} */
  const dom = sheetCase.dom
    ? {
        html: sheetCase.dom,
        pseudos: collectPseudos(sheets),
        rootAttrs: {},
        selectors: 0,
        synthesized: 0,
        unsupported: 0,
        generic: false,
        override: true,
      }
    : synthesize(sheetCase.domFrom ? [sheetCase.domFrom] : sheets);

  if (sheetCase.domFrom) {
    dom.focused = true;
  }

  return dom;
}

/**
 * The sheets of a job (`empty` first) with their probes. Custom properties the input uses but
 * never defines are defined (`:root{…}` appended) in every sheet, the empty one included, so the
 * stand-ins themselves never count as something the input touches.
 *
 * @param {[name: string, css: string][]} variants
 * @param {[name: string, value: string][]} injected
 * @returns {{ sheets: Record<string, string>, probe: Record<string, ValidityProbe>, rewrites: number }}
 */
function prepareSheets(variants, injected) {
  const define = injected.length
    ? `\n:root{${injected.map(([name, value]) => `${name}:${value}`).join(';')}}`
    : '';
  /** @type {Record<string, string>} */
  const sheets = { empty: define.trim() };
  /** @type {Record<string, ValidityProbe>} */
  const probe = {};
  let rewrites = 0;

  for (const [name, css] of variants) {
    const rewritten = rewriteStates(css + define);

    rewrites += rewritten.rewrites;
    sheets[name] = rewritten.css;
    probe[name] = validityProbe(rewritten.css);
  }

  return { sheets, probe, rewrites };
}

/**
 * Variants whose text equals the input's up to whitespace, comments and final semicolons: in the
 * same engine they behave like the input by definition.
 *
 * @param {SheetCase} sheetCase
 * @param {[name: string, css: string][]} variants
 * @returns {string[]}
 */
function sameTextAsInput(sheetCase, variants) {
  const inputText = canonicalText(sheetCase.sheets.input);

  if (inputText === null) {
    return [];
  }

  return variants
    .filter(([name, css]) => name !== 'input' && canonicalText(css) === inputText)
    .map(([name]) => name);
}

/**
 * The job(s) of a sheet case and its meta row.
 *
 * @param {SheetCase} sheetCase
 * @returns {BuiltJobs}
 */
export function sheetJob(sheetCase) {
  const variants = /** @type {[string, string][]} */ (
    Object.entries(sheetCase.sheets).filter(([, css]) => typeof css === 'string')
  );
  const dom = caseDom(
    sheetCase,
    variants.map(([, css]) => css),
  );
  const input = sheetCase.sheets.input;
  const injected = typeof input === 'string' ? undefinedCustomProperties(input) : [];
  const { sheets, probe, rewrites } = prepareSheets(variants, injected);
  /** @type {SheetJob} */
  const job = {
    id: sheetCase.id,
    kind: 'sheet',
    html: dom.html,
    rootAttrs: dom.rootAttrs,
    pseudos: dom.pseudos,
    sheets,
    probe,
    reference: 'input',
    visual: Boolean(sheetCase.visual),
  };
  const sameAsInput = sameTextAsInput(sheetCase, variants);

  if (sameAsInput.length) {
    job.sameAsInput = sameAsInput;
  }

  /** @type {JobMeta} */
  const meta = {
    id: sheetCase.id,
    dom: {
      selectors: dom.selectors,
      synthesized: dom.synthesized,
      unsupported: dom.unsupported,
      generic: dom.generic,
      override: Boolean(dom.override),
      focused: Boolean(dom.focused),
    },
    rewrites,
  };

  if (injected.length) {
    meta.injectedVars = injected.map(([name]) => name);
  }

  /** @type {Job[]} */
  const jobs = [job];

  if (variants.some(([, css]) => SCHEME_RE.test(css))) {
    // Screenshots are taken in the light scheme only.
    jobs.push({ ...job, id: sheetCase.id + DARK_SUFFIX, colorScheme: 'dark', visual: false });
    meta.dark = true;
  }

  return { jobs, meta };
}

/**
 * The job of a WPT parsing case (passed through) and its meta row.
 *
 * @param {PropertyCase} propertyCase
 * @returns {BuiltJobs}
 */
export function propertyJob(propertyCase) {
  /** @type {PropertyJob} */
  const job = {
    id: propertyCase.id,
    kind: 'property',
    property: propertyCase.property,
    value: propertyCase.value,
    wptKind: propertyCase.wptKind,
    expected: propertyCase.expected,
    outputs: propertyCase.outputs,
  };

  return { jobs: [job], meta: { id: propertyCase.id } };
}

/**
 * @typedef {object} TouchedSubset What one reference engine saw the input touch.
 * @property {Record<string, string[]>} props Engine -> touched properties, sorted.
 * @property {Record<string, string[]>} keys Engine -> touched element keys, sorted.
 */

/**
 * Collect, per job, the properties and element keys each reference engine saw the input touch.
 *
 * @param {AsyncIterable<unknown> | Iterable<unknown>} referenceResults Rows of results-latest.jsonl.
 * @returns {Promise<Map<string, TouchedSubset>>}
 */
export async function touchedByJob(referenceResults) {
  /** @type {Map<string, TouchedSubset>} */
  const byId = new Map();

  for await (const row of referenceResults) {
    const result = /** @type {EngineResult} */ (row);

    if (!result.result || !result.result.variants) {
      continue;
    }

    if (!byId.has(result.id)) {
      byId.set(result.id, { props: {}, keys: {} });
    }

    const touched = (result.result.variants.input && result.result.variants.input.touched) || {};
    const props = new Set(Object.values(touched).flatMap((values) => Object.keys(values)));
    const subset = /** @type {TouchedSubset} */ (byId.get(result.id));

    subset.props[result.engine] = [...props].sort();
    subset.keys[result.engine] = Object.keys(touched).sort();
  }

  return byId;
}

/**
 * The legacy job of a reference job: the same sheets, but each engine reads only the elements and
 * properties its reference engine saw the input touch (all the lowering comparison looks at).
 * Screenshots are a reference-profile check only.
 *
 * @param {SheetJob} job
 * @param {TouchedSubset} subset
 * @returns {SheetJob}
 */
export function legacyJob(job, subset) {
  return { ...job, visual: false, propsByEngine: subset.props, keysByEngine: subset.keys };
}
