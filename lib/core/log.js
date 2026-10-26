/**
 * Progress messages and command output.
 *
 * Stage: shared. Two channels, kept apart on purpose:
 * - `print` writes a command's result to stdout. Reports, tables and summaries are diffed byte for
 *   byte against py-final, so stdout carries nothing else.
 * - `log` writes progress to stderr with the `[lcr] ` prefix, unbuffered, so a long stage shows
 *   where it is even when stdout is piped.
 *
 * Invariant: colour only ever reaches a terminal. `styleText` checks the target stream (TTY,
 * NO_COLOR, FORCE_COLOR), so redirected output is plain text.
 */
import { styleText } from 'node:util';

const PREFIX = '[lcr] ';

/**
 * A progress line on stderr: `[lcr] <message>`.
 *
 * @param {string} message
 * @returns {void}
 */
export function log(message) {
  process.stderr.write(`${PREFIX}${message}\n`);
}

/**
 * `[lcr] warning: <message>` on stderr; the prefix is yellow on a terminal.
 *
 * @param {string} message
 * @returns {void}
 */
export function logWarning(message) {
  log(`${styleText('yellow', 'warning:', { stream: process.stderr })} ${message}`);
}

/**
 * `[lcr] error: <message>` on stderr; the prefix is red on a terminal.
 *
 * @param {string} message
 * @returns {void}
 */
export function logError(message) {
  log(`${styleText('red', 'error:', { stream: process.stderr })} ${message}`);
}

/**
 * One line of command output on stdout, like Python's `print(text)`.
 *
 * @param {string} [text]
 * @returns {void}
 */
export function print(text = '') {
  process.stdout.write(`${text}\n`);
}
