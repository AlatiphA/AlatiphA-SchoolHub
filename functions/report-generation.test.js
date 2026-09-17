const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync(`${__dirname}/../app-4.js`, 'utf8');
function fixture({ theme = 'premium', failDraw = false, failOutput = false, enough = true } = {}) {
  const deductions = [], downloads = [];
  const context = vm.createContext({
    window: { jspdf: { jsPDF: class { addPage() {} output() { if (failOutput) throw Error('serialization failed'); return {}; } } } },
    DB: { get: () => ({}) }, KEYS: { settings: 'settings' },
    getReportTheme: () => ({ id: theme }),
    ensureCreditsAvailable: async () => enough,
    consumeReportCredits: async n => { deductions.push(n); },
    prepareReportAssets: async () => ({}),
    drawReportPage: () => { if (failDraw) throw Error('render failed'); },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    document: { createElement: () => ({ click() { downloads.push(this.download); } }) },
    setTimeout: fn => fn(), alert() {}, console
  });
  vm.runInContext(app.slice(app.indexOf('function reportUsesCredits('), app.indexOf('/* ---------- utils ---------- */')), context);
  const student = { entries: [{}], student: { id: 'one', name: 'Test Student' } };
  return { context, deductions, downloads, student };
}
test('premium singles cost one, Black & White singles are free, batches count only graded students', async () => {
  const f = fixture();
  await f.context.generateSinglePDF(f.student);
  assert.deepEqual(f.deductions, [1]);
  const bw = fixture({ theme: 'bw' });
  await bw.context.generateSinglePDF(bw.student);
  assert.deepEqual(bw.deductions, []);
  await bw.context.generateBatchPDF([bw.student, bw.student, { entries: [] }], {}, 3, {}, {});
  assert.deepEqual(bw.deductions, [2]);
  assert.equal(bw.downloads.length, 2);
});
for (const option of ['failDraw', 'failOutput']) test(`${option} does not deduct or download`, async () => {
  const f = fixture({ [option]: true });
  await assert.rejects(f.context.generateSinglePDF(f.student));
  await assert.rejects(f.context.generateBatchPDF([f.student], {}, 1, {}, {}));
  assert.deepEqual(f.deductions, []);
  assert.deepEqual(f.downloads, []);
});
test('insufficient balance blocks generation; overlapping clicks only deduct once', async () => {
  const empty = fixture({ enough: false });
  await empty.context.generateSinglePDF(empty.student);
  await empty.context.generateBatchPDF([empty.student], {}, 1, {}, {});
  assert.deepEqual(empty.deductions, []);
  assert.deepEqual(empty.downloads, []);
  const f = fixture();
  await Promise.all([f.context.generateSinglePDF(f.student), f.context.generateSinglePDF(f.student)]);
  assert.deepEqual(f.deductions, [1]);
});
test('transient deduction retries reuse the request ID and update only the test balance', async () => {
  const account = { balance: 7, testBalance: 10 }, requests = [];
  const context = vm.createContext({
    crypto: { randomUUID: () => 'same-generation-id' }, reportBillingIsFree: () => false,
    requireSchoolAccountForPaidFeature: () => true, firebase: { functions: true },
    currentSchoolId: 'school', currentUid: 'head',
    billingFunctions: () => ({ httpsCallable: () => async data => {
      requests.push(data);
      if (requests.length === 1) throw Object.assign(Error('timeout'), { code: 'functions/deadline-exceeded' });
      return { data: { mode: 'test', balance: 9 } };
    } }), DB: { get: () => account, set: (_, data) => Object.assign(account, data) },
    KEYS: { billing: 'billing' }, renderReportCreditStatus() {}, auditAction() {}
  });
  vm.runInContext(app.slice(app.indexOf('async function consumeReportCredits('), app.indexOf('async function buyReportCredits(')), context);
  await context.consumeReportCredits(1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].requestId, requests[1].requestId);
  assert.equal(account.testBalance, 9);
  assert.equal(account.balance, 7);
});
