/**
 * Streaming JSONL files, optionally gzip-compressed.
 *
 * Stage: oracle (engine runner and, through oracle/lib/jsonl.mjs, the analysis scripts). Result
 * files can exceed V8's maximum string length, so they are never read or written as one string;
 * a `.gz` suffix selects gzip in both directions. Rows are written with JSON.stringify: these
 * files were always JavaScript-written, and the host reads them back with its JSON parser.
 */
'use strict';

const fs = require('fs');
const readline = require('readline');
const zlib = require('zlib');

/**
 * A readable stream of the file's text, decompressed when it ends in `.gz`.
 *
 * @param {string} file
 * @returns {NodeJS.ReadableStream}
 */
function openInput(file) {
  const stream = fs.createReadStream(file);

  return file.endsWith('.gz') ? stream.pipe(zlib.createGunzip()) : stream;
}

/**
 * The parsed non-blank lines of a JSONL file, one at a time.
 *
 * @param {string} file
 * @returns {AsyncGenerator<unknown>}
 * @yields {unknown}
 */
async function* readRows(file) {
  const lines = readline.createInterface({ input: openInput(file), crlfDelay: Infinity });

  for await (const line of lines) {
    if (line.trim()) {
      yield JSON.parse(line);
    }
  }
}

/**
 * @typedef {object} RowWriter
 * @property {(row: unknown) => void} write Append one row.
 * @property {() => Promise<void>} end Flush and close; resolves once the file is complete.
 */

/**
 * A JSONL writer; `.gz` files are compressed.
 *
 * @param {string} file
 * @returns {RowWriter}
 */
function openRowWriter(file) {
  const stream = fs.createWriteStream(file);
  const gzip = file.endsWith('.gz') ? zlib.createGzip() : null;

  if (gzip) {
    gzip.pipe(stream);
  }

  /** @type {NodeJS.WritableStream} */
  const target = gzip || stream;

  return {
    write: (row) => {
      target.write(JSON.stringify(row) + '\n');
    },
    end: () =>
      new Promise((resolve, reject) => {
        stream.on('finish', () => resolve());
        stream.on('error', reject);
        target.end();
      }),
  };
}

module.exports = { openInput, readRows, openRowWriter };
