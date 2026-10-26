/**
 * Reading cases and their oracle verdicts the way the check catalog needs them: which area a case
 * belongs to, which engines may judge it, which classification covers it, which case ids a line
 * of free text mentions.
 *
 * Stage: report. Inputs are corpus/cases.jsonl rows, oracle.json verdicts and analysis.json
 * classifications; nothing here writes files.
 *
 * Invariant: an engine judges a case only when the input does something there (it is not inert),
 * its job did not error, and it stands for a browser inside the case's targets (output for
 * explicit targets is not wrong in an engine those targets do not include).
 */
import { join } from 'node:path';

import { readJson, readJsonl } from '../core/files.js';
import { CONFIG_DIR } from '../core/paths.js';
import { pyEquals, pyGet } from '../core/py-value.js';
import { compareCodePoints, fnmatchcase, PY_WHITESPACE, pyStr, pyStrip, pyTruthy } from '../core/py.js';
import { CLASSIFICATIONS, ENGINE_FAMILIES, JUDGING } from './constants.js';

/**
 * @import { AdapterRequest, AdapterResponse, Analysis, CaseVerdict, DeltaClassification, EngineEntry,
 *   EngineStatus, ProfileSummary, PropertyEntry, Side, Targets, TupleExpectation } from '../types.js'
 */

/**
 * A corpus case as the report reads it: every source's fields, all optional (py-final read them
 * with `.get()`), so code can look at a field before it knows the source.
 *
 * @typedef {object} CaseRecord
 * @property {string} id
 * @property {string} [source]
 * @property {Partial<AdapterRequest> | null} [request]
 * @property {string} [side] Tuples: `base`, `head` or `both`.
 * @property {string} [origin] Probes: `curated`, `pr` or `cli`.
 * @property {string | null} [parent] Mutations.
 * @property {string | null} [area] Probes and mutations.
 * @property {{ id: string, area: string, title: string, mode?: string, repro?: unknown } & Record<string, unknown>} [probe]
 * @property {string} [test] Tuples.
 * @property {string} [helper]
 * @property {number} [line]
 * @property {TupleExpectation} [expectation]
 * @property {string} [mutation]
 * @property {{ file: string, property: string, value: string, kind: string }} [wpt]
 * @property {string} [mode] WPT and real-world cases.
 * @property {string} [name] Real-world cases.
 */

/**
 * A verdict as the report reads it. Older oracle.json files carried `engines` on the verdict
 * itself; current ones carry it in `summary.latest`.
 *
 * @typedef {CaseVerdict & { engines?: ProfileSummary['engines'] }} VerdictRecord
 */

/** @typedef {{ base: EngineStatus, head: EngineStatus }} SideStatuses */

/**
 * The case id inside a check item: `<id>~dark@<profile> [annotation]` -> `<id>`.
 *
 * @param {unknown} tag
 * @returns {string}
 */
export function caseId(tag) {
  return pyStr(tag).split(' ')[0].split('~')[0].split('@')[0];
}

/**
 * True when a case reference is a glob (`t-*`, `p-color-?`) rather than one case id.
 *
 * @param {string} pattern
 * @returns {boolean}
 */
export function isGlob(pattern) {
  return pattern.includes('*') || pattern.includes('?');
}

/**
 * Whether an analysis.json delta pattern names a case: the exact id, an fnmatch glob over ids, or
 * `source:<source>` for every case of a source.
 *
 * @param {unknown} pattern
 * @param {string} id
 * @param {string} source
 * @returns {boolean}
 */
export function matches(pattern, id, source) {
  if (!pyTruthy(pattern)) {
    return false;
  }

  const text = String(pattern);

  if (text.startsWith('source:')) {
    return text === `source:${source}`;
  }

  return text === id || (isGlob(text) && fnmatchcase(id, text));
}

/**
 * The first valid classification entry covering the case (entries match in file order, so an
 * exact id listed before a glob wins).
 *
 * @param {Partial<Analysis>} analysis
 * @param {string} id
 * @param {string} source
 * @returns {DeltaClassification | null}
 */
export function classified(analysis, id, source) {
  for (const entry of analysis.deltas ?? []) {
    if (CLASSIFICATIONS.has(entry.classification) && matches(pyGet(entry, 'id', ''), id, source)) {
      return entry;
    }
  }

  return null;
}

/**
 * Property name -> area, from config/properties.json.
 *
 * @returns {Map<string, string | null>}
 */
export function propertyAreas() {
  const data = /** @type {PropertyEntry[] | null} */ (readJson(join(CONFIG_DIR, 'properties.json'), []));
  /** @type {Map<string, string | null>} */
  const areas = new Map();

  for (const entry of data ?? []) {
    if (pyTruthy(entry.name)) {
      areas.set(entry.name, entry.area ?? null);
    }
  }

  return areas;
}

const VENDOR_PREFIX = /^-(webkit|moz|ms|o)-/;

/**
 * The areas a case belongs to: a probe's own area, a tuple's test function's areas, a WPT
 * property's area (vendor prefix ignored), `tests` for unassigned mutations and tuples.
 *
 * @param {CaseRecord} entry
 * @param {Map<string, string[]>} testAreas
 * @param {Map<string, string | null>} propertyAreaMap
 * @returns {(string | null | undefined)[]}
 */
export function caseArea(entry, testAreas, propertyAreaMap) {
  switch (entry.source) {
    case 'probe':
      return [entry.probe?.area];
    case 'mutation':
      return [pyTruthy(entry.area) ? entry.area : 'tests'];
    case 'tuple':
      return testAreas.get(String(entry.test).split('::').at(-1) ?? '') ?? ['tests'];
    case 'wpt':
      return [wptArea(entry.wpt?.property ?? '', propertyAreaMap)];
    default:
      return ['realworld'];
  }
}

/**
 * The area of a WPT case's property (vendor prefix ignored), `unknown` when it has none.
 *
 * @param {string} property
 * @param {Map<string, string | null>} propertyAreaMap
 * @returns {string}
 */
function wptArea(property, propertyAreaMap) {
  const own = propertyAreaMap.get(property);
  const area = pyTruthy(own) ? own : propertyAreaMap.get(property.replace(VENDOR_PREFIX, ''));

  return pyTruthy(area) ? /** @type {string} */ (area) : 'unknown';
}

/**
 * Case ids mentioned in free text (evidence, notes), in order of appearance. A token counts when
 * it is a known id, an annotated tag of one (`<id>~dark`), or a probe id without its `p-`.
 *
 * @param {unknown} text
 * @param {ReadonlySet<string>} known
 * @returns {string[]}
 */
export function caseRefs(text, known) {
  /** @type {string[]} */
  const refs = [];

  for (const raw of (pyTruthy(text) ? pyStr(text) : '').split(REF_SPLIT)) {
    const token = pyStrip(raw, '.:');

    for (const candidate of [token, caseId(token), `p-${token}`]) {
      if (known.has(candidate)) {
        if (!refs.includes(candidate)) {
          refs.push(candidate);
        }

        break;
      }
    }
  }

  return refs;
}

/** Separators between the tokens of free text that may be case ids (Python whitespace included). */
const REF_SPLIT = new RegExp(`[${PY_WHITESPACE},;()\\[\\]\`'"]+`, 'u');

/**
 * The light-scheme verdict of a case (the first one when there is none); null without verdicts.
 *
 * @param {ReadonlyArray<VerdictRecord> | null | undefined} verdicts
 * @returns {VerdictRecord | null}
 */
export function light(verdicts) {
  if (!verdicts || verdicts.length === 0) {
    return null;
  }

  return verdicts.find((verdict) => verdict.scheme === 'light') ?? verdicts[0];
}

/**
 * Whether an engine stands for a browser inside the targets (no targets: every engine counts).
 *
 * @param {string} engine
 * @param {Targets | null | undefined} targets
 * @returns {boolean}
 */
export function inTargets(engine, targets) {
  if (!pyTruthy(targets)) {
    return true;
  }

  const families = ENGINE_FAMILIES.get(engine) ?? [engine];

  return families.some((family) => Object.hasOwn(/** @type {Targets} */ (targets), family));
}

/**
 * `{engine: {base, head}}` for the engines that can judge the case (the input does something
 * there and the job did not error), sorted by engine.
 *
 * @param {VerdictRecord} verdict
 * @returns {Map<string, SideStatuses>}
 */
export function engineStatuses(verdict) {
  const summary = verdict.summary?.latest ?? /** @type {Partial<ProfileSummary>} */ ({});
  /** @type {Set<string>} */
  const skip = new Set([...(summary.inert || []), ...(summary.errored || [])]);
  const engines = pyTruthy(verdict.engines) ? verdict.engines : summary.engines;
  /** @type {[string, SideStatuses][]} */
  const out = [];

  if (isNonEmptyDict(engines)) {
    for (const [engine, statuses] of Object.entries(engines)) {
      if (!skip.has(engine)) {
        out.push([
          engine,
          { base: pyGet(statuses, 'base', 'unknown'), head: pyGet(statuses, 'head', 'unknown') },
        ]);
      }
    }
  } else {
    for (const [engine, entry] of Object.entries(verdict.latest || {})) {
      const statuses = variantStatuses(engine, entry, skip);

      if (statuses) {
        out.push([engine, statuses]);
      }
    }
  }

  return new Map(out.sort(([a], [b]) => compareCodePoints(a, b)));
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, { base?: EngineStatus, head?: EngineStatus } | null>}
 */
function isNonEmptyDict(value) {
  return (
    value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
  );
}

/**
 * The base/head statuses of one engine entry, or null when the engine cannot judge the case.
 *
 * @param {string} engine
 * @param {EngineEntry | undefined} entry
 * @param {Set<string>} skip Inert and errored engines.
 * @returns {SideStatuses | null}
 */
function variantStatuses(engine, entry, skip) {
  const isEntry = entry !== null && typeof entry === 'object' && !Array.isArray(entry);
  const variants = isEntry ? entry.variants : null;

  if (!pyTruthy(variants) || skip.has(engine) || pyTruthy(entry?.error) || pyEquals(entry?.touched, 0)) {
    return null;
  }

  const status = (/** @type {Side} */ side) =>
    /** @type {EngineStatus} */ (pyGet(variants?.[side] || {}, 'status', 'unknown'));

  return { base: status('base'), head: status('head') };
}

/**
 * The judging engines (see `engineStatuses`) that stand for a browser in the case's targets.
 *
 * @param {VerdictRecord} verdict
 * @param {CaseRecord | Record<string, never>} entry
 * @returns {Map<string, SideStatuses>}
 */
export function judged(verdict, entry) {
  const targets = (entry.request || {}).targets;

  return new Map([...engineStatuses(verdict)].filter(([engine]) => inTargets(engine, targets)));
}

/**
 * The in-target engines where one side renders differently from the input.
 *
 * @param {VerdictRecord} verdict
 * @param {CaseRecord | Record<string, never>} entry
 * @param {Side} side
 * @returns {string[]}
 */
export function wrongIn(verdict, entry, side) {
  return [...judged(verdict, entry)]
    .filter(([, statuses]) => statuses[side] === 'different')
    .map(([engine]) => engine);
}

/**
 * True/false when an in-target engine could judge that side (false when any found it different);
 * null when none could.
 *
 * @param {VerdictRecord} verdict
 * @param {CaseRecord | Record<string, never>} entry
 * @param {Side} side
 * @returns {boolean | null}
 */
export function sideEquivalent(verdict, entry, side) {
  const statuses = [...judged(verdict, entry).values()]
    .map((pair) => pair[side])
    .filter((status) => JUDGING.includes(status));

  return statuses.length === 0 ? null : !statuses.includes('different');
}

/**
 * Hard rejections (a declaration with no surviving fallback) of base and head output by engines
 * inside the case's targets. A value the input already carried inside a rejected declaration was
 * rejected before the PR, so it does not count against either side.
 *
 * @param {VerdictRecord} verdict
 * @param {CaseRecord | Record<string, never>} entry
 * @returns {[number, number]}
 */
export function rejectedCounts(verdict, entry) {
  const latest = verdict.latest || {};

  if (Object.keys(latest).length === 0) {
    const summary = verdict.summary.latest;

    return [Number(pyGet(summary, 'rejectedBase', 0)), Number(pyGet(summary, 'rejectedHead', 0))];
  }

  const targets = (entry.request || {}).targets;
  const counts = { base: 0, head: 0 };

  for (const [engine, engineEntry] of Object.entries(latest)) {
    if (
      !engineEntry ||
      typeof engineEntry !== 'object' ||
      Array.isArray(engineEntry) ||
      !inTargets(engine, targets)
    ) {
      continue;
    }

    for (const side of /** @type {const} */ (['base', 'head'])) {
      counts[side] += sideRejections((engineEntry.variants || {})[side] || {});
    }
  }

  return [counts.base, counts.head];
}

/**
 * @param {Partial<import('../types.js').EngineVariant>} variant
 * @returns {number}
 */
function sideRejections(variant) {
  const decls = (variant.rejected || {}).decls || [];
  const carried = decls.filter(
    (decl) => pyTruthy(decl.carrierRejected) && !pyTruthy(decl.fallbackSurvives),
  ).length;

  return Math.max(0, Number(pyGet(variant, 'hardRejected', 0) || 0) - carried);
}

/**
 * corpus/outputs-<side>.jsonl by case id.
 *
 * @param {string} runDir
 * @param {Side} side
 * @returns {Map<string, Partial<AdapterResponse>>}
 */
export function readOutputs(runDir, side) {
  const rows = /** @type {Partial<AdapterResponse>[]} */ (
    readJsonl(join(runDir, 'corpus', `outputs-${side}.jsonl`))
  );

  return new Map(rows.map((row) => [String(row.id), row]));
}

/**
 * One line naming a case for a human: the test and its helper, the probe and its title, the
 * mutation and its parent, the WPT file and declaration, or the real-world file.
 *
 * @param {CaseRecord | Record<string, never>} entry
 * @returns {string}
 */
export function describeCase(entry) {
  switch (entry.source) {
    case 'tuple':
      return `test \`${String(entry.test).split('::').at(-1)}\` (\`${pyStr(entry.helper)}\`, lib.rs:${pyStr(entry.line)}, ${pyStr(entry.side)})`;
    case 'probe':
      return `probe \`${pyStr(entry.probe?.id)}\` (${pyStr(entry.origin)}): ${pyStr(entry.probe?.title)}`;
    case 'mutation':
      return `mutation \`${pyStr(entry.mutation)}\` of \`${pyStr(entry.parent)}\``;
    case 'wpt':
      return describeWpt(/** @type {CaseRecord} */ (entry));
    default:
      return `real-world \`${pyStr(entry.name ?? null)}\` (mode ${pyStr(entry.mode ?? null)})`;
  }
}

/**
 * @param {CaseRecord} entry A WPT case.
 * @returns {string}
 */
function describeWpt(entry) {
  const wpt = entry.wpt ?? { file: '', property: '', value: '', kind: '' };

  return `WPT \`${pyStr(wpt.file)}\` \`${pyStr(wpt.property)}: ${pyStr(wpt.value)}\` (${pyStr(wpt.kind)}, mode ${pyStr(entry.mode)})`;
}
