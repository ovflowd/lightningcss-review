/**
 * `lcr`: parse the command line, run the command, map failures to exit statuses.
 *
 * Stage: CLI entry (bin/lcr). Exit statuses are part of the CLI contract (see commands.js), so
 * scripts can rely on them: 0 on success (or what the command
 * returns: `doctor`, `selftest`, `validate-probes` and `clean` return their own), 2 for a usage
 * error or an `LcrError` (printed as `[lcr] error: …`), 2 for a full disk, 130 on Ctrl-C. Any other
 * exception is a bug and keeps its stack trace.
 *
 * The command line is parsed with argparse's rules (argparse.js), from the command table in
 * commands.js, so abbreviations, errors and the `-h` text stay what scripts and SKILL.md expect.
 */
import { DISK_REMEDY, isNoSpaceError, LcrError } from '../core/errors.js';
import { logError } from '../core/log.js';
import { helpAction, helpWidth, ParseExit, parseArgs } from './argparse.js';
import { COMMANDS, findCommand } from './commands.js';

/** @import { Action, Parser } from './argparse.js' */
/** @import { CommandArgs, CommandSpec, OptionSpec, PositionalSpec } from './commands.js' */

const PROGRAM = 'lcr';
/** The description `lcr -h` prints under the usage line. */
const DESCRIPTION = 'lcr: deterministic review harness for parcel-bundler/lightningcss pull requests.';
const EXIT_ERROR = 2;

/**
 * Run `lcr` with these arguments (without the program name); resolves to the exit status.
 *
 * @param {readonly string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const parsed = parseCommandLine(argv);

  if (parsed instanceof ParseExit) {
    process.stdout.write(parsed.stdout);
    process.stderr.write(parsed.stderr);

    return parsed.status;
  }

  try {
    return (await parsed.command.run(parsed.args)) ?? 0;
  } catch (error) {
    return handleFailure(error);
  }
}

/**
 * The exit status of an expected failure, after printing it; anything else is a bug and rethrown.
 *
 * @param {unknown} error
 * @returns {number}
 */
function handleFailure(error) {
  if (error instanceof LcrError) {
    logError(error.message);

    return EXIT_ERROR;
  }

  if (isNoSpaceError(error)) {
    const path = /** @type {NodeJS.ErrnoException} */ (error).path ?? 'cache';

    logError(`no space left on device (${path}); ${DISK_REMEDY}`);

    return EXIT_ERROR;
  }

  throw error;
}

/**
 * The command and its arguments, or what argparse would have printed and exited with.
 *
 * @param {readonly string[]} argv
 * @param {number} [width] Help width (default: from COLUMNS or the terminal, as argparse).
 * @returns {{ command: CommandSpec, args: CommandArgs } | ParseExit}
 */
export function parseCommandLine(argv, width = helpWidth()) {
  try {
    const values = parseArgs(programParser(), argv, width);
    const command = /** @type {CommandSpec} */ (findCommand(/** @type {string} */ (values.command)));

    return { command, args: /** @type {CommandArgs} */ (values) };
  } catch (error) {
    if (error instanceof ParseExit) {
      return error;
    }

    throw error;
  }
}

/**
 * The `lcr` parser: `-h` and the required subcommand.
 *
 * @returns {Parser}
 */
function programParser() {
  const subparsers = COMMANDS.map((command) => commandParser(command));

  return {
    prog: PROGRAM,
    description: DESCRIPTION,
    actions: [
      helpAction(),
      {
        kind: 'subcommand',
        dest: 'command',
        name: 'command',
        optionStrings: [],
        nargs: 'A...',
        metavar: `{${COMMANDS.map((command) => command.name).join(',')}}`,
        default: null,
        required: true,
        choices: COMMANDS.map((command) => command.name),
        subparsers,
      },
    ],
  };
}

/**
 * One command's subparser, built from its entry in the command table.
 *
 * @param {CommandSpec} command
 * @returns {Parser}
 */
function commandParser(command) {
  return {
    prog: `${PROGRAM} ${command.name}`,
    help: command.help,
    actions: [
      helpAction(),
      ...Object.entries(command.options).map(([flag, spec]) => optionAction(flag, spec)),
      ...command.positionals.map((spec) => positionalAction(spec)),
    ],
  };
}

/**
 * @param {string} flag
 * @param {OptionSpec} spec
 * @returns {Action}
 */
function optionAction(flag, spec) {
  const dest = spec.dest ?? camelCase(flag);

  return {
    kind: spec.type === 'boolean' ? 'storeTrue' : 'store',
    dest,
    name: `--${flag}`,
    optionStrings: [`--${flag}`],
    nargs: spec.type === 'boolean' ? 0 : null,
    // argparse's default metavar is the dest in upper case (`--max-cases` -> MAX_CASES).
    metavar: spec.metavar ?? choicesMetavar(spec.choices) ?? snakeCase(dest).toUpperCase(),
    default: spec.default ?? (spec.type === 'boolean' ? false : null),
    required: false,
    help: spec.help,
    type: spec.parse,
    choices: spec.choices,
  };
}

/**
 * @param {PositionalSpec} spec
 * @returns {Action}
 */
function positionalAction(spec) {
  /** @type {Record<PositionalSpec['arity'], Action['nargs']>} */
  const nargs = { required: null, optional: '?', variadic: '*' };

  return {
    kind: 'store',
    dest: spec.name,
    name: spec.name,
    optionStrings: [],
    nargs: nargs[spec.arity],
    metavar: spec.name,
    default: null,
    required: spec.arity === 'required',
    help: spec.help,
    type: spec.parse,
  };
}

/**
 * `{auto,all,none}`: how argparse shows an option with choices.
 *
 * @param {readonly string[]} [choices]
 * @returns {string | undefined}
 */
function choicesMetavar(choices) {
  return choices ? `{${choices.join(',')}}` : undefined;
}

/**
 * @param {string} flag
 * @returns {string}
 */
function camelCase(flag) {
  return flag.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

/**
 * `maxCases` -> `max_cases`: the dest name argparse derives the metavar from, so `-h` keeps
 * printing `MAX_CASES`.
 *
 * @param {string} name
 * @returns {string}
 */
function snakeCase(name) {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
