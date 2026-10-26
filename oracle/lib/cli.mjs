/**
 * Command-line options of the analysis scripts (prepare-jobs.mjs, compare.mjs).
 *
 * Stage: oracle (analysis image). `lcr oracle` always calls these scripts with the same fixed
 * flags. A malformed invocation (unknown option, option without its value, stray argument) is a
 * usage error: the usage goes to stderr and the script exits with status 2, like spec-cards.mjs
 * and the engine runner, instead of running with options it silently misread.
 */
import { parseArgs } from 'node:util';

/** @import { ParseArgsOptionsConfig } from 'node:util' */

/** Exit status of a usage error (the driver reports the script's stderr). */
export const USAGE_EXIT = 2;

/**
 * Print a parse error and the usage, and exit.
 *
 * @param {Error} error
 * @param {string} usage
 * @returns {never}
 */
function usageError(error, usage) {
  process.stderr.write(`${error.message}\n${usage}\n`);
  process.exit(USAGE_EXIT);
}

/**
 * Parse `process.argv` (or `args`), exiting with the usage on a malformed command line.
 *
 * @template {ParseArgsOptionsConfig} T
 * @param {T} options
 * @param {string} usage
 * @param {string[]} [args]
 * @returns {ReturnType<typeof parseArgs<{ options: T }>>['values']}
 */
export function parseOptions(options, usage, args = process.argv.slice(2)) {
  try {
    return parseArgs({ args, options }).values;
  } catch (error) {
    // node:util marks every command-line problem with an ERR_PARSE_ARGS_* code.
    if (!/^ERR_PARSE_ARGS_/.test(String(/** @type {{ code?: unknown }} */ (error).code))) {
      throw error;
    }

    return usageError(/** @type {Error} */ (error), usage);
  }
}
