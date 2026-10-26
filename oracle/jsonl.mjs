// Line-by-line JSONL I/O. Result files can exceed V8's maximum string length, so they are never
// read into one string. A `.gz` suffix selects gzip on both read and write.
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';

export async function* readJsonl(file) {
  if (!file || !fs.existsSync(file)) return;
  let input = fs.createReadStream(file);
  if (file.endsWith('.gz')) input = input.pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield JSON.parse(line);
}

export async function readAll(file) {
  const out = [];
  for await (const record of readJsonl(file)) out.push(record);
  return out;
}

export function jsonlWriter(file) {
  const stream = fs.createWriteStream(file);
  const sink = file.endsWith('.gz') ? zlib.createGzip() : null;
  if (sink) sink.pipe(stream);
  const target = sink || stream;
  return {
    write: (record) => target.write(JSON.stringify(record) + '\n'),
    end: () => new Promise((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
      target.end();
    }),
  };
}
