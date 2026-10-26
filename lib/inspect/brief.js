/**
 * `lcr brief <run>`: the compact digest of a run the reviewing agent reads instead of the raw
 * stage files: the PR, the change classification, build and test results, the deltas grouped by
 * source and mutation family, and the oracle's transition counts.
 *
 * Stage: inspect (read-only; `lcr review` prints it after the corpus). Reads prepare.json,
 * build.json, corpus.json, corpus/deltas.jsonl and oracle.json; any of them may be missing.
 * Writes nothing.
 *
 * The text is a fixed format, line for line: the agent's instructions (SKILL.md) quote it.
 */
import { join } from 'node:path';

import { iterJsonl, readJson } from '../core/files.js';
import { print } from '../core/log.js';
import { pyGet, pyGetIn, pyOr } from '../core/py-value.js';
import { pyLen, pySlice, pySorted, pyStr, pyStrip, pyTruthy } from '../core/py.js';
import { compareCodePoints } from '../core/pyjson.js';
import { MUTATIONS } from '../corpus/mutations.js';

/** @import { Build, CaseVerdict, CorpusSummary, Delta, OracleSummary, Prepare } from '../types.js' */

/** @typedef {{ id: string, source?: string }} DeltaRef The fields of a deltas.jsonl row grouped here. */

/** Delta ids listed per group before `(+N more)`. */
const DELTA_IDS_SHOWN = 8;
/** Characters of the PR body shown. */
const PR_BODY_CHARS = 1200;
/** Changed items, tests per tuple bucket, and overlapping PRs listed. */
const CHANGED_ITEMS_SHOWN = 15;
const TESTS_SHOWN = 4;
const OVERLAPS_SHOWN = 5;
/** Delta groups are listed in this source order; unknown sources go last. */
const SOURCE_ORDER = ['tuple', 'probe', 'mutation', 'wpt', 'realworld'];
/** `m-<parent>-engine-<profile>`: the retarget-to-an-engine-profile mutations. */
const ENGINE_MUTATION = /^m-(.+)-engine-[^/]+$/u;
/** Longest names first, so `value-prefixed-sibling` wins over `prefixed-sibling`. */
const MUTATIONS_BY_LENGTH = pySorted(MUTATIONS, (name) => name.length, { reverse: true });

/**
 * Print the brief of a run and return its text.
 *
 * @param {string} runDir
 * @returns {Promise<string>}
 */
export async function brief(runDir) {
  const prep = /** @type {Partial<Prepare>} */ (pyOr(readJson(join(runDir, 'prepare.json')), {}));
  const build = /** @type {Partial<Build>} */ (pyOr(readJson(join(runDir, 'build.json')), {}));
  const corpus = /** @type {Partial<CorpusSummary>} */ (pyOr(readJson(join(runDir, 'corpus.json')), {}));
  const oracle = /** @type {Partial<OracleSummary>} */ (pyOr(readJson(join(runDir, 'oracle.json')), {}));
  const runId = pyStr(pyGet(prep, 'run_id', null));
  const lines = [
    ...prepareLines(runDir, prep),
    ...buildLines(build),
    ...(pyTruthy(corpus) ? corpusLines(runDir, corpus) : []),
    ...oracleLines(oracle),
    '',
    `inspect a case: lcr show ${runId} <case-id>; full diff: ${runDir}/diff.patch`,
  ];
  const text = lines.join('\n');

  print(text);

  return text;
}

/**
 * The PR, its body, the change classification, linked issues and overlapping PRs.
 *
 * @param {string} runDir
 * @param {Partial<Prepare>} prep
 * @returns {string[]}
 */
function prepareLines(runDir, prep) {
  const pr = /** @type {Partial<import('../types.js').PrMeta>} */ (pyGet(prep, 'pr', {}));
  const field = (/** @type {keyof import('../types.js').PrMeta} */ key) => pyStr(pyGet(pr, key, null));
  const lines = [
    `# ${pyStr(pyGet(prep, 'run_id', null))}: #${field('number')} ${field('title')} (@${field('author')})`,
    '',
  ];

  if (pr.body && pyTruthy(pr.body)) {
    lines.push('PR body:', pySlice(pyStrip(pr.body), 0, PR_BODY_CHARS), '');
  }

  const radius = pyGet(prep, 'radius_areas', []).join(', ') || '-';

  lines.push(
    `strategy: ${pyStr(pyGet(prep, 'strategy', null))}; areas: ${pyGet(prep, 'areas', []).join(', ')}; radius adds: ${radius}`,
  );

  for (const [path, info] of Object.entries(pyGet(prep, 'files', {})).sort(([a], [b]) =>
    compareCodePoints(a, b),
  )) {
    lines.push(`  ${path} +${pyStr(info.added)}/-${pyStr(info.removed)}`);
  }

  lines.push(...changedItemLines(prep));

  const flags = pyGet(prep, 'risk_flags', []);
  const flagText = flags.map((flag) => `${pyStr(flag.id)}: ${pyStr(flag.detail)}`).join('; ');

  lines.push(`risk flags: ${flags.length > 0 ? flagText : 'none'}`);

  for (const issue of pyGet(prep, 'linked_issues', [])) {
    lines.push(
      `linked issue #${pyStr(issue.number)} (${pyStr(issue.state)}): ${pyStr(issue.title)}  -> ` +
        `${runDir}/issues/${pyStr(issue.number)}.json`,
    );
  }

  for (const overlap of pyGet(prep, 'overlapping_prs', []).slice(0, OVERLAPS_SHOWN)) {
    lines.push(
      `overlaps #${pyStr(overlap.number)}: ${pyStr(overlap.title)} (${overlap.shared_files.join(', ')})`,
    );
  }

  return lines;
}

/**
 * `changed items: <impl type>::<item name> (<file>); …`, distinct and sorted.
 *
 * @param {Partial<Prepare>} prep
 * @returns {string[]}
 */
function changedItemLines(prep) {
  const labels = new Set(
    pyGet(prep, 'changed_items', []).map((change) => {
      const type = pyOr(pyGetIn(change, 'impl', 'type'), '-');
      const name = pyOr(pyGetIn(change, 'item', 'name'), '-');

      return `${pyStr(type)}::${pyStr(name)} (${pyStr(change.file)})`;
    }),
  );
  const items = [...labels].sort(compareCodePoints);

  return items.length > 0 ? [`changed items: ${items.slice(0, CHANGED_ITEMS_SHOWN).join('; ')}`] : [];
}

/**
 * One line per built side: test summary, test exit status, adapter build.
 *
 * @param {Partial<Build>} build
 * @returns {string[]}
 */
function buildLines(build) {
  const lines = [];

  for (const side of /** @type {const} */ (['base', 'head'])) {
    const result = pyGet(build, side, null);

    if (result && pyTruthy(result)) {
      lines.push(
        `build ${side}: tests ${pyStr(result.summary)} exit=${pyStr(result.test_exit)} ` +
          `adapter=${pyTruthy(result.adapter_ok) ? 'ok' : 'FAILED'}`,
      );
    }
  }

  return lines;
}

/**
 * Case and delta counts, the delta groups, the test buckets, robustness and flag-only requests.
 *
 * @param {string} runDir
 * @param {Partial<CorpusSummary>} corpus
 * @returns {string[]}
 */
function corpusLines(runDir, corpus) {
  const deltas = /** @type {Delta[]} */ (iterJsonl(join(runDir, 'corpus', 'deltas.jsonl')).toArray());
  const lines = [
    `cases: ${pyStr(pyGet(corpus, 'cases', null))}; deltas: ${pyStr(pyOr(pyGet(corpus, 'deltas', null), 'none'))}`,
    ...deltaLines(deltas),
  ];

  for (const [bucket, entries] of Object.entries(pyOr(pyGet(corpus, 'tuples', null), {}))) {
    if (pyTruthy(entries)) {
      const examples = entries
        .slice(0, TESTS_SHOWN)
        .map((entry) => `${entry.test.split('::').at(-1)}:${pyStr(entry.line)}`);

      lines.push(`tests ${bucket}: ${entries.length}  e.g. ${examples.join(', ')}`);
    }
  }

  const robustness = pyGet(corpus, 'robustness', /** @type {Partial<CorpusSummary['robustness']>} */ ({}));

  lines.push(
    `panics/timeouts: head ${pyGet(robustness, 'head', []).length}, base ${pyGet(robustness, 'base', []).length}`,
  );

  const flagOnly = pyGet(corpus, 'flag_only', null);

  if (flagOnly && pyTruthy(flagOnly)) {
    const counts = Object.entries(flagOnly)
      .sort(([a], [b]) => compareCodePoints(a, b))
      .map(([flag, ids]) => `${flag} ${ids.length}`);

    lines.push(`flag-only requests (base rejects the flag): ${counts.join(', ')}`);
  }

  return lines;
}

/**
 * `oracle transitions: {...}` once the oracle has verdicts.
 *
 * @param {Partial<OracleSummary>} oracle
 * @returns {string[]}
 */
function oracleLines(oracle) {
  const verdicts = /** @type {Record<string, CaseVerdict[]>} */ (pyGet(oracle, 'verdicts', {}));

  if (!pyTruthy(verdicts)) {
    return [];
  }

  /** @type {Record<string, number>} */
  const counts = {};

  for (const verdict of Object.values(verdicts).flat()) {
    const transition = verdict.summary.latest.transition;

    counts[transition] = (counts[transition] ?? 0) + 1;
  }

  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => compareCodePoints(a, b)));

  return [`oracle transitions: ${pyStr(sorted)}`];
}

/**
 * The parent case of a mutation case id, or null when the id names no known mutation.
 *
 * @param {string} caseId
 * @returns {string | null}
 */
export function mutationParent(caseId) {
  for (const name of MUTATIONS_BY_LENGTH) {
    if (caseId.startsWith('m-') && caseId.endsWith(`-${name}`)) {
      return caseId.slice(2, -name.length - 1);
    }
  }

  return ENGINE_MUTATION.exec(caseId)?.[1] ?? null;
}

/**
 * The group a delta is listed under: `m-<parent>-*` for mutations, `p-<dir>/*` for probes, the
 * source otherwise.
 *
 * @param {Partial<DeltaRef>} delta
 * @returns {string}
 */
export function deltaGroup(delta) {
  const id = pyGet(delta, 'id', '');
  const source = pyGet(delta, 'source', '');

  if (source === 'mutation') {
    const parent = mutationParent(id);

    return parent ? `m-${parent}-*` : source;
  }

  if (source === 'probe' && id.includes('/')) {
    return `${id.split('/', 1)[0]}/*`;
  }

  return source;
}

/**
 * Deltas grouped by source and family, in SOURCE_ORDER, each group's ids sorted.
 *
 * @param {Iterable<DeltaRef>} deltas
 * @returns {[string, string[]][]} (group, ids)
 */
export function deltaGroups(deltas) {
  /** @type {Map<string, { source: string, group: string, ids: string[] }>} */
  const groups = new Map();

  for (const delta of deltas) {
    const source = pyGet(delta, 'source', '');
    const group = deltaGroup(delta);
    const key = JSON.stringify([source, group]);
    const entry = groups.get(key) ?? { source, group, ids: [] };

    groups.set(key, entry);
    entry.ids.push(delta.id);
  }

  const rank = (/** @type {string} */ source) =>
    SOURCE_ORDER.includes(source) ? SOURCE_ORDER.indexOf(source) : SOURCE_ORDER.length;
  const ordered = pySorted(groups.values(), ({ source, group }) => [rank(source), source, group]);

  return ordered.map(({ group, ids }) => [group, ids.toSorted(compareCodePoints)]);
}

/**
 * One line per delta group; a mutation family lists the mutation names after its glob.
 *
 * @param {Iterable<DeltaRef>} deltas
 * @returns {string[]}
 */
export function deltaLines(deltas) {
  return deltaGroups(deltas).map(([group, ids]) => {
    const family = group.startsWith('m-') && group.endsWith('-*');
    const names = family ? ids.map((id) => pySlice(id, pyLen(group) - 1)) : ids;
    const more = ids.length > DELTA_IDS_SHOWN ? ` (+${ids.length - DELTA_IDS_SHOWN} more)` : '';

    return `  delta ${group} (${ids.length}): ${names.slice(0, DELTA_IDS_SHOWN).join(', ')}${more}`;
  });
}
