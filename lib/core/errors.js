/**
 * The one error type for expected failures.
 *
 * Stage: shared by every stage. A missing stage file, a Docker daemon that is not running, a bad
 * target string, a full disk: all of these are things a user can fix, so they surface as an
 * `LcrError` with a message and, when there is one, the remedy. `bin/lcr` prints
 * `[lcr] error: <message>` (plus `; <remedy>` and an indented detail block) and exits with status 2.
 * Anything else that escapes a command is a bug and keeps its stack trace.
 *
 * Invariant: the rendered text (`String(error.message)`) is what py-final printed for the same
 * failure, so messages keep their wording when they are ported.
 */

/** What the user can do about a full disk; appended to every out-of-space error. */
export const DISK_REMEDY =
  'free space with `lcr clean --results` (oracle raw results), `lcr clean <run>` (build trees) or ' +
  '`lcr clean --keep 3` (old runs), or set LCR_CACHE to a larger disk';

/**
 * @typedef {object} LcrErrorOptions
 * @property {string} [remedy] What the user can do about it, rendered after `; `.
 * @property {string} [detail] Captured output (a command's stderr tail), rendered on the next line.
 * @property {unknown} [cause] The underlying error, kept for debugging.
 */

/** A user-facing failure: a message, an optional remedy and optional detail lines. */
export class LcrError extends Error {
  /**
   * @param {string} summary What went wrong, in one line.
   * @param {LcrErrorOptions} [options]
   */
  constructor(summary, { remedy, detail, cause } = {}) {
    super(renderMessage(summary, remedy, detail), cause === undefined ? undefined : { cause });
    this.name = 'LcrError';
    this.summary = summary;
    this.remedy = remedy;
    this.detail = detail;
  }
}

/**
 * @param {string} summary
 * @param {string | undefined} remedy
 * @param {string | undefined} detail
 * @returns {string}
 */
function renderMessage(summary, remedy, detail) {
  const head = remedy ? `${summary}; ${remedy}` : summary;

  return detail === undefined ? head : `${head}\n${detail}`;
}

/**
 * True for a Node.js error caused by a full disk.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isNoSpaceError(error) {
  return error instanceof Error && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOSPC';
}

/**
 * The error a write raises when the disk is full, in py-final's wording.
 *
 * @param {string} path The file that could not be written.
 * @returns {LcrError}
 */
export function noSpaceError(path) {
  return new LcrError(`no space left writing ${path}`, { remedy: DISK_REMEDY });
}
