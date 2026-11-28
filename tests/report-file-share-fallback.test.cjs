const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('app-4.js', 'utf8');
const start = source.indexOf('let preparedReportUrl = null;');
const end = source.indexOf('function reportGenerationProgress(', start);

function fixture(share) {
  let downloaded = false;
  const nodes = new Map();
  for (const selector of ['.prepared-report-name', '[data-report-share]', '[data-report-note]', '[data-report-error]', '[data-report-compose]', '[data-report-download]', '[data-report-open]', '[data-report-close]']) {
    nodes.set(selector, {
      hidden: selector === '[data-report-share]' || selector === '[data-report-error]' || selector === '[data-report-compose]',
      addEventListener(event, listener) { if (event === 'click') this.click = listener; },
      removeAttribute() {}, focus() {}
    });
  }
  nodes.get('[data-report-download]').click = () => { downloaded = true; };
  const overlay = {
    querySelector: selector => nodes.get(selector),
    setAttribute() {}, addEventListener() {}, remove() { this.removed = true; }
  };
  const results = [];
  const ctx = {
    URL: { revokeObjectURL() {} },
    document: { createElement: () => overlay, getElementById: () => null, activeElement: { focus() {} }, body: { appendChild() {} } },
    navigator: { share },
    guardianWhatsAppDigits: value => String(value || ''),
    setTimeout: () => 0,
    console: { warn() {} }
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(start, end), ctx);
  return { ctx, nodes, overlay, results, get downloaded() { return downloaded; } };
}

test('a rejected mobile or PC file share offers a PDF-only retry and parent WhatsApp draft', async () => {
  const calls = [];
  const f = fixture(async data => {
    calls.push(data);
    if (calls.length === 1) { const error = Error('Sharing target rejected the PDF'); error.name = 'NotAllowedError'; throw error; }
  });
  const file = { name: 'learner.pdf' };
  f.ctx.showPreparedReport('blob:report', 'learner.pdf', false, {
    file, shareData: { files: [file], title: 'Report', text: 'Message' },
    channel: 'whatsapp', recipient: '233243443688', subject: 'Report', text: 'Report attached',
    onResult: state => f.results.push(state)
  });
  await f.nodes.get('[data-report-share]').click();
  assert.equal(f.nodes.get('[data-report-share]').textContent, 'Try PDF only');
  assert.match(f.nodes.get('[data-report-compose]').href, /^https:\/\/wa\.me\/233243443688\?/);
  assert.match(f.nodes.get('[data-report-note]').textContent, /Save PDF/);
  assert.match(f.nodes.get('[data-report-error]').textContent, /NotAllowedError/);
  assert.equal(f.downloaded, false);
  assert.deepEqual(f.results, ['fallback']);
  await f.nodes.get('[data-report-share]').click();
  assert.deepEqual(Object.keys(calls[1]), ['files']);
  assert.deepEqual(f.results, ['fallback', 'shared']);
  assert.equal(f.overlay.removed, true);
});

test('unsupported file sharing opens a parent email draft and waits for an explicit PDF save', () => {
  const f = fixture(async () => {});
  f.ctx.showPreparedReport('blob:report', 'learner.pdf', false, {
    fallback: true, channel: 'email', recipient: 'parent@example.com', subject: 'Report card', text: 'Report attached'
  });
  assert.equal(f.nodes.get('[data-report-share]').hidden, true);
  assert.match(f.nodes.get('[data-report-compose]').href, /^mailto:parent%40example\.com\?subject=Report%20card/);
  assert.equal(f.nodes.get('[data-report-compose]').hidden, false);
  assert.equal(f.downloaded, false);
});
