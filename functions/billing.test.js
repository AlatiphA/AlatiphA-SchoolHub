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

test('lifetime verification is school-owned, idempotent and does not mint credits', async () => {
  const f = fixture({ amount: 54900 });
  Object.assign(f.records.get('schools/school/billingTransactions/ref'), {type:'lifetime_licence',packageId:'lifetime',expectedAmountPesewas:54900});
  await f.exports.verifyReportCreditPurchase(f.request);
  await f.exports.verifyReportCreditPurchase(f.request);
  const account=f.records.get('schools/school/billing/account');
  assert.equal(account.testLifetimeLicence.schoolId,'school');
  assert.equal(account.testLifetimeLicence.active,true);
  assert.equal(account.lifetimeLicence,undefined);
  assert.equal(account.testBalance,0);
  f.records.set('users/new-head',{role:'headteacher',status:'active',schoolId:'school'});
  f.records.set('users/teacher',{role:'teacher',status:'active',schoolId:'school'});
  for(const uid of ['new-head','teacher']) {
    const req=deductionRequest(30,'generation-'+uid+'-0001'); req.auth.uid=uid;
    assert.equal((await f.exports.consumeReportCredits(req)).consumed,0);
  }
});

test('foreign-school and live licences do not grant test report access', async () => {
  const f=fixture();
  Object.assign(f.records.get('schools/school/billing/account'), {testLifetimeLicence:{active:true,schoolId:'other'},lifetimeLicence:{active:true,schoolId:'school'}});
  await assert.rejects(f.exports.consumeReportCredits(deductionRequest()), {code:'failed-precondition'});
});

test('attendance verification unlocks only the purchased term and preserves balances', async () => {
  const f=fixture({amount:5000});
  const termKey=encodeURIComponent(JSON.stringify(['2026/2027','Term 1']));
  Object.assign(f.records.get('schools/school/billingTransactions/ref'),{type:'attendance_term',packageId:'attendance',expectedAmountPesewas:5000,attendanceTermKey:termKey});
  f.records.set('schools/school',{profile:{currentTerm:'Term 2',currentYear:'2026/2027'}});
  await f.exports.verifyReportCreditPurchase(f.request);
  await f.exports.verifyReportCreditPurchase(f.request);
  const account=f.records.get('schools/school/billing/account');
  assert.equal(account.testAttendanceTerms[termKey].active,true);
  assert.equal(Object.keys(account.testAttendanceTerms).length,1);
  assert.equal(account.testBalance,0);
  assert.equal(account.attendanceTerms,undefined);
});

test('attendance initialization requires a saved term and rejects duplicate unlocks', async () => {
  const f=fixture(); f.request.data={packageId:'attendance'};
  await assert.rejects(f.exports.initializeReportCreditPurchase(f.request),{code:'failed-precondition'});
  f.records.set('schools/school',{profile:{currentTerm:'Term 1',currentYear:'2026/2027'}});
  f.records.get('schools/school/billing/account').testLifetimeLicence={active:true,schoolId:'school'};
  await assert.rejects(f.exports.initializeReportCreditPurchase(f.request),{code:'already-exists'});
});


test('new 3-year offer uses 34999 pesewas and hidden lifetime offer cannot start checkout', async () => {
  const f = fixture();
  const result = await f.exports.initializeReportCreditPurchase({...f.request,data:{packageId:'three-year'}});
  assert.equal(result.amountPesewas,34999);
  assert.equal([...f.records.values()].find(x=>x.type==='school_licence_3_year').expectedAmountPesewas,34999);
  await assert.rejects(f.exports.initializeReportCreditPurchase({...f.request,data:{packageId:'lifetime'}}),{code:'failed-precondition'});
});
test('verified 3-year purchase creates dated test entitlement, preserves legacy and does not extend on retry', async () => {
  const f=fixture({amount:34999});
  Object.assign(f.records.get('schools/school/billingTransactions/ref'),{type:'school_licence_3_year',packageId:'three-year',expectedAmountPesewas:34999});
  const account=f.records.get('schools/school/billing/account');account.lifetimeLicence={active:true,schoolId:'school',reference:'legacy'};
  const result=await f.exports.verifyReportCreditPurchase(f.request),saved=f.records.get('schools/school/billing/account');
  assert.equal(result.schoolLicence,true);assert.equal(saved.testSchoolLicence.schoolId,'school');
  assert.equal(saved.testSchoolLicence.durationYears,3);
  assert.equal(new Date(saved.testSchoolLicence.expiresAt).getUTCFullYear()-new Date(saved.testSchoolLicence.startsAt).getUTCFullYear(),3);
  assert.equal(saved.testBalance,0);assert.equal(saved.balance,7);assert.equal(saved.schoolLicence,undefined);
  assert.equal(saved.lifetimeLicence.reference,'legacy');
  const repeated=await f.exports.verifyReportCreditPurchase(f.request);
  assert.equal(repeated.expiresAt,result.expiresAt);assert.equal(f.fetches(),1);
});
test('3-year purchase rejects the wrong amount without activating licence',async()=>{
 const f=fixture({amount:34998});Object.assign(f.records.get('schools/school/billingTransactions/ref'),{type:'school_licence_3_year',packageId:'three-year',expectedAmountPesewas:34999});
 await assert.rejects(f.exports.verifyReportCreditPurchase(f.request),{code:'failed-precondition'});
 assert.equal(f.records.get('schools/school/billing/account').testSchoolLicence,undefined);
});
for(const [label,expiresAt,schoolId,consumed] of [['active','2150-01-01T00:00:00.000Z','school',0],['expired','2000-01-01T00:00:00.000Z','school',1],['wrong-school','2150-01-01T00:00:00.000Z','other',1],['invalid-expiry','invalid','school',1]]){
 test('report licence entitlement: '+label,async()=>{
  const f=fixture();Object.assign(f.records.get('schools/school/billing/account'),{testBalance:10,testSchoolLicence:{active:true,schoolId,expiresAt}});
  const result=await f.exports.consumeReportCredits({...f.request,data:{mode:'test',count:1,requestId:'three_year_report_0001'}});
  assert.equal(result.consumed,consumed);assert.equal(result.balance,10-consumed);
 });
}
test('expired licence permits a fresh purchase; active licence blocks duplicate checkout',async()=>{
 const f=fixture();f.records.get('schools/school/billing/account').testSchoolLicence={active:true,schoolId:'school',expiresAt:'2150-01-01T00:00:00.000Z'};
 await assert.rejects(f.exports.initializeReportCreditPurchase({...f.request,data:{packageId:'three-year'}}),{code:'already-exists'});
 f.records.get('schools/school/billing/account').testSchoolLicence.expiresAt='2000-01-01T00:00:00.000Z';
 assert.equal((await f.exports.initializeReportCreditPurchase({...f.request,data:{packageId:'three-year'}})).amountPesewas,34999);
});
test('calendar expiry handles leap day and exact boundary',()=>{
 const source=fs.readFileSync(`${__dirname}/index.js`,'utf8'),context={};
 vm.runInNewContext(source.slice(source.indexOf('function activeSchoolLicence'),source.indexOf('async function getHeadSchool')),context);
 assert.equal(context.schoolLicenceEnd(Date.parse('2024-02-29T12:00:00.000Z')),'2027-02-28T12:00:00.000Z');
 const a={testSchoolLicence:{active:true,schoolId:'s',expiresAt:'2029-10-14T12:00:00.000Z'}};
 const end=Date.parse(a.testSchoolLicence.expiresAt);
 assert.equal(context.activeSchoolLicence(a,'s','test',end-1),true);assert.equal(context.activeSchoolLicence(a,'s','test',end),false);
});
