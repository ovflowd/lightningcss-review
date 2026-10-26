/**
 * Command-line options of the engine runner.
 *
 * Stage: oracle (engine runner, Node 14/16/24). Node 14 has no `util.parseArgs`, so this is the
 * small parser the runner always had: `--name value` pairs and bare flags, anywhere on the line.
 * Unknown options are ignored, which keeps old and new drivers compatible.
 */
'use strict';

/**
 * The value after `name`, or `fallback` when the option is absent or has no value.
 *
 * @param {string[]} args
 * @param {string} name
 * @param {string | null} [fallback]
 * @returns {string | null | undefined}
 */
function option(args, name, fallback) {
  const index = args.indexOf(name);

  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

/**
 * Whether a bare flag is present.
 *
 * @param {string[]} args
 * @param {string} name
 * @returns {boolean}
 */
function hasFlag(args, name) {
  return args.includes(name);
}

/** Engines a run covers unless `--engines` narrows them. */
const DEFAULT_ENGINES = 'chromium,firefox,webkit';

/**
 * The parsed runner options.
 *
 * @param {string[]} args `process.argv.slice(2)`.
 * @returns {{ versions: boolean, jobs: string | null, out: string | null, screenshots: string | null,
 *   engines: string[] }}
 */
function parseRunnerArgs(args) {
  return {
    versions: hasFlag(args, '--versions'),
    jobs: option(args, '--jobs') || null,
    out: option(args, '--out') || null,
    screenshots: option(args, '--screenshots', null) || null,
    engines: String(option(args, '--engines', DEFAULT_ENGINES))
      .split(',')
      .filter(Boolean),
  };
}

module.exports = { option, hasFlag, parseRunnerArgs, DEFAULT_ENGINES };
