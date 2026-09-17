const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const PAYSTACK_SECRET_KEY = defineSecret('PAYSTACK_SECRET_KEY');
// Keep real-money checkout disabled until the end-to-end test is approved.
const CHECKOUT_TEST_ONLY = true;

function paymentMode() {
  const key = PAYSTACK_SECRET_KEY.value();
  const mode = key.startsWith('sk_test_') ? 'test' : key.startsWith('sk_live_') ? 'live' : '';
  if (!mode || (CHECKOUT_TEST_ONLY && mode !== 'test')) {
    throw new HttpsError('failed-precondition', 'Checkout is configured for test payments only.');
  }
  return mode;
}

const PACKAGES = {
  '10': { credits: 10, amountPesewas: 200 },
  '50': { credits: 50, amountPesewas: 1000 },
  '100': { credits: 100, amountPesewas: 2000 },
  '250': { credits: 250, amountPesewas: 5000 },
  '500': { credits: 500, amountPesewas: 10000 },
  '1000': { credits: 1000, amountPesewas: 20000 }
};

async function getHeadSchool(uid) {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) throw new HttpsError('permission-denied', 'School account not found.');
  const user = snap.data() || {};
  if (user.role !== 'headteacher' || user.status !== 'active' || !user.schoolId) {
    throw new HttpsError('permission-denied', 'Only an active Head Teacher can purchase report credits.');
  }
  return { user, schoolId: user.schoolId };
}

async function paystackRequest(path, options = {}) {
  const response = await fetch(`https://api.paystack.co${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY.value()}`,
      'Content-Type': 'application/json'
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const json = await response.json();
  if (!response.ok || !json.status) {
    throw new Error(json.message || `Paystack request failed (${response.status})`);
  }
  return json;
}

exports.initializeReportCreditPurchase = onCall({ secrets: [PAYSTACK_SECRET_KEY], region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Please sign in.');
  const { schoolId } = await getHeadSchool(request.auth.uid);
  const mode = paymentMode();
  const packageId = String(request.data?.packageId || '');
  const pack = Object.hasOwn(PACKAGES, packageId) ? PACKAGES[packageId] : null;
  if (!pack) throw new HttpsError('invalid-argument', 'Invalid credit package.');

  const email = String(request.auth.token.email || request.data?.email || '').trim();
  if (!email) throw new HttpsError('invalid-argument', 'A valid account email is required for payment.');

  const reference = `SH_${schoolId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`.replace(/[^A-Za-z0-9_.=-]/g, '');
  await db.collection('schools').doc(schoolId).collection('billingTransactions').doc(reference).set({
    reference,
    schoolId,
    uid: request.auth.uid,
    type: 'credit_purchase',
    mode,
    packageId,
    credits: pack.credits,
    expectedAmountPesewas: pack.amountPesewas,
    currency: 'GHS',
    status: 'initiated',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  try {
    const result = await paystackRequest('/transaction/initialize', {
      method: 'POST',
      body: {
        email,
        amount: String(pack.amountPesewas),
        currency: 'GHS',
        reference,
        metadata: {
          schoolId,
          uid: request.auth.uid,
          packageId,
          credits: pack.credits
        }
      }
    });

    await db.collection('schools').doc(schoolId).collection('billingTransactions').doc(reference).set({
      accessCode: result.data.access_code,
      authorizationUrl: result.data.authorization_url,
      status: 'payment_pending',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return { reference, mode, accessCode: result.data.access_code, authorizationUrl: result.data.authorization_url, credits: pack.credits, amountPesewas: pack.amountPesewas };
  } catch (err) {
    await db.collection('schools').doc(schoolId).collection('billingTransactions').doc(reference).set({
      status: 'initialization_failed',
      error: String(err.message || err).slice(0, 500),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    throw new HttpsError('internal', 'Could not initialize payment. Please try again.');
  }
});

exports.verifyReportCreditPurchase = onCall({ secrets: [PAYSTACK_SECRET_KEY], region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Please sign in.');
  const { schoolId } = await getHeadSchool(request.auth.uid);
  const reference = String(request.data?.reference || '').trim();
  if (!/^[A-Za-z0-9_.=-]{1,200}$/.test(reference)) throw new HttpsError('invalid-argument', 'A valid payment reference is required.');

  const txRef = db.collection('schools').doc(schoolId).collection('billingTransactions').doc(reference);
  const txSnap = await txRef.get();
  if (!txSnap.exists) throw new HttpsError('not-found', 'Payment record not found.');
  const tx = txSnap.data() || {};
  if (tx.uid !== request.auth.uid) throw new HttpsError('permission-denied', 'Payment does not belong to this account.');
  const mode = paymentMode();
  if (tx.mode !== mode) throw new HttpsError('failed-precondition', 'Payment environment does not match.');
  const balanceField = mode === 'test' ? 'testBalance' : 'balance';

  if (tx.status === 'credited') {
    const billSnap = await db.collection('schools').doc(schoolId).collection('billing').doc('account').get();
    return { credited: true, mode, balance: Number((billSnap.data() || {})[balanceField] || 0), reference };
  }

  const verified = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`);
  const data = verified.data || {};
  const expectedAmount = Number(tx.expectedAmountPesewas || 0);
  const paidAmount = Number(data.amount || 0);
  const success = data.status === 'success' && expectedAmount > 0 && paidAmount === expectedAmount
    && data.currency === 'GHS' && data.reference === reference && data.domain === mode
    && data.metadata?.schoolId === schoolId && data.metadata?.uid === tx.uid;
  if (!success) {
    // Do not overwrite a concurrently credited transaction with a stale response.
    throw new HttpsError('failed-precondition', 'Payment could not be verified for the expected amount.');
  }

  const billRef = db.collection('schools').doc(schoolId).collection('billing').doc('account');
  let newBalance = 0;
  await db.runTransaction(async t => {
    const [billSnap, latestTx] = await Promise.all([t.get(billRef), t.get(txRef)]);
    const latest = latestTx.data() || {};
    if (latest.status === 'credited') {
      newBalance = Number((billSnap.data() || {})[balanceField] || 0);
      return;
    }
    const current = Number((billSnap.data() || {})[balanceField] || 0);
    newBalance = current + Number(tx.credits || 0);
    t.set(billRef, {
      [balanceField]: newBalance,
      currency: 'GHS',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    t.set(txRef, {
      status: 'credited',
      paidAmountPesewas: paidAmount,
      paystackTransactionId: data.id || null,
      creditedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });

  return { credited: true, mode, balance: newBalance, reference };
});

exports.consumeReportCredits = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Please sign in.');
  if (CHECKOUT_TEST_ONLY) throw new HttpsError('failed-precondition', 'Paid report billing is not active yet.');
  const userSnap = await db.collection('users').doc(request.auth.uid).get();
  const user = userSnap.data() || {};
  if (!['headteacher', 'teacher'].includes(user.role) || user.status !== 'active' || !user.schoolId) {
    throw new HttpsError('permission-denied', 'Active school users only.');
  }
  const schoolId = user.schoolId;
  const count = Number(request.data?.count || 0);
  if (!Number.isInteger(count) || count < 1 || count > 5000) throw new HttpsError('invalid-argument', 'Invalid credit count.');

  const billRef = db.collection('schools').doc(schoolId).collection('billing').doc('account');
  const usageRef = db.collection('schools').doc(schoolId).collection('billingUsage').doc();
  let balance = 0;
  await db.runTransaction(async t => {
    const billSnap = await t.get(billRef);
    const current = Number((billSnap.data() || {}).balance || 0);
    if (current < count) throw new HttpsError('failed-precondition', `Not enough report credits. You have ${current}.`);
    balance = current - count;
    t.update(billRef, { balance, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    t.set(usageRef, {
      uid: request.auth.uid,
      schoolId,
      count,
      action: 'report_card_generation',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
  return { balance, consumed: count };
});
