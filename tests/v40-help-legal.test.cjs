const fs = require('fs');
const assert = require('assert');

const app = fs.readFileSync('app-4.js','utf8');
const index = fs.readFileSync('index.html','utf8');
const faq = fs.readFileSync('faq.html','utf8');
const privacy = fs.readFileSync('privacy.html','utf8');
const terms = fs.readFileSync('terms.html','utf8');
const sw = fs.readFileSync('sw.js','utf8');

assert(app.includes('Offline & Sync Center'));
assert(app.includes('Academic Year Rollover'));
assert(app.includes('Restore Year-End Backup'));
assert(index.includes('href="privacy.html"'));
assert(index.includes('href="terms.html"'));
assert(faq.includes('Sync Pending'));
assert(faq.includes('Academic Year Rollover'));
assert(faq.includes('Save</strong> is used for a new entry'));
assert(privacy.includes('student photos and staff signatures'));
assert(privacy.includes('Firebase Storage'));
assert(terms.includes('Save is for creating new records and Update is for changing existing records'));
assert(terms.includes('Billing/credit features may be enabled, suspended or placed in test mode'));
assert(sw.includes("'./privacy.html','./terms.html'"));
console.log('help/legal update regression: PASS');
