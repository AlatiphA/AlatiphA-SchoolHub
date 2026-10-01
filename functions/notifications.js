'use strict';

const crypto = require('node:crypto');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');

function register({ onCall, HttpsError, db, admin }) {
  const call = fn => onCall({ region: 'us-central1', invoker: 'public' }, fn);
  const fail = (code, message) => { throw new HttpsError(code, message); };
  const clean = (value, max = 500) => String(value || '').trim().slice(0, max);
  const sameIds = (a, b) => JSON.stringify([...(Array.isArray(a) ? a : [])].map(String).sort()) === JSON.stringify([...(Array.isArray(b) ? b : [])].map(String).sort());
  const eventId = (prefix, event, uid = '') => `${prefix}_${clean(event && event.id, 180).replace(/[^A-Za-z0-9_-]/g, '_')}_${clean(uid, 80).replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 480);
  const notificationRef = (uid, id) => db.collection('users').doc(uid).collection('notifications').doc(id);

  async function schoolInfo(schoolId) {
    if (!schoolId) return null;
    const snap = await db.collection('schools').doc(schoolId).get();
    if (!snap.exists) return null;
    const data = snap.data() || {};
    return {
      id: schoolId,
      ownerUid: clean(data.ownerUid, 200),
      name: clean(data.profile && data.profile.schoolName, 200) || 'your school'
    };
  }

  function notificationData({ title, body, type, action, schoolId, actorUid, actorName, meta }) {
    return {
      title: clean(title, 160),
      body: clean(body, 1000),
      type: clean(type, 80),
      action: clean(action, 80),
      schoolId: clean(schoolId, 200),
      actorUid: clean(actorUid, 200),
      actorName: clean(actorName, 200),
      meta: meta && typeof meta === 'object' ? meta : {},
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
  }

  async function createNotification(uid, id, data) {
    if (!uid || !id) return false;
    const ref = notificationRef(uid, id);
    let created = false;
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (snap.exists) return;
      tx.set(ref, data);
      created = true;
    });
    return created;
  }

  async function activeHeadForSchool(school) {
    if (!school || !school.ownerUid) return null;
    const snap = await db.collection('users').doc(school.ownerUid).get();
    if (!snap.exists) return null;
    const data = snap.data() || {};
    if (data.role !== 'headteacher' || data.status !== 'active' || data.schoolId !== school.id) return null;
    return { uid: school.ownerUid, data };
  }

  const onUserMembershipNotification = onDocumentWritten(
    { document: 'users/{uid}', region: 'us-central1' },
    async event => {
      const before = event.data && event.data.before && event.data.before.exists ? (event.data.before.data() || {}) : null;
      const after = event.data && event.data.after && event.data.after.exists ? (event.data.after.data() || {}) : null;
      if (!after) return;

      const wasTeacher = before && before.role === 'teacher';
      const isTeacher = after.role === 'teacher';
      if (!wasTeacher && !isTeacher) return;

      const uid = event.params.uid;
      const schoolId = clean(after.schoolId || (before && before.schoolId), 200);
      if (!schoolId) return;
      const school = await schoolInfo(schoolId);
      if (!school) return;

      const displayName = clean(
        after.displayName || after.email ||
        (before && (before.displayName || before.email)) ||
        'A teacher',
        200
      );

      if (
        isTeacher &&
        after.status === 'pending' &&
        after.schoolId &&
        (!before || before.status !== 'pending' || before.schoolId !== after.schoolId)
      ) {
        const head = await activeHeadForSchool(school);
        if (head) {
          await createNotification(
            head.uid,
            eventId('join_request', event, uid),
            notificationData({
              title: 'New teacher join request',
              body: `${displayName} requested to join ${school.name}.`,
              type: 'teacher_join_request',
              action: 'manage-teachers',
              schoolId,
              actorUid: uid,
              actorName: displayName,
              meta: { teacherUid: uid }
            })
          );
        }
        return;
      }

      if (before && before.status === 'pending' && after.status === 'active') {
        await createNotification(
          uid,
          eventId('approved', event, uid),
          notificationData({
            title: 'SchoolHub access approved',
            body: `Your account has been approved for ${school.name}. You can now use your assigned classes and subjects.`,
            type: 'teacher_approved',
            action: 'home',
            schoolId,
            actorUid: school.ownerUid,
            actorName: 'Head Teacher'
          })
        );
        return;
      }

      if (before && before.status === 'active' && after.status === 'disabled') {
        await createNotification(
          uid,
          eventId('disabled', event, uid),
          notificationData({
            title: 'SchoolHub access disabled',
            body: `Your access to ${school.name} has been disabled by the Head Teacher.`,
            type: 'teacher_disabled',
            action: '',
            schoolId,
            actorUid: school.ownerUid,
            actorName: 'Head Teacher'
          })
        );
        return;
      }

      if (before && before.status === 'disabled' && after.status === 'active') {
        await createNotification(
          uid,
          eventId('reactivated', event, uid),
          notificationData({
            title: 'SchoolHub access reactivated',
            body: `Your access to ${school.name} has been reactivated.`,
            type: 'teacher_reactivated',
            action: 'home',
            schoolId,
            actorUid: school.ownerUid,
            actorName: 'Head Teacher'
          })
        );
        return;
      }

      if (before && before.status === 'pending' && after.status === 'rejected') {
        await createNotification(
          uid,
          eventId('rejected', event, uid),
          notificationData({
            title: 'School join request rejected',
            body: `Your request to join ${school.name} was rejected. Contact the Head Teacher if you need help.`,
            type: 'teacher_rejected',
            action: '',
            schoolId,
            actorUid: school.ownerUid,
            actorName: 'Head Teacher'
          })
        );
        return;
      }

      if (before && ['active', 'disabled'].includes(before.status) && after.status === 'removed') {
        await createNotification(
          uid,
          eventId('removed', event, uid),
          notificationData({
            title: 'Removed from school',
            body: `Your SchoolHub membership for ${school.name} has been removed. You will need the school join code to request access again.`,
            type: 'teacher_removed',
            action: '',
            schoolId,
            actorUid: school.ownerUid,
            actorName: 'Head Teacher'
          })
        );
        return;
      }

      if (
        before &&
        before.status === 'active' &&
        after.status === 'active' &&
        before.schoolId === after.schoolId &&
        (!sameIds(before.assignedClassIds, after.assignedClassIds) ||
         !sameIds(before.assignedSubjectIds, after.assignedSubjectIds))
      ) {
        await createNotification(
          uid,
          eventId('assignments', event, uid),
          notificationData({
            title: 'Teacher assignments updated',
            body: `Your class or subject assignments for ${school.name} have been updated by the Head Teacher.`,
            type: 'teacher_assignments_updated',
            action: 'home',
            schoolId,
            actorUid: school.ownerUid,
            actorName: 'Head Teacher'
          })
        );
      }
    }
  );

  const recordSchoolSignIn = call(async request => {
    if (!request.auth) fail('unauthenticated', 'Sign in first.');
    const uid = request.auth.uid;
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) return { notified: false, reason: 'no-school-membership' };
    const user = userSnap.data() || {};
    if (user.role !== 'teacher' || !user.schoolId || !['pending', 'active', 'disabled'].includes(user.status)) {
      return { notified: false, reason: 'not-a-school-teacher' };
    }

    const school = await schoolInfo(user.schoolId);
    const head = await activeHeadForSchool(school);
    if (!school || !head) return { notified: false, reason: 'head-teacher-unavailable' };

    const method = ['password', 'google'].includes(request.data && request.data.method) ? request.data.method : 'account';
    const name = clean(user.displayName || user.email || request.auth.token.email || 'A teacher', 200);
    const now = Date.now();
    const dedupeRef = db.collection('schools').doc(school.id).collection('notificationDedupe').doc(`signin_${uid}`);
    const id = `signin_${uid}_${crypto.randomUUID()}`;
    let created = false;

    await db.runTransaction(async tx => {
      const dedupeSnap = await tx.get(dedupeRef);
      const lastAt = dedupeSnap.exists && dedupeSnap.data().lastAt && typeof dedupeSnap.data().lastAt.toMillis === 'function'
        ? dedupeSnap.data().lastAt.toMillis()
        : 0;
      if (lastAt && now - lastAt < 120000) return;

      let body = `${name} signed in to ${school.name}.`;
      if (user.status === 'pending') body = `${name} signed in and is still waiting for approval to ${school.name}.`;
      if (user.status === 'disabled') body = `${name} signed in, but SchoolHub access to ${school.name} is disabled.`;

      tx.set(dedupeRef, {
        uid,
        lastAt: admin.firestore.Timestamp.fromMillis(now),
        method,
        notificationId: id
      }, { merge: true });

      tx.set(notificationRef(head.uid, id), notificationData({
        title: 'Teacher signed in',
        body,
        type: 'teacher_sign_in',
        action: 'manage-teachers',
        schoolId: school.id,
        actorUid: uid,
        actorName: name,
        meta: { teacherUid: uid, method, status: user.status }
      }));
      created = true;
    });

    return { notified: created, deduplicated: !created };
  });

  const sendSchoolAnnouncement = call(async request => {
    if (!request.auth) fail('unauthenticated', 'Sign in first.');
    const headSnap = await db.collection('users').doc(request.auth.uid).get();
    const head = headSnap.data() || {};
    if (head.role !== 'headteacher' || head.status !== 'active' || !head.schoolId) {
      fail('permission-denied', 'Only the active Head Teacher can send school announcements.');
    }

    const body = clean(request.data && request.data.body, 1000);
    if (!body) fail('invalid-argument', 'Enter an announcement.');
    if (body.length < 3) fail('invalid-argument', 'The announcement is too short.');

    const users = await db.collection('users').where('schoolId', '==', head.schoolId).get();
    const recipients = users.docs
      .map(doc => ({ uid: doc.id, ...(doc.data() || {}) }))
      .filter(member => member.uid !== request.auth.uid && member.role === 'teacher' && member.status === 'active');

    const school = await schoolInfo(head.schoolId);
    const announcementId = crypto.randomUUID();
    const actorName = clean(head.displayName || head.email || request.auth.token.email || 'Head Teacher', 200);

    await Promise.all(recipients.map(member =>
      createNotification(
        member.uid,
        `announcement_${announcementId}`,
        notificationData({
          title: 'School announcement',
          body,
          type: 'school_announcement',
          action: 'home',
          schoolId: head.schoolId,
          actorUid: request.auth.uid,
          actorName,
          meta: { announcementId }
        })
      )
    ));

    return { sent: recipients.length, schoolName: school ? school.name : '' };
  });

  return { onUserMembershipNotification, recordSchoolSignIn, sendSchoolAnnouncement };
}

module.exports = { register };
