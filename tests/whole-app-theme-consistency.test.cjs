const fs=require('fs');
const assert=require('assert');

const css=fs.readFileSync('style-3.css','utf8');
const publicCss=fs.readFileSync('public/style-3.css','utf8');
const index=fs.readFileSync('index.html','utf8');
const sw=fs.readFileSync('sw.js','utf8');

assert.strictEqual(css, publicCss, 'root/public CSS must stay identical');

for (const token of [
  '--card:var(--surface);',
  '--card-alt:var(--surface-alt);',
  '--border:var(--rule);',
  '--accent:var(--gold);',
  '--surface2:var(--surface-alt);',
  '--on-accent:#16241C;'
]) assert(css.includes(token), `missing theme token ${token}`);

assert(css.includes('.bulk-selection-toolbar{'));
assert(css.includes('background:var(--card);'));
assert(css.includes('border-color:var(--border);'));
assert(css.includes('color:var(--paper);'));
assert(css.includes('color:var(--on-accent);'));

assert(!css.includes('background:var(--card,#fff)'),
  'dark mode must not depend on white fallback cards');
assert(!css.includes('var(--border,#ddd)'),
  'theme borders must not fall back to light-mode grey');
assert(!css.includes('var(--accent,#956433)'),
  'accent controls must use the active theme token');

assert(index.includes('style-3.css?v=v40-theme-system-fix-6'));
assert(sw.includes('schoolhub-cache-v40-theme-system-fix-6'));

console.log('whole-app theme consistency regression: PASS');
