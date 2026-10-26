/**
 * The one place that starts processes: git, gh, docker compose, cargo on the host, the adapter.
 *
 * Stage: shared. Every command is an argv array (never a shell string), runs with captured output
 * and an optional timeout, and fails with an `LcrError` that names the command and carries the end
 * of its output, so a failure in any stage reads the same way.
 *
 * - `run` (async) for anything that may take a while or runs alongside other work.
 * - `runSync` for millisecond queries in otherwise synchronous code (`git rev-parse`,
 *   `docker image inspect`).
 * - `LineProcess` for long-lived line-protocol children (the JSONL adapter), disposable with
 *   `await using`.
 * - `halfTheCpus` for how many such workers (or cargo jobs) to run side by side.
 */
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { cpus, constants as osConstants } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

import { LcrError } from './errors.js';

/**
 * A failed command's error keeps this many characters of the end of its output: enough for a
 * compiler error or a stack trace, short enough for a terminal.
 */
const ERROR_DETAIL_CHARS = 4000;
/** spawnSync's buffer for captured output (git diff and docker logs can be large). */
const MAX_SYNC_BUFFER = 1 << 30;

/**
 * @typedef {object} RunOptions
 * @property {string} [cwd]
 * @property {Record<string, string | undefined>} [env] Merged over `process.env`; `undefined`
 *   removes a variable.
 * @property {string | Buffer} [input] Written to stdin, which is then closed.
 * @property {number} [timeoutMs] Kill the process (SIGKILL) after this long.
 * @property {boolean} [check] Throw an `LcrError` on a non-zero exit or timeout (default true).
 * @property {boolean} [capture] Capture stdout/stderr (default true); false inherits them.
 */

/**
 * @typedef {object} RunResult
 * @property {readonly string[]} argv
 * @property {number | null} code Exit status; null when killed by a signal.
 * @property {NodeJS.Signals | null} signal
 * @property {boolean} timedOut
 * @property {string} stdout Empty when not captured.
 * @property {string} stderr Empty when not captured.
 */

/**
 * Run a command to completion.
 *
 * @param {readonly string[]} argv
 * @param {RunOptions} [options]
 * @returns {Promise<RunResult>}
 */
export function run(argv, options = {}) {
  const { cwd, env, input, timeoutMs, check = true, capture = true } = options;
  const { promise, resolve, reject } = /** @type {PromiseWithResolvers<RunResult>} */ (
    Promise.withResolvers()
  );
  const child = spawn(argv[0], argv.slice(1), { cwd, env: mergeEnv(env), stdio: stdioFor(input, capture) });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  let timedOut = false;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;

  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
  }

  // A child that exits without reading its input closes the pipe; its exit status tells what
  // happened, so the write error itself is ignored.
  child.stdin?.on('error', () => {});
  child.stdin?.end(input);
  child.on('error', (error) => {
    clearTimeout(timer);
    reject(spawnError(argv, error));
  });
  child.on('close', (code, signal) => {
    clearTimeout(timer);

    try {
      resolve(
        checked({ argv, code, signal, timedOut, stdout: stdout(), stderr: stderr() }, { check, timeoutMs }),
      );
    } catch (error) {
      reject(error);
    }
  });

  return promise;
}

/**
 * Run a short command synchronously (same options and result as `run`).
 *
 * @param {readonly string[]} argv
 * @param {RunOptions} [options]
 * @returns {RunResult}
 */
export function runSync(argv, options = {}) {
  const { cwd, env, input, timeoutMs, check = true, capture = true } = options;
  const child = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env: mergeEnv(env),
    input,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_SYNC_BUFFER,
    encoding: 'utf8',
    stdio: stdioFor(input, capture),
  });
  const errorCode = /** @type {NodeJS.ErrnoException | undefined} */ (child.error)?.code;

  if (child.error && errorCode !== 'ETIMEDOUT') {
    throw spawnError(argv, child.error);
  }

  const result = {
    argv,
    code: child.status,
    signal: child.signal,
    timedOut: errorCode === 'ETIMEDOUT',
    stdout: child.stdout ?? '',
    stderr: child.stderr ?? '',
  };

  return checked(result, { check, timeoutMs });
}

/**
 * @param {string | Buffer | undefined} input
 * @param {boolean} capture
 * @returns {import('node:child_process').StdioOptions}
 */
function stdioFor(input, capture) {
  const output = capture ? 'pipe' : 'inherit';

  return [input === undefined ? 'ignore' : 'pipe', output, output];
}

/**
 * The result, or the `LcrError` a checked run raises for a timeout or a non-zero exit (exported
 * for wrappers that clean up a result before checking it, such as core/compose.js).
 *
 * @param {RunResult} result
 * @param {{ check: boolean, timeoutMs: number | undefined }} options
 * @returns {RunResult}
 */
export function checked(result, { check, timeoutMs }) {
  if (check && result.timedOut) {
    throw new LcrError(`command timed out after ${Number(timeoutMs) / 1000}s: ${shellJoin(result.argv)}`);
  }

  if (check && result.code !== 0) {
    throw failure(result);
  }

  return result;
}

/**
 * The error for a failed command: exit status, the command, then the end of its output.
 *
 * @param {RunResult} result
 * @returns {LcrError}
 */
function failure(result) {
  const output = (result.stderr || result.stdout || '').trim();
  const detail = Array.from(output).slice(-ERROR_DETAIL_CHARS).join('');

  return new LcrError(`command failed (${returncode(result)}): ${shellJoin(result.argv)}`, { detail });
}

/**
 * Python's `returncode`: the exit status, or minus the signal number when a signal killed the
 * process (`-9` for SIGKILL). Messages and stage files spell exit statuses this way.
 *
 * @param {{ code: number | null, signal: NodeJS.Signals | null }} result
 * @returns {number | null}
 */
export function returncode({ code, signal }) {
  if (code !== null) {
    return code;
  }

  return signal ? -osConstants.signals[signal] : null;
}

/**
 * @param {readonly string[]} argv
 * @param {Error} error
 * @returns {LcrError}
 */
function spawnError(argv, error) {
  if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
    return new LcrError(`command not found: ${argv[0]} (${error.message})`, { cause: error });
  }

  return new LcrError(`could not start ${argv[0]}: ${error.message}`, { cause: error });
}

/**
 * @param {Record<string, string | undefined> | undefined} extra
 * @returns {NodeJS.ProcessEnv}
 */
function mergeEnv(extra) {
  if (!extra) {
    return process.env;
  }

  const merged = { ...process.env };

  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

/**
 * @param {import('node:stream').Readable | null} stream
 * @returns {() => string}
 */
function collect(stream) {
  /** @type {Buffer[]} */
  const chunks = [];

  stream?.on('data', (chunk) => chunks.push(chunk));

  return () => Buffer.concat(chunks).toString('utf8');
}

/**
 * Half the CPUs, clamped to `[min, max]`: the parallelism the adapter pool and cargo use, leaving
 * the other half to the second build side and to the machine. An unknown CPU count (an empty
 * `os.cpus()`, as in some containers) gives `min`.
 *
 * @param {{ min: number, max?: number }} bounds
 * @returns {number}
 */
export function halfTheCpus({ min, max = Infinity }) {
  const count = cpus().length || 2 * min;

  return Math.min(max, Math.max(min, Math.floor(count / 2)));
}

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

/**
 * Python's `shlex.join(argv)`, used in error messages so a failed command can be pasted back.
 *
 * @param {readonly string[]} argv
 * @returns {string}
 */
export function shellJoin(argv) {
  return argv
    .map((arg) => (arg !== '' && SHELL_SAFE.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`))
    .join(' ');
}

/**
 * Python's `shutil.which(name)`: the first executable on PATH, or null.
 *
 * @param {string} name
 * @returns {string | null}
 */
export function which(name) {
  const candidates =
    isAbsolute(name) || name.includes('/')
      ? [name]
      : (process.env.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, name));

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);

      if (!statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Not here (or not executable); keep looking.
    }
  }

  return null;
}

/**
 * @typedef {object} StartOptions
 * @property {string} [cwd]
 * @property {Record<string, string | undefined>} [env] Merged over `process.env`.
 * @property {boolean} [stderr] Keep stderr (default: discarded, as the adapter's panics are noise).
 */

/**
 * Line breaks as Python's text-mode pipes read them (universal newlines): `\n`, `\r\n` and a lone
 * `\r`. Not `readline`'s set, which also breaks at U+2028 and U+2029: serde_json writes those raw
 * inside JSON strings, so a response holding one must stay one line.
 */
const LINE_BREAK = /\r\n|\r|\n/g;

/**
 * One line of a child's output: its text without the line break, and whether it had one (only
 * the last line of the output can lack it).
 *
 * @typedef {{ text: string, terminated: boolean }} OutputLine
 */

/**
 * A long-lived child that speaks a line protocol on stdin/stdout: write a request line, read the
 * answer line. Lines that arrive before anyone reads them are queued.
 */
export class LineProcess {
  /** @type {OutputLine[]} Lines nobody has read yet. */
  #pending = [];
  /** @type {((line: OutputLine | null) => void)[]} Readers waiting for the next line. */
  #waiting = [];
  /** Output not yet split into lines. */
  #buffer = '';
  #ended = false;

  /**
   * @param {readonly string[]} argv
   * @param {StartOptions} [options]
   */
  constructor(argv, { cwd, env, stderr = false } = {}) {
    this.argv = argv;
    this.child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: mergeEnv(env),
      stdio: ['pipe', 'pipe', stderr ? 'inherit' : 'ignore'],
    });
    /** False when the line `readLine` returned last was a final line without a line break. */
    this.lastLineTerminated = true;
    // 'exit', not 'close': a grandchild holding stdout open must not delay a kill. Resolves to
    // Python's returncode (minus the signal number when a signal killed it).
    /** @type {Promise<number | null>} */
    this.exited = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => resolve(returncode({ code, signal })));
    });
    this.child.on('error', () => this.#finish());
    this.child.stdin.on('error', () => {});
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (/** @type {string} */ chunk) => this.#split(chunk, false));
    this.child.stdout.on('end', () => this.#split('', true));
    this.child.stdout.on('close', () => this.#finish());
  }

  /**
   * Deliver the complete lines of the output so far; at the end of the output, the rest too.
   *
   * @param {string} chunk
   * @param {boolean} atEnd
   * @returns {void}
   */
  #split(chunk, atEnd) {
    let text = this.#buffer + chunk;

    // A trailing `\r` may be the first half of a `\r\n` split across chunks.
    const held = !atEnd && text.endsWith('\r');

    if (held) {
      text = text.slice(0, -1);
    }

    let start = 0;

    for (const match of text.matchAll(LINE_BREAK)) {
      this.#deliver({ text: text.slice(start, match.index), terminated: true });
      start = match.index + match[0].length;
    }

    this.#buffer = text.slice(start) + (held ? '\r' : '');

    if (atEnd) {
      if (this.#buffer) {
        this.#deliver({ text: this.#buffer, terminated: false });
      }

      this.#buffer = '';
      this.#finish();
    }
  }

  /**
   * Hand a line to the oldest waiting reader, or queue it.
   *
   * @param {OutputLine} line
   * @returns {void}
   */
  #deliver(line) {
    const waiter = this.#waiting.shift();

    if (waiter) {
      waiter(line);
    } else {
      this.#pending.push(line);
    }
  }

  /**
   * The output is over: every waiting reader gets null, and so does every later one.
   *
   * @returns {void}
   */
  #finish() {
    this.#ended = true;

    for (const waiter of this.#waiting.splice(0)) {
      waiter(null);
    }
  }

  /**
   * Write one line (a newline is appended). Returns false when stdin is already closed.
   *
   * @param {string} line
   * @returns {boolean}
   */
  writeLine(line) {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      return false;
    }

    this.child.stdin.write(`${line}\n`);

    return true;
  }

  /**
   * The next output line; `null` once stdout closed; `'timeout'` when none arrived in time.
   *
   * @param {number} timeoutMs
   * @returns {Promise<string | null | 'timeout'>}
   */
  async readLine(timeoutMs) {
    const line = await this.#nextLine(timeoutMs);

    if (line === null || line === 'timeout') {
      return line;
    }

    this.lastLineTerminated = line.terminated;

    return line.text;
  }

  /**
   * @param {number} timeoutMs
   * @returns {Promise<OutputLine | null | 'timeout'>}
   */
  #nextLine(timeoutMs) {
    const queued = this.#pending.shift();

    if (queued) {
      return Promise.resolve(queued);
    }

    if (this.#ended) {
      return Promise.resolve(null);
    }

    const { promise, resolve } = /** @type {PromiseWithResolvers<OutputLine | null | 'timeout'>} */ (
      Promise.withResolvers()
    );
    /** @param {OutputLine | null} line */
    const waiter = (line) => {
      clearTimeout(timer);
      resolve(line);
    };
    const timer = setTimeout(() => {
      this.#waiting = this.#waiting.filter((other) => other !== waiter);
      resolve('timeout');
    }, timeoutMs);

    this.#waiting.push(waiter);

    return promise;
  }

  /**
   * Kill the child (SIGKILL) and wait for it to exit; resolves to its Python-style returncode.
   *
   * @returns {Promise<number | null>}
   */
  async kill() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGKILL');
    }

    // Stop reading even if something else still holds the pipe; pending reads get null.
    this.child.stdout.destroy();
    this.child.stdin.destroy();
    this.#finish();

    return this.exited;
  }

  async [Symbol.asyncDispose]() {
    await this.kill();
  }
}
