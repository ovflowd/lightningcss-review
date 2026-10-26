/**
 * A synthetic run directory with every stage file the report, the worklist and the status reader
 * use, plus builders for the cases and oracle verdicts those tests need, so the report and driver
 * tests share one fixture builder and each test states only the cases it cares about.
 *
 * Usage:
 *   using run = new SyntheticRun();
 *   run.addCase(probeCase('p-color/x'), { delta: true });
 *   run.oracle.verdicts['p-color/x'] = verdict('p-color/x', { head: 'different', transition: 'regressed' });
 *   const dir = run.write();
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeFile, writeJson, writeJsonl } from '../../lib/core/files.js';
import { compareCodePoints } from '../../lib/core/pyjson.js';

/** @typedef {Record<string, any>} Json A loosely typed stage-file object (tests build them freely). */

const ENGINES = /** @type {const} */ (['chromium', 'firefox', 'webkit']);

/** A spec URL a classification can cite. */
export const SPEC = 'https://drafts.csswg.org/css-color-4/#x';

/**
 * A run directory under the system temp dir; deleted when the `using` block ends.
 */
export class SyntheticRun {
  constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'lcr-run-'));
    this.dir = join(this.root, 'run');
    /** @type {Json | null} */
    this.prep = {
      run_id: 'run',
      strategy: 'local-range',
      base: 'b'.repeat(40),
      head_tree: 'h'.repeat(40),
      areas: ['color'],
      files: { 'src/values/color.rs': { status: 'M', added: 1, removed: 1 } },
      file_areas: { 'src/values/color.rs': ['color'] },
      linked_issues: [],
      overlapping_prs: [],
      risk_flags: [],
    };
    /** @type {Json | null} */
    this.build = { head: { summary: { passed: 1, ignored: 0 } }, base: {}, js: {} };
    /** @type {Json | null} */
    this.corpus = {
      cases: {},
      deltas: {},
      tuples: {},
      tuple_stats: {},
      robustness: { head: [], base: [] },
      idempotency: {},
      idempotency_failures: [],
      probes: [],
      size: [],
    };
    /** @type {Json | null} */
    this.oracle = { profiles: { latest: { chromium: '1' } }, verdicts: {} };
    /** @type {Json | null} */
    this.analysis = { intent: { kind: 'bugfix', summary: 's' }, checklist: [], deltas: [], findings: [] };
    /** @type {Map<string, Json>} */
    this.cases = new Map();
    /** @type {Set<string>} */
    this.deltaIds = new Set();
    /** @type {{ base: Map<string, Json>, head: Map<string, Json> }} */
    this.outputs = { base: new Map(), head: new Map() };
  }

  /**
   * Add a corpus case with ok outputs; a delta gets a different head output.
   *
   * @param {Json} entry
   * @param {{ delta?: boolean, baseCode?: string, headCode?: string }} [options]
   * @returns {string} The case id.
   */
  addCase(entry, { delta = false, baseCode = 'a', headCode } = {}) {
    this.cases.set(entry.id, entry);

    if (delta) {
      this.deltaIds.add(entry.id);
    }

    this.outputs.base.set(entry.id, { ok: true, code: baseCode });
    this.outputs.head.set(entry.id, { ok: true, code: headCode ?? (delta ? `${baseCode}x` : baseCode) });

    return entry.id;
  }

  /**
   * Write every stage file (a null stage object deletes its file) and return the run directory.
   *
   * @returns {string}
   */
  write() {
    if (this.corpus) {
      this.corpus.cases = countBy([...this.cases.values()], (entry) => entry.source);
      this.corpus.deltas = countBy([...this.deltaIds], (id) => this.cases.get(id)?.source);
    }

    /** @type {[string, Json | null][]} */
    const stages = [
      ['prepare', this.prep],
      ['build', this.build],
      ['corpus', this.corpus],
      ['oracle', this.oracle],
      ['analysis', this.analysis],
    ];

    for (const [name, value] of stages) {
      const path = join(this.dir, `${name}.json`);

      if (value === null) {
        removeFile(path);
      } else {
        writeJson(path, value);
      }
    }

    const ids = [...this.cases.keys()].sort(compareCodePoints);
    const corpusDir = join(this.dir, 'corpus');

    writeJsonl(
      join(corpusDir, 'cases.jsonl'),
      ids.map((id) => this.cases.get(id)),
    );
    writeJsonl(
      join(corpusDir, 'deltas.jsonl'),
      [...this.deltaIds].sort(compareCodePoints).map((id) => ({ id, source: this.cases.get(id)?.source })),
    );

    for (const side of /** @type {const} */ (['base', 'head'])) {
      const rows = [...this.outputs[side]]
        .sort(([a], [b]) => compareCodePoints(a, b))
        .map(([id, out]) => ({ id, ...out }));

      writeJsonl(join(corpusDir, `outputs-${side}.jsonl`), rows);
    }

    return this.dir;
  }

  [Symbol.dispose]() {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/**
 * @template T
 * @param {readonly T[]} items
 * @param {(item: T) => string | undefined} key
 * @returns {Record<string, number>}
 */
function countBy(items, key) {
  /** @type {Record<string, number>} */
  const counts = {};

  for (const item of items) {
    const name = String(key(item));

    counts[name] = (counts[name] ?? 0) + 1;
  }

  return counts;
}

/**
 * @typedef {object} VerdictOptions
 * @property {string} [base] Base status in every engine (default `equivalent`).
 * @property {string} [head] Head status in every engine (default `equivalent`).
 * @property {string} [transition] Default `both-equivalent`.
 * @property {Record<string, [string, string]>} [perEngine] `{ engine: [base, head] }` overrides.
 * @property {Json} [legacy] `summary.legacy`.
 * @property {Json} [summary] Extra `summary.latest` fields.
 */

/**
 * One light-scheme oracle verdict list for a case, consistent across engines.
 *
 * @param {string} caseId
 * @param {VerdictOptions} [options]
 * @returns {Json[]}
 */
export function verdict(
  caseId,
  {
    base = 'equivalent',
    head = 'equivalent',
    transition = 'both-equivalent',
    perEngine = {},
    legacy = {},
    summary = {},
  } = {},
) {
  /** @type {Record<string, [string, string]>} */
  const per = Object.fromEntries(ENGINES.map((engine) => [engine, [base, head]]));

  Object.assign(per, perEngine);

  const variant = (/** @type {string} */ status) => ({ status, hardRejected: 0, diffs: [] });
  const latest = Object.fromEntries(
    Object.entries(per).map(([engine, [b, h]]) => [
      engine,
      { touched: 1, version: '1', variants: { base: variant(b), head: variant(h) } },
    ]),
  );
  const engines = (/** @type {0 | 1} */ side, /** @type {(status: string) => boolean} */ keep) =>
    Object.keys(per)
      .filter((engine) => keep(per[engine][side]))
      .sort();
  const split = (/** @type {0 | 1} */ side) => {
    const ok = engines(side, (status) => status === 'equivalent' || status === 'near');
    const bad = engines(side, (status) => status === 'different');

    return { ok, bad, divergent: ok.length > 0 && bad.length > 0 };
  };

  return [
    {
      id: caseId,
      case: caseId,
      kind: 'sheet',
      scheme: 'light',
      latest,
      legacy: {},
      summary: {
        latest: {
          base,
          head,
          transition,
          rejectedBase: 0,
          rejectedHead: 0,
          visualBase: false,
          visualHead: false,
          enginesBase: split(0),
          enginesHead: split(1),
          engines: Object.fromEntries(
            Object.entries(per).map(([engine, [b, h]]) => [engine, { base: b, head: h }]),
          ),
          inert: [],
          errored: [],
          divergent: false,
          neutral: false,
          ...summary,
        },
        legacy,
      },
    },
  ];
}

/**
 * @typedef {object} ProbeCaseOptions
 * @property {string} [area]
 * @property {string} [origin]
 * @property {string} [mode]
 * @property {Json | null} [targets]
 * @property {unknown} [repro] Usually a number; analysis-side tests also pass text such as `#7`.
 * @property {string} [known]
 * @property {string[]} [flags]
 */

/**
 * A probe case (`p-<id>`).
 *
 * @param {string} caseId
 * @param {ProbeCaseOptions} [options]
 * @returns {Json}
 */
export function probeCase(
  caseId,
  {
    area = 'color',
    origin = 'pr',
    mode = 'minify',
    targets = null,
    repro = null,
    known = 'none',
    flags,
  } = {},
) {
  /** @type {Json} */
  const request = {
    kind: 'sheet',
    css: '.t{color:red}',
    minify: true,
    compact: mode === 'minify' || mode === 'lower-minify',
    targets,
  };

  if (flags) {
    request.flags = flags;
  }

  return {
    id: caseId,
    source: 'probe',
    origin,
    area,
    request,
    probe: { id: caseId.slice(2), area, title: 't', mode, expect: [], known, repro },
  };
}

/**
 * A mutation case of `parent`.
 *
 * @param {string} parent
 * @param {string} name
 * @param {string} [area]
 * @returns {Json}
 */
export function mutationCase(parent, name, area = 'color') {
  return {
    id: `m-${parent}-${name}`,
    source: 'mutation',
    mutation: name,
    parent,
    area,
    request: { kind: 'sheet', css: '.t{color:red}', minify: true },
  };
}
