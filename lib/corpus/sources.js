/**
 * Where corpus cases come from: one function per source, each returning cases in a fixed order.
 *
 * Stage: corpus (and `lcr probe` for the PR probes).
 *
 * - tuples: every test-helper call recorded from the base and head `cargo test` (the PR's own tests
 *   and every existing expectation), mapped to adapter requests by lib/build/tuples.js;
 * - probes: curated edge cases (corpus/probes) plus PR-specific ones (<run>/probes);
 * - wpt: the WPT property-value corpus (lightningcss#1328 extraction) in the `wpt` mode matrix;
 * - realworld: pinned framework stylesheets in the `realworld` mode matrix.
 * Mutations of tuples and probes are built in mutations.js.
 *
 * Reads: prepare.json (changed lines of src/lib.rs), build/<side>/tuples.jsonl, src/<side>/src/
 * targets.rs (feature bits), probe files, the WPT fixtures and real-world files in the cache,
 * config/modes.json.
 *
 * Invariants: case ids are stable across runs and machines (tuple identities and WPT ids are
 * content hashes; probe ids come from the files), and every list comes out in a deterministic
 * order, so cases.jsonl is byte-identical for identical inputs. Base and head get the very same
 * request for every case; a tuple seen on only one side still runs on both builds.
 */
import { existsSync } from 'node:fs';

import { loadTuples, mappingProblem, toRequests } from '../build/tuples.js';
import { fileSha256, readPyText } from '../core/files.js';
import { sha256, stableId } from '../core/ids.js';
import { log } from '../core/log.js';
import { joinPath, purePath, rglobRelative } from '../core/pathlib.js';
import { loadConfig } from '../core/paths.js';
import { compareCodePoints, pyTruthy } from '../core/py.js';
import { availableFiles } from '../fixtures/realworld.js';
import { loadFixtures } from '../fixtures/wpt.js';
import { featureBits, parseTargets } from '../targets/targets.js';
import { curatedDirs, loadProbes, prProbeDir } from './probes.js';

/**
 * @import { AdapterRequest, CaseBase, CorpusCase, ModesConfig, Prepare, ProbeMeta, Side, Targets,
 *   TupleCaseFields, UnmappableTuple } from '../types.js'
 */
/** @import { Probe } from './probes.js' */
/** @import { LoadedTuple } from '../build/tuples.js' */

/** Characters a WPT value cannot contain when it is wrapped in a style rule (`.t{prop:value}`). */
const RULE_BREAKING_CHARS = Object.freeze(['{', '}', ';']);

/**
 * @typedef {{ minify: boolean, compact: boolean, targets: Targets | null }} ModeRequest The request
 *   options of a mode from config/modes.json.
 */

/**
 * The request options of one mode of config/modes.json.
 *
 * @param {string} modeName
 * @returns {ModeRequest}
 */
export function modeRequest(modeName) {
  const mode = /** @type {ModesConfig} */ (loadConfig('modes.json')).modes[modeName];

  return { minify: mode.minify, compact: mode.compact, targets: parseTargets(mode.targets) };
}

/**
 * Whether a line falls in one of the inclusive `[start, end]` ranges.
 *
 * @param {number | null | undefined} line
 * @param {readonly (readonly number[])[]} ranges
 * @returns {boolean}
 */
export function inRanges(line, ranges) {
  return line !== null && line !== undefined && ranges.some(([start, end]) => start <= line && line <= end);
}

// ---------------------------------------------------------------------------------------------
// Tuples

/**
 * @typedef {CaseBase & TupleCaseFields & { tuple: LoadedTuple }} TupleCase
 *   A tuple case before it is written (cases.jsonl leaves out the `tuple`).
 * @typedef {object} TupleStats corpus.json `tuple_stats` before rejected requests are merged in.
 * @property {number} base_tuples
 * @property {number} head_tuples
 * @property {number} unmappable
 * @property {string[]} unmappable_helpers
 * @property {Omit<UnmappableTuple, 'count'>[]} unmappable_cases
 */

/**
 * One case per adapter request of every recorded tuple, base and head merged by identity. A tuple
 * recorded on both sides is mapped with head's feature bits and reported at head's line.
 *
 * @param {string} runDir
 * @param {Prepare} prep
 * @returns {{ cases: TupleCase[], stats: TupleStats }}
 */
export function tupleCases(runDir, prep) {
  const base = loadTuples(joinPath(runDir, 'build/base/tuples.jsonl'));
  const head = loadTuples(joinPath(runDir, 'build/head/tuples.jsonl'));
  /** @type {Record<Side, Record<string, number>>} */
  const bits = {
    base: featureBits(joinPath(runDir, 'src/base')),
    head: featureBits(joinPath(runDir, 'src/head')),
  };
  const libHunks = Object.hasOwn(prep.files, 'src/lib.rs')
    ? prep.files['src/lib.rs']
    : { head: [], base: [] };
  /** @type {TupleCase[]} */
  const cases = [];
  /** @type {Omit<UnmappableTuple, 'count'>[]} */
  const unmappable = [];
  const identities = [...new Set([...base.keys(), ...head.keys()])].sort(compareCodePoints);

  for (const identity of identities) {
    const onHead = head.has(identity);
    const side = tupleSide(onHead, base.has(identity));
    const lineSide = onHead ? 'head' : 'base';
    const tuple = /** @type {LoadedTuple} */ (head.get(identity) ?? base.get(identity));
    const inDiff = inRanges(tuple.line, libHunks[lineSide]);
    const requests = toRequests(tuple, bits[lineSide]);

    if (requests === null) {
      const { helper, test, line } = tuple;

      unmappable.push({ helper, test, line, side, in_diff: inDiff, reason: mappingProblem(tuple) });
      continue;
    }

    for (const [suffix, request, expectation] of requests) {
      cases.push({
        id: suffix ? `t-${identity}-${suffix}` : `t-${identity}`,
        source: 'tuple',
        side,
        helper: tuple.helper,
        test: tuple.test,
        line: tuple.line,
        line_side: lineSide,
        in_diff: inDiff,
        request,
        expectation,
        tuple,
        suffix,
      });
    }
  }

  return { cases, stats: tupleStats(base.size, head.size, unmappable) };
}

/**
 * @param {boolean} onHead
 * @param {boolean} onBase
 * @returns {'both' | 'head' | 'base'}
 */
function tupleSide(onHead, onBase) {
  if (onHead && onBase) {
    return 'both';
  }

  return onHead ? 'head' : 'base';
}

/**
 * @param {number} baseCount
 * @param {number} headCount
 * @param {Omit<UnmappableTuple, 'count'>[]} unmappable
 * @returns {TupleStats}
 */
function tupleStats(baseCount, headCount, unmappable) {
  return {
    base_tuples: baseCount,
    head_tuples: headCount,
    unmappable: unmappable.length,
    unmappable_helpers: [...new Set(unmappable.map((row) => row.helper))].sort(compareCodePoints),
    unmappable_cases: unmappable,
  };
}

// ---------------------------------------------------------------------------------------------
// Probes

/**
 * The `probe` object a probe case carries (what the report, the oracle and `lcr show` read).
 *
 * @param {Probe} probe
 * @returns {ProbeMeta}
 */
function probeMeta(probe) {
  return {
    id: probe.id,
    area: probe.area,
    title: probe.title,
    mode: /** @type {ProbeMeta['mode']} */ (probe.mode),
    targets: probe.targetsText,
    expect: probe.expect,
    known: probe.known,
    refs: probe.refs,
    path: probe.path,
    dom: probe.dom,
    note: probe.note,
    repro: /** @type {number | null} */ (probe.repro),
  };
}

/**
 * One case per valid probe: the curated corpus, then the run's PR probes (sorted by id together).
 *
 * @param {string} runDir
 * @returns {{ cases: CorpusCase[], problems: string[] }}
 */
export function probeCases(runDir) {
  const { probes, problems } = loadProbes([...curatedDirs(), prProbeDir(runDir)]);
  const cases = probes.map((probe) => {
    /** @type {CorpusCase} */
    const probeCase = {
      id: `p-${probe.id}`,
      source: 'probe',
      origin: /** @type {'curated' | 'pr' | 'cli'} */ (probe.origin),
      probe: probeMeta(probe),
      area: probe.area,
      request: probe.request(),
    };

    if (pyTruthy(probe.timeout)) {
      probeCase.timeout = /** @type {number} */ (probe.timeout);
    }

    return probeCase;
  });

  return { cases, problems };
}

/**
 * Fingerprint of <run>/probes (relative path and content of every probe file), so a stale probe
 * or oracle stage can be detected.
 *
 * @param {string} runDir
 * @returns {string}
 */
export function probeFilesHash(runDir) {
  const root = joinPath(purePath(runDir), 'probes');
  const files = existsSync(root) ? rglobRelative(root, '.css') : [];

  return sha256(files.map((relative) => `${relative}\0${fileSha256(joinPath(root, relative))}`).join('\n'));
}

// ---------------------------------------------------------------------------------------------
// WPT and real-world CSS

/**
 * The WPT lane: every fixture value in every mode of the `wpt` matrix. Lowering modes go through
 * a real style rule because a style attribute skips logical lowering, `@supports` fallbacks and
 * dark-mode rules (context.rs: should_compile_logical / add_conditional_property); values that
 * would break out of that rule are skipped in those modes.
 *
 * @param {string} selection `auto`, `all` or `none`.
 * @returns {CorpusCase[]}
 */
export function wptCases(selection) {
  if (selection === 'none') {
    return [];
  }

  const fixtures = loadFixtures();

  if (!fixtures || !pyTruthy(fixtures)) {
    log('WPT fixtures missing; run `lcr wpt` once to enable the WPT lane');

    return [];
  }

  const modes = /** @type {ModesConfig} */ (loadConfig('modes.json')).matrix.wpt.map(
    (mode) => /** @type {const} */ ([mode, modeRequest(mode)]),
  );
  /** @type {CorpusCase[]} */
  const cases = [];

  for (const fixture of fixtures.cases) {
    for (const [mode, options] of modes) {
      const request = wptRequest(fixture, options);

      if (request) {
        cases.push({
          id: `w-${stableId(fixture.id, mode)}`,
          source: 'wpt',
          wpt: {
            id: fixture.id,
            file: fixture.file,
            kind: fixture.kind,
            property: fixture.property,
            value: fixture.value,
            expected: fixture.expected ?? null,
          },
          mode,
          request,
        });
      }
    }
  }

  return cases;
}

/**
 * @param {{ property: string, value: string }} fixture
 * @param {ModeRequest} options
 * @returns {AdapterRequest | null}
 */
function wptRequest({ property, value }, options) {
  if (!pyTruthy(options.targets)) {
    return { kind: 'property', property, value, ...options };
  }

  if (RULE_BREAKING_CHARS.some((char) => value.includes(char))) {
    return null;
  }

  return { kind: 'sheet', css: `.t{${property}:${value}}`, ...options };
}

/**
 * The real-world lane: every downloaded, checksum-verified stylesheet in every mode of the
 * `realworld` matrix, parsed with error recovery as browsers do.
 *
 * @param {string} selection `auto`, `all` or `none`.
 * @returns {CorpusCase[]}
 */
export function realworldCases(selection) {
  if (selection === 'none') {
    return [];
  }

  const matrix = /** @type {ModesConfig} */ (loadConfig('modes.json')).matrix.realworld;
  /** @type {CorpusCase[]} */
  const cases = [];

  for (const [name, path] of availableFiles()) {
    const css = readPyText(path, { replace: true });

    for (const mode of matrix) {
      cases.push({
        id: `r-${name}-${mode}`,
        source: 'realworld',
        name,
        mode,
        request: { kind: 'sheet', css, error_recovery: true, ...modeRequest(mode) },
      });
    }
  }

  return cases;
}
