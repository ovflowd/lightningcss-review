/**
 * Reading and writing stage files.
 *
 * Stage: shared. Every `.json` and `.jsonl` file of a run goes through `writeJson`/`writeJsonl`
 * (Python's layout, see pyjson.js) and is read back with `readJson`/`readJsonl` (Python's number
 * rules), so a file round-trips byte for byte and diffs cleanly against py-final.
 *
 * Invariants:
 * - Stage files are written atomically: to `<path>.tmp`, then renamed. A crash or a full disk never
 *   leaves a truncated stage file or a stray `.tmp` behind; ENOSPC becomes an `LcrError` with the
 *   cleanup remedy.
 * - JSONL is streamed in both directions: result files can exceed V8's maximum string length.
 * - Missing files read as the caller's default (py-final's `read_json(path, default)`), never as
 *   an exception, because "stage not run yet" is a normal state.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { isNoSpaceError, noSpaceError } from './errors.js';
import { jsonFileText, jsonLineText, loads } from './pyjson.js';

/** Bytes per read when streaming a file. */
const READ_CHUNK_BYTES = 1 << 20;
/** Characters buffered before a write when streaming JSONL out. */
const WRITE_CHUNK_CHARS = 1 << 20;

/**
 * Write through `<path>.tmp` and rename; create the parent directory; never leave the `.tmp`.
 *
 * @param {string} path
 * @param {(tmpPath: string) => void} write
 * @returns {void}
 */
export function writeAtomic(path, write) {
  const tmp = `${path}.tmp`;

  mkdirSync(dirname(path), { recursive: true });

  try {
    write(tmp);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });

    if (isNoSpaceError(error)) {
      throw noSpaceError(path);
    }

    throw error;
  }
}

/**
 * A text file, read as UTF-8.
 *
 * @param {string} path
 * @returns {string}
 */
export function readText(path) {
  return readFileSync(path, 'utf8');
}

/** Python's universal newlines: `\r\n` and a lone `\r` read as `\n`. */
const UNIVERSAL_NEWLINE = /\r\n?/g;

/**
 * Universal newlines: `\r\n` and lone `\r` become `\n`, as Python's text mode reads files and
 * captured process output.
 *
 * @param {string} text
 * @returns {string}
 */
export function universalNewlines(text) {
  return text.replace(UNIVERSAL_NEWLINE, '\n');
}

/**
 * `Path.read_text()`: UTF-8 with a byte-order mark kept as U+FEFF, and universal newlines. Invalid
 * UTF-8 throws, as Python's strict decoder does, unless `replace` is set (`errors="replace"`, or
 * a reader that prefers U+FFFD to a crash).
 *
 * @param {string} path
 * @param {{ replace?: boolean }} [options]
 * @returns {string}
 */
export function readPyText(path, { replace = false } = {}) {
  const decoder = new TextDecoder('utf-8', { fatal: !replace, ignoreBOM: true });

  return universalNewlines(decoder.decode(readFileSync(path)));
}

/**
 * `sum(1 for _ in open(path))`: lines as Python's text mode iterates them (`\n`, `\r\n` and `\r`
 * end a line; a last line without an ending still counts). Invalid UTF-8 is replaced.
 *
 * @param {string} path
 * @returns {number}
 */
export function countPyLines(path) {
  const text = readPyText(path, { replace: true });

  if (text === '') {
    return 0;
  }

  const endings = text.split('\n').length - 1;

  return text.endsWith('\n') ? endings : endings + 1;
}

/**
 * Write a text file in place, like Python's `Path.write_text` (no atomic rename, no mkdir). Used
 * for py-final's plain outputs: report.md, diff.patch, logs.
 *
 * @param {string} path
 * @param {string} text
 * @returns {void}
 */
export function writeText(path, text) {
  try {
    writeFileSync(path, text);
  } catch (error) {
    if (isNoSpaceError(error)) {
      throw noSpaceError(path);
    }

    throw error;
  }
}

/**
 * Write a stage `.json` file atomically in Python's layout (`indent=2`, sorted keys, UTF-8,
 * trailing newline).
 *
 * @param {string} path
 * @param {unknown} value
 * @returns {void}
 */
export function writeJson(path, value) {
  const text = jsonFileText(value);

  writeAtomic(path, (tmp) => writeFileSync(tmp, text));
}

/**
 * Read a `.json` file with Python's number rules; `fallback` when it does not exist.
 *
 * @param {string} path
 * @param {unknown} [fallback] Returned when the file is missing (default null).
 * @returns {unknown} Cast it to the file's typedef: `/** @type {Prepare} *\/ (readJson(path))`.
 */
export function readJson(path, fallback) {
  if (!existsSync(path)) {
    return fallback === undefined ? null : fallback;
  }

  return loads(readFileSync(path, 'utf8'));
}

/**
 * Write rows as JSONL atomically (one compact, key-sorted row per line). Rows may be a generator;
 * they are written as they come.
 *
 * @param {string} path
 * @param {Iterable<unknown>} rows
 * @returns {number} How many rows were written.
 */
export function writeJsonl(path, rows) {
  let count = 0;

  writeAtomic(path, (tmp) => {
    const fd = openSync(tmp, 'w');

    try {
      let buffer = '';

      for (const row of rows) {
        buffer += `${jsonLineText(row)}\n`;
        count++;

        if (buffer.length >= WRITE_CHUNK_CHARS) {
          writeSync(fd, buffer);
          buffer = '';
        }
      }

      writeSync(fd, buffer);
    } finally {
      closeSync(fd);
    }
  });

  return count;
}

/**
 * Every row of a JSONL file (blank lines skipped); `[]` when the file does not exist.
 *
 * @param {string} path
 * @returns {unknown[]}
 */
export function readJsonl(path) {
  return [...iterJsonl(path)];
}

/**
 * Stream the rows of a JSONL file without holding the file in one string.
 *
 * @param {string} path
 * @yields {unknown} One parsed row per non-blank line.
 * @returns {Generator<unknown, void, void>}
 */
export function* iterJsonl(path) {
  for (const line of iterLines(path)) {
    const text = line.trim();

    if (text) {
      yield loads(text);
    }
  }
}

/**
 * Stream the lines of a UTF-8 text file (split on `\n`, line endings removed). Nothing when the
 * file does not exist.
 *
 * @param {string} path
 * @yields {string} One line, without its newline.
 * @returns {Generator<string, void, void>}
 */
export function* iterLines(path) {
  if (!existsSync(path)) {
    return;
  }

  const fd = openSync(path, 'r');
  const decoder = new StringDecoder('utf8');
  const chunk = Buffer.alloc(READ_CHUNK_BYTES);
  let rest = '';

  try {
    for (let read = readSync(fd, chunk); read > 0; read = readSync(fd, chunk)) {
      const lines = (rest + decoder.write(chunk.subarray(0, read))).split('\n');

      rest = /** @type {string} */ (lines.pop());
      yield* lines;
    }

    rest += decoder.end();

    if (rest) {
      yield rest;
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * SHA-256 of a file's bytes (hex), streamed; null when it does not exist.
 *
 * @param {string} path
 * @returns {string | null}
 */
export function fileSha256(path) {
  if (!existsSync(path)) {
    return null;
  }

  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const chunk = Buffer.alloc(READ_CHUNK_BYTES);

  try {
    for (let read = readSync(fd, chunk); read > 0; read = readSync(fd, chunk)) {
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }

  return hash.digest('hex');
}

/**
 * Delete a file or directory tree if it exists (`rm -rf`).
 *
 * @param {string} path
 * @returns {void}
 */
export function removePath(path) {
  rmSync(path, { recursive: true, force: true });
}

/**
 * Delete a file if it exists (`Path.unlink(missing_ok=True)`).
 *
 * @param {string} path
 * @returns {void}
 */
export function removeFile(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
      throw error;
    }
  }
}
