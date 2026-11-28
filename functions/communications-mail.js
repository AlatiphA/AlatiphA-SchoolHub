'use strict';

const nodemailer = require('nodemailer');

function register({ onCall, HttpsError, db, admin, smtpConfig, createTransport = nodemailer.createTransport }) {
  const fail = (code, message) => { throw new HttpsError(code, message); };
  const options = { region: 'us-central1', invoker: 'public', timeoutSeconds: 90, secrets: [smtpConfig] };
  const call = fn => onCall(options, fn);
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const email = value => String(value || '').trim().toLowerCase();
  const validEmail = value => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value) && value.length <= 254;

  function config(schoolId, schoolEmail) {
    let stored;
    try { stored = JSON.parse(String(smtpConfig.value() || '{}')); }
    catch { return null; }
    const value = stored?.schools?.[schoolId] || (stored?.schoolId === schoolId ? stored : null);
    if (!validEmail(schoolEmail) || email(value?.from) !== schoolEmail) return null;
    if (value.enabled !== true || typeof value.host !== 'string' || !value.host.trim()
      || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
      || !validEmail(email(value.user)) || !validEmail(email(value.from))
      || typeof value.password !== 'string' || !value.password) return null;
    return value;
  }

  async function sender(req) {
    if (!req.auth || req.auth.token?.email_verified !== true) fail('unauthenticated', 'Sign in with a verified school account.');
    const user = (await db.collection('users').doc(req.auth.uid).get()).data();
    if (!user || user.status !== 'active' || !id(user.schoolId) || !['headteacher', 'teacher'].includes(user.role)
      || req.data?.expectedSchoolId !== user.schoolId) fail('permission-denied', 'School report access is required.');
    return user;
  }

  const getSchoolMailStatus = call(async req => {
    const user = await sender(req);
    const school = await db.collection('schools').doc(user.schoolId).get();
    const schoolEmail = email(school.data()?.profile?.email);
    const settings = config(user.schoolId, schoolEmail);
    return { configured: !!settings, from: settings ? email(settings.from) : '', schoolEmail };
  });

  const sendParentReportEmail = call(async req => {
    const user = await sender(req);
    const school = db.collection('schools').doc(user.schoolId);
    const schoolSnap = await school.get();
    const settings = config(user.schoolId, email(schoolSnap.data()?.profile?.email));
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
      const transporter = createTransport({
        host: settings.host, port: settings.port, secure: settings.port === 465,
        auth: { user: settings.user, pass: settings.password },
        connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000
      });
      const outcome = await transporter.sendMail({
        from: settings.from, to: recipient, replyTo: settings.replyTo || settings.from,
        subject, text,
        attachments: [{ filename: `${String(student.name || 'Learner').replace(/[^A-Za-z0-9_-]+/g, '_')}_report.pdf`, content: pdf, contentType: 'application/pdf' }]
      });
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

  return { getSchoolMailStatus, sendParentReportEmail };
}

module.exports = { register };
