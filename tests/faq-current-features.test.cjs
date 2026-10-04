const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = p => fs.readFileSync(p, 'utf8');
const faq = read('faq.html');
const publicFaq = read('public/faq.html');
const index = read('index.html');
const publicIndex = read('public/index.html');

const required = [
  'email/password Sign in and Sign up first',
  'Does Continue with Google automatically join a school?',
  'Fees &amp; Receipts (FIS)',
  'multiple selected classes',
  'oldest outstanding debt first',
  'Financial Dashboard',
  'What is a Parent Fee Statement?',
  'What does Arrears Management do?',
  'Reminder Generator',
  'What does Copy message do?',
  'What does Open WhatsApp do?',
  'What does Print / Save reminder PDF do?',
  'FIS pending saves &amp; confirmed balances',
  'Does SchoolHub use Background Sync?',
  'Mobile tables &amp; horizontal scrolling',
  'Recommended workflow &amp; key reminders',
  'Save draft &amp; add another',
  'Saved request drafts',
  'Waiting to reconnect',
  'six subject results are complete',
  '15 seconds',
  'My Details and stock request drafts are not submitted automatically'

];

test('standalone FAQ covers current auth, FIS, PWA and mobile-table features', () => {
  for (const phrase of required) assert.ok(faq.includes(phrase), `missing FAQ content: ${phrase}`);
});

test('standalone FAQ hosting mirror is identical', () => {
  assert.equal(publicFaq, faq);
});

test('inline FAQ contains the same current feature guidance', () => {
  for (const phrase of required) assert.ok(index.includes(phrase), `missing inline FAQ content: ${phrase}`);
  assert.ok(index.includes('<template id="inlineDocTemplateFaq">'));
});

test('root and public index keep matching inline FAQ content', () => {
  const extract = html => html.match(/<template id="inlineDocTemplateFaq">([\s\S]*?)<\/template>/)?.[1];
  assert.ok(extract(index));
  assert.equal(extract(publicIndex), extract(index));
  const standalone=faq.match(/<div class="standalone-doc-body">([\s\S]*?)<\/div>\s*<footer/)?.[1];
  assert.equal(extract(index).trim(),standalone.trim());
});

test('FAQ preserves important existing help topics and support links', () => {
  for (const phrase of ['Save, Update &amp; deleting','Attendance &amp; Calendar','Backup, recovery &amp; rollover','Install, security &amp; troubleshooting','Call 0243443688']) {
    assert.ok(faq.includes(phrase), `existing FAQ topic missing: ${phrase}`);
  }
});
