/**
 * git against the Lightning CSS clone (read-only use: fetch, rev-parse, diff, archive, grep).
 *
 * Stage: prepare and baseline mostly. Every call goes through `git -C <repoDir()>`, so the
 * command's working directory never matters and the user's own checkout is never touched.
 */
import { repoDir } from './paths.js';
import { run } from './proc.js';

/** @import { RunOptions } from './proc.js' */

/**
 * `git -C <clone> <args…>`; resolves to stdout. Throws an `LcrError` on failure unless
 * `check: false`.
 *
 * @param {readonly string[]} args
 * @param {RunOptions} [options]
 * @returns {Promise<string>}
 */
export async function git(args, options = {}) {
  const result = await run(['git', '-C', repoDir(), ...args], options);

  return result.stdout;
}
