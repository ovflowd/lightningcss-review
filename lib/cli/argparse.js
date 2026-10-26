/**
 * The command-line parser py-final built with Python's argparse, reproduced for the features lcr
 * uses: long options (abbreviable to any unique prefix), `-h`/`--help`, store and store-true
 * options, `type=int`, `choices`, positionals with nargs `?` and `*`, and one level of
 * subcommands.
 *
 * Stage: CLI. `lcr` must accept and reject exactly what py-final accepted, with the same exit
 * statuses and the same text: help goes to stdout (exit 0), usage errors to stderr (exit 2).
 * `node:util` `parseArgs` differs in too many places to adapt (negative numbers as values, options
 * after `--`, abbreviations, which parser reports an unknown option), so this follows argparse's
 * own algorithm: classify every token as option (`O`), argument (`A`) or `--` (`-`), then match
 * each action's nargs pattern against that string.
 *
 * Help and usage text follow argparse's HelpFormatter, wrapped to the terminal width as argparse
 * computes it, without the colors Python 3.14 adds on a terminal.
 */
import { pyInt } from '../core/py-number.js';
import { PY_WHITESPACE, pyRepr } from '../core/py.js';
import { wrap } from './textwrap.js';

/**
 * How many tokens an action takes: `null` exactly one, `?` at most one, `*` any number,
 * `A...` a subcommand and everything after it, `0` none (flags).
 *
 * @typedef {null | '?' | '*' | 'A...' | 0} Nargs
 */

/**
 * @typedef {object} Action
 * @property {'help' | 'store' | 'storeTrue' | 'subcommand'} kind
 * @property {string} dest Key of the parsed value.
 * @property {string} name How errors name it: `--keep`, or a positional's name.
 * @property {readonly string[]} optionStrings Empty for a positional.
 * @property {Nargs} nargs
 * @property {string} metavar The value's placeholder in help (`KEEP`, `run`, `{auto,all,none}`).
 * @property {unknown} default
 * @property {boolean} required
 * @property {string} [help]
 * @property {'int'} [type]
 * @property {readonly string[]} [choices]
 * @property {readonly Parser[]} [subparsers] For `subcommand`: the commands, in order.
 */

/**
 * @typedef {object} Parser
 * @property {string} prog `lcr`, or `lcr <command>`.
 * @property {string} [description]
 * @property {string} [help] A subcommand's line in the parent's help.
 * @property {readonly Action[]} actions In definition order, `-h` first.
 */

/** What argparse would have printed before exiting (`--help`, or a usage error). */
export class ParseExit extends Error {
  /**
   * @param {number} status
   * @param {{ stdout?: string, stderr?: string }} output
   */
  constructor(status, { stdout = '', stderr = '' }) {
    super(stderr || 'help');
    this.status = status;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** An argparse `ArgumentError`: reported by the parser being parsed, as `<prog>: error: …`. */
class ArgumentError extends Error {
  /**
   * @param {Action | null} action
   * @param {string} message
   */
  constructor(action, message) {
    super(action ? `argument ${action.name}: ${message}` : message);
  }
}

const EXIT_USAGE = 2;
/** argparse treats tokens like `-1` and `-.5` as values, since no lcr option looks like that. */
const NEGATIVE_NUMBER = /^-\.?\p{Nd}/u;

/**
 * The `-h, --help` action every parser has.
 *
 * @returns {Action}
 */
export function helpAction() {
  return {
    kind: 'help',
    dest: 'help',
    name: '-h/--help',
    optionStrings: ['-h', '--help'],
    nargs: 0,
    metavar: 'HELP',
    default: null,
    required: false,
    help: 'show this help message and exit',
  };
}

/**
 * Parse `args` like `parser.parse_args(args)`: resolves to the parsed values (a subcommand's
 * values merged in), or throws `ParseExit` with what argparse printed.
 *
 * @param {Parser} parser
 * @param {readonly string[]} args
 * @param {number} width Help width (`helpWidth()`).
 * @returns {Record<string, unknown>}
 */
export function parseArgs(parser, args, width) {
  const { values, extras } = parseKnownArgs(parser, args, width);

  if (extras.length > 0) {
    throw usageError(parser, `unrecognized arguments: ${extras.join(' ')}`, width);
  }

  return values;
}

/**
 * `parser.parse_known_args(args)`: the values and the tokens no action took.
 *
 * @param {Parser} parser
 * @param {readonly string[]} args
 * @param {number} width
 * @returns {{ values: Record<string, unknown>, extras: string[] }}
 */
function parseKnownArgs(parser, args, width) {
  try {
    return new Scan(parser, args, width).run();
  } catch (error) {
    if (error instanceof ArgumentError) {
      throw usageError(parser, error.message, width);
    }

    throw error;
  }
}

/**
 * argparse's `error()`: the usage, then `<prog>: error: <message>`, exit status 2.
 *
 * @param {Parser} parser
 * @param {string} message
 * @param {number} width
 * @returns {ParseExit}
 */
function usageError(parser, message, width) {
  return new ParseExit(EXIT_USAGE, {
    stderr: `${formatUsage(parser, width)}${parser.prog}: error: ${message}\n`,
  });
}

/**
 * What an option token names: the action (null: unknown), the option string, and a value
 * attached to the token with `=` (`--keep=3`) or, for a short option, directly (`-hx`).
 *
 * @typedef {[action: Action | null, optionString: string, explicit: string | null, separator: '=' | '' | null]} OptionMatch
 */

/** One run of argparse's `_parse_known_args` over the tokens of one parser. */
class Scan {
  /**
   * @param {Parser} parser
   * @param {readonly string[]} args
   * @param {number} width
   */
  constructor(parser, args, width) {
    this.parser = parser;
    this.args = args;
    this.width = width;
    /** @type {Map<number, OptionMatch[]>} */
    this.options = new Map();
    this.pattern = this.classify();
    /** Positionals not matched yet, in order. */
    this.positionals = parser.actions.filter((action) => action.optionStrings.length === 0);
    /** @type {Set<Action>} */
    this.seen = new Set();
    /** @type {Record<string, unknown>} */
    this.values = Object.fromEntries(
      parser.actions
        .filter((action) => action.kind !== 'help')
        .map((action) => [action.dest, action.default]),
    );
    /** @type {string[]} */
    this.extras = [];
    /** Tokens a subcommand did not recognize; argparse reports them after the parent's own. */
    /** @type {string[]} */
    this.unrecognized = [];
  }

  /**
   * The pattern string: `O` option, `A` argument, `-` the first `--` (everything after it is `A`).
   *
   * @returns {string}
   */
  classify() {
    let pattern = '';

    for (const [index, token] of this.args.entries()) {
      if (pattern.includes('-')) {
        pattern += 'A';
      } else if (token === '--') {
        pattern += '-';
      } else {
        const match = parseOptional(this.parser, token);

        if (match) {
          this.options.set(index, match);
        }

        pattern += match ? 'O' : 'A';
      }
    }

    return pattern;
  }

  /**
   * Consume positionals and options alternately, then check the required actions.
   *
   * @returns {{ values: Record<string, unknown>, extras: string[] }}
   */
  run() {
    const lastOption = Math.max(-1, ...this.options.keys());
    let start = 0;

    while (start <= lastOption) {
      let next = start;

      while (next <= lastOption && !this.options.has(next)) {
        next++;
      }

      if (start !== next) {
        const end = this.consumePositionals(start);

        if (end > start) {
          start = end;
          continue;
        }
      }

      if (!this.options.has(start)) {
        this.extras.push(...this.args.slice(start, next));
        start = next;
      }

      start = this.consumeOptional(start);
    }

    this.extras.push(...this.args.slice(this.consumePositionals(start)));
    this.checkRequired();

    return { values: this.values, extras: [...this.extras, ...this.unrecognized] };
  }

  /**
   * @returns {void}
   */
  checkRequired() {
    const missing = this.parser.actions.filter((action) => action.required && !this.seen.has(action));

    if (missing.length > 0) {
      throw new ArgumentError(
        null,
        `the following arguments are required: ${missing.map((a) => a.name).join(', ')}`,
      );
    }
  }

  /**
   * The option token at `start` and its value; returns the index after them.
   *
   * @param {number} start
   * @returns {number}
   */
  consumeOptional(start) {
    const matches = /** @type {OptionMatch[]} */ (this.options.get(start));

    if (matches.length > 1) {
      const names = matches.map(([, optionString]) => optionString).join(', ');

      throw new ArgumentError(null, `ambiguous option: ${this.args[start]} could match ${names}`);
    }

    const [action, optionString, explicit, separator] = matches[0];

    if (!action) {
      this.extras.push(this.args[start]);

      return start + 1;
    }

    if (explicit !== null) {
      return this.consumeExplicit(start, action, explicit, optionString.startsWith('--') || separator !== '');
    }

    const count = matchArgument(action, this.pattern.slice(start + 1));

    this.takeAction(action, this.args.slice(start + 1, start + 1 + count));

    return start + 1 + count;
  }

  /**
   * An option written with its value attached: `--keep=3`, `-hx`.
   *
   * @param {number} start
   * @param {Action} action
   * @param {string} explicit
   * @param {boolean} separated The value was given with `=`, or the option is a long one.
   * @returns {number}
   */
  consumeExplicit(start, action, explicit, separated) {
    if (matchArgument(action, 'A') === 1) {
      this.takeAction(action, [explicit]);

      return start + 1;
    }

    // `-hx`: a short flag followed by more short flags. lcr has no other short option, so the
    // rest is unrecognized, and `-h` prints the help before that is reported.
    if (!separated && explicit !== '' && !explicit.startsWith('-')) {
      this.extras.push(`-${explicit}`);
      this.takeAction(action, []);

      return start + 1;
    }

    throw new ArgumentError(action, `ignored explicit argument ${pyRepr(explicit)}`);
  }

  /**
   * Give the arguments from `start` to as many remaining positionals as they satisfy; returns the
   * index after the last argument taken.
   *
   * @param {number} start
   * @returns {number}
   */
  consumePositionals(start) {
    const counts = matchPartial(this.positionals, this.pattern.slice(start));
    let index = start;

    for (const [position, count] of counts.entries()) {
      const action = this.positionals[position];
      const taken = this.args.slice(index, index + count);
      const dashes = this.pattern.slice(index, index + count).indexOf('-');

      // The first `--` separates, it is not an argument (a subcommand gets everything after it).
      if (dashes >= 0 && (action.nargs !== 'A...' || dashes === 0)) {
        taken.splice(dashes, 1);
      }

      index += count;
      this.takeAction(action, taken);
    }

    this.positionals = this.positionals.slice(counts.length);

    return index;
  }

  /**
   * Store an action's value (or print help, or parse a subcommand).
   *
   * @param {Action} action
   * @param {string[]} strings
   * @returns {void}
   */
  takeAction(action, strings) {
    this.seen.add(action);

    if (action.kind === 'help') {
      throw new ParseExit(0, { stdout: formatHelp(this.parser, this.width) });
    }

    if (action.kind === 'storeTrue') {
      this.values[action.dest] = true;
    } else if (action.kind === 'subcommand') {
      this.takeSubcommand(action, strings);
    } else {
      this.values[action.dest] = argumentValues(action, strings);
    }
  }

  /**
   * @param {Action} action
   * @param {string[]} strings The command name, then its arguments.
   * @returns {void}
   */
  takeSubcommand(action, strings) {
    const [name, ...rest] = strings;

    checkChoice(action, name);

    const subparser = /** @type {Parser} */ (
      action.subparsers?.find((parser) => commandName(parser) === name)
    );
    const { values, extras } = parseKnownArgs(subparser, rest, this.width);

    this.values[action.dest] = name;
    Object.assign(this.values, values);
    this.unrecognized.push(...extras);
  }
}

/**
 * What a token names, if it looks like an option (`_parse_optional`); null for an argument.
 *
 * @param {Parser} parser
 * @param {string} token
 * @returns {OptionMatch[] | null}
 */
function parseOptional(parser, token) {
  if (!token.startsWith('-')) {
    return null;
  }

  const exact = findOption(parser, token);

  if (exact) {
    return [[exact, token, null, null]];
  }

  if (token.length === 1) {
    return null;
  }

  const separator = token.indexOf('=');

  if (separator >= 0) {
    const option = findOption(parser, token.slice(0, separator));

    if (option) {
      return [[option, token.slice(0, separator), token.slice(separator + 1), '=']];
    }
  }

  const prefixed = optionsByPrefix(parser, token);

  if (prefixed.length > 0) {
    return prefixed;
  }

  if (NEGATIVE_NUMBER.test(token) || token.includes(' ')) {
    return null;
  }

  return [[null, token, null, null]];
}

/**
 * The options an abbreviated token can mean (`_get_option_tuples`).
 *
 * @param {Parser} parser
 * @param {string} token
 * @returns {OptionMatch[]}
 */
function optionsByPrefix(parser, token) {
  const separator = token.indexOf('=');
  const prefix = separator >= 0 ? token.slice(0, separator) : token;
  const explicit = separator >= 0 ? token.slice(separator + 1) : null;
  const attached = separator >= 0 ? '=' : null;
  /** @type {OptionMatch[]} */
  const matches = [];

  for (const action of parser.actions) {
    for (const optionString of action.optionStrings) {
      if (!token.startsWith('--') && optionString === token.slice(0, 2)) {
        // A short option with its value attached (`-hx`).
        matches.push([action, optionString, token.slice(2), '']);
      } else if (optionString.startsWith(prefix)) {
        matches.push([action, optionString, explicit, attached]);
      }
    }
  }

  return matches;
}

/**
 * @param {Parser} parser
 * @param {string} optionString
 * @returns {Action | undefined}
 */
function findOption(parser, optionString) {
  return parser.actions.find((action) => action.optionStrings.includes(optionString));
}

/**
 * The regex for how many tokens an action takes (`_get_nargs_pattern`); a group per action.
 *
 * @param {Action} action
 * @returns {string}
 */
function nargsPattern(action) {
  const optional = action.optionStrings.length > 0;

  switch (action.nargs) {
    case null:
      return optional ? '(A)' : '(-*A-*)';
    case '?':
      return optional ? '(A?)' : '(-*A?-*)';
    case '*':
      return optional ? '(A*)' : '(-*[A-]*)';
    case 'A...':
      return optional ? '(A[AO]*)' : '(-*A[-AO]*)';
    default:
      return optional ? '()' : '(-*)';
  }
}

/**
 * How many of the following tokens an option takes (`_match_argument`).
 *
 * @param {Action} action
 * @param {string} pattern
 * @returns {number}
 */
function matchArgument(action, pattern) {
  const match = new RegExp(`^${nargsPattern(action)}`).exec(pattern);

  if (!match) {
    // Only an option that takes a value can miss it: lcr's options take one value or none.
    throw new ArgumentError(action, 'expected one argument');
  }

  return match[1].length;
}

/**
 * How many tokens each of the leading positionals takes, for as many positionals as the tokens
 * satisfy (`_match_arguments_partial`).
 *
 * @param {readonly Action[]} positionals
 * @param {string} pattern
 * @returns {number[]}
 */
function matchPartial(positionals, pattern) {
  for (let count = positionals.length; count > 0; count--) {
    const regex = new RegExp(`^${positionals.slice(0, count).map(nargsPattern).join('')}`);
    const match = regex.exec(pattern);

    if (match) {
      const counts = match.slice(1).map((group) => group.length);

      // Before an option, positionals that matched nothing stay for later tokens.
      if (pattern[match[0].length] === 'O') {
        while (counts.length > 0 && counts.at(-1) === 0) {
          counts.pop();
        }
      }

      return counts;
    }
  }

  return [];
}

/**
 * The stored value for the tokens an action took (`_get_values`).
 *
 * @param {Action} action
 * @param {string[]} strings
 * @returns {unknown}
 */
function argumentValues(action, strings) {
  if (strings.length === 0 && action.nargs === '?') {
    return action.default;
  }

  if (strings.length === 0 && action.nargs === '*') {
    return action.default ?? [];
  }

  if (strings.length === 1 && (action.nargs === null || action.nargs === '?')) {
    return convert(action, strings[0]);
  }

  return strings.map((text) => convert(action, text));
}

/**
 * A token as the action's type, checked against its choices.
 *
 * @param {Action} action
 * @param {string} text
 * @returns {unknown}
 */
function convert(action, text) {
  if (action.type === 'int') {
    const value = pyInt(text);

    if (value === null) {
      throw new ArgumentError(action, `invalid int value: ${pyRepr(text)}`);
    }

    return value;
  }

  checkChoice(action, text);

  return text;
}

/**
 * @param {Action} action
 * @param {string} value
 * @returns {void}
 */
function checkChoice(action, value) {
  if (action.choices && !action.choices.includes(value)) {
    const choices = action.choices.map((choice) => pyRepr(choice)).join(', ');

    throw new ArgumentError(action, `invalid choice: ${pyRepr(value)} (choose from ${choices})`);
  }
}

/**
 * @param {Parser} parser
 * @returns {string}
 */
function commandName(parser) {
  return parser.prog.slice(parser.prog.lastIndexOf(' ') + 1);
}

// ---------------------------------------------------------------------------------------------
// Help text (argparse's HelpFormatter)

/** argparse's defaults: help starts at most this far in, sections indent by two. */
const MAX_HELP_POSITION = 24;
const INDENT_STEP = 2;
const MIN_TEXT_WIDTH = 11;
/** The usage line keeps the program name and options together while they take this share. */
const USAGE_PROG_SHARE = 0.75;
/** Python's fallback terminal width when stdout is not a terminal and COLUMNS is unset. */
const FALLBACK_COLUMNS = 80;
const SPACES = new RegExp(`[${RegExp.escape(PY_WHITESPACE)}]+`, 'gu');

/**
 * The width argparse formats help for: `shutil.get_terminal_size().columns - 2`.
 *
 * @param {{ columns?: string, terminalColumns?: number }} [environment] COLUMNS and stdout's
 *   terminal width (default: this process's).
 * @returns {number}
 */
export function helpWidth({
  columns = process.env.COLUMNS,
  terminalColumns = process.stdout.isTTY ? process.stdout.columns : 0,
} = {}) {
  const fromEnvironment = pyInt(columns ?? '') ?? 0;
  const resolved = fromEnvironment > 0 ? fromEnvironment : terminalColumns || FALLBACK_COLUMNS;

  return resolved - INDENT_STEP;
}

/**
 * `usage: …` (wrapped) and a blank line, as `parser.format_usage()` prints it before an error.
 *
 * @param {Parser} parser
 * @param {number} width
 * @returns {string}
 */
export function formatUsage(parser, width) {
  return `usage: ${usageText(parser, width)}\n`;
}

/**
 * The whole `-h` text (`parser.format_help()`).
 *
 * @param {Parser} parser
 * @param {number} width
 * @returns {string}
 */
export function formatHelp(parser, width) {
  const positionals = parser.actions.filter((action) => action.optionStrings.length === 0);
  const optionals = parser.actions.filter((action) => action.optionStrings.length > 0);
  const layout = helpLayout(parser.actions, width);
  const parts = [`usage: ${usageText(parser, width)}\n\n`];

  if (parser.description) {
    parts.push(`${wrap(collapse(parser.description), Math.max(width, MIN_TEXT_WIDTH)).join('\n')}\n\n`);
  }

  for (const [heading, actions] of /** @type {const} */ ([
    ['positional arguments', positionals],
    ['options', optionals],
  ])) {
    if (actions.length > 0) {
      parts.push(
        `\n${heading}:\n`,
        ...actions.map((action) => formatAction(action, layout, INDENT_STEP)),
        '\n',
      );
    }
  }

  return `${parts
    .join('')
    .replace(/\n\n\n+/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')}\n`;
}

/**
 * The usage text after `usage: `, wrapped like `_format_usage`: options after the program name,
 * positionals on lines of their own once it does not fit.
 *
 * @param {Parser} parser
 * @param {number} width
 * @returns {string}
 */
function usageText(parser, width) {
  const optionParts = parser.actions.filter((action) => action.optionStrings.length > 0).map(usagePart);
  const positionalParts = parser.actions.filter((action) => action.optionStrings.length === 0).map(usagePart);
  const prefix = 'usage: ';
  const full = [parser.prog, ...optionParts, ...positionalParts].join(' ');

  if (prefix.length + full.length <= width) {
    return full;
  }

  if (prefix.length + parser.prog.length <= USAGE_PROG_SHARE * width) {
    const indent = ' '.repeat(prefix.length + parser.prog.length + 1);
    const lines =
      optionParts.length > 0
        ? [
            ...usageLines([parser.prog, ...optionParts], indent, width, prefix),
            ...usageLines(positionalParts, indent, width),
          ]
        : usageLines([parser.prog, ...positionalParts], indent, width, prefix);

    return lines.join('\n');
  }

  const indent = ' '.repeat(prefix.length);
  let lines = usageLines([...optionParts, ...positionalParts], indent, width);

  if (lines.length > 1) {
    lines = [...usageLines(optionParts, indent, width), ...usageLines(positionalParts, indent, width)];
  }

  return [parser.prog, ...lines].join('\n');
}

/**
 * Lay usage parts out on lines of `width` (`get_lines`); the first line follows `prefix` when
 * given, the others start with `indent`.
 *
 * @param {readonly string[]} parts
 * @param {string} indent
 * @param {number} width
 * @param {string} [prefix]
 * @returns {string[]}
 */
function usageLines(parts, indent, width, prefix) {
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  let line = [];
  let length = (prefix ?? indent).length - 1;

  for (const part of parts) {
    if (length + 1 + part.length > width && line.length > 0) {
      lines.push(indent + line.join(' '));
      line = [];
      length = indent.length - 1;
    }

    line.push(part);
    length += part.length + 1;
  }

  if (line.length > 0) {
    lines.push(indent + line.join(' '));
  }

  if (prefix !== undefined && lines.length > 0) {
    lines[0] = lines[0].slice(indent.length);
  }

  return lines;
}

/**
 * One action in the usage line: `[-h]`, `[--keep KEEP]`, `run`, `[run]`, `[paths ...]`.
 *
 * @param {Action} action
 * @returns {string}
 */
function usagePart(action) {
  if (action.optionStrings.length === 0) {
    return formatArgs(action);
  }

  const option = action.optionStrings[0];
  const part = action.nargs === 0 ? option : `${option} ${formatArgs(action)}`;

  return action.required ? part : `[${part}]`;
}

/**
 * An action's value placeholder for its nargs (`_format_args`).
 *
 * @param {Action} action
 * @returns {string}
 */
function formatArgs(action) {
  switch (action.nargs) {
    case '?':
      return `[${action.metavar}]`;
    case '*':
      return `[${action.metavar} ...]`;
    case 'A...':
      return `${action.metavar} ...`;
    default:
      return action.metavar;
  }
}

/**
 * An action's first column in help: `-h, --help`, `--keep KEEP`, `run`.
 *
 * @param {Action} action
 * @returns {string}
 */
function invocation(action) {
  if (action.optionStrings.length === 0) {
    return action.metavar;
  }

  const options = action.optionStrings.join(', ');

  return action.nargs === 0 ? options : `${options} ${formatArgs(action)}`;
}

/**
 * @typedef {object} HelpLayout
 * @property {number} helpPosition The column help text starts at.
 * @property {number} helpWidth
 */

/**
 * Where help text starts: two columns after the longest invocation (subcommands count with their
 * deeper indent), at most `MAX_HELP_POSITION`.
 *
 * @param {readonly Action[]} actions
 * @param {number} width
 * @returns {HelpLayout}
 */
function helpLayout(actions, width) {
  const maxHelpPosition = Math.min(MAX_HELP_POSITION, Math.max(width - 20, INDENT_STEP * 2));
  const lengths = actions.flatMap((action) => [
    invocation(action).length + INDENT_STEP,
    ...subcommandEntries(action).map((entry) => entry.metavar.length + 2 * INDENT_STEP),
  ]);
  const helpPosition = Math.min(Math.max(0, ...lengths) + 2, maxHelpPosition);

  return { helpPosition, helpWidth: Math.max(width - helpPosition, MIN_TEXT_WIDTH) };
}

/**
 * The subcommand lines under a subcommand action (one per command with a help text).
 *
 * @param {Action} action
 * @returns {Action[]}
 */
function subcommandEntries(action) {
  return (action.subparsers ?? [])
    .filter((parser) => parser.help !== undefined)
    .map((parser) => ({
      kind: 'store',
      dest: commandName(parser),
      name: commandName(parser),
      optionStrings: [],
      nargs: null,
      metavar: commandName(parser),
      default: null,
      required: false,
      help: parser.help,
    }));
}

/**
 * One action's help entry (`_format_action`): the invocation, its help text wrapped at the help
 * column, then any subcommand entries one level deeper.
 *
 * @param {Action} action
 * @param {HelpLayout} layout
 * @param {number} indent
 * @returns {string}
 */
function formatAction(action, layout, indent) {
  const header = invocation(action);
  const actionWidth = layout.helpPosition - indent - 2;
  const lines = action.help ? wrap(collapse(action.help), layout.helpWidth) : [];
  let text;

  if (!action.help) {
    text = `${' '.repeat(indent)}${header}\n`;
  } else if (header.length <= actionWidth) {
    text = `${' '.repeat(indent)}${header.padEnd(actionWidth)}  ${lines[0] ?? ''}\n`;
  } else {
    text = `${' '.repeat(indent)}${header}\n${' '.repeat(layout.helpPosition)}${lines[0] ?? ''}\n`;
  }

  for (const line of lines.slice(1)) {
    text += `${' '.repeat(layout.helpPosition)}${line}\n`;
  }

  for (const entry of subcommandEntries(action)) {
    text += formatAction(entry, layout, indent + INDENT_STEP);
  }

  return text;
}

/**
 * argparse's whitespace cleanup before wrapping: runs become one space, ends are stripped.
 *
 * @param {string} text
 * @returns {string}
 */
function collapse(text) {
  return text.replace(SPACES, ' ').trim();
}
