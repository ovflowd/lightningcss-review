/**
 * The command table: every `lcr` command, its arguments and the stage function it calls.
 *
 * Stage: CLI. This is the whole command-line surface. SKILL.md, the docs and the reviewer's
 * scripts depend on it, so it is a compatibility contract (identical to the Python harness, tag
 * py-final): the same commands, positionals, flags, defaults and choices, the same help texts, and
 * the same stdout lines around the stage call (`prepare` prints the run directory, run-stage
 * commands print it after the stage, `review` prints a blank line and the brief).
 * Stage modules are imported lazily, so `lcr show` does not load the report renderer.
 *
 * New flags (`setup --update`) are additions; nothing py-final accepted is removed.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { print } from '../core/log.js';
import { repoDir } from '../core/paths.js';
import { resolveRun } from './run-dir.js';

/**
 * @typedef {object} OptionSpec
 * @property {'string' | 'boolean'} type
 * @property {'int'} [parse] Parse the value as an int (argparse `type=int`).
 * @property {readonly string[]} [choices]
 * @property {string | number | boolean | null} [default]
 * @property {string} [dest] Argument name when it differs from the camel-cased flag.
 * @property {string} [metavar]
 * @property {string} [help]
 */

/**
 * @typedef {object} PositionalSpec
 * @property {string} name
 * @property {'required' | 'optional' | 'variadic'} arity
 * @property {'int'} [parse]
 * @property {string} [help]
 */

/**
 * Parsed arguments of any command: positionals by name, flags camel-cased (`--max-cases` ->
 * `maxCases`) or by `dest`. Flags a command does not declare are absent.
 *
 * @typedef {object} CommandArgs
 * @property {string | null} [run]
 * @property {number | null} [pr]
 * @property {string} [case]
 * @property {string[]} [paths]
 * @property {string | null} [localRange]
 * @property {boolean} [offline]
 * @property {string | null} [profiles]
 * @property {boolean} [rebuild]
 * @property {boolean} [update]
 * @property {boolean} [js]
 * @property {number | null} [jobs]
 * @property {'auto' | 'all' | 'none'} [wpt]
 * @property {'auto' | 'all' | 'none'} [realworld]
 * @property {number} [maxCases]
 * @property {string | null} [rerun]
 * @property {boolean} [allowIncomplete]
 * @property {boolean} [json]
 * @property {string | null} [transition]
 * @property {string | null} [check]
 * @property {boolean} [refresh]
 * @property {string | null} [tree]
 * @property {number} [keep]
 * @property {boolean} [results]
 */

/**
 * @typedef {object} CommandSpec
 * @property {string} name
 * @property {string} help
 * @property {readonly PositionalSpec[]} positionals
 * @property {Readonly<Record<string, OptionSpec>>} options Keyed by flag name without dashes.
 * @property {(args: CommandArgs) => Promise<number | void>} run Resolves to the exit status (default 0).
 */

const RUN_HELP = "run id, PR number, or 'latest'";
/** @type {PositionalSpec} */
const OPTIONAL_RUN = { name: 'run', arity: 'optional', help: RUN_HELP };
/** @type {PositionalSpec} */
const REQUIRED_RUN = { name: 'run', arity: 'required' };
/** @type {OptionSpec} */
const PROFILES = { type: 'string', default: null };

/**
 * A command that runs one stage on a run and then prints the run directory.
 *
 * @param {string} name
 * @param {string} help
 * @param {Record<string, OptionSpec>} options
 * @param {(runDir: string, args: CommandArgs) => Promise<unknown>} stage
 * @returns {CommandSpec}
 */
function runStage(name, help, options, stage) {
  return {
    name,
    help,
    positionals: [OPTIONAL_RUN],
    options,
    run: async (args) => {
      const runDir = resolveRun(args.run);

      await stage(runDir, args);
      print(runDir);
    },
  };
}

/**
 * A command that reads or renders one run and prints only its own output.
 *
 * @param {string} name
 * @param {string} help
 * @param {(runDir: string, args: CommandArgs) => Promise<unknown>} action
 * @returns {CommandSpec}
 */
function runView(name, help, action) {
  return {
    name,
    help,
    positionals: [{ name: 'run', arity: 'optional' }],
    options: {},
    run: async (args) => {
      await action(resolveRun(args.run), args);
    },
  };
}

/** @type {readonly CommandSpec[]} */
export const COMMANDS = [
  {
    name: 'doctor',
    help: 'check host requirements and images',
    positionals: [],
    options: {},
    run: async () => (await import('../setup/setup.js')).doctor(),
  },
  {
    name: 'setup',
    help: 'build Docker images (builder + browser engines) and record versions',
    positionals: [],
    options: {
      profiles: {
        ...PROFILES,
        help: 'comma-separated engine profiles (default: config/engines.json default_profiles)',
      },
      rebuild: { type: 'boolean', default: false },
      update: {
        type: 'boolean',
        default: false,
        help: 'resolve the newest Playwright release, rebuild the latest profile, and pin it only if the selftest passes',
      },
    },
    run: async (args) =>
      (await import('../setup/setup.js')).setup({
        profiles: args.profiles,
        rebuild: args.rebuild,
        update: args.update,
      }),
  },
  {
    name: 'prepare',
    help: 'resolve PR -> base/head trees, classify the change',
    positionals: [{ name: 'pr', arity: 'optional', parse: 'int' }],
    options: {
      range: {
        type: 'string',
        dest: 'localRange',
        default: null,
        help: 'review a local <base>..<head> instead of a PR',
      },
      offline: { type: 'boolean', default: false, help: 'do not fetch (use refs already present)' },
    },
    run: async (args) => {
      const { prepare } = await import('../prepare/prepare.js');

      print(await prepare({ pr: args.pr, localRange: args.localRange, offline: args.offline }));
    },
  },
  runStage(
    'build',
    'fmt check, inject recorder, cargo test (both sides), build adapters',
    {
      js: { type: 'boolean', default: false, help: 'also run the JS lane (yarn build/test/tsc)' },
      jobs: { type: 'string', parse: 'int', default: null },
    },
    async (runDir, args) =>
      (await import('../build/build.js')).build(runDir, { js: args.js, jobs: args.jobs }),
  ),
  runStage(
    'corpus',
    'assemble cases (tests, probes, WPT, real-world), run base/head adapters, compute deltas',
    {
      wpt: { type: 'string', choices: ['auto', 'all', 'none'], default: 'auto' },
      realworld: { type: 'string', choices: ['auto', 'all', 'none'], default: 'auto' },
    },
    async (runDir, args) =>
      (await import('../corpus/corpus.js')).corpus(runDir, { wpt: args.wpt, realworld: args.realworld }),
  ),
  runStage(
    'probe',
    'run the agent-written probes in <run>/probes through both adapters',
    {},
    async (runDir) => (await import('../corpus/run-probes.js')).runProbes(runDir),
  ),
  runStage(
    'oracle',
    'run browser oracles on deltas, PR tests and probes',
    {
      profiles: PROFILES,
      'max-cases': { type: 'string', parse: 'int', default: 4000 },
      rerun: {
        type: 'string',
        default: null,
        metavar: 'IDS',
        help: 're-run only these case ids or globs (comma/space separated) and merge them into oracle.json',
      },
    },
    async (runDir, args) =>
      (await import('../oracle-driver/oracle.js')).oracle(runDir, {
        profiles: args.profiles,
        maxCases: args.maxCases,
        rerun: args.rerun,
      }),
  ),
  runStage(
    'perf',
    'optional: release-build timing on the real-world corpus and binary size, base vs head',
    {},
    async (runDir) => (await import('../build/perf.js')).perf(runDir),
  ),
  runStage(
    'report',
    'compute verdict and render report.md/report.json from the templates',
    {
      'allow-incomplete': {
        type: 'boolean',
        default: false,
        help: 'render even if analysis.json is missing',
      },
    },
    async (runDir, args) =>
      (await import('../report/report.js')).report(runDir, { allowIncomplete: args.allowIncomplete }),
  ),
  runStage('status', 'show stage status for a run', {}, async (runDir) =>
    (await import('../inspect/status.js')).status(runDir),
  ),
  runView(
    'worklist',
    'write/refresh analysis.json with every slot the report needs; print the open ones',
    async (runDir) => (await import('../inspect/worklist.js')).worklist(runDir),
  ),
  runView('brief', 'compact digest of a run for the reviewer (instead of raw JSON)', async (runDir) =>
    (await import('../inspect/brief.js')).brief(runDir),
  ),
  runView('summary', 'print the fixed chat summary for a reported run', async (runDir) =>
    (await import('../report/report.js')).summary(runDir),
  ),
  {
    name: 'show',
    help: 'print one case: input, base/head output, per-engine oracle diffs',
    positionals: [REQUIRED_RUN, { name: 'case', arity: 'required' }],
    options: { json: { type: 'boolean', default: false, help: 'everything about the case, untruncated' } },
    run: async (args) =>
      (await import('../inspect/show.js')).show(resolveRun(args.run), /** @type {string} */ (args.case), {
        json: args.json,
      }),
  },
  {
    name: 'table',
    help: 'one line per oracle case: transition, base/head status, bad engines, legacy (before the oracle: outputs only)',
    positionals: [REQUIRED_RUN],
    options: {
      transition: { type: 'string', default: null, help: 'only these transitions (comma separated)' },
      check: {
        type: 'string',
        default: null,
        help: 'only the cases a report check lists (needs report.json)',
      },
      case: { type: 'string', default: null, help: 'only case ids matching this glob' },
      json: { type: 'boolean', default: false },
    },
    run: async (args) =>
      (await import('../inspect/table.js')).table(resolveRun(args.run), {
        transition: args.transition,
        check: args.check,
        pattern: args.case,
        json: args.json,
      }),
  },
  {
    name: 'review',
    help: 'prepare + build + corpus (stops before the agent analysis step)',
    positionals: [{ name: 'pr', arity: 'required', parse: 'int' }],
    options: { js: { type: 'boolean', default: false } },
    run: review,
  },
  {
    name: 'wpt',
    help: 'fetch the pinned WPT revision and extract the parsing corpus',
    positionals: [],
    options: { refresh: { type: 'boolean', default: false } },
    run: async (args) =>
      print(await (await import('../fixtures/wpt.js')).ensureFixtures({ refresh: args.refresh })),
  },
  {
    name: 'realworld',
    help: 'download the pinned real-world CSS corpus',
    positionals: [],
    options: {},
    run: async () => print(await (await import('../fixtures/realworld.js')).ensureRealworld()),
  },
  {
    name: 'spec-coverage',
    help: 'webref inventory vs. what LightningCSS parses (missing features)',
    positionals: [],
    options: { tree: { type: 'string', default: null, help: 'source tree (default: the persistent clone)' } },
    run: async (args) => print(await (await import('../spec/spec.js')).specCoverage(args.tree || repoDir())),
  },
  {
    name: 'clean',
    help: 'delete old runs; with <run> drop its build trees; --results drops raw oracle results',
    positionals: [{ name: 'run', arity: 'optional', help: "run id, PR number or 'latest'" }],
    options: {
      keep: { type: 'string', parse: 'int', default: 10, help: 'most recent runs to keep (default 10)' },
      results: {
        type: 'boolean',
        default: false,
        help: 'delete oracle results-*.jsonl and screenshots once verdicts.jsonl exists',
      },
    },
    run: async (args) =>
      (await import('./clean.js')).clean({ run: args.run, keep: args.keep, results: args.results }),
  },
  {
    name: 'baseline',
    help: 'run every curated probe on current master through the oracle',
    positionals: [],
    options: { profiles: PROFILES },
    run: async (args) =>
      print(await (await import('../oracle-driver/baseline.js')).baseline({ profiles: args.profiles })),
  },
  {
    name: 'selftest',
    help: "run the oracle's known-answer cases in every engine profile",
    positionals: [],
    options: { profiles: PROFILES },
    run: async (args) => (await import('../oracle-driver/selftest.js')).selftest({ profiles: args.profiles }),
  },
  {
    name: 'validate-probes',
    help: 'parse every probe file and report format errors',
    positionals: [{ name: 'paths', arity: 'variadic' }],
    options: {},
    run: async (args) => {
      // A run id, PR number or 'latest' is shorthand for <run>/probes.
      const paths = (args.paths ?? []).map((path) =>
        existsSync(path) ? path : join(resolveRun(path), 'probes'),
      );

      return (await import('../corpus/probes.js')).validateCli(paths);
    },
  },
];

/**
 * `lcr review <PR>`: prepare, build and corpus, then the brief for the reviewer.
 *
 * @param {CommandArgs} args
 * @returns {Promise<void>}
 */
async function review(args) {
  const { prepare } = await import('../prepare/prepare.js');
  const { build } = await import('../build/build.js');
  const { corpus } = await import('../corpus/corpus.js');
  const { brief } = await import('../inspect/brief.js');
  const runDir = await prepare({ pr: args.pr, localRange: null, offline: false });

  await build(runDir, { js: args.js, jobs: null });
  await corpus(runDir, { wpt: 'auto', realworld: 'auto' });
  print();
  await brief(runDir);
}

/**
 * The command spec named `name`, or undefined.
 *
 * @param {string} name
 * @returns {CommandSpec | undefined}
 */
export function findCommand(name) {
  return COMMANDS.find((command) => command.name === name);
}
