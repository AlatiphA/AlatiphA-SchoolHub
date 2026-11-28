'use strict';
// Parent Portal backend tests live with the rest of the app regression suite.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { register } = require('../functions/parent-portal');

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function fixture() {
  const records = new Map([
    ['users/head', { schoolId: 'school1', role: 'headteacher', status: 'active', email: 'head@example.com' }],
    ['users/teacher', { schoolId: 'school1', role: 'teacher', status: 'active' }],
    ['schools/school1', { name: 'Test School', profile: { schoolName: 'Test School', currentTerm: 'Term 1', currentYear: '2026-2027' } }],
    ['schools/school1/classes/class1', { name: 'Class One' }],
    ['schools/school1/subjects/math', { name: 'Mathematics' }],
    ['schools/school1/students/pupil1', { name: 'Pupil One', admissionId: 'A-1', classId: 'class1', isActive: true, guardianPhone: 'private' }],
    ['schools/school1/students/pupil2', { name: 'Other Pupil', classId: 'class1', isActive: true }],
    ['schools/school1/attendance/day1', { date: '2026-11-25', term: 'Term 1', year: '2026-2027', entries: { pupil1: 'Present', pupil2: 'Absent' } }],
    ['schools/school1/grades/class1__Term 1__2026-2027', { classId: 'class1', entries: { pupil1: { math: { c: 18, e: 72 } }, pupil2: { math: { c: 20, e: 90 } } } }],
    ['schools/school1/remarks/class1__Term 1__2026-2027', { classId: 'class1', entries: { pupil1: { comment: 'Making good progress', privateField: 'do not send' }, pupil2: { comment: 'Other pupil report' } } }],
    ['schools/school1/pupilCharges/charge1', { studentId: 'pupil1', term: 'Term 1', year: '2026-2027', baseAmount: 1200, adjustment: -200, paid: 300 }],
    ['schools/school1/feeAccounts/charge1', { studentId: 'pupil1', term: 'Term 1', year: '2026-2027', base: 1200 }],
    ['schools/school1/feeAccounts/old1', { studentId: 'pupil1', term: 'Term 3', year: '2025-2026', base: 500, paid: 0 }],
    ['schools/school1/pupilCharges/otherCharge', { studentId: 'pupil2', term: 'Term 1', year: '2026-2027', baseAmount: 9900 }]
  ]);
  const files = new Map();

  const clone = value => value === undefined ? undefined : structuredClone(value);
  const snapshot = path => ({
    exists: records.has(path),
    id: path.split('/').at(-1),
    data: () => clone(records.get(path))
  });
  const collection = (path, filters = [], cap = Infinity) => ({
    path,
    doc(id) { return doc(`${path}/${id}`); },
    where(field, op, value) {
      assert.equal(op, '==');
      return collection(path, [...filters, [field, value]], cap);
    },
    limit(count) { return collection(path, filters, count); },
    async get() {
      const directChildDepth = path.split('/').length + 1;
      const docs = [...records.entries()]
        .filter(([key, value]) => key.startsWith(`${path}/`)
          && key.split('/').length === directChildDepth
          && filters.every(([field, expected]) => value?.[field] === expected))
        .slice(0, cap)
        .map(([key, value]) => ({ id: key.split('/').at(-1), exists: true, data: () => clone(value) }));
      return { docs };
    }
  });
  const doc = path => ({
    path,
    collection: name => collection(`${path}/${name}`),
    async get() { return snapshot(path); },
    async create(value) {
      if (records.has(path)) throw new Error('already exists');
      records.set(path, clone(value));
    },
    async set(value) { records.set(path, clone(value)); }
  });
  const db = {
    collection: name => collection(name),
    async runTransaction(callback) {
      const writes = [];
      const tx = {
        get: ref => Promise.resolve(snapshot(ref.path)),
        set: (ref, value, options = {}) => writes.push(['set', ref.path, clone(value), options.merge]),
        update: (ref, value) => writes.push(['update', ref.path, clone(value)]),
        delete: ref => writes.push(['delete', ref.path])
      };
      const result = await callback(tx);
      for (const [action, path, value, merge] of writes) {
        if (action === 'delete') records.delete(path);
        else if (action === 'update' && !records.has(path)) throw new Error('missing record');
        else records.set(path, merge ? { ...(records.get(path) || {}), ...value } : value);
      }
      return result;
    }
  };
  const handlers = register({
    db,
    onCall: (_options, handler) => handler,
    HttpsError,
    admin: {
      firestore: { FieldValue: { serverTimestamp: () => 12345 } },
      storage: () => ({ bucket: () => ({ file: path => ({
        save: async value => files.set(path, Buffer.from(value)),
        download: async () => [files.get(path)]
      }) }) })
    }
  });
  const request = (uid, email, data = {}, emailVerified = true) => ({
    auth: { uid, token: { email, email_verified: emailVerified, name: 'Portal User' } },
    data
  });
  const headRequest = data => request('head', 'head@example.com', { expectedSchoolId: 'school1', ...data });
  return { handlers, records, files, request, headRequest };
}

test('approved report PDF is published only by an authorized school member and readable only by the linked parent', async () => {
  const f = fixture();
  const pdfBase64 = Buffer.from('%PDF-1.7\nexample report').toString('base64');
  const input = { studentId: 'pupil1', term: 'Term 1', year: '2026-2027', pdfBase64 };
  await assert.rejects(f.handlers.publishParentReportCard(f.request('teacher', 'teacher@example.com', { expectedSchoolId: 'school1', ...input })),
    error => error.code === 'permission-denied');
  await assert.rejects(f.handlers.publishParentReportCard(f.headRequest({ ...input, year: 'wrong' })),
    error => error.code === 'failed-precondition');
  const result = await f.handlers.publishParentReportCard(f.headRequest(input));
  assert.equal(result.published, true);
  assert.equal(f.files.size, 1);
  const invitation = await f.handlers.createParentPortalInvitation(f.headRequest({ studentId: 'pupil1', email: 'parent@example.com' }));
  await f.handlers.claimParentPortalInvitation(f.request('parent', 'parent@example.com', { inviteCode: invitation.inviteCode }));
  const data = await f.handlers.getParentPortalData(f.request('parent', 'parent@example.com'));
  assert.deepEqual(data.publishedReports, [{ reportId: result.reportId, studentId: 'pupil1', term: 'Term 1', year: '2026-2027' }]);
  const download = await f.handlers.getParentReportCard(f.request('parent', 'parent@example.com', { reportId: result.reportId }));
  assert.equal(download.pdfBase64, pdfBase64);
  await assert.rejects(f.handlers.getParentReportCard(f.request('someone', 'someone@example.com', { reportId: result.reportId })),
    error => error.code === 'permission-denied');
  await f.handlers.revokeParentPortalLink(f.headRequest({ parentUid: 'parent', studentId: 'pupil1' }));
  await assert.rejects(f.handlers.getParentReportCard(f.request('parent', 'parent@example.com', { reportId: result.reportId })),
    error => error.code === 'permission-denied');
});

test('Parent Portal invitations require an active Head Teacher and verified email, and claim only for the invited email', async () => {
  const f = fixture();
  await assert.rejects(
    f.handlers.createParentPortalInvitation(f.request('teacher', 'teacher@example.com', { expectedSchoolId: 'school1', studentId: 'pupil1', email: 'parent@example.com' })),
    error => error.code === 'permission-denied'
  );
  await assert.rejects(
    f.handlers.createParentPortalInvitation(f.request('head', 'head@example.com', { expectedSchoolId: 'school1', studentId: 'pupil1', email: 'parent@example.com' }, false)),
    error => error.code === 'failed-precondition'
  );

  const invitation = await f.handlers.createParentPortalInvitation(f.headRequest({ studentId: 'pupil1', email: ' PARENT@example.com ' }));
  const [schoolId, secret] = invitation.inviteCode.split('.');
  const invitePath = `schools/${schoolId}/parentPortalInvites/${crypto.createHash('sha256').update(secret).digest('hex')}`;
  assert.equal(f.records.get(invitePath).email, 'parent@example.com');
  assert.equal(f.records.get(invitePath).status, 'pending');
  assert.equal(invitation.studentName, 'Pupil One');

  await assert.rejects(
    f.handlers.claimParentPortalInvitation(f.request('parent', 'someone-else@example.com', { inviteCode: invitation.inviteCode })),
    error => error.code === 'permission-denied'
  );
  assert.equal(f.records.get(invitePath).status, 'pending');
  const claimed = await f.handlers.claimParentPortalInvitation(f.request('parent', 'parent@example.com', { inviteCode: invitation.inviteCode }));
  assert.equal(claimed.claimed, true);
  assert.deepEqual(f.records.get('schools/school1/parentPortalAccess/parent').studentIds, ['pupil1']);
  assert.equal(f.records.get('users/parent').role, 'parent');
  await assert.rejects(
    f.handlers.claimParentPortalInvitation(f.request('parent', 'parent@example.com', { inviteCode: invitation.inviteCode })),
    error => error.code === 'failed-precondition'
  );
});

test('parent data is restricted to linked learners and returns only safe attendance, reports, grades and fee balances', async () => {
  const f = fixture();
  const invitation = await f.handlers.createParentPortalInvitation(f.headRequest({ studentId: 'pupil1', email: 'parent@example.com' }));
  await f.handlers.claimParentPortalInvitation(f.request('parent', 'parent@example.com', { inviteCode: invitation.inviteCode }));

  const result = await f.handlers.getParentPortalData(f.request('parent', 'parent@example.com'));
  assert.deepEqual(result.students, [{ id: 'pupil1', name: 'Pupil One', admissionId: 'A-1', classId: 'class1', className: 'Class One', isActive: true }]);
  assert.deepEqual(result.attendance, [{ studentId: 'pupil1', date: '2026-11-25', term: 'Term 1', year: '2026-2027', status: 'Present' }]);
  assert.deepEqual(result.grades, [{ studentId: 'pupil1', term: 'Term 1', year: '2026-2027', subjects: [{ subject: 'Mathematics', classScore: 18, examScore: 72 }] }]);
  assert.deepEqual(result.reports, [{ studentId: 'pupil1', term: 'Term 1', year: '2026-2027', comment: 'Making good progress' }]);
  assert.deepEqual(result.fees, [{ studentId: 'pupil1', totalBalance: 1200, currentTermBalance: 700, previousBalance: 500, currency: 'GHS' }]);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('Other Pupil'), false);
  assert.equal(JSON.stringify(result).includes('Other pupil report'), false);

  await assert.rejects(
    f.handlers.getParentPortalData(f.request('parent', 'different@example.com')),
    error => error.code === 'permission-denied'
  );
});

test('Head Teacher can inspect linked parents and revoke the last learner link', async () => {
  const f = fixture();
  const invitation = await f.handlers.createParentPortalInvitation(f.headRequest({ studentId: 'pupil1', email: 'parent@example.com' }));
  await f.handlers.claimParentPortalInvitation(f.request('parent', 'parent@example.com', { inviteCode: invitation.inviteCode }));
  const overview = await f.handlers.getParentPortalOverview(f.headRequest({}));
  assert.deepEqual(overview.parents, [{ uid: 'parent', email: 'parent@example.com', students: [{ id: 'pupil1', name: 'Pupil One', admissionId: 'A-1', classId: 'class1', className: 'Class One', isActive: true }] }]);
  assert.deepEqual(await f.handlers.revokeParentPortalLink(f.headRequest({ parentUid: 'parent', studentId: 'pupil1' })), { removed: true });
  assert.equal(f.records.has('schools/school1/parentPortalAccess/parent'), false);
  assert.equal(f.records.get('users/parent').status, 'removed');
  await assert.rejects(
    f.handlers.getParentPortalData(f.request('parent', 'parent@example.com')),
    error => error.code === 'permission-denied'
  );
});
