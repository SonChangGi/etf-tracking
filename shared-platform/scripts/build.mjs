import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const sourceUrl = new URL('../src/index.js', import.meta.url);
const outputUrl = new URL('../dist/index.js', import.meta.url);
const source = await readFile(sourceUrl);

new Function(source.toString('utf8'));
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await writeFile(outputUrl, source);

const output = await readFile(outputUrl);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (digest(source) !== digest(output)) {
  throw new Error('Shared platform browser build is not byte-identical to its pinned source.');
}

console.log(`Built shared-platform/dist/index.js (${digest(output).slice(0, 12)}).`);
