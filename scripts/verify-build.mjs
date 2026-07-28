import { createHash } from 'node:crypto';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const required = [
  'dist/index.html',
  'dist/assets/app.js',
  'dist/assets/styles.css',
  'dist/assets/shared-nav.css',
  'dist/shared-platform/dist/index.js',
  'dist/data/dashboard.json',
  'dist/data/status.json',
  'dist/data/history.json',
  'dist/data/automation-status.json',
  'dist/data/summary.json',
];
await Promise.all(required.map((path) => access(resolve(root, path))));

const html = await readFile(resolve(root, 'dist/index.html'), 'utf8');
const platformIndex = html.indexOf('shared-platform/dist/index.js');
const appIndex = html.indexOf('assets/app.js');
if (platformIndex < 0 || appIndex < 0 || platformIndex > appIndex) {
  throw new Error('Pinned shared-platform runtime must load before assets/app.js.');
}
if (/https?:\/\/[^"']+\.(?:js|css)(?:[?"'])/i.test(html)) {
  throw new Error('Built ETF HTML unexpectedly depends on a remote JS/CSS asset.');
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const repositoryPlatform = await readFile(resolve(root, 'shared-platform/dist/index.js'));
const builtPlatform = await readFile(resolve(root, 'dist/shared-platform/dist/index.js'));
if (digest(repositoryPlatform) !== digest(builtPlatform)) {
  throw new Error('Built shared-platform runtime is not byte-identical.');
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else files.push(path);
  }
  return files;
}

const repositoryDataRoot = resolve(root, 'data');
const repositoryJson = (await filesUnder(repositoryDataRoot))
  .filter((path) => path.endsWith('.json'))
  .sort();
if (!repositoryJson.length) throw new Error('Repository data JSON files are missing.');

let totalJsonBytes = 0;
for (const repositoryPath of repositoryJson) {
  const relativePath = relative(root, repositoryPath);
  const builtPath = resolve(root, 'dist', relativePath);
  const [repositoryBytes, builtBytes, metadata] = await Promise.all([
    readFile(repositoryPath),
    readFile(builtPath),
    stat(repositoryPath),
  ]);
  totalJsonBytes += metadata.size;
  if (digest(repositoryBytes) !== digest(builtBytes)) {
    throw new Error(`Built JSON is not byte-identical: ${relativePath}`);
  }
}

const applicationBytes =
  (await stat(resolve(root, 'dist/assets/app.js'))).size +
  (await stat(resolve(root, 'dist/shared-platform/dist/index.js'))).size;
if (applicationBytes >= 1_000_000) {
  throw new Error(`Client JavaScript is unexpectedly large: ${applicationBytes} bytes.`);
}
if (totalJsonBytes <= applicationBytes) {
  throw new Error('Large ETF data should remain external static JSON, not a client bundle.');
}

console.log(
  `Verified ${repositoryJson.length} byte-identical JSON files (${totalJsonBytes} bytes) and a ${applicationBytes}-byte local-only client runtime.`,
);
