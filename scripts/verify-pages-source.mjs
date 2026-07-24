import { readFile } from 'node:fs/promises';

const [source, published] = await Promise.all([
  readFile(new URL('../shared-platform/src/index.js', import.meta.url)),
  readFile(new URL('../shared-platform/dist/index.js', import.meta.url)),
]);

if (!source.equals(published)) {
  throw new Error(
    'The committed GitHub Pages compatibility runtime must be rebuilt from shared-platform/src/index.js.',
  );
}

console.log(
  `Verified committed GitHub Pages compatibility runtime (${published.byteLength} bytes).`,
);
