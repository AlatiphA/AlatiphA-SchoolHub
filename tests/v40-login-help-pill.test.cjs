const fs = require('fs');
const assert = require('assert');

const app = fs.readFileSync('app-4.js','utf8');
const css = fs.readFileSync('style-3.css','utf8');
const index = fs.readFileSync('index.html','utf8');

assert(app.includes("if(!sessionReady&&FIREBASE_ENABLED){if(p)p.remove();return;}"));
assert(app.includes("document.getElementById('schoolHubFloatingPill')?.remove();"));
assert(css.includes("html.authing #schoolHubFloatingPill"));
assert(css.includes("#inlineDocDialog{z-index:13000;}"));

assert(index.includes('data-inline-doc="faq"'));
assert(index.includes('data-inline-doc="privacy"'));
assert(index.includes('data-inline-doc="terms"'));

assert(index.includes('© All Rights Reserved · AlatiphA Multimedia'));
assert(!index.includes('© 2026 AlatiphA Multimedia'));

console.log('login help and floating pill regression: PASS');
