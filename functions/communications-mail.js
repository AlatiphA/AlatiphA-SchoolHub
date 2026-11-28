'use strict';

const nodemailer = require('nodemailer');
const { createMailConnection } = require('./mail-connection');

function register({ onCall, HttpsError, db, admin, mailKey, createTransport = nodemailer.createTransport, resolveAddresses }) {
  const fail = (code, message) => { throw new HttpsError(code, message); };
  const options = { region: 'us-central1', invoker: 'public', timeoutSeconds: 90, secrets: [mailKey].filter(Boolean) };
  const call = fn => onCall(options, fn);
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const email = value => String(value || '').trim().toLowerCase();
  const validEmail = value => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value) && value.length <= 254;
  const connection = createMailConnection({ db, mailKey: mailKey || { value: () => '' }, createTransport, resolveAddresses });

  async function sender(req) {
    if (!req.auth || req.auth.token?.email_verified !== true) fail('unauthenticated', 'Sign in with a verified school account.');
    const user = (await db.collection('users').doc(req.auth.uid).get()).data();
    if (!user || user.status !== 'active' || !id(user.schoolId) || !['headteacher', 'teacher'].includes(user.role)
      || req.data?.expectedSchoolId !== user.schoolId) fail('permission-denied', 'School report access is required.');
    return user;
  }

  async function schoolMail(user) {
    const school = db.collection('schools').doc(user.schoolId);
    const snap = await school.get();
    const schoolEmail = email(snap.data()?.profile?.email);
    const linked = await connection.read(user.schoolId, schoolEmail);
    const settings = linked.settings;
    return { school, schoolEmail, settings, pending: linked.status === 'pending' };
  }

  async function headTeacher(req) {
    const user = await sender(req);
    if (user.role !== 'headteacher') fail('permission-denied', 'Only the Head Teacher can connect the school email.');
    return user;
  }

  const getSchoolMailStatus = call(async req => {
    const user = await sender(req);
    const { schoolEmail, settings, pending } = await schoolMail(user);
    return { configured: !!settings, from: settings ? email(settings.from) : '', schoolEmail, pending };
  });

  const beginSchoolMailConnection = call(async req => {
    const user = await headTeacher(req);
    const { schoolEmail } = await schoolMail(user);
    try { return await connection.begin(user.schoolId, schoolEmail, req.data); }
    catch (error) {
      const message = String(error.message || '');
      const allowed = ['Use the school email and valid outgoing mail details.', 'Wait one minute before requesting another verification code.', 'The outgoing mail server has no public address.', 'The school address did not accept the verification email.'];
      fail('failed-precondition', allowed.includes(message) ? message : 'Could not send the verification email. Check the mailbox credentials and server details.');
    }
  });

  const confirmSchoolMailConnection = call(async req => {
    const user = await headTeacher(req);
    const { schoolEmail } = await schoolMail(user);
    try { return await connection.confirm(user.schoolId, schoolEmail, String(req.data?.code || '').trim()); }
    catch (error) {
      const message = String(error.message || '');
      const allowed = ['Verification expired. Start the connection again.', 'That verification code is incorrect.'];
      fail('failed-precondition', allowed.includes(message) ? message : 'Could not confirm the school mail account. Try again.');
    }
  });

  const disconnectSchoolMailConnection = call(async req => {
    const user = await headTeacher(req);
    return connection.disconnect(user.schoolId);
  });

  const sendParentReportEmail = call(async req => {
    const user = await sender(req);
    const { school, settings } = await schoolMail(user);
    if (!settings) fail('failed-precondition', 'This school needs an outgoing mail account matching its saved school email. Use the email draft or Parent Portal until it is set up.');
    const reportId = req.data?.reportId;
    const requestId = req.data?.requestId;
    if (typeof reportId !== 'string' || !/^[a-f0-9]{64}$/.test(reportId) || !id(requestId)) {
      fail('invalid-argument', 'Choose the published report and try again.');
    }
    const subject = String(req.data?.subject || '').trim();
    const text = String(req.data?.text || '').trim();
    if (!subject || subject.length > 180 || /[\r\n]/.test(subject) || !text || text.length > 5000) {
      fail('invalid-argument', 'Review the email subject and message before sending.');
    }
    const reportSnap = await school.collection('publishedReports').doc(reportId).get();
    const report = reportSnap.data() || {};
    if (!reportSnap.exists || !id(report.studentId) || !id(report.classId)) fail('not-found', 'Publish this report before sending email.');
    if (user.role === 'teacher' && (!(user.assignedClassIds || []).includes(report.classId) || !(user.formClassIds || []).includes(report.classId))) {
      fail('permission-denied', 'Only the Head Teacher or assigned class/form teacher can send this report.');
    }
    const studentSnap = await school.collection('students').doc(report.studentId).get();
    const student = studentSnap.data() || {};
    if (!studentSnap.exists || student.isActive === false || student.classId !== report.classId) {
      fail('failed-precondition', 'The learner record changed. Review it before sending.');
    }
    const recipient = email(student.parentEmail);
    if (!validEmail(recipient) || recipient !== email(req.data?.recipient)) {
      fail('failed-precondition', 'The saved Parent/Guardian Email changed. Review the learner record before sending.');
    }
    const expectedPath = `schools/${user.schoolId}/published-reports/${report.studentId}/${reportId}.pdf`;
    if (report.storagePath !== expectedPath) fail('data-loss', 'The published PDF is unavailable.');
    const jobRef = school.collection('reportEmailSends').doc(requestId);
    try {
      await jobRef.create({ studentId: report.studentId, reportId, recipient, state: 'sending',
        requestedBy: req.auth.uid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    } catch (error) {
      if (error.code === 6 || error.code === 'already-exists') {
        fail('already-exists', 'This send was already started. Check the status before retrying.');
      }
      throw error;
    }
    try {
      const [pdf] = await admin.storage().bucket().file(expectedPath).download();
      if (pdf.length > 5_000_000 || pdf.subarray(0, 5).toString() !== '%PDF-') {
        fail('data-loss', 'The published PDF is invalid. Generate and publish it again.');
      }
      const transporter = await connection.transport(settings);
      let outcome;
      try { outcome = await transporter.sendMail({
        from: settings.from, to: recipient, replyTo: settings.replyTo || settings.from,
        subject, text,
        attachments: [{ filename: `${String(student.name || 'Learner').replace(/[^A-Za-z0-9_-]+/g, '_')}_report.pdf`, content: pdf, contentType: 'application/pdf' }]
      }); } finally { transporter.close?.(); }
      if (!Array.isArray(outcome.accepted) || !outcome.accepted.map(email).includes(recipient)) {
        throw new Error('The mail server did not accept the parent address.');
      }
      await jobRef.update({ state: 'accepted', messageId: String(outcome.messageId || '').slice(0, 256),
        acceptedAt: admin.firestore.FieldValue.serverTimestamp() });
      return { accepted: true, recipient, from: email(settings.from) };
    } catch (error) {
      await jobRef.update({ state: 'needs-review', error: String(error.message || error).slice(0, 400),
        reviewedAt: admin.firestore.FieldValue.serverTimestamp() });
      fail('unavailable', 'Email delivery was not confirmed. Check the sender’s Sent folder before trying again.');
    }
  });

  return { getSchoolMailStatus, beginSchoolMailConnection, confirmSchoolMailConnection,
    disconnectSchoolMailConnection, sendParentReportEmail };
}

module.exports = { register };
