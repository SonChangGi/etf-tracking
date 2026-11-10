import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const {verifyHtml} = require('../scripts/design-contract/verify-design.cjs');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const loader = '<script src="https://sonchanggi.github.io/quant-dashboard/shared/preferences/1.0.0/preferences.js"></script>';
test('shared preferences restore once before theme and startup', () => {
  assert.equal(html.split(loader).length - 1, 1);
  assert.ok(html.indexOf(loader) < html.indexOf('quant-research-theme'));
  assert.ok(html.indexOf(loader) < html.indexOf('/startup/1.2.0/start.js'));
  verifyHtml(html, {project:'etf-tracking'});
});
for (const [label, mutated] of [
  ['duplicate', html.replace(loader, loader + loader)],
  ['async', html.replace(loader, loader.replace('<script ', '<script async '))],
  ['defer', html.replace(loader, loader.replace('<script ', '<script defer '))],
  ['module', html.replace(loader, loader.replace('<script ', '<script type="module" '))],
  ['late', html.replace(loader, '').replace('</head>', loader + '</head>')],
  ['untrusted', html.replace(loader, loader.replace('sonchanggi.github.io', 'example.com'))]
]) test('reject preferences ' + label, () => assert.throws(() => verifyHtml(mutated, {project:'etf-tracking'}), /Design contract:/));
