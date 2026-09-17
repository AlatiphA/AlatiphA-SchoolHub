const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('checkout stays locked until cancellation and retains a recoverable reference', async () => {
  const app = fs.readFileSync(`${__dirname}/../app-4.js`, 'utf8');
  const start = app.indexOf('async function buyReportCredits(');
  const end = app.indexOf('async function verifyPendingCreditPayment(', start);
  const saved = new Map();
  let calls = 0;
  let callbacks;
  const context = vm.createContext({
    checkoutBusy: false, currentSchoolId: 'school', currentUid: 'head',
    REPORT_CREDIT_PACKAGES: [{ id: '10', credits: 10 }],
    isHeadTeacher: () => true,
    requireSchoolAccountForPaidFeature: () => true,
    window: { PAYSTACK_PUBLIC_KEY: 'pk_test_fixture', PaystackPop: true },
    firebase: { functions: true },
    billingFunctions: () => ({ httpsCallable: () => async () => {
      calls++;
      return { data: { mode: 'test', reference: 'ref', accessCode: 'access' } };
    } }),
    pendingPaymentKey: () => 'school-head',
    document: { querySelector: () => null },
    localStorage: { setItem: (key, value) => saved.set(key, value) },
    renderBilling: async () => {},
    PaystackPop: class { resumeTransaction(_, handlers) { callbacks = handlers; } },
    alert: message => { throw new Error(message); },
    console
  });
  vm.runInContext(app.slice(start, end), context);
  await context.buyReportCredits('10');
  await context.buyReportCredits('10');
  assert.equal(calls, 1);
  assert.equal(context.checkoutBusy, true);
  assert.equal(saved.get('school-head'), 'ref');
  callbacks.onCancel();
  assert.equal(context.checkoutBusy, false);
  await context.buyReportCredits('10');
  assert.equal(calls, 2);
});
