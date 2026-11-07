/* Same contract as verify_design.py; no build-time network or dependencies. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const CONTRACT = JSON.parse(fs.readFileSync(path.join(__dirname, 'contract.json'), 'utf8'));
function parse(html) {
  html = html.replace(/<!--[\s\S]*?-->/g, "");
  const tags = []; let inHead = false;
  const pattern = /<head\b[^>]*>|<\/head\s*>|<script\b([^>]*)>[\s\S]*?<\/script\s*>|<link\b([^>]*)\/?\s*>/gi;
  for (const match of html.matchAll(pattern)) {
    if (/^<head\b/i.test(match[0])) { inHead = true; continue; }
    if (/^<\/head/i.test(match[0])) { inHead = false; continue; }
    const tag = match[1] !== undefined ? 'script' : 'link', attrs = {};
    for (const a of (match[1] ?? match[2]).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? null;
    tags.push({tag, attrs, inHead});
  }
  return tags;
}
function verifyHtml(html, {project, navigation = 'static'} = {}) {
  const check = (ok, message) => { if (!ok) throw new Error('Design contract: ' + message); };
  check(CONTRACT.projects.includes(project), 'unknown project');
  check(['static', 'react'].includes(navigation), 'unknown navigation owner');
  const tags = parse(html), own = (a, k) => Object.hasOwn(a, k);
  const sheets = tags.map((t, i) => ({...t, i})).filter(t => t.tag === 'link' && own(t.attrs, 'data-quant-first-paint-css'));
  const starts = tags.map((t, i) => ({...t, i})).filter(t => t.tag === 'script' && (own(t.attrs, 'data-quant-design-project') || (t.attrs.src || '').includes('/shared/design/startup/')));
  check(sheets.length === 1 && starts.length === 1, 'one first-paint stylesheet and one startup required');
  const sheet = sheets[0], start = starts[0], base = CONTRACT.startupBase;
  check((sheet.attrs.href || '').split('?')[0] === base + project + '.css' && sheet.attrs.rel === 'stylesheet', 'wrong stylesheet pin');
  check((start.attrs.src || '').split('?')[0] === base + 'start.js' && start.attrs['data-quant-design-project'] === project, 'wrong startup pin or project');
  check(!own(start.attrs, 'async') && !own(start.attrs, 'defer') && ['', 'text/javascript', 'application/javascript'].includes(start.attrs.type || ''), 'startup must be blocking');
  check(sheet.inHead && start.inHead && start.i === sheet.i + 1, 'stylesheet must immediately precede startup in head');
  const navs = [];
  for (const [i, {tag, attrs, inHead}] of tags.entries()) {
    const src = (tag === 'script' ? attrs.src : attrs.href) || '', plain = src.split('?')[0];
    if (tag === 'link' && attrs.rel === 'stylesheet') check(i <= sheet.i, 'native stylesheet follows final common stylesheet');
    if (!src) continue;
    check(!plain.includes('/shared/design/releases/') && !/(?:^|\/)(?:quant-range|number|runtime)\.js$/.test(plain), 'direct or legacy design loader');
    if (tag !== 'script') continue;
    if (plain === CONTRACT.navigationUrl) { navs.push(i); check(i > start.i && own(attrs, 'defer') && !own(attrs, 'async'), 'navigation must defer after startup'); continue; }
    if (i === start.i) continue;
    const name = plain.split('/').pop(), theme = CONTRACT.earlyThemeBasenames.includes(name);
    const framework = navigation === 'react' && attrs.type === 'module' && new RegExp(CONTRACT.earlyFrameworkPattern).test(name);
    check(i > start.i || theme || framework, 'application script precedes startup');
    if (inHead && !theme && !framework) check(own(attrs, 'defer') || attrs.type === 'module' || (navigation === 'react' && own(attrs, 'async')), 'head application must defer');
    if (navs.length && !framework) check(i < navs[0], 'application script follows navigation owner');
  }
  check(navs.length === (navigation === 'static' ? 1 : 0), 'navigation owner count mismatch');
  return {contract: CONTRACT.version, project, ui: CONTRACT.uiVersion, startup: CONTRACT.startupVersion, navigation};
}
module.exports = {CONTRACT, verifyHtml};
if (require.main === module) {
  const args = process.argv.slice(2), get = name => args[args.indexOf(name) + 1];
  if (!args.includes('--html') || !args.includes('--project')) throw new Error('--html and --project required');
  console.log(JSON.stringify(verifyHtml(fs.readFileSync(get('--html'), 'utf8'), {project: get('--project'), navigation: args.includes('--navigation') ? get('--navigation') : 'static'})));
}
