const fs=require('fs');
const assert=require('assert');

const index=fs.readFileSync('index.html','utf8');
const app=fs.readFileSync('app-4.js','utf8');
const css=fs.readFileSync('style-3.css','utf8');
const faq=fs.readFileSync('faq.html','utf8');
const privacy=fs.readFileSync('privacy.html','utf8');
const terms=fs.readFileSync('terms.html','utf8');

assert(index.includes('id="inlineDocDialog"'));
assert(index.includes('data-inline-doc="faq"'));
assert(index.includes('data-inline-doc="privacy"'));
assert(index.includes('data-inline-doc="terms"'));
assert(index.includes('id="inlineDocTemplateFaq"'));
assert(index.includes('id="inlineDocTemplatePrivacy"'));
assert(index.includes('id="inlineDocTemplateTerms"'));
assert(app.includes('function openInlineDoc(name)'));
assert(css.includes('.inline-doc-box'));
assert(css.includes('background:var(--surface)'));
assert(css.includes('color:var(--paper)'));

for (const doc of [faq,privacy,terms]) {
  assert(!doc.includes('id="themeToggle"'));
  assert(!doc.includes('class="theme"'));
  assert(doc.includes('style-3.css?v=v40-inline-help-legal-1'));
}

for (const file of ['index.html','public/index.html','faq.html','public/faq.html','privacy.html','public/privacy.html','terms.html','public/terms.html']) {
  const text=fs.readFileSync(file,'utf8');
  assert(!text.includes('© 2026 AlatiphA Multimedia'));
}
assert(index.includes('© All Rights Reserved · AlatiphA Multimedia'));
console.log('inline help/legal and copyright regression: PASS');
