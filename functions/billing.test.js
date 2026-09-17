const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function fixture(overrides = {}, key = 'sk_test_fixture') {
  const records = new Map([
    ['users/head', { role: 'headteacher', status: 'active', schoolId: 'school' }],
    ['schools/school/billingTransactions/ref', { uid: 'head', mode: 'test', status: 'payment_pending', credits: 10, expectedAmountPesewas: 200 }],
    ['schools/school/billing/account', { balance: 7, testBalance: 0 }]
  ]);
  const ref = path => ({
    path,
    collection: name => ref(`${path}/${name}`),
    doc: id => ref(`${path}/${id}`),
    get: async () => ({ exists: records.has(path), data: () => records.get(path) }),
    set: async data => records.set(path, { ...records.get(path), ...data })
  });
  const db = { collection: ref, runTransaction: async fn => fn({ get: r => r.get(), set: (r, d) => r.set(d) }) };
  const firestore = () => db;
  firestore.FieldValue = { serverTimestamp: () => 'timestamp' };
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const exports = {};
  let fetches = 0;
  vm.runInNewContext(fs.readFileSync(`${__dirname}/index.js`, 'utf8'), {
    exports, console,
    require: name => ({
      'firebase-functions/v2/https': { onCall: (_, fn) => fn, HttpsError },
      'firebase-functions/params': { defineSecret: () => ({ value: () => key }) },
      'firebase-admin': { initializeApp() {}, firestore }
    })[name],
    fetch: async () => { fetches++; return { ok: true, json: async () => ({ status: true, data: {
      status: 'success', amount: 200, currency: 'GHS', reference: 'ref', domain: 'test',
      metadata: { schoolId: 'school', uid: 'head' }, ...overrides
    } }) }; }
  });
  return { exports, records, fetches: () => fetches, request: { auth: { uid: 'head', token: { email: 'test@example.com' } }, data: { reference: 'ref' } } };
}

test('verified test payments credit only the test balance, once', async () => {
  const f = fixture();
  const first = await f.exports.verifyReportCreditPurchase(f.request);
  const repeated = await f.exports.verifyReportCreditPurchase(f.request);
  assert.equal(first.balance, 10);
  assert.equal(repeated.balance, 10);
  assert.equal(f.records.get('schools/school/billing/account').balance, 7);
  assert.equal(f.fetches(), 1);
});

for (const mismatch of [{ amount: 100 }, { currency: 'NGN' }, { domain: 'live' }, { reference: 'other' }, { status: 'failed' }, { metadata: { schoolId: 'other', uid: 'head' } }]) {
  test(`reject mismatched payment ${JSON.stringify(mismatch)}`, async () => {
    const f = fixture(mismatch);
    await assert.rejects(f.exports.verifyReportCreditPurchase(f.request), { code: 'failed-precondition' });
    assert.equal(f.records.get('schools/school/billing/account').testBalance, 0);
  });
}

test('live keys and live-credit deductions remain disabled', async () => {
  const f = fixture({}, 'sk_live_fixture');
  await assert.rejects(f.exports.initializeReportCreditPurchase(f.request), { code: 'failed-precondition' });
  await assert.rejects(f.exports.consumeReportCredits(f.request), { code: 'failed-precondition' });
  assert.equal(f.fetches(), 0);
});

test('another account cannot verify the purchase', async () => {
  const f = fixture();
  f.records.get('schools/school/billingTransactions/ref').uid = 'other';
  await assert.rejects(f.exports.verifyReportCreditPurchase(f.request), { code: 'permission-denied' });
  assert.equal(f.fetches(), 0);
});

test('public checkout endpoints reject requests without Firebase sign-in', async () => {
  const f = fixture();
  for (const name of ['initializeReportCreditPurchase', 'verifyReportCreditPurchase']) {
    await assert.rejects(f.exports[name]({ data: {} }), { code: 'unauthenticated' });
  }
  assert.equal(f.fetches(), 0);
});

test('signed-in teachers cannot initialize or verify purchases', async () => {
  const f = fixture();
  f.records.get('users/head').role = 'teacher';
  for (const name of ['initializeReportCreditPurchase', 'verifyReportCreditPurchase']) {
    await assert.rejects(f.exports[name](f.request), { code: 'permission-denied' });
  }
  assert.equal(f.fetches(), 0);
});

function deductionRequest(count = 1, requestId = 'test-generation-0001') {
  return { auth: { uid: 'head' }, data: { count, requestId, mode: 'test' } };
}
test('single and batch deductions use only test credits and retries are idempotent', async () => {
  const f = fixture();
  const account = f.records.get('schools/school/billing/account');
  account.testBalance = 10;
  assert.equal((await f.exports.consumeReportCredits(deductionRequest())).balance, 9);
  assert.equal((await f.exports.consumeReportCredits(deductionRequest())).balance, 9);
  assert.equal((await f.exports.consumeReportCredits(deductionRequest(3, 'test-generation-0002'))).balance, 6);
  assert.equal(f.records.get('schools/school/billing/account').balance, 7);
  assert.equal(f.records.get('schools/school/billing/account').testBalance, 6);
  await assert.rejects(f.exports.consumeReportCredits(deductionRequest(2)), { code: 'failed-precondition' });
});
test('insufficient test balance never falls back to live credits', async () => {
  const f = fixture();
  await assert.rejects(f.exports.consumeReportCredits(deductionRequest()), { code: 'failed-precondition' });
  assert.equal(f.records.get('schools/school/billing/account').balance, 7);
  assert.equal(f.records.has('schools/school/billingUsage/test-generation-0001'), false);
});
test('deductions validate identity, active role, count, mode and request ID', async () => {
  const f = fixture();
  await assert.rejects(f.exports.consumeReportCredits({ data: {} }), { code: 'unauthenticated' });
  for (const data of [{ count: 0 }, { count: 1.5 }, { count: 5001 }, { requestId: '../bad' }]) {
    const req = deductionRequest(); Object.assign(req.data, data);
    await assert.rejects(f.exports.consumeReportCredits(req), { code: 'invalid-argument' });
  }
  const live = deductionRequest(); live.data.mode = 'live';
  await assert.rejects(f.exports.consumeReportCredits(live), { code: 'failed-precondition' });
  f.records.get('users/head').status = 'disabled';
  await assert.rejects(f.exports.consumeReportCredits(deductionRequest()), { code: 'permission-denied' });
});
test('active teachers can consume test credits', async () => {
  const f = fixture();
  f.records.get('users/head').role = 'teacher';
  f.records.get('schools/school/billing/account').testBalance = 1;
  assert.equal((await f.exports.consumeReportCredits(deductionRequest())).balance, 0);
});
