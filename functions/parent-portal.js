'use strict';

const crypto = require('node:crypto');

function register({ onCall, HttpsError, db, admin }) {
  const fail = (code, message) => { throw new HttpsError(code, message); };
  const call = fn => onCall({ region: 'us-central1', invoker: 'public', timeoutSeconds: 90 }, fn);
  const normalizeEmail = value => String(value || '').trim().toLowerCase();
  const schoolIdValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const recordIdValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const schoolRef = id => db.collection('schools').doc(id);
  const emailFor = req => normalizeEmail(req.auth?.token?.email);
  const requireSignedIn = req => {
    if (!req.auth) fail('unauthenticated', 'Sign in to continue.');
    if (req.auth.token?.email_verified !== true || !emailFor(req)) {
      fail('failed-precondition', 'Verify your email address before using the Parent Portal.');
    }
  };

  async function headTeacher(req) {
    requireSignedIn(req);
    const user = (await db.collection('users').doc(req.auth.uid).get()).data();
    if (!user || user.role !== 'headteacher' || user.status !== 'active' || !user.schoolId) {
      fail('permission-denied', 'Only the active Head Teacher can manage Parent Portal access.');
    }
    if (req.data?.expectedSchoolId !== user.schoolId) {
      fail('failed-precondition', 'Your school changed. Reopen the Parent Portal and try again.');
    }
    return user;
  }

  async function parentMembership(req) {
    requireSignedIn(req);
    const user = (await db.collection('users').doc(req.auth.uid).get()).data();
    if (!user || user.role !== 'parent' || user.status !== 'active' || !user.schoolId) {
      fail('permission-denied', 'This account does not have active Parent Portal access.');
    }
    if (normalizeEmail(user.email) !== emailFor(req)) {
      fail('permission-denied', 'Sign in with the verified email linked to this Parent Portal.');
    }
    return user;
  }

  function linkedStudent(student, id, className) {
    return {
      id,
      name: String(student.name || 'Learner').slice(0, 200),
      admissionId: String(student.admissionId || '').slice(0, 80),
      classId: String(student.classId || ''),
      className: String(className || 'Class not set').slice(0, 120),
      isActive: student.isActive !== false
    };
  }

  const validParentCode = value => {
    if (typeof value !== 'string' || value.length > 200) return null;
    const match = /^([A-Za-z0-9_-]{1,128})\.([A-Za-z0-9_-]{40,60})$/.exec(value.trim());
    return match ? { schoolId: match[1], secret: match[2] } : null;
  };

  const createParentPortalInvitation = call(async req => {
    const user = await headTeacher(req);
    const studentId = req.data?.studentId;
    const email = normalizeEmail(req.data?.email);
    if (!recordIdValid(studentId)) fail('invalid-argument', 'Choose a learner.');
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      fail('invalid-argument', 'Enter a valid parent or guardian email address.');
    }
    const secret = crypto.randomBytes(32).toString('base64url');
    const inviteCode = `${user.schoolId}.${secret}`;
    const inviteRef = schoolRef(user.schoolId).collection('parentPortalInvites').doc(hash(secret));
    const studentRef = schoolRef(user.schoolId).collection('students').doc(studentId);
    const schoolDoc = await schoolRef(user.schoolId).get();
    if (!schoolDoc.exists) fail('not-found', 'School record not found.');
    const studentDoc = await studentRef.get();
    if (!studentDoc.exists || studentDoc.data()?.isActive === false) {
      fail('not-found', 'The selected active learner record was not found.');
    }
    const expiresAtMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
    await inviteRef.create({
      email,
      studentId,
      studentName: String(studentDoc.data()?.name || 'Learner').slice(0, 200),
      status: 'pending',
      createdBy: req.auth.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAtMs
    });
    return { inviteCode, expiresAtMs, studentName: String(studentDoc.data()?.name || 'Learner') };
  });

  const claimParentPortalInvitation = call(async req => {
    requireSignedIn(req);
    const parsed = validParentCode(req.data?.inviteCode);
    if (!parsed) fail('invalid-argument', 'That invitation code is not valid. Check it and try again.');
    const { schoolId, secret } = parsed;
    const email = emailFor(req);
    const inviteRef = schoolRef(schoolId).collection('parentPortalInvites').doc(hash(secret));
    const parentRef = db.collection('users').doc(req.auth.uid);
    const linkRef = schoolRef(schoolId).collection('parentPortalAccess').doc(req.auth.uid);
    return db.runTransaction(async tx => {
      const [inviteSnap, schoolSnap, parentSnap, linkSnap] = await Promise.all([
        tx.get(inviteRef), tx.get(schoolRef(schoolId)), tx.get(parentRef), tx.get(linkRef)
      ]);
      if (!schoolSnap.exists) fail('not-found', 'The school for this invitation could not be found.');
      const invite = inviteSnap.data() || {};
      if (!inviteSnap.exists || invite.status !== 'pending' || Number(invite.expiresAtMs || 0) <= Date.now()) {
        fail('failed-precondition', 'This invitation has expired or has already been used. Ask the school for a new one.');
      }
      if (normalizeEmail(invite.email) !== email) {
        fail('permission-denied', 'This invitation was issued to a different email address. Sign in with that verified email.');
      }
      const current = parentSnap.data() || {};
      const activeMembership = current.schoolId && ['active', 'pending', 'disabled'].includes(current.status);
      if (activeMembership && (current.role !== 'parent' || current.schoolId !== schoolId || current.status !== 'active')) {
        fail('failed-precondition', 'This account already belongs to a school. Use a separate parent email account.');
      }
      const priorIds = Array.isArray(linkSnap.data()?.studentIds) ? linkSnap.data().studentIds : [];
      if (!priorIds.includes(invite.studentId) && priorIds.length >= 20) {
        fail('resource-exhausted', 'This Parent Portal account has reached its learner limit. Contact the school.');
      }
      const studentRef = schoolRef(schoolId).collection('students').doc(invite.studentId);
      const studentSnap = await tx.get(studentRef);
      if (!studentSnap.exists || studentSnap.data()?.isActive === false) {
        fail('failed-precondition', 'The linked learner is no longer active. Contact the school.');
      }
      const now = admin.firestore.FieldValue.serverTimestamp();
      tx.set(parentRef, {
        schoolId,
        role: 'parent',
        status: 'active',
        email,
        displayName: String(req.auth.token?.name || req.auth.token?.display_name || '').slice(0, 200),
        createdAt: current.createdAt || now,
        parentPortalUpdatedAt: now
      }, { merge: true });
      tx.set(linkRef, {
        studentIds: [...new Set([...priorIds, invite.studentId])],
        updatedAt: now,
        ...(linkSnap.exists ? {} : { createdAt: now })
      }, { merge: true });
      tx.update(inviteRef, { status: 'claimed', claimedBy: req.auth.uid, claimedAt: now });
      return { claimed: true, schoolName: String(schoolSnap.data()?.profile?.schoolName || schoolSnap.data()?.name || 'School') };
    });
  });

  const getParentPortalData = call(async req => {
    const parent = await parentMembership(req);
    const school = schoolRef(parent.schoolId);
    const [schoolSnap, linksSnap] = await Promise.all([
      school.get(), school.collection('parentPortalAccess').doc(req.auth.uid).get()
    ]);
    const studentIds = Array.isArray(linksSnap.data()?.studentIds)
      ? [...new Set(linksSnap.data().studentIds.filter(recordIdValid))].slice(0, 20) : [];
    if (!schoolSnap.exists || !studentIds.length) fail('permission-denied', 'No learners are currently linked to this account. Contact the school.');
    const [studentSnaps, classSnap, subjectSnap] = await Promise.all([
      Promise.all(studentIds.map(id => school.collection('students').doc(id).get())),
      school.collection('classes').get(),
      school.collection('subjects').get()
    ]);
    const classes = new Map(classSnap.docs.map(doc => [doc.id, String(doc.data()?.name || '')]));
    const subjects = new Map(subjectSnap.docs.map(doc => [doc.id, String(doc.data()?.name || doc.id)]));
    const students = studentSnaps.flatMap((doc, i) => doc.exists
      ? [linkedStudent(doc.data() || {}, studentIds[i], classes.get(doc.data()?.classId))] : []);
    if (!students.length) fail('permission-denied', 'The linked learner records are no longer available. Contact the school.');

    const profile = schoolSnap.data()?.profile || {};
    const year = String(profile.currentYear || '');
    const currentTerm = String(profile.currentTerm || '');
    const attendanceSnap = year
      ? await school.collection('attendance').where('year', '==', year).limit(1200).get()
      : { docs: [] };
    const attendance = [];
    for (const doc of attendanceSnap.docs) {
      const row = doc.data() || {};
      const entries = row.entries && typeof row.entries === 'object' ? row.entries : {};
      for (const pupil of students) {
        const status = entries[pupil.id];
        if (typeof status === 'string' && status) {
          attendance.push({ studentId: pupil.id, date: String(row.date || ''), term: String(row.term || ''), year: String(row.year || year), status: status.slice(0, 30) });
        }
      }
    }
    attendance.sort((a, b) => b.date.localeCompare(a.date));

    const classIds = [...new Set(students.map(student => student.classId).filter(recordIdValid))];
    const gradeSnapshots = await Promise.all(classIds.map(id => school.collection('grades').where('classId', '==', id).limit(200).get()));
    const remarkSnapshots = await Promise.all(classIds.map(id => school.collection('remarks').where('classId', '==', id).limit(200).get()));
    const grades = [];
    const reports = [];
    const appendAcademic = (snapshots, destination, kind) => {
      for (const snapshot of snapshots) for (const doc of snapshot.docs) {
        const row = doc.data() || {};
        const key = decodeURIComponent(doc.id);
        const parts = key.split('__');
        const term = String(parts[1] || '');
        const recordYear = String(parts.slice(2).join('__') || '');
        const entries = row.entries && typeof row.entries === 'object' ? row.entries : {};
        for (const pupil of students) {
          if (String(row.classId || '') !== pupil.classId || !entries[pupil.id] || typeof entries[pupil.id] !== 'object') continue;
          if (kind === 'grades') {
            const scores = entries[pupil.id];
            const subjectsForPupil = Object.entries(scores).map(([subjectId, mark]) => ({
              subject: String(subjects.get(subjectId) || subjectId).slice(0, 120),
              classScore: Number.isFinite(Number(mark?.c)) ? Number(mark.c) : null,
              examScore: Number.isFinite(Number(mark?.e)) ? Number(mark.e) : null
            }));
            destination.push({ studentId: pupil.id, term, year: recordYear, subjects: subjectsForPupil });
          } else {
            const report = entries[pupil.id];
            const safeReport = {};
            for (const field of ['attendance', 'promoted', 'conduct', 'attitude', 'interest', 'comment']) {
              if (typeof report[field] === 'string' || typeof report[field] === 'number') safeReport[field] = String(report[field]).slice(0, 1000);
            }
            if (Object.keys(safeReport).length) destination.push({ studentId: pupil.id, term, year: recordYear, ...safeReport });
          }
        }
      }
    };
    appendAcademic(gradeSnapshots, grades, 'grades');
    appendAcademic(remarkSnapshots, reports, 'reports');

    const financialRows = await Promise.all(students.map(async pupil => {
      const [chargesSnap, accountsSnap] = await Promise.all([
        school.collection('pupilCharges').where('studentId', '==', pupil.id).get(),
        school.collection('feeAccounts').where('studentId', '==', pupil.id).get()
      ]);
      const charges = chargesSnap.docs.map(doc => ({ id: doc.id, ...(doc.data() || {}) }));
      const chargeIds = new Set(charges.map(item => item.id));
      const chargeBalance = item => item.cancelled ? 0 : Math.max(0,
        Number(item.baseAmount ?? item.base ?? 0) + Number(item.adjustment || 0) - Number(item.paid || 0));
      const rows = charges.filter(item => item.isTestData !== true).map(item => ({
        term: String(item.term || ''), year: String(item.year || ''), amount: chargeBalance(item)
      }));
      for (const doc of accountsSnap.docs) {
        if (chargeIds.has(doc.id)) continue;
        const item = doc.data() || {};
        if (item.isTestData === true) continue;
        rows.push({ term: String(item.term || ''), year: String(item.year || ''), amount: item.cancelled ? 0 : Math.max(0, Number(item.base || 0) + Number(item.adjustment || 0) - Number(item.paid || 0)) });
      }
      const total = rows.reduce((sum, item) => sum + item.amount, 0);
      const current = rows.filter(item => item.term === currentTerm && item.year === year).reduce((sum, item) => sum + item.amount, 0);
      return { studentId: pupil.id, totalBalance: total, currentTermBalance: current, previousBalance: Math.max(0, total - current), currency: 'GHS' };
    }));

    return {
      schoolName: String(profile.schoolName || schoolSnap.data()?.name || 'School'),
      currentTerm,
      currentYear: year,
      students,
      attendance: attendance.slice(0, 600),
      grades: grades.slice(0, 400),
      reports: reports.slice(0, 400),
      fees: financialRows
    };
  });

  const getParentPortalOverview = call(async req => {
    const user = await headTeacher(req);
    const school = schoolRef(user.schoolId);
    const [linksSnap, classesSnap] = await Promise.all([
      school.collection('parentPortalAccess').limit(200).get(), school.collection('classes').get()
    ]);
    const classes = new Map(classesSnap.docs.map(doc => [doc.id, String(doc.data()?.name || '')]));
    const linkedParents = await Promise.all(linksSnap.docs.map(async doc => {
      const studentIds = Array.isArray(doc.data()?.studentIds) ? doc.data().studentIds.filter(recordIdValid).slice(0, 20) : [];
      const [accountSnap, studentSnaps] = await Promise.all([
        db.collection('users').doc(doc.id).get(),
        Promise.all(studentIds.map(id => school.collection('students').doc(id).get()))
      ]);
      const linked = studentSnaps.flatMap((snap, i) => snap.exists
        ? [linkedStudent(snap.data() || {}, studentIds[i], classes.get(snap.data()?.classId))] : []);
      if (!linked.length) return null;
      return { uid: doc.id, email: normalizeEmail(accountSnap.data()?.email), students: linked };
    }));
    return { parents: linkedParents.filter(Boolean).sort((a, b) => a.email.localeCompare(b.email)) };
  });

  const revokeParentPortalLink = call(async req => {
    const user = await headTeacher(req);
    const parentUid = req.data?.parentUid;
    const studentId = req.data?.studentId;
    if (typeof parentUid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(parentUid) || !recordIdValid(studentId)) {
      fail('invalid-argument', 'Choose the parent and learner access to remove.');
    }
    const school = schoolRef(user.schoolId);
    const linkRef = school.collection('parentPortalAccess').doc(parentUid);
    return db.runTransaction(async tx => {
      const [linkSnap, parentSnap] = await Promise.all([tx.get(linkRef), tx.get(db.collection('users').doc(parentUid))]);
      const link = linkSnap.data() || {};
      if (!linkSnap.exists || !Array.isArray(link.studentIds) || !link.studentIds.includes(studentId)) {
        fail('not-found', 'That parent link has already been removed. Refresh the list.');
      }
      const remaining = link.studentIds.filter(id => id !== studentId);
      if (remaining.length) tx.update(linkRef, { studentIds: remaining, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      else tx.delete(linkRef);
      const parent = parentSnap.data() || {};
      if (!remaining.length && parent.role === 'parent' && parent.schoolId === user.schoolId) {
        tx.update(db.collection('users').doc(parentUid), { status: 'removed', schoolId: '', parentPortalUpdatedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
      return { removed: true };
    });
  });

  return { createParentPortalInvitation, claimParentPortalInvitation, getParentPortalData, getParentPortalOverview, revokeParentPortalLink };
}

module.exports = { register };
