import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(
  await readFile(new URL('../platform-snapshot.json', import.meta.url), 'utf8'),
);

if (
  manifest.schemaVersion !== 1 ||
  manifest.sharedVersion !== 'quant-platform-frontend/0.1.0'
) {
  throw new Error('Unsupported shared platform snapshot manifest.');
}

const entries = Object.entries(manifest.files).sort(([left], [right]) =>
  left.localeCompare(right),
);
const fingerprintLines = [];

for (const [path, expected] of entries) {
  const bytes = await readFile(new URL(`../${path}`, import.meta.url));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `Shared platform snapshot drift: ${path} expected ${expected}, received ${actual}`,
    );
  }
  fingerprintLines.push(`${actual}  ${path}`);
}

const aggregate = createHash('sha256')
  .update(`${fingerprintLines.join('\n')}\n`)
  .digest('hex');
if (aggregate !== manifest.aggregateFingerprint) {
  throw new Error(
    `Shared platform aggregate drift: expected ${manifest.aggregateFingerprint}, received ${aggregate}`,
  );
}

const [source, output] = await Promise.all([
  readFile(new URL('../src/index.js', import.meta.url)),
  readFile(new URL('../dist/index.js', import.meta.url)),
]);
if (!source.equals(output)) {
  throw new Error('Shared platform dist/index.js drifted from src/index.js.');
}

console.log(
  `Verified ${entries.length} pinned platform files (${manifest.sharedVersion}, ${aggregate.slice(0, 12)}).`,
);
