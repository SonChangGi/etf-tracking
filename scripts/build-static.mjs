import { cp, copyFile, mkdir, rm } from 'node:fs/promises';

const output = new URL('../dist/', import.meta.url);
await rm(output, { force: true, recursive: true });
await mkdir(new URL('../dist/assets/', import.meta.url), { recursive: true });
await mkdir(new URL('../dist/shared-platform/dist/', import.meta.url), {
  recursive: true,
});

await Promise.all([
  copyFile(new URL('../index.html', import.meta.url), new URL('../dist/index.html', import.meta.url)),
  copyFile(new URL('../.nojekyll', import.meta.url), new URL('../dist/.nojekyll', import.meta.url)),
  cp(new URL('../assets/', import.meta.url), new URL('../dist/assets/', import.meta.url), {
    recursive: true,
  }),
  copyFile(
    new URL('../shared-platform/dist/index.js', import.meta.url),
    new URL('../dist/shared-platform/dist/index.js', import.meta.url),
  ),
  cp(new URL('../data/', import.meta.url), new URL('../dist/data/', import.meta.url), {
    recursive: true,
  }),
]);

console.log('Built the independently deployable ETF static site in dist/.');
