'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { register } = require('../functions/communications-mail');

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function fixture() {
  const reportId = 'a'.repeat(64);
  const records = new Map([
    ['users/head', { schoolId: 'school1', role: 'headteacher', status: 'active' }],
    ['users/teacher', { schoolId: 'school1', role: 'teacher', status: 'active', assignedClassIds: ['class1'], formClassIds: [] }],
    [`schools/school1/publishedReports/${reportId}`, { studentId: 'pupil1', classId: 'class1', storagePath: `schools/school1/published-reports/pupil1/${reportId}.pdf` }],
    ['schools/school1/students/pupil1', { name: 'Pupil One', classId: 'class1', parentEmail: 'parent@example.com' }]
  ]);
  const sent = [];
  const db = { collection: name => ({ doc: id => ({
    async get() { return { exists: records.has(`${name}/${id}`), data: () => records.get(`${name}/${id}`) }; },
    collection: child => db.collection(`${name}/${id}/${child}`),
    async create(value) { if (records.has(`${name}/${id}`)) { const error = new Error('exists'); error.code = 6; throw error; } records.set(`${name}/${id}`, value); },
    async update(value) { records.set(`${name}/${id}`, { ...records.get(`${name}/${id}`), ...value }); }
  }) }) };
  const admin = {
    firestore: { FieldValue: { serverTimestamp: () => 123 } },
    storage: () => ({ bucket: () => ({ file: path => ({
      download: async () => { assert.equal(path, `schools/school1/published-reports/pupil1/${reportId}.pdf`); return [Buffer.from('%PDF-1.7\nreport')]; }
    }) }) })
  };
  const handlers = register({
    onCall: (_options, fn) => fn, HttpsError, db, admin,
    smtpConfig: { value: () => JSON.stringify({ enabled: true, host: 'smtp.example.com', port: 465, user: 'school@example.com', from: 'school@example.com', password: 'secret' }) },
    createTransport: options => ({ sendMail: async message => { sent.push({ options, message }); return { messageId: 'sent-1', accepted: [message.to] }; } })
  });
  const req = (uid, data = {}) => ({ auth: { uid, token: { email_verified: true } }, data: { expectedSchoolId: 'school1', ...data } });
  return { handlers, records, sent, req, reportId };
}

test('direct report email attaches only the published PDF and uses the saved parent address', async () => {
  const f = fixture();
  assert.deepEqual(await f.handlers.getSchoolMailStatus(f.req('head')), { configured: true, from: 'school@example.com' });
  const input = { requestId: 'request1', reportId: f.reportId, recipient: 'parent@example.com', subject: 'Report card', text: 'Please review the report.' };
  await assert.rejects(f.handlers.sendParentReportEmail(f.req('teacher', input)), error => error.code === 'permission-denied');
  await assert.rejects(f.handlers.sendParentReportEmail(f.req('head', { ...input, recipient: 'other@example.com' })), error => error.code === 'failed-precondition');
  assert.equal(f.sent.length, 0);
  assert.deepEqual(await f.handlers.sendParentReportEmail(f.req('head', input)), { accepted: true, recipient: 'parent@example.com', from: 'school@example.com' });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].message.to, 'parent@example.com');
  assert.equal(f.sent[0].message.attachments[0].content.toString(), '%PDF-1.7\nreport');
  await assert.rejects(f.handlers.sendParentReportEmail(f.req('head', input)), error => error.code === 'already-exists');
  assert.equal(f.sent.length, 1);
});
