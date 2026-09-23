// AlatiphA SchoolHub — app-4.js
// v40 sync-safety patch: non-destructive hydration, dirty-record upserts, explicit cloud-confirmed deletes.
const APP_VERSION = 'v40';

/* ---------- storage helpers ---------- */
const SYNC_OUTBOX_KEY = 'arc_sync_outbox_v1';
const VERIFIED_SESSION_PREFIX = 'arc_verified_session_v1__';
const syncDirtyKeys = new Map();
const syncBaseValues = new Map();
const SYNC_JOURNAL_KEY = 'arc_sync_journal_v2';
function recoverSyncJournal() {
  const raw = localStorage.getItem(SYNC_JOURNAL_KEY);
  if (!raw) return;
  const item = JSON.parse(raw);
  localStorage.setItem(SYNC_OUTBOX_KEY, item.outbox);
  localStorage.setItem(item.key, item.payload);
  localStorage.removeItem(SYNC_JOURNAL_KEY);
  syncDirtyKeys.clear(); syncBaseValues.clear(); loadPersistentSyncOutbox();
}
try { recoverSyncJournal(); } catch (error) {
  console.error('Pending save recovery is blocked; the saved journal has been retained.', error);
}
let offlineAuthenticatedMode = false;
let offlineReconnectInProgress = false;

function loadPersistentSyncOutbox() {
  try {
    const stored = JSON.parse(localStorage.getItem(SYNC_OUTBOX_KEY) || '{}');
    const parsed = stored.version === 2 ? stored.dirty : stored;
    Object.entries(stored.bases || {}).forEach(([key, value]) => syncBaseValues.set(key, value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    Object.keys(parsed).forEach(rawKey => {
      const ids = Array.isArray(parsed[rawKey]) ? parsed[rawKey].map(String).filter(Boolean) : [];
      if (ids.length) syncDirtyKeys.set(rawKey, new Set(ids));
    });
  } catch (e) {
    console.warn('Could not restore pending sync queue:', e);
  }
}

function syncOutboxJson() {
  const dirty = {};
  syncDirtyKeys.forEach((ids, key) => { if (ids.size) dirty[key] = Array.from(ids); });
  return JSON.stringify({version:2, dirty, bases:Object.fromEntries(syncBaseValues)});
}
function persistSyncOutbox() {
  localStorage.setItem(SYNC_OUTBOX_KEY, syncOutboxJson());
}

loadPersistentSyncOutbox();

function stableSyncJson(value) {
  try { return JSON.stringify(value); } catch (e) { return String(value); }
}

function markSyncDirty(rawKey, oldValue, newValue, deferPersist) {
  // Automatic synchronization is UPSERT-ONLY. A missing local record is never
  // interpreted as a cloud delete. Explicit Delete/Clear handlers are the only
  // code paths allowed to delete Firestore documents.
  const dirty = syncDirtyKeys.get(rawKey) || new Set();

  if (Array.isArray(newValue)) {
    const oldById = new Map((Array.isArray(oldValue) ? oldValue : [])
      .filter(item => item && item.id != null)
      .map(item => [String(item.id), item]));
    newValue.forEach(item => {
      if (!item || item.id == null) return;
      const id = String(item.id);
      if (!oldById.has(id) || stableSyncJson(oldById.get(id)) !== stableSyncJson(item)) dirty.add(id);
    });
  } else if (newValue && typeof newValue === 'object') {
    const oldObj = oldValue && typeof oldValue === 'object' && !Array.isArray(oldValue) ? oldValue : {};
    Object.keys(newValue).forEach(key => {
      if (!(key in oldObj) || stableSyncJson(oldObj[key]) !== stableSyncJson(newValue[key])) dirty.add(String(key));
    });
    // Deliberately do not mark keys that disappeared locally. Deletion must be
    // explicit and cloud-confirmed, never inferred from an incomplete cache.
  } else if (stableSyncJson(oldValue) !== stableSyncJson(newValue)) {
    dirty.add('__value__');
  }

  if (dirty.size) syncDirtyKeys.set(rawKey, dirty);
  const bases = syncBaseValues.get(rawKey) || {};
  dirty.forEach(id => {
    if (!Object.prototype.hasOwnProperty.call(bases, id)) {
      const previous = Array.isArray(oldValue) ? oldValue.find(item => item && String(item.id) === id) : oldValue && oldValue[id];
      bases[id] = previous === undefined ? null : JSON.parse(JSON.stringify(previous));
    }
  });
  syncBaseValues.set(rawKey, bases);
  if (!deferPersist) persistSyncOutbox();
}

function clearSyncDirty(rawKey, ids) {
  const dirty = syncDirtyKeys.get(rawKey);
  if (!dirty) return;
  (ids || []).forEach(id => { dirty.delete(String(id)); const bases=syncBaseValues.get(rawKey); if(bases) delete bases[String(id)]; });
  if (!dirty.size) syncDirtyKeys.delete(rawKey);
  persistSyncOutbox();
  updateOfflineModeBanner();
}

const DB = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      const v = JSON.parse(raw);
      if (v === null || v === undefined) return fallback;
      return restoreLocalImagesForDbKey(key, v);
    } catch (e) { return fallback; }
  },
  set(key, val, options) {
    const clean = stripImagesForLocalStorage(key, val);
    let oldClean = null;
    try {
      const previousRaw = localStorage.getItem(key);
      oldClean = previousRaw === null ? null : JSON.parse(previousRaw);
    } catch (e) {}
    const payload = JSON.stringify(clean);
    const outbound = !(options && options.skipCloudSync);
    try {
      recoverSyncJournal();
      if (outbound) {
        markSyncDirty(key, oldClean, clean, true);
        // One durable intent contains both the value and queue; replay after interruption.
        localStorage.setItem(SYNC_JOURNAL_KEY, JSON.stringify({key,payload,outbox:syncOutboxJson()}));
        persistSyncOutbox();
      }
      localStorage.setItem(key, payload);
      if (outbound) localStorage.removeItem(SYNC_JOURNAL_KEY);
    } catch (e) {
      // setItem is atomic on failure: keep the previous saved value intact.
      console.error('Could not save local data:', key, e);
      if (typeof alert === 'function') alert('This save could not be completed on this device. Keep this page open and export a backup before freeing browser storage. Your previous saved data and any recovery journal have been retained.');
      throw e;
    }
    // Cloud hydration/recovery writes never become outbound edits. Normal
    // local edits record only the records that actually changed.
    if (!(options && options.skipCloudSync)) {
      if (typeof scheduleCloudPush === 'function') scheduleCloudPush(key);
      updateOfflineModeBanner();
    }
  }
};

// currentUid identifies who's signed in (for reading their own users/{uid}
// doc). currentSchoolId is the actual data-namespacing boundary now:
// every teacher who belongs to the same school shares the same local
// cache, since it mirrors that school's one shared Firestore document.
// currentRole/currentStatus gate what a signed-in person can do once
// they're an active member of a school.
let currentUid = null;
let currentSchoolId = null;
let currentRole = null;   // 'headteacher' | 'teacher'
let currentStatus = null; // 'active' | 'pending'
let currentAssignedClassIds = [];
let currentAssignedSubjectIds = [];
let currentUserData = null;
let pendingStaffImport = null;

// Session isolation: every authentication transition receives a new token.
// Any asynchronous work started by a previous user must stop using its data
// once the token changes. This prevents stale Firestore responses from
// repainting or overwriting the next user's workspace.
let sessionGeneration = 0;
let sessionReady = false;
let sessionDataReady = false; // Core school data has finished loading for this session.
let cloudHydrationInProgress = false; // Suppresses cloud pushes caused by Firestore-to-local writes.
let manualSignOutInProgress = false; // Prevent Firebase auth transitions from re-blocking the login form during logout.

function ns(base) { return currentSchoolId ? `${base}__${currentSchoolId}${currentRole === 'teacher' ? '__user_' + currentUid : ''}` : base; }

function isCurrentSession(token, uid, schoolId) {
  return token === sessionGeneration
    && currentUid === uid
    && (schoolId == null || currentSchoolId === schoolId);
}

function verifiedSessionKey(uidValue) {
  return VERIFIED_SESSION_PREFIX + String(uidValue || '');
}

function saveVerifiedLocalSession(user, data) {
  if (!user || !user.uid || !data || data.status !== 'active' || !data.schoolId) return;
  const safe = {
    uid: String(user.uid),
    schoolId: String(data.schoolId),
    role: String(data.role || ''),
    status: 'active',
    assignedClassIds: Array.isArray(data.assignedClassIds) ? data.assignedClassIds.map(String) : [],
    assignedSubjectIds: Array.isArray(data.assignedSubjectIds) ? data.assignedSubjectIds.map(String) : [],
    email: String(data.email || user.email || ''),
    displayName: String(data.displayName || user.displayName || ''),
    verifiedAt: Date.now()
  };
  try { localStorage.setItem(verifiedSessionKey(user.uid), JSON.stringify(safe)); }
  catch (e) { console.warn('Could not cache verified session:', e); }
}

function loadVerifiedLocalSession(user) {
  if (!user || !user.uid) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(verifiedSessionKey(user.uid)) || 'null');
    if (!parsed || !Number.isFinite(parsed.verifiedAt) || Date.now() - parsed.verifiedAt > 24 * 60 * 60 * 1000 || parsed.verifiedAt > Date.now() || parsed.uid !== String(user.uid) || parsed.status !== 'active' ||
        !parsed.schoolId || !['headteacher','teacher'].includes(parsed.role)) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function clearVerifiedLocalSession(uidValue) {
  if (!uidValue) return;
  try { localStorage.removeItem(verifiedSessionKey(uidValue)); } catch (e) {}
}

function isLikelyOfflineError(error) {
  const code = String(error && error.code || '').toLowerCase();
  const message = String(error && error.message || error || '').toLowerCase();
  return navigator.onLine === false ||
    code.includes('unavailable') ||
    code.includes('network-request-failed') ||
    code.includes('deadline-exceeded') ||
    message.includes('failed to get document because the client is offline') ||
    message.includes('network') ||
    message.includes('offline');
}

function pendingSyncCountForCurrentSchool() {
  if (!currentSchoolId) return 0;
  let count = 0;
  try {
    syncableFields().forEach(field => { count += dirtyIdsFor(field.key).length; });
  } catch (e) {}
  return count;
}

function updateOfflineModeBanner(message) {
  const banner = document.getElementById('offlineModeBanner');
  if (!banner) return;
  const offline = navigator.onLine === false || offlineAuthenticatedMode;
  const pending = pendingSyncCountForCurrentSchool();
  banner.classList.toggle('hidden', !offline && !pending && !offlineReconnectInProgress);
  banner.classList.toggle('is-reconnecting', offlineReconnectInProgress);
  const title = banner.querySelector('.offline-mode-title');
  const detail = banner.querySelector('.offline-mode-detail');
  if (offlineReconnectInProgress) {
    if (title) title.textContent = 'Reconnecting…';
    if (detail) detail.textContent = message || 'Checking your account and safely syncing pending changes.';
  } else if (offline) {
    if (title) title.textContent = 'Offline Mode';
    if (detail) detail.textContent = message || (pending
      ? `${pending} pending change${pending === 1 ? '' : 's'} saved on this device. They will sync after your account is reverified online.`
      : 'SchoolHub is using the verified data saved on this device. Cloud features will resume when internet returns.');
  } else {
    if (title) title.textContent = 'Sync Pending';
    if (detail) detail.textContent = message || `${pending} change${pending === 1 ? '' : 's'} waiting to sync.`;
  }
}

function startCachedAuthenticatedSession(user, cached) {
  if (!user || !cached) return false;
  currentUid = user.uid;
  currentSchoolId = cached.schoolId;
  currentRole = cached.role;
  if (currentRole === 'teacher') redactCachedStaff();
  currentStatus = 'active';
  currentAssignedClassIds = Array.isArray(cached.assignedClassIds) ? cached.assignedClassIds.slice() : [];
  currentAssignedSubjectIds = Array.isArray(cached.assignedSubjectIds) ? cached.assignedSubjectIds.slice() : [];
  currentUserData = Object.assign({}, cached);
  sessionReady = true;
  sessionDataReady = true;
  cloudHydrationInProgress = false;
  offlineAuthenticatedMode = true;
  localStorage.removeItem(GUEST_MODE_KEY);
  hideSyncingMessage(); hideSessionRestoring(); hideAuthGate(); hideSchoolChoiceGate(); hidePendingGate(); hideDisabledGate();
  initLockScreen();
  ensureDefaults();
  loadSettingsForm();
  refreshProfileMenu();
  proceedToApp();
  updateOfflineModeBanner();
  return true;
}

function resetWorkspaceState() {
  const recoveryPreview = document.getElementById('staffRecoveryPreview');
  if (recoveryPreview) { recoveryPreview.innerHTML = ''; recoveryPreview.classList.add('hidden'); }
  pendingStaffImport = null;
  const preview = document.getElementById('staffImportPreview');
  if (preview) { preview.innerHTML = ''; preview.classList.add('hidden'); }
  const staffSearch = document.getElementById('staffSearch');
  if (staffSearch) staffSearch.value = '';
  const staffCount = document.getElementById('staffTableCount');
  if (staffCount) staffCount.textContent = '';
  const staffDetails = document.getElementById('staffDetailsContent');
  if (staffDetails) staffDetails.innerHTML = '';
  document.getElementById('staffDetailsDialog')?.classList.add('hidden');
  currentUid = null;
  currentSchoolId = null;
  currentRole = null;
  currentStatus = null;
  currentAssignedClassIds = [];
  currentAssignedSubjectIds = [];
  currentUserData = null;
  sessionReady = false;
  sessionDataReady = false;
  cloudHydrationInProgress = false;

  // Remove any stale rendered content immediately. Local/cloud records are
  // deliberately NOT deleted here because they belong to their school
  // namespace and may be reused after that same school logs in again.
  try {
    const ids = ['quickAccessList', 'classList', 'studentList', 'subjectList', 'staffList', 'statsSummary'];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });
  } catch (e) {}
}

function beginSessionTransition() {
  sessionGeneration += 1;
  resetWorkspaceState();
  showSyncingMessage();
  showAuthGate();
  return sessionGeneration;
}

async function signOutAndReset() {
  const signingOutUid = currentUid || (firebase.auth && firebase.auth().currentUser ? firebase.auth().currentUser.uid : '');
  clearVerifiedLocalSession(signingOutUid);
  offlineAuthenticatedMode = false;
  updateOfflineModeBanner();

  // Invalidate all old async work immediately. The login form must be released
  // locally without waiting for Firebase signOut() or onAuthStateChanged.
  // Firebase persistence/network can be slow on mobile PWAs, and waiting here
  // was the reason the user could be trapped on the "Syncing…" screen until
  // a page refresh.
  const token = beginSessionTransition();
  manualSignOutInProgress = true;

  // Immediately expose a clean sign-in form. No previous session data or role
  // is retained, and no cloud operation is allowed to block this transition.
  resetWorkspaceState();
  hideSyncingMessage();
  hideSchoolChoiceGate(); hidePendingGate(); hideDisabledGate();
  renderAuthForm();
  showAuthGate();

  try {
    await firebase.auth().signOut();
  } catch (err) {
    // Sign-out failures must not trap the user behind a loading screen. The
    // local session has already been invalidated. Show the error on the clean
    // sign-in screen so the user can retry or refresh if Firebase is offline.
    if (token === sessionGeneration) setAuthError('Could not sign out: ' + err.message);
  } finally {
    if (token === sessionGeneration) {
      resetWorkspaceState();
      hideSyncingMessage();
      hideSchoolChoiceGate(); hidePendingGate(); hideDisabledGate();
      renderAuthForm();
      showAuthGate();
    }
    manualSignOutInProgress = false;
  }
}
function isHeadTeacher() {
  return currentRole === 'headteacher' && currentStatus === 'active';
}

function isTeacher() {
  return currentRole === 'teacher' && currentStatus === 'active';
}

function accessibleClassIds() {
  if (isHeadTeacher() || isActiveGuest()) return DB.get(KEYS.classes, []).map(c => c.id);
  if (isTeacher()) return Array.isArray(currentAssignedClassIds) ? currentAssignedClassIds : [];
  return [];
}

function getAccessibleClasses() {
  const ids = new Set(accessibleClassIds());
  return DB.get(KEYS.classes, []).filter(c => ids.has(c.id));
}

function getAccessibleStudents(options) {
  const opts = options || {};
  const ids = new Set(accessibleClassIds());
  return DB.get(KEYS.students, []).filter(s =>
    ids.has(s.classId) && (opts.includeInactive === true || s.isActive !== false)
  );
}

function studentClassIdForYear(student, year) {
  if (!student) return '';
  const history = student.classHistory && typeof student.classHistory === 'object' ? student.classHistory : {};
  return history[String(year || '')] || student.classId || '';
}

function studentsForClassYear(classId, year) {
  if (!classId || !canAccessClass(classId)) return [];
  const currentYear = String(DB.get(KEYS.settings, {}).currentYear || '');
  const requestedYear = String(year || '');
  return DB.get(KEYS.students, []).filter(student => {
    if (studentClassIdForYear(student, requestedYear) !== classId) return false;
    // In the active academic year, completed/leaving students stay archived
    // but must not reappear on current rolls. Historical years include them.
    if (requestedYear === currentYear && student.isActive === false) return false;
    return true;
  });
}

function subjectOrderValue(subject, fallbackIndex) {
  const n = Number(subject && subject.order);
  return Number.isFinite(n) ? n : fallbackIndex;
}

function sortSubjectsByOrder(subjects) {
  return subjects.slice().sort((a, b) => {
    const ao = subjectOrderValue(a, 0);
    const bo = subjectOrderValue(b, 0);
    return ao - bo || String(a.name || '').localeCompare(String(b.name || '')) || String(a.id || '').localeCompare(String(b.id || ''));
  });
}

// Existing Phase 3 subject records did not have an explicit order field.
// Preserve their current local order the first time we encounter them, then
// keep a stable numeric order for Firestore and aggregate calculations.
function ensureSubjectOrder(subjects) {
  let changed = false;
  subjects.forEach((subject, index) => {
    if (!Number.isFinite(Number(subject.order))) {
      subject.order = index;
      changed = true;
    }
  });
  const sorted = sortSubjectsByOrder(subjects);
  sorted.forEach((subject, index) => {
    if (Number(subject.order) !== index) {
      subject.order = index;
      changed = true;
    }
  });
  if (changed) {
    subjects.length = 0;
    sorted.forEach(subject => subjects.push(subject));
  }
  return changed;
}

// Subject names are the school's human-facing identity for a subject.  IDs
// can differ after an import or a sync retry, so use a conservative name key
// when looking for accidental duplicates.
function subjectNameKey(name) {
  return String(name == null ? '' : name)
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

function subjectEntryHasScore(entry) {
  return !!entry && typeof entry === 'object'
    && (entry.c !== undefined || entry.e !== undefined);
}

function subjectHasSavedScores(subjectId, grades) {
  return Object.keys(grades && typeof grades === 'object' ? grades : {}).some(gradeKey => {
    const classGrades = grades[gradeKey];
    return Object.keys(classGrades && typeof classGrades === 'object' ? classGrades : {}).some(studentId =>
      subjectEntryHasScore(classGrades[studentId] && classGrades[studentId][subjectId])
    );
  });
}

// The recovery cache can contain default subjects from an older browser
// install. Once Firestore has returned a non-empty authoritative subject
// collection, do not let unscored cache-only subjects reappear in the Head
// Teacher list. A cache-only subject with scores is retained for safety.
function removeUnscoredSubjectsAbsentFromCloud(subjects, grades, cloudSubjectIds) {
  if (!cloudSubjectIds || !cloudSubjectIds.size) return { subjects, changed: false, removed: 0 };
  const kept = (Array.isArray(subjects) ? subjects : []).filter(subject =>
    cloudSubjectIds.has(subject.id) || subjectHasSavedScores(subject.id, grades)
  );
  const removed = (Array.isArray(subjects) ? subjects.length : 0) - kept.length;
  if (removed) ensureSubjectOrder(kept);
  return { subjects: kept, changed: removed > 0, removed };
}

// Merge duplicate subject IDs into the first subject in display order.  A
// duplicate is removed only when every saved score can be represented by the
// kept subject. If two different values exist for the same pupil/score part,
// the duplicate is deliberately retained: silently choosing one would lose a
// scored result. This makes the repair safe to run repeatedly.
function repairDuplicateSubjects(subjects, grades) {
  const ordered = sortSubjectsByOrder(Array.isArray(subjects) ? subjects : []);
  const repairedGrades = grades && typeof grades === 'object' ? grades : {};
  const byName = new Map();
  const removedIds = new Set();
  let movedScores = 0;
  let protectedDuplicates = 0;

  ordered.forEach(subject => {
    const key = subjectNameKey(subject && subject.name);
    if (!key) return;
    const kept = byName.get(key);
    if (!kept) {
      byName.set(key, subject);
      return;
    }

    let conflict = false;
    Object.keys(repairedGrades).forEach(gradeKey => {
      const classGrades = repairedGrades[gradeKey];
      if (!classGrades || typeof classGrades !== 'object') return;
      Object.keys(classGrades).forEach(studentId => {
        const studentGrades = classGrades[studentId];
        const duplicateScore = studentGrades && studentGrades[subject.id];
        if (!subjectEntryHasScore(duplicateScore)) return;
        const keptScore = studentGrades[kept.id];
        ['c', 'e'].forEach(part => {
          if (duplicateScore[part] !== undefined && keptScore && keptScore[part] !== undefined
              && Number(duplicateScore[part]) !== Number(keptScore[part])) conflict = true;
        });
      });
    });
    if (conflict) {
      protectedDuplicates++;
      return;
    }

    Object.keys(repairedGrades).forEach(gradeKey => {
      const classGrades = repairedGrades[gradeKey];
      if (!classGrades || typeof classGrades !== 'object') return;
      Object.keys(classGrades).forEach(studentId => {
        const studentGrades = classGrades[studentId];
        const duplicateScore = studentGrades && studentGrades[subject.id];
        if (!subjectEntryHasScore(duplicateScore)) return;
        if (!studentGrades[kept.id]) studentGrades[kept.id] = {};
        ['c', 'e'].forEach(part => {
          if (duplicateScore[part] !== undefined && studentGrades[kept.id][part] === undefined) {
            studentGrades[kept.id][part] = duplicateScore[part];
            movedScores++;
          }
        });
        delete studentGrades[subject.id];
      });
    });
    removedIds.add(subject.id);
  });

  const repairedSubjects = ordered.filter(subject => !removedIds.has(subject.id));
  if (removedIds.size) ensureSubjectOrder(repairedSubjects);
  return { subjects: repairedSubjects, grades: repairedGrades, changed: removedIds.size > 0, removed: removedIds.size, movedScores, protectedDuplicates };
}

function getAccessibleSubjects() {
  const all = DB.get(KEYS.subjects, []);
  const ordered = sortSubjectsByOrder(all);
  if (isHeadTeacher() || isActiveGuest()) return ordered;
  const ids = new Set(Array.isArray(currentAssignedSubjectIds) ? currentAssignedSubjectIds : []);
  return ordered.filter(s => ids.has(s.id));
}

function canAccessClass(classId) {
  return accessibleClassIds().indexOf(classId) !== -1;
}

function canAccessSubject(subjectId) {
  if (isHeadTeacher() || isActiveGuest()) return true;
  return Array.isArray(currentAssignedSubjectIds) && currentAssignedSubjectIds.indexOf(subjectId) !== -1;
}

function requireHeadTeacher(action) {
  if (isActiveGuest()) return true; // Local workspace only; never grants a school role.
  if (!isHeadTeacher()) {
    alert('Only the Head Teacher can ' + action + '.');
    return false;
  }
  return true;
}

function requireClassAccess(classId) {
  if (!canAccessClass(classId)) {
    alert('You do not have access to this class.');
    return false;
  }
  return true;
}



const KEYS = {
  get settings() { return ns('arc_settings'); },
  get classes() { return ns('arc_classes'); },
  get subjects() { return ns('arc_subjects'); },
  get students() { return ns('arc_students'); },
  get grades() { return ns('arc_grades'); },
  get attendance() { return ns('arc_attendance'); },
  get teacherAttendance() { return ns('arc_teacher_attendance'); },
  get schoolCalendar() { return ns('arc_school_calendar'); },
  get remarks() { return ns('arc_remarks'); },
  get staff() { return ns('arc_staff'); },
  get activity() { return ns('arc_activity'); },
  get billing() { return ns('arc_billing'); }
};

/* ---------- audit trail / activity log ---------- */
const AUDIT_MAX_LOCAL = 100;
function auditActor() {
  const u = FIREBASE_ENABLED && firebase.auth && firebase.auth().currentUser ? firebase.auth().currentUser : null;
  return { uid: currentUid || (u && u.uid) || 'local', email: (u && u.email) || '', name: String((currentUserData && (currentUserData.displayName || currentUserData.name)) || '').trim(), role: currentRole || 'guest' };
}
function auditLocal(action, entity, entityId, summary) {
  try {
    const items = DB.get(KEYS.activity, []); const actor = auditActor();
    items.unshift({ id: uid(), at: new Date().toISOString(), action, entity, entityId: entityId || '', summary: summary || '', actor });
    DB.set(KEYS.activity, items.slice(0, AUDIT_MAX_LOCAL));
  } catch (e) { console.warn('Could not save local activity:', e); }
}
function auditAction(action, entity, entityId, summary) {
  if (!sessionReady && FIREBASE_ENABLED) return Promise.resolve();
  auditLocal(action, entity, entityId, summary);
  if (!FIREBASE_ENABLED || !currentSchoolId || !firebase.firestore) return Promise.resolve();
  const actor = auditActor();
  return schoolRef().collection('activity').add({ uid: actor.uid, email: actor.email, actorName: actor.name, role: actor.role, action: String(action || ''), entity: String(entity || ''), entityId: String(entityId || ''), summary: String(summary || '').slice(0, 300), createdAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(err => console.warn('Activity log write failed:', err));
}
function formatActivityTime(value) {
  const d = value && value.toDate ? value.toDate() : new Date(value || 0);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}
function activityIcon(action) { if (/delete|remove|reject|disable/i.test(action)) return '✕'; if (/create|add|approve/i.test(action)) return '+'; if (/login|logout/i.test(action)) return '↪'; return '✓'; }
function renderActivityRows(rows) {
  const list = document.getElementById('activityLogList'); if (!list) return;
  if (!rows.length) { list.innerHTML = '<li class="empty">No activity has been recorded yet.</li>'; return; }
  list.innerHTML = rows.map(r => { const actor = r.actorName || r.email || r.actor?.name || r.actor?.email || r.role || 'User'; return `<li class="activity-item"><span class="activity-icon">${activityIcon(r.action)}</span><div><strong>${escapeHtml(r.summary || `${r.action || 'Activity'} · ${r.entity || ''}`)}</strong><div class="meta">${escapeHtml(actor)} · ${escapeHtml(r.role || r.actor?.role || '')} · ${escapeHtml(formatActivityTime(r.createdAt || r.at))}</div></div></li>`; }).join('');
}
async function loadActivityLog() {
  const list = document.getElementById('activityLogList'), status = document.getElementById('activityLogStatus'); if (!list) return;
  list.innerHTML = '<li class="empty">Loading activity…</li>';
  try {
    if (FIREBASE_ENABLED && currentSchoolId && firebase.firestore) {
      let q = schoolRef().collection('activity');
      if (!isHeadTeacher()) q = q.where('uid', '==', currentUid);
      q = q.limit(100);
      const snap = await q.get(); const rows=[]; snap.forEach(doc => rows.push(Object.assign({id:doc.id}, doc.data())));
      rows.sort((a,b) => { const da = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : new Date(a.at || 0).getTime(); const db = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : new Date(b.at || 0).getTime(); return db - da; });
      renderActivityRows(rows); if (status) status.textContent = `${rows.length} cloud activities shown.`;
    } else {
      const rows = DB.get(KEYS.activity, []).slice(0,100); renderActivityRows(rows); if (status) status.textContent = `${rows.length} local activities shown.`;
    }
  } catch (e) {
    const rows = DB.get(KEYS.activity, []).slice(0,100); renderActivityRows(rows); if (status) status.textContent = `Cloud activity unavailable. Showing ${rows.length} local activities.`;
  }
}

const DEFAULT_SUBJECTS = [
  'English Language','Mathematics','Science','History',
  'Rel. & Moral Edu. (RME)','Creative Arts','Computing','Ghanaian Language'
];

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function ensureDefaults() {
  if (DB.get(KEYS.subjects, null) === null) {
    DB.set(KEYS.subjects, DEFAULT_SUBJECTS.map((name, order) => ({ id: uid(), name, order })));
  } else {
    const subjects = DB.get(KEYS.subjects, []);
    if (Array.isArray(subjects) && ensureSubjectOrder(subjects)) DB.set(KEYS.subjects, subjects);
  }
  if (DB.get(KEYS.settings, null) === null) {
    DB.set(KEYS.settings, {
      teacherName: '', schoolName: '', address: '', email: '', logo: '',
      currentTerm: 'Term 1', currentYear: '', attendanceOutOf: '', nextTermBegins: '',
      reportLayout: 'standard', reportTheme: 'bw', headTeacherId: '', termDates: {}
    });
  }
  if (DB.get(KEYS.classes, null) === null) DB.set(KEYS.classes, []);
  if (DB.get(KEYS.students, null) === null) DB.set(KEYS.students, []);
  if (DB.get(KEYS.grades, null) === null) DB.set(KEYS.grades, {});
  if (DB.get(KEYS.attendance, null) === null) DB.set(KEYS.attendance, {});
  if (DB.get(KEYS.teacherAttendance, null) === null) DB.set(KEYS.teacherAttendance, {});
  if (DB.get(KEYS.schoolCalendar, null) === null) DB.set(KEYS.schoolCalendar, {});
  if (DB.get(KEYS.remarks, null) === null) DB.set(KEYS.remarks, {});
  if (DB.get(KEYS.staff, null) === null) DB.set(KEYS.staff, []);
  if (DB.get(KEYS.billing, null) === null) DB.set(KEYS.billing, { balance: 0, currency: 'GHS', updatedAt: null });
}

// Shared helper: fill a <select> with staff options ("— None —" first),
// selecting selectedId if it matches an existing staff member.
function fillStaffSelect(sel, selectedId) {
  const staff = DB.get(KEYS.staff, []);
  const opts = ['<option value="">— None —</option>'].concat(
    staff.map(s => `<option value="${s.id}" ${s.id === selectedId ? 'selected' : ''}>${escapeHtml(s.name)}${s.role ? ' (' + escapeHtml(s.role) + ')' : ''}</option>`)
  );
  sel.innerHTML = opts.join('');
}

/* ---------- grading & remark bands (school's own scale) ---------- */
const GRADE_BANDS = [
  { min: 80, grade: 1 }, { min: 75, grade: 2 }, { min: 70, grade: 3 },
  { min: 65, grade: 4 }, { min: 60, grade: 5 }, { min: 50, grade: 6 },
  { min: 45, grade: 7 }, { min: 40, grade: 8 }, { min: 0, grade: 9 }
];
const REMARK_BANDS = [
  { min: 80, label: 'Highly Proficient' },
  { min: 54, label: 'Proficient' },
  { min: 46, label: 'Approaching Proficiency' },
  { min: 40, label: 'Developing' },
  { min: 0, label: 'Emerging' }
];

function getGradeFor(total) {
  for (const b of GRADE_BANDS) { if (total >= b.min) return b.grade; }
  return 9;
}
function getRemarkFor(total) {
  for (const b of REMARK_BANDS) { if (total >= b.min) return b.label; }
  return 'Emerging';
}

function gradeKey(classId, term, year) { return `${classId}__${term}__${year}`; }

function clampScore(raw, max) {
  if (raw === '') return '';
  let n = Number(raw);
  if (isNaN(n)) return '';
  if (n < 0) n = 0;
  if (n > max) n = max;
  return n;
}

// Class Score is out of 60, scaled down to 50. Exam Score is out of 100,
// scaled down to 50. The two combine into a Total out of 100.
function scaleClass(raw) { return Math.round((raw / 60) * 50); }
function scaleExam(raw) { return Math.round((raw / 100) * 50); }

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/* ---------- persistent navigation state ---------- */
const NAV_VIEW_KEY = 'arc_last_view';
const NAV_ATTENDANCE_TAB_KEY = 'arc_last_attendance_tab';
const VALID_ATTENDANCE_TABS = ['students','teachers','calendar','summary','analysis','reports'];

function getSavedNavigation() {
  let view = localStorage.getItem(NAV_VIEW_KEY) || 'home';
  const allowed = ['home','setup','staff','classes','students','subjects','attendance','grades','remarks','reports','history','manage-teachers','activity'];
  if (allowed.indexOf(view) === -1) view = 'home';
  let attendanceTab = localStorage.getItem(NAV_ATTENDANCE_TAB_KEY) || 'students';
  if (VALID_ATTENDANCE_TABS.indexOf(attendanceTab) === -1) attendanceTab = 'students';
  return { view, attendanceTab };
}

function saveNavigationState(view) {
  if (!view || !sessionDataReady) return;
  localStorage.setItem(NAV_VIEW_KEY, view);
}

function saveAttendanceTabState(mode) {
  if (!sessionDataReady || VALID_ATTENDANCE_TABS.indexOf(mode) === -1) return;
  localStorage.setItem(NAV_ATTENDANCE_TAB_KEY, mode);
}

/* ---------- view switching ---------- */
const views = ['home', 'setup', 'staff', 'classes', 'students', 'subjects', 'attendance', 'grades', 'remarks', 'reports', 'billing', 'history', 'manage-teachers', 'activity'];
function showView(name) {
  if (!enforceGuestTrial()) return;
  // Never render role-sensitive views while an authenticated session is still
  // being resolved. Guest mode explicitly marks itself ready before calling
  // proceedToApp().
  if (FIREBASE_ENABLED && !sessionReady) return;
  if (isTeacher() && ['setup', 'staff', 'classes', 'subjects', 'billing', 'manage-teachers'].indexOf(name) !== -1) {
    name = 'home';
  }
  views.forEach(v => {
    document.getElementById('view-' + v).classList.toggle('hidden', v !== name);
  });
  document.getElementById('backBtn').classList.toggle('hidden', name === 'home');
  document.getElementById('brandText').textContent = name === 'home' ? 'AlatiphA SchoolHub' : sectionTitle(name);

  // v28: identity/role may be ready before cloud data. Never render cached
  // school records from a previous session while the new session is syncing.
  // Persist the user's last valid page only after the current session's
  // school data is ready. During startup we deliberately do not overwrite the
  // saved page with the temporary Home view.
  saveNavigationState(name);

  if (FIREBASE_ENABLED && !sessionDataReady) {
    if (name !== 'home') {
      views.forEach(v => {
        document.getElementById('view-' + v).classList.toggle('hidden', v !== 'home');
      });
      document.getElementById('backBtn').classList.add('hidden');
      document.getElementById('brandText').textContent = 'AlatiphA SchoolHub';
    }
    renderHome();
    renderClasses();
    renderStudents();
    renderSubjects();
    renderStaff();
    window.scrollTo(0, 0);
    return;
  }

  if (name === 'home') renderHome();
  if (name === 'setup') { refreshHeadTeacherSelect(); renderCloudSyncStatus(); renderYearRollover(); renderYearEndRestorePreview(); }
  if (name === 'students') renderStudentClassSelect();
  if (name === 'attendance') renderAttendanceView();
  if (name === 'grades') renderGradesClassSelect();
  if (name === 'remarks') renderRemarksClassSelect();
  if (name === 'reports') renderReportsClassSelect();
  if (name === 'billing') renderBilling();
  if (name === 'history') renderHistoryTermYearSelect();
  if (name === 'manage-teachers') renderManageTeachers();
  if (name === 'activity') loadActivityLog();
  renderClasses();
  renderStudents();
  renderSubjects();
  renderStaff();
  renderFloatingPill();
  showFloatingPill();
  window.scrollTo(0, 0);
}

function refreshHeadTeacherSelect() {
  const settings = DB.get(KEYS.settings, {});
  fillStaffSelect(document.getElementById('headTeacherSelect'), settings.headTeacherId || '');
}

function sectionTitle(name) {
  const titles = {
    setup: 'Setup', staff: 'Staff', classes: 'Classes', students: 'Students', subjects: 'Subjects',
    attendance: 'Attendance', grades: 'Grades', remarks: 'Remarks', reports: 'Reports', billing: 'Billing & Credits', history: 'Term History',
    'manage-teachers': 'Manage Teachers', activity: 'Activity Log'
  };
  return titles[name] || 'AlatiphA SchoolHub';
}

document.getElementById('backBtn').addEventListener('click', () => showView('home'));

/* ---------- v40 floating quick-access pill ---------- */
let floatingPillLastY = window.scrollY || 0, floatingPillTicking = false;
function floatingPillIcon(name) {
 const icons={home:'<svg viewBox="0 0 24 24"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/></svg>',attendance:'<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M7 3v4M17 3v4M4 9h16"/><path d="m8 15 2 2 5-5"/></svg>',reports:'<svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M15 3v5h4M9 17v-3M12 17v-6M15 17v-4"/></svg>',billing:'<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/></svg>'}; return icons[name]||'';
}
function currentVisibleViewName(){return views.find(v=>{const el=document.getElementById('view-'+v);return el&&!el.classList.contains('hidden')})||'home'}
function floatingPillItems(){const x=[{view:'home',label:'Home',icon:'home'},{view:'attendance',label:'Attendance',icon:'attendance'},{view:'reports',label:'Reports',icon:'reports'}];if(isHeadTeacher())x.push({view:'billing',label:'Billing & Credits',icon:'billing'});return x}
function renderFloatingPill(){let p=document.getElementById('schoolHubFloatingPill');if(!sessionReady&&FIREBASE_ENABLED){if(p)p.remove();return;}if(!p){p=document.createElement('nav');p.id='schoolHubFloatingPill';p.setAttribute('aria-label','Quick navigation');document.body.appendChild(p)}const active=currentVisibleViewName();p.innerHTML=floatingPillItems().map(i=>`<button type="button" data-view="${i.view}" class="${active===i.view?'active':''}">${floatingPillIcon(i.icon)}<span class="pill-label">${escapeHtml(i.label)}</span></button>`).join('');p.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{p.classList.remove('pill-hidden');showView(b.dataset.view);renderFloatingPill()}))}
function showFloatingPill(){const p=document.getElementById('schoolHubFloatingPill');if(p)p.classList.remove('pill-hidden')}
function hideFloatingPill(){const p=document.getElementById('schoolHubFloatingPill');if(p)p.classList.add('pill-hidden')}
window.addEventListener('scroll',()=>{if(floatingPillTicking)return;floatingPillTicking=true;requestAnimationFrame(()=>{const y=Math.max(0,window.scrollY||document.documentElement.scrollTop||0),d=y-floatingPillLastY;if(y<80)showFloatingPill();else if(d>10)hideFloatingPill();else if(d<-10)showFloatingPill();floatingPillLastY=y;floatingPillTicking=false})},{passive:true});

/* ---------- Home dashboard ---------- */
const QUICK_ACCESS_CARDS = [
  { view: 'setup', title: 'Setup', description: 'School info, term, and report layout', headteacherOnly: true,
    icon: '<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="7" cy="18" r="2"/>' },
  { view: 'manage-teachers', title: 'Manage Teachers', description: 'Approve, assign classes, disable', headteacherOnly: true,
    icon: '<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2"/><path d="M17 8l3 3-3 3"/><path d="M20 11h-6"/>' },
  { view: 'staff', title: 'Staff', description: 'Staff records, ranks, and signatures', headteacherOnly: true,
    icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="14" x2="13" y2="14"/><line x1="8" y1="17" x2="11" y2="17"/>' },
  { view: 'classes', title: 'Classes', description: 'Create and manage your classes', headteacherOnly: true,
    icon: '<polygon points="12 2 22 8 12 14 2 8 12 2"/><polyline points="2 14 12 20 22 14"/>' },
  { view: 'students', title: 'Students', description: 'Add, edit, search, and photo students',
    icon: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/>' },
  { view: 'subjects', title: 'Subjects', description: 'Manage the subjects taught', headteacherOnly: true,
    icon: '<path d="M4 4h8a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H4z"/><path d="M20 4h-8a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h9z"/>' },
  { view: 'attendance', title: 'Attendance', description: 'Record daily attendance and term totals',
    icon: '<path d="M6 3v4M18 3v4M4 6h16"/><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 11h8M8 15h5"/>' },
  { view: 'grades', title: 'Grades', description: 'Enter class and exam scores',
    icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>' },
  { view: 'remarks', title: 'Remarks', description: 'Attendance, conduct, and comments',
    icon: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' },
  { view: 'reports', title: 'Reports', description: 'Generate PDFs, CSV, and view statistics',
    icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="9" y2="17"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="15" y1="15" x2="15" y2="17"/>' },
  { view: 'billing', title: 'Billing & Credits', description: 'Buy and manage school report credits',
    icon: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/><path d="M7 14h4"/><circle cx="17" cy="14" r="1"/>' },
  { view: 'activity', title: 'Activity Log', description: 'See who changed school data and when',
    icon: '<path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h6M8 17h4"/>' },
  { view: 'history', title: 'Term History', description: 'Browse and export past terms',
    icon: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/>' }
];

function renderQuickAccessList() {
  const wrap = document.getElementById('quickAccessList');
  if (FIREBASE_ENABLED && !sessionDataReady) {
    wrap.innerHTML = '<div class="empty">Loading your school workspace…</div>';
    return;
  }
  const cards = QUICK_ACCESS_CARDS.filter(c => c.view !== 'billing' && (!c.headteacherOnly || currentRole === 'headteacher' || (c.view === 'staff' && isActiveGuest())));
  wrap.innerHTML = cards.map(c => `
    <button type="button" class="qa-card" data-view="${c.view}">
      <span class="qa-icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${c.icon}</svg></span>
      <span class="qa-text">
        <span class="qa-title">${escapeHtml(c.title)}</span>
        <span class="qa-desc">${escapeHtml(c.description)}</span>
      </span>
    </button>
  `).join('');
  wrap.querySelectorAll('.qa-card').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });
}

/* ---------- Guided Tour ---------- */
// Bumping the number in this key would make the tour show again for
// everyone next time, if the content ever changes significantly.
const TOUR_SEEN_KEY = 'arc_tour_seen_v1';
let tourIndex = 0;

function tourSlidesForHeadTeacher() {
  return [
    { title: 'Welcome, Head Teacher', body: "This tour covers the current SchoolHub workflow: setup, staff and classes, attendance, grades, reports, safe sync, backups, and year-end rollover. You can replay it anytime from the profile menu." },
    { title: '1. Setup your school', body: 'In Setup, confirm the school name, Term, Academic Year, Attendance Out Of, Next Term Begins, report layout/theme, and other school settings. Use Save Settings for new changes and Update when editing an existing record.' },
    { title: '2. Staff, classes & subjects', body: 'Add staff records, optional signatures, classes and subjects. Editing an existing Staff, Class or Subject record uses Update. Assign each class teacher where needed.' },
    { title: '3. Add students safely', body: 'Add students one at a time, in bulk, or by spreadsheet where available. Existing student edits use Update. SchoolHub keeps recovery snapshots to help protect against accidental data loss.' },
    { title: '4. Approve teachers', body: "Share the school join code with teachers. Approve each request in Manage Teachers, then assign only the classes and subjects that teacher should access." },
    { title: '5. Attendance & Calendar', body: 'Record pupil attendance by class and date. Head Teachers can also record teacher attendance and manage holidays, midterms and other calendar exceptions. Editing a calendar event updates or moves the existing event instead of creating a duplicate.' },
    { title: '6. Grades, remarks & reports', body: 'Enter class and exam scores, add remarks, then generate report cards. Grade sheets can be exported/imported with Excel. Attendance summaries and reports use the same clean print/download layout.' },
    { title: '7. Offline & Sync Center', body: 'A previously verified signed-in account can reopen saved school data when the internet is unavailable. Offline edits wait in Sync Pending. When back online, SchoolHub validates the account, sends pending edits first, then refreshes cloud data.' },
    { title: '8. Backups & recovery', body: 'Use Setup → Backup & Restore to export a JSON backup. Recovery tools can compare saved copies for missing student or staff records. Keep downloaded backups somewhere safe.' },
    { title: '9. Term & year rollover', body: 'Use Term History for a new term. At the end of the academic year, Academic Year Rollover lets you Promote, Repeat, Graduate/Complete, or Transfer/Leave students and creates a year-end backup before applying changes.' },
    { title: '10. Emergency restore', body: 'If a year rollover needs to be reversed, Setup → Academic Year Rollover → Restore Year-End Backup validates the rollover JSON and restores the backed-up roster/settings without wiping later records unnecessarily.' },
    { title: "You're set", body: 'Use the profile menu for Guided Tour, Help & FAQ, Sync Center, System Health, About, Privacy and Terms. Head Teachers also see Billing & Credits when available.' }
  ];
}

function tourSlidesForTeacher() {
  return [
    { title: 'Welcome, Teacher', body: "This tour covers the current teacher workflow. You can replay it anytime from the profile menu." },
    { title: '1. Approval & assignments', body: 'After joining a school, your Head Teacher must approve your account and assign the classes and subjects you are allowed to use.' },
    { title: '2. Attendance', body: 'Open Attendance, choose one of your assigned classes and a date, mark pupils, and save. Use Unmark All when you need to clear the current marks before saving.' },
    { title: '3. Grades', body: 'Open Grades, choose an assigned class, enter the required scores, and save the grade sheet. Desktop grade inputs support full three-digit values and the table can scroll horizontally when there are many subjects.' },
    { title: '4. Remarks & reports', body: 'Add remarks, then open Reports to generate available student or class reports. Your access remains limited to the classes and subjects assigned by the Head Teacher.' },
    { title: '5. Offline work & syncing', body: 'After your account has been verified online on this device, SchoolHub can reopen saved data offline. Pending supported edits are shown as Sync Pending and are sent when the connection returns.' },
    { title: '6. Help & account tools', body: 'Use the profile menu for Guided Tour, Help & FAQ, Sync Center, System Health, About, Privacy and Terms. Billing controls are reserved for the Head Teacher.' },
    { title: "You're set", body: 'If a class or subject is missing, ask your Head Teacher to review your assignments in Manage Teachers.' }
  ];
}

function tourSlidesForGuest() {
  return [
    { title: 'Welcome', body: "Guest mode is a 7-day trial. Guest data stays on this device and is not a shared cloud school. You can replay this tour anytime from the profile menu." },
    { title: '1. Setup', body: 'Enter your school name, Term, Academic Year, attendance/report settings and preferred report layout.' },
    { title: '2. Build your school records', body: 'Add classes, subjects, staff and students. Use Save for new records and Update when editing an existing record.' },
    { title: '3. Attendance, grades & remarks', body: 'Record attendance, enter grades and add remarks as you test the SchoolHub workflow.' },
    { title: '4. Reports', body: 'Generate and preview the available reports. Guest information remains on this device unless you later create an account and register a school.' },
    { title: '5. Backup your trial data', body: 'Use Setup → Backup & Restore to export a JSON copy before clearing browser/app data or moving to another device.' },
    { title: '6. Move to a school account', body: 'Create an account to register a school as Head Teacher or join an existing school with its join code. Teacher access requires Head Teacher approval.' },
    { title: "You're set", body: 'Use the profile menu for Guided Tour, Help & FAQ, About, Privacy and Terms.' }
  ];
}

function getTourSlides() {
  if (FIREBASE_ENABLED && currentRole === 'headteacher') return tourSlidesForHeadTeacher();
  if (FIREBASE_ENABLED && currentRole === 'teacher') return tourSlidesForTeacher();
  return tourSlidesForGuest();
}

function renderTourSlide() {
  const slides = getTourSlides();
  const slide = slides[tourIndex];
  document.getElementById('tourTitle').textContent = slide.title;
  document.getElementById('tourBody').textContent = slide.body;
  document.getElementById('tourDots').innerHTML = slides.map((s, i) =>
    `<span class="tour-dot${i === tourIndex ? ' active' : ''}"></span>`
  ).join('');
  document.getElementById('tourBackBtn').classList.toggle('hidden', tourIndex === 0);
  document.getElementById('tourNextBtn').textContent = tourIndex === slides.length - 1 ? 'Done' : 'Next';
}

function showTour() {
  tourIndex = 0;
  renderTourSlide();
  document.getElementById('tourOverlay').classList.remove('hidden');
}
function hideTour() {
  document.getElementById('tourOverlay').classList.add('hidden');
  localStorage.setItem(TOUR_SEEN_KEY, '1');
}

document.getElementById('tourNextBtn').addEventListener('click', () => {
  const slides = getTourSlides();
  if (tourIndex >= slides.length - 1) { hideTour(); return; }
  tourIndex++;
  renderTourSlide();
});
document.getElementById('tourBackBtn').addEventListener('click', () => {
  if (tourIndex > 0) { tourIndex--; renderTourSlide(); }
});
document.getElementById('tourSkipBtn').addEventListener('click', hideTour);

function renderHome() {
  // During a new authenticated session, show only neutral identity/status
  // information. Never expose the previous school's cached records while
  // cloud data is being loaded, but also do not make the welcome screen wait
  // for the complete Firestore synchronization.
  if (FIREBASE_ENABLED && !sessionDataReady) {
    const displayName = (currentUserData && (currentUserData.displayName || currentUserData.name)) || '';
    document.getElementById('welcomeHeading').textContent = displayName
      ? `Welcome back, ${displayName}` : 'Welcome back';
    document.getElementById('welcomeSubtext').textContent = 'Your school workspace is loading in the background…';
    document.getElementById('statsSummary').innerHTML = '<span>LOADING SCHOOL DATA…</span>';
    const qa = document.getElementById('quickAccessList');
    if (qa) qa.innerHTML = '<div class="empty">Preparing your school workspace…</div>';
    return;
  }
  const settings = DB.get(KEYS.settings, {});
  document.getElementById('welcomeHeading').textContent = settings.teacherName
    ? `Welcome back, ${settings.teacherName}`
    : 'Welcome back';
  document.getElementById('welcomeSubtext').textContent = (settings.currentTerm && settings.currentYear)
    ? `Here's what's happening in ${settings.currentTerm}, ${settings.currentYear}.`
    : "Here's what's happening with your classes.";

  const totalStudents = DB.get(KEYS.students, []).length;
  const totalClasses = DB.get(KEYS.classes, []).length;
  const totalStaff = DB.get(KEYS.staff, []).length;
  document.getElementById('statsSummary').innerHTML =
    `<span>TOTAL STUDENTS: ${totalStudents}</span><span class="stats-dot">•</span>`
    + `<span>CLASSES: ${totalClasses}</span><span class="stats-dot">•</span>`
    + `<span>STAFF: ${totalStaff}</span>`;

  renderQuickAccessList();

  if (!localStorage.getItem(TOUR_SEEN_KEY)) showTour();
}

/* ---------- Profile menu ---------- */
function refreshProfileMenu() {
  const settings = DB.get(KEYS.settings, {});
  document.getElementById('profileSchoolName').textContent = settings.schoolName || 'School name not set';
  document.getElementById('profileTermYear').textContent = (settings.currentTerm && settings.currentYear)
    ? `${settings.currentTerm} · ${settings.currentYear}` : 'Term not set';

  const accountLine = document.getElementById('profileAccountLine');
  const logoutBtn = document.getElementById('logoutBtn');
  const loginBtn = document.getElementById('profileLoginBtn');
  const roleLabel = currentRole === 'headteacher' ? 'Head Teacher' : currentRole === 'teacher' ? 'Teacher' : '';
  if (!FIREBASE_ENABLED) {
    accountLine.textContent = 'Accounts not set up';
    logoutBtn.classList.add('hidden');
    loginBtn.classList.add('hidden');
  } else if (currentSchoolId && firebase.auth().currentUser) {
    accountLine.textContent = `${firebase.auth().currentUser.email} (${roleLabel})`;
    logoutBtn.classList.remove('hidden');
    loginBtn.classList.add('hidden');
  } else {
    accountLine.textContent = `Guest trial: ${Math.ceil(guestTrialRemaining() / 86400000)} days left — data saved on this device`;
    logoutBtn.classList.add('hidden');
    loginBtn.classList.remove('hidden');
  }
}

// Lets a guest-mode user return to the sign-in screen — without this,
// choosing "Continue without an account" was a one-way trip with no
// way back to logging in.
document.getElementById('profileLoginBtn').addEventListener('click', () => {
  localStorage.removeItem(GUEST_MODE_KEY);
  document.getElementById('profileDropdown').classList.add('hidden');
  authMode = 'login';
  renderAuthForm();
  showAuthGate();
});

document.getElementById('profileBtn').addEventListener('click', e => {
  e.stopPropagation();
  refreshProfileMenu();
  document.getElementById('profileDropdown').classList.toggle('hidden');
});
document.getElementById('profileSetupLink').addEventListener('click', () => {
  document.getElementById('profileDropdown').classList.add('hidden');
  showView('setup');
});
document.getElementById('profileTourBtn').addEventListener('click', () => {
  document.getElementById('profileDropdown').classList.add('hidden');
  showTour();
});

// About dialog / version information. Keeping the version visible in-app
// makes PWA/service-worker troubleshooting possible without relying on
// browser developer tools.
function showAboutDialog() {
  const dialog = document.getElementById('aboutDialog');
  if (!dialog) return;
  document.getElementById('aboutVersion').textContent = APP_VERSION;
  document.getElementById('aboutDeveloper').textContent = 'AlatiphA Multimedia';
  const cacheStatus = document.getElementById('aboutImageCacheStatus');
  const browserStatus = document.getElementById('aboutBrowserStatus');
  const localStorageStatus = document.getElementById('aboutLocalStorageStatus');
  const swStatus = document.getElementById('aboutSwStatus');
  const cloudImageStatus = document.getElementById('aboutCloudImageStatus');
  const imageSyncStatus = document.getElementById('aboutImageSyncStatus');
  if (cacheStatus) {
    cacheStatus.textContent = 'Checking local image cache…';
    getImageCacheCount().then(count => {
      cacheStatus.textContent = count === null ? 'Unavailable in this browser' : `${count} local image${count === 1 ? '' : 's'} cached (IndexedDB)`;
    });
  }
  if (cloudImageStatus || imageSyncStatus) {
    if (!FIREBASE_ENABLED || !currentSchoolId) {
      if (cloudImageStatus) cloudImageStatus.textContent = 'Cloud sync unavailable';
      if (imageSyncStatus) imageSyncStatus.textContent = 'Not signed in';
    } else {
      getCloudImageInventory().then(items => {
        if (cloudImageStatus) cloudImageStatus.textContent = `${items.length} cloud image${items.length === 1 ? '' : 's'} (Storage + Firestore)`;
        if (imageSyncStatus) imageSyncStatus.textContent = `Last image sync: ${getLastImageSyncText()}`;
      }).catch(() => {
        if (cloudImageStatus) cloudImageStatus.textContent = 'Unable to read cloud images';
        if (imageSyncStatus) imageSyncStatus.textContent = `Last image sync: ${getLastImageSyncText()}`;
      });
    }
  }
  if (browserStatus) browserStatus.textContent = /SamsungBrowser/i.test(navigator.userAgent) ? 'Samsung Internet' : /Chrome/i.test(navigator.userAgent) ? 'Chrome' : 'Other';
  if (localStorageStatus) {
    try {
      let chars = 0;
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i) || ''; chars += k.length + String(localStorage.getItem(k) || '').length; }
      localStorageStatus.textContent = `${Math.round(chars / 1024)} KB structured data`;
    } catch (e) { localStorageStatus.textContent = 'Unavailable'; }
  }
  if (swStatus) {
    if (!('serviceWorker' in navigator)) swStatus.textContent = 'Unavailable';
    else navigator.serviceWorker.getRegistration('./').then(r => { swStatus.textContent = r ? (r.active ? 'Active' : r.installing ? 'Installing' : r.waiting ? 'Waiting' : 'Registered') : 'Not registered'; }).catch(() => { swStatus.textContent = 'Unavailable'; });
  }
  dialog.classList.remove('hidden');
}

function hideAboutDialog() {
  const dialog = document.getElementById('aboutDialog');
  if (dialog) dialog.classList.add('hidden');
}


/* ---------- v31 Sync Center + System Health ---------- */
function formatSyncTime(raw) {
  if (!raw) return 'Never';
  const n = Number(raw);
  if (!Number.isFinite(n)) return 'Unknown';
  try { return new Date(n).toLocaleString(); } catch (e) { return 'Unknown'; }
}

function setStatusRow(id, state, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `health-status ${state || ''}`.trim();
  el.textContent = text || '';
}

async function getLocalStorageUsageBytes() {
  try {
    let chars = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) || '';
      chars += k.length + String(localStorage.getItem(k) || '').length;
    }
    return chars * 2;
  } catch (e) { return null; }
}

async function getStorageQuotaInfo() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    return await navigator.storage.estimate();
  } catch (e) { return null; }
}

function bytesToText(bytes) {
  if (bytes == null || !Number.isFinite(Number(bytes))) return 'Unknown';
  const n = Number(bytes);
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function countCachedInventoryItems(inventory) {
  if (!Array.isArray(inventory) || !inventory.length) return 0;
  let count = 0;
  for (const item of inventory) {
    if (!item || !item.kind || !item.id) continue;
    const rec = await getCachedImageRecordAsync(imageCacheKey(item.kind, item.id));
    if (rec && rec.dataUrl) count++;
  }
  return count;
}

function withUiTimeout(promise, milliseconds, message) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => setTimeout(() => reject(new Error(message || 'Operation timed out.')), milliseconds))
  ]);
}

async function updateSyncCenter() {
  const cloudEl = document.getElementById('syncCloudImages');
  const localEl = document.getElementById('syncLocalImages');
  const lastEl = document.getElementById('syncLastImage');
  const dataEl = document.getElementById('syncLastData');
  const stateEl = document.getElementById('syncOverallState');
  const detailEl = document.getElementById('syncDetail');
  if (!cloudEl) return;

  cloudEl.textContent = 'Checking…';
  localEl.textContent = 'Checking…';
  lastEl.textContent = 'Checking…';
  dataEl.textContent = formatSyncTime(localStorage.getItem(LAST_SYNCED_KEY));
  stateEl.textContent = 'Checking cloud synchronization…';
  detailEl.textContent = '';

  if (!FIREBASE_ENABLED || !currentSchoolId) {
    cloudEl.textContent = '—';
    localEl.textContent = `${(await getImageCacheCount()) ?? 0}`;
    stateEl.textContent = 'Offline / Guest mode';
    detailEl.textContent = 'Sign in to a school account to compare cloud and browser data.';
    return;
  }

  try {
    const inventory = await withUiTimeout(getCloudImageInventory({ probeLegacy: false }), 10000, 'Image inventory check is taking too long. Core school data is still available.');
    const localCount = await countCachedInventoryItems(inventory);
    cloudEl.textContent = String(inventory.length);
    localEl.textContent = String(localCount);
    lastEl.textContent = getLastImageSyncText();
    const missing = Math.max(0, inventory.length - localCount);
    if (missing > 0) {
      stateEl.textContent = `⚠ ${missing} image${missing === 1 ? '' : 's'} may need synchronization`;
      detailEl.textContent = 'Use Sync Images to reconcile this browser with the current cloud image inventory.';
    } else {
      stateEl.textContent = '✓ Image cache appears synchronized';
      detailEl.textContent = 'Cloud and local image counts match. This does not remove unrelated legacy cloud files.';
    }
  } catch (e) {
    stateEl.textContent = '⚠ Could not read cloud image inventory';
    detailEl.textContent = e && e.message ? e.message : String(e || 'Unknown error');
  }
}

async function showSyncCenter() {
  const dialog = document.getElementById('syncCenterDialog');
  if (!dialog) return;
  dialog.classList.remove('hidden');
  await updateSyncCenter();
}

function hideSyncCenter() {
  const dialog = document.getElementById('syncCenterDialog');
  if (dialog) dialog.classList.add('hidden');
}

function renderImageSyncDiagnostics(result) {
  const el = document.getElementById('syncDiagnostics');
  if (!el) return;
  const details = result && Array.isArray(result.details) ? result.details : [];
  if (!details.length) {
    el.textContent = '';
    el.classList.add('hidden');
    return;
  }
  const lines = details.map(d => {
    const label = `${d.kind || 'image'}:${d.id || ''}`;
    if (d.status === 'downloaded') return `✓ ${label} — downloaded${d.method ? ` via ${d.method}` : ''}`;
    if (d.status === 'already-local') return `✓ ${label} — already local`;
    if (d.status === 'skipped') return `⚠ ${label} — skipped${d.error ? `: ${d.error}` : ''}`;
    return `✗ ${label} — ${d.error || 'failed'}${d.attempts && d.attempts.length ? `\n   ${d.attempts.join('\n   ')}` : ''}`;
  });
  el.textContent = lines.join('\n');
  el.classList.remove('hidden');
}

async function runSyncCenterSync() {
  const btn = document.getElementById('syncCenterSyncBtn');
  const status = document.getElementById('syncCenterActionStatus');
  if (!FIREBASE_ENABLED || !currentSchoolId) {
    if (status) status.textContent = 'Sign in to a school account first.';
    return;
  }
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Synchronizing school data and images…';
  try {
    await pullCloudData();
    renderCloudSyncStatus();
    renderClasses(); renderStudents(); renderSubjects(); renderStaff(); renderQuickAccessList(); renderHome();
    const result = await syncImagesFromCloud({ force: false });
    renderImageSyncDiagnostics(result);
    if (status) status.textContent = `Sync complete: ${result.downloaded} downloaded, ${result.repaired} metadata repaired, ${result.failed} failed.`;
    await updateSyncCenter();
  } catch (e) {
    if (status) status.textContent = 'Sync failed: ' + (e && e.message ? e.message : String(e || 'Unknown error'));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function checkHealth() {
  const ids = ['healthAuth','healthFirestore','healthStorage','healthIndexedDB','healthLocalStorage','healthServiceWorker','healthSchool','healthRole','healthImages','healthReport'];
  ids.forEach(id => setStatusRow(id, 'checking', 'Checking…'));
  const summary = document.getElementById('healthSummary');
  if (summary) summary.textContent = 'Running read-only diagnostics…';

  // Authentication
  try {
    const user = FIREBASE_ENABLED && firebase.auth ? firebase.auth().currentUser : null;
    setStatusRow('healthAuth', user ? 'ok' : 'warn', user ? `✓ Signed in: ${user.email || user.uid}` : '⚠ Not signed in');
  } catch (e) { setStatusRow('healthAuth', 'fail', '✗ Authentication unavailable'); }

  // LocalStorage
  const usage = await getLocalStorageUsageBytes();
  setStatusRow('healthLocalStorage', usage == null ? 'fail' : 'ok', usage == null ? '✗ Unavailable' : `✓ ${bytesToText(usage)} used by localStorage`);

  // IndexedDB
  try {
    const db = await openImageDB();
    const count = await getImageCacheCount();
    setStatusRow('healthIndexedDB', db ? 'ok' : 'warn', db ? `✓ Available, ${count == null ? '?' : count} image${count === 1 ? '' : 's'}` : '⚠ IndexedDB unavailable');
  } catch (e) { setStatusRow('healthIndexedDB', 'fail', '✗ IndexedDB check failed'); }

  // Service worker
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration('./') : null;
    setStatusRow('healthServiceWorker', reg && reg.active ? 'ok' : 'warn', reg && reg.active ? '✓ Active' : reg ? '⚠ Registered but not active' : '⚠ Not registered');
  } catch (e) { setStatusRow('healthServiceWorker', 'fail', '✗ Service worker check failed'); }

  if (!FIREBASE_ENABLED || !currentSchoolId) {
    setStatusRow('healthFirestore', 'warn', '⚠ Cloud disabled or no school selected');
    setStatusRow('healthStorage', 'warn', '⚠ Cloud disabled or no school selected');
    setStatusRow('healthSchool', 'warn', '⚠ No active school session');
    setStatusRow('healthRole', currentRole ? 'ok' : 'warn', currentRole ? `✓ ${currentRole}` : '⚠ No active role');
    setStatusRow('healthImages', 'warn', '⚠ Cloud image check requires a school session');
  } else {
    try {
      const snap = await schoolRef().get();
      setStatusRow('healthFirestore', snap.exists ? 'ok' : 'warn', snap.exists ? '✓ Firestore read successful' : '⚠ School document not found');
      setStatusRow('healthSchool', snap.exists ? 'ok' : 'warn', snap.exists ? `✓ School ${currentSchoolId}` : '⚠ School profile unavailable');
    } catch (e) { setStatusRow('healthFirestore', 'fail', '✗ Firestore read failed: ' + (e.message || e)); setStatusRow('healthSchool', 'fail', '✗ School profile unavailable'); }
    try {
      const manifestSnap = await schoolRef().collection('imageAssets').limit(1).get();
      if (manifestSnap.empty) {
        setStatusRow('healthStorage', 'warn', '⚠ Storage reachable but no image manifest entries exist yet');
      } else {
        const asset = manifestSnap.docs[0].data() || {};
        if (!asset.storagePath) throw new Error('Image manifest contains no Storage path.');
        const meta = await storageRef(asset.storagePath).getMetadata();
        setStatusRow('healthStorage', meta ? 'ok' : 'warn', meta ? '✓ Storage file access successful' : '⚠ Storage file metadata unavailable');
      }
    } catch (e) { setStatusRow('healthStorage', 'fail', '✗ Storage file access failed: ' + (e.message || e)); }
    try {
      const inventory = await getCloudImageInventory();
      const localCount = await countCachedInventoryItems(inventory);
      const missing = Math.max(0, inventory.length - localCount);
      setStatusRow('healthImages', missing ? 'warn' : 'ok', missing ? `⚠ ${localCount}/${inventory.length} current cloud images cached locally` : `✓ ${inventory.length} current cloud images / ${localCount} local`);
    } catch (e) { setStatusRow('healthImages', 'fail', '✗ Image inventory failed'); }
  }

  setStatusRow('healthRole', currentRole && currentStatus === 'active' ? 'ok' : currentRole ? 'warn' : 'warn', currentRole ? `✓ ${currentRole} (${currentStatus || 'unknown'})` : '⚠ No active role');
  setStatusRow('healthReport', typeof window.jspdf !== 'undefined' || typeof window.jsPDF !== 'undefined' ? 'ok' : 'warn', (typeof window.jspdf !== 'undefined' || typeof window.jsPDF !== 'undefined') ? '✓ jsPDF library available' : '⚠ jsPDF library not detected');

  const quota = await getStorageQuotaInfo();
  if (quota && quota.usage != null && quota.quota) {
    const pct = (Number(quota.usage) / Number(quota.quota)) * 100;
    const quotaEl = document.getElementById('healthQuota');
    if (quotaEl) quotaEl.textContent = `Browser storage estimate: ${bytesToText(quota.usage)} / ${bytesToText(quota.quota)} (${pct.toFixed(1)}%)`;
  }
  if (summary) summary.textContent = 'Diagnostics complete. Green items are healthy; yellow items need attention.';
}

function showSystemHealth() {
  const dialog = document.getElementById('systemHealthDialog');
  if (!dialog) return;
  dialog.classList.remove('hidden');
  checkHealth();
}
function hideSystemHealth() {
  const dialog = document.getElementById('systemHealthDialog');
  if (dialog) dialog.classList.add('hidden');
}

document.getElementById('profileAboutBtn').addEventListener('click', () => {
  document.getElementById('profileDropdown').classList.add('hidden');
  showAboutDialog();
});
document.getElementById('profileInstallBtn').addEventListener('click', () => {
  document.getElementById('profileDropdown').classList.add('hidden');
  if (window.SchoolHubInstall) window.SchoolHubInstall.prompt();
  else alert('Install is not available yet. Please wait a moment, then try again.');
});
document.getElementById('aboutCloseBtn').addEventListener('click', hideAboutDialog);
document.getElementById('aboutDialog').addEventListener('click', e => {
  if (e.target.id === 'aboutDialog') hideAboutDialog();
});

document.getElementById('profileSyncCenterBtn').addEventListener('click', () => {
  document.getElementById('profileDropdown').classList.add('hidden');
  showSyncCenter();
});
document.getElementById('profileSystemHealthBtn').addEventListener('click', () => {
  document.getElementById('profileDropdown').classList.add('hidden');
  showSystemHealth();
});
const profileBillingBtn = document.getElementById('profileBillingBtn');
if (profileBillingBtn) {
  profileBillingBtn.classList.toggle('hidden', isTeacher());
  profileBillingBtn.addEventListener('click', () => {
    document.getElementById('profileDropdown').classList.add('hidden');
    if (!isHeadTeacher()) { showView('home'); return; }
    showView('billing');
  });
}
document.getElementById('syncCenterCloseBtn').addEventListener('click', hideSyncCenter);
document.getElementById('syncCenterDialog').addEventListener('click', e => { if (e.target.id === 'syncCenterDialog') hideSyncCenter(); });
document.getElementById('syncCenterRefreshBtn').addEventListener('click', updateSyncCenter);
document.getElementById('syncCenterSyncBtn').addEventListener('click', runSyncCenterSync);
const syncCenterRecoverBtn = document.getElementById('syncCenterRecoverBtn');
if (syncCenterRecoverBtn) {
  syncCenterRecoverBtn.addEventListener('click', async () => {
    const status = document.getElementById('syncCenterActionStatus');
    if (!isHeadTeacher()) {
      if (status) status.textContent = 'Only the Head Teacher can recover local images to the cloud.';
      return;
    }
    syncCenterRecoverBtn.disabled = true;
    if (status) status.textContent = 'Registering this browser’s local images in the cloud…';
    try {
      const result = await publishLocalImagesToCloud();
      if (status) status.textContent = `Recovery complete: ${result.published} published, ${result.skipped} already registered, ${result.failed} failed.`;
      await updateSyncCenter();
    } catch (e) {
      if (status) status.textContent = 'Image recovery failed: ' + (e.message || e);
    } finally {
      syncCenterRecoverBtn.disabled = false;
    }
  });
}

document.getElementById('systemHealthCloseBtn').addEventListener('click', hideSystemHealth);
document.getElementById('systemHealthDialog').addEventListener('click', e => { if (e.target.id === 'systemHealthDialog') hideSystemHealth(); });
document.getElementById('systemHealthRefreshBtn').addEventListener('click', checkHealth);

document.getElementById('aboutCheckUpdateBtn').addEventListener('click', async () => {
  const status = document.getElementById('aboutUpdateStatus');
  status.textContent = 'Checking for an update…';
  try {
    if (!('serviceWorker' in navigator)) {
      status.textContent = 'Service workers are not available in this browser.';
      return;
    }
    const registration = await navigator.serviceWorker.getRegistration('./');
    if (!registration) {
      status.textContent = 'No SchoolHub service worker is registered in this browser.';
      return;
    }
    await registration.update();
    const active = registration.active ? 'active' : registration.installing ? 'installing' : registration.waiting ? 'waiting' : 'registered';
    status.textContent = `Update check completed. Service worker is ${active}. Reload SchoolHub to apply a new version.`;
  } catch (err) {
    const detail = err && err.message ? err.message : String(err || 'Unknown error');
    status.textContent = 'Update check failed: ' + detail;
    console.warn('SchoolHub update check failed:', err);
  }
});
const aboutSyncImagesBtn = document.getElementById('aboutSyncImagesBtn');
if (aboutSyncImagesBtn) {
  aboutSyncImagesBtn.addEventListener('click', async () => {
    const status = document.getElementById('aboutImageSyncStatus');
    aboutSyncImagesBtn.disabled = true;
    if (status) status.textContent = 'Synchronizing images…';
    try {
      const result = await syncImagesFromCloud({ force: false });
      if (status) status.textContent = `Sync complete: ${result.local}/${result.total} local, ${result.downloaded} downloaded, ${result.repaired} metadata repaired`;
      showAboutDialog();
    } catch (err) {
      if (status) status.textContent = 'Image sync failed: ' + (err && err.message ? err.message : String(err));
    } finally {
      aboutSyncImagesBtn.disabled = false;
    }
  });
}

document.addEventListener('click', e => {
  const dropdown = document.getElementById('profileDropdown');
  const menu = document.querySelector('.profile-menu');
  if (!dropdown.classList.contains('hidden') && !menu.contains(e.target)) {
    dropdown.classList.add('hidden');
  }
});

/* ---------- Setup ---------- */
function loadSettingsForm() {
  const s = DB.get(KEYS.settings, {});
  document.getElementById('teacherName').value = s.teacherName || '';
  document.getElementById('schoolName').value = s.schoolName || '';
  document.getElementById('schoolAddress').value = s.address || '';
  document.getElementById('schoolEmail').value = s.email || '';
  document.getElementById('currentTerm').value = s.currentTerm || 'Term 1';
  document.getElementById('currentYear').value = s.currentYear || '';
  const activeTermKey = termYearKey(s.currentTerm || 'Term 1', s.currentYear || '');
  const savedTermDates = s.termDates && typeof s.termDates === 'object' ? s.termDates[activeTermKey] : null;
  document.getElementById('termStartDate').value = (savedTermDates && savedTermDates.start) || s.termStartDate || '';
  document.getElementById('termEndDate').value = (savedTermDates && savedTermDates.end) || s.termEndDate || '';
  document.getElementById('attendanceOutOf').value = calculateTimesOpen(s.currentTerm || 'Term 1', s.currentYear || '') || '';
  document.getElementById('nextTermBegins').value = s.nextTermBegins || '';
  document.getElementById('reportLayout').value = s.reportLayout || 'standard';
  if (document.getElementById('reportThemeSelect')) document.getElementById('reportThemeSelect').value = s.reportTheme || 'schoolhub';
  const wrap = document.getElementById('logoPreviewWrap');
  const img = document.getElementById('logoPreview');
  if (s.logo) { img.src = s.logo; wrap.classList.remove('hidden'); }
  else { wrap.classList.add('hidden'); }
}

document.getElementById('schoolLogo').addEventListener('change', async e => {
  if (!requireHeadTeacher('upload the school logo')) return;
  const file = e.target.files[0];
  if (!file) return;
  const assetPath = schoolAssetPath(file, 'logos', 'school-logo');
  try {
    // v36: logo is cached locally before cloud backup.
    const dataUrl = await fileToDataUrl(file);
    if (!isDataImage(dataUrl)) throw new Error('The selected logo file is not a readable image.');
    await cacheLocalImageWithMeta(imageCacheKey('logo', 'school'), dataUrl, {
      storagePath: assetPath,
      sourceUrl: '',
      updatedAt: new Date().toISOString()
    });
    const s = DB.get(KEYS.settings, {});
    s.logo = dataUrl;
    s.logoUrl = '';
    s.logoStoragePath = assetPath;
    DB.set(KEYS.settings, s);
    loadSettingsForm();
    auditAction('update', 'settings-logo', 'school', 'Updated school logo');

    try {
      const url = await uploadSchoolAsset(file, 'logos', 'school-logo');
      const latest = DB.get(KEYS.settings, {});
      latest.logo = dataUrl;
      latest.logoUrl = url || '';
      latest.logoStoragePath = assetPath;
      DB.set(KEYS.settings, latest);
      if (FIREBASE_ENABLED && currentSchoolId) {
        await schoolRef().set({ profile: { logoUrl: url || '', logoStoragePath: assetPath, updatedAt: firebase.firestore.FieldValue.serverTimestamp() } }, { merge: true });
        await upsertImageManifest('logo', 'school', { storagePath: assetPath, sourceUrl: url || '', storageUpdatedAt: new Date().toISOString() });
      }
      loadSettingsForm();
    } catch (cloudError) {
      console.warn('School logo cloud backup pending:', cloudError);
      alert(`School logo saved on this browser. Firebase backup is pending.\n\n${cloudError.message || cloudError}`);
    }
  } catch (err) {
    alert('Could not save the school logo locally: ' + (err.message || err));
  } finally {
    e.target.value = '';
  }
});

document.getElementById('removeLogo').addEventListener('click', () => {
  if (!requireHeadTeacher('change school settings')) return;
  const s = DB.get(KEYS.settings, {});
  const oldUrl = s.logoUrl || s.logo || '';
  s.logo = '';
  s.logoUrl = '';
  s.logoStoragePath = '';
  removeCachedLocalImage(imageCacheKey('logo', 'school'));
  DB.set(KEYS.settings, s);
  const cloud = (FIREBASE_ENABLED && currentSchoolId)
    ? Promise.all([
        schoolRef().set({ profile: { logoUrl: '', logoStoragePath: '', updatedAt: firebase.firestore.FieldValue.serverTimestamp() } }, { merge: true }),
        removeImageManifest('logo', 'school')
      ])
    : Promise.resolve();
  cloud.then(() => removeStorageFile(oldUrl)).then(() => loadSettingsForm());
});

document.getElementById('saveSettings').addEventListener('click', () => {
  if (!requireHeadTeacher('change school settings')) return;
  const s = DB.get(KEYS.settings, {});
  s.teacherName = document.getElementById('teacherName').value.trim();
  s.schoolName = document.getElementById('schoolName').value.trim();
  s.address = document.getElementById('schoolAddress').value.trim();
  s.email = document.getElementById('schoolEmail').value.trim();
  s.currentTerm = document.getElementById('currentTerm').value;
  s.currentYear = document.getElementById('currentYear').value.trim();
  s.termDates = (s.termDates && typeof s.termDates === 'object') ? s.termDates : {};
  const termDateKey = termYearKey(s.currentTerm, s.currentYear);
  const termStart = document.getElementById('termStartDate').value;
  const termEnd = document.getElementById('termEndDate').value;
  if (termDateKey && termStart && termEnd) s.termDates[termDateKey] = { start: termStart, end: termEnd };
  else if (termDateKey && (!termStart || !termEnd)) delete s.termDates[termDateKey];
  s.attendanceOutOf = String(calculateTimesOpen(s.currentTerm, s.currentYear) || '');
  s.nextTermBegins = document.getElementById('nextTermBegins').value;
  s.reportLayout = document.getElementById('reportLayout').value;
  s.reportTheme = document.getElementById('reportThemeSelect') ? document.getElementById('reportThemeSelect').value : (s.reportTheme || 'schoolhub');
  if (isActiveGuest()) s.reportTheme = 'bw';
  s.headTeacherId = document.getElementById('headTeacherSelect').value;
  DB.set(KEYS.settings, s);
  auditAction('update', 'settings', 'school', 'Updated school and report settings');
  alert('Settings saved. School name on report: ' + (s.schoolName || '(not set)'));
});


/* ---------- v40 Academic Year Rollover ---------- */
let yearRolloverDraft = null;

function nextAcademicYearLabel(year) {
  const match = String(year || '').trim().match(/^(\d{4})\s*\/\s*(\d{4})$/);
  if (!match) return '';
  const first = Number(match[1]), second = Number(match[2]);
  if (second !== first + 1) return '';
  return `${first + 1}/${second + 1}`;
}

function rolloverSafeId(year) {
  return String(year || '').trim().replace(/[^0-9A-Za-z]+/g, '_').replace(/^_+|_+$/g, '');
}

function rolloverStudents() {
  return DB.get(KEYS.students, []).filter(student => student && student.id && student.isActive !== false);
}

function rolloverClassOptions(selectedId, includeBlank) {
  const classes = DB.get(KEYS.classes, []);
  let html = includeBlank ? '<option value="">Select class</option>' : '';
  html += classes.map(c => `<option value="${escapeHtml(c.id)}" ${c.id === selectedId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
  return html;
}

function rolloverDefaultDestination(classId) {
  const classes = DB.get(KEYS.classes, []);
  const index = classes.findIndex(c => c.id === classId);
  return index >= 0 && index < classes.length - 1 ? classes[index + 1].id : '';
}

function buildYearRolloverDraft() {
  const settings = DB.get(KEYS.settings, {});
  const fromYear = String(settings.currentYear || '').trim();
  const toYear = nextAcademicYearLabel(fromYear);
  const classes = DB.get(KEYS.classes, []);
  const students = rolloverStudents();
  const decisions = {};
  students.forEach(student => {
    const destination = rolloverDefaultDestination(student.classId);
    decisions[student.id] = destination
      ? { decision: 'promote', destinationClassId: destination }
      : { decision: 'graduate', destinationClassId: '' };
  });
  return {
    fromYear,
    toYear,
    classes,
    decisions,
    createdAt: new Date().toISOString()
  };
}

function rolloverDecisionLabel(value) {
  return ({ promote:'Promote', repeat:'Repeat', graduate:'Graduate / Complete', leave:'Transfer / Leave' })[value] || value;
}

function rolloverCounts(draft) {
  const counts = { promote:0, repeat:0, graduate:0, leave:0, unresolved:0 };
  const students = rolloverStudents();
  students.forEach(student => {
    const d = draft.decisions[student.id] || {};
    if (!['promote','repeat','graduate','leave'].includes(d.decision)) { counts.unresolved++; return; }
    if (d.decision === 'promote' && !d.destinationClassId) { counts.unresolved++; return; }
    counts[d.decision]++;
  });
  return counts;
}

function renderYearRollover() {
  const section = document.getElementById('yearRolloverSection');
  const host = document.getElementById('yearRolloverWorkspace');
  const openBtn = document.getElementById('openYearRolloverBtn');
  if (!section || !host || !openBtn) return;

  const allowed = isHeadTeacher() || isActiveGuest();
  section.classList.toggle('hidden', !allowed);
  if (!allowed) return;

  if (!yearRolloverDraft) {
    host.classList.add('hidden');
    openBtn.textContent = 'Start Year Rollover';
    return;
  }

  const draft = yearRolloverDraft;
  const students = rolloverStudents();
  const classes = DB.get(KEYS.classes, []);
  const byClass = classes.map(c => ({
    classInfo: c,
    students: students.filter(s => s.classId === c.id)
  })).filter(group => group.students.length);
  const counts = rolloverCounts(draft);

  host.classList.remove('hidden');
  openBtn.textContent = 'Restart Rollover';

  let html = `
    <div class="year-rollover-period">
      <label>Current Academic Year
        <input type="text" value="${escapeHtml(draft.fromYear)}" readonly>
      </label>
      <label>New Academic Year
        <input type="text" id="rolloverNewYear" value="${escapeHtml(draft.toYear)}" placeholder="e.g. 2027/2028">
      </label>
    </div>
    <div class="rollover-safety-note">
      <strong>Safe rollover:</strong> previous grades, attendance, remarks and calendar records remain under ${escapeHtml(draft.fromYear || 'the current year')}. Only each student's current enrolment/class is changed.
    </div>`;

  byClass.forEach(group => {
    html += `<section class="rollover-class-card">
      <div class="rollover-class-head">
        <div><h4>${escapeHtml(group.classInfo.name)}</h4><span>${group.students.length} active student${group.students.length === 1 ? '' : 's'}</span></div>
        <button type="button" class="btn-text rollover-mark-class" data-class="${escapeHtml(group.classInfo.id)}">Mark All Promote</button>
      </div>
      <div class="table-scroll"><table class="grades-table rollover-table">
        <thead><tr><th>Student</th><th>Decision</th><th>Destination</th></tr></thead><tbody>`;
    group.students.forEach(student => {
      const d = draft.decisions[student.id] || {};
      html += `<tr data-student="${escapeHtml(student.id)}">
        <td><strong>${escapeHtml(student.name || 'Unnamed student')}</strong><div class="meta">${escapeHtml(student.admissionId || '')}</div></td>
        <td><select class="rollover-decision" data-student="${escapeHtml(student.id)}">
          <option value="promote" ${d.decision === 'promote' ? 'selected' : ''}>Promote</option>
          <option value="repeat" ${d.decision === 'repeat' ? 'selected' : ''}>Repeat</option>
          <option value="graduate" ${d.decision === 'graduate' ? 'selected' : ''}>Graduate / Complete</option>
          <option value="leave" ${d.decision === 'leave' ? 'selected' : ''}>Transfer / Leave</option>
        </select></td>
        <td><select class="rollover-destination" data-student="${escapeHtml(student.id)}" ${d.decision === 'promote' ? '' : 'disabled'}>
          ${rolloverClassOptions(d.destinationClassId || '', true)}
        </select></td>
      </tr>`;
    });
    html += '</tbody></table></div></section>';
  });

  html += `<div class="rollover-review-card">
    <div><span>Promoted</span><strong>${counts.promote}</strong></div>
    <div><span>Repeated</span><strong>${counts.repeat}</strong></div>
    <div><span>Completed</span><strong>${counts.graduate}</strong></div>
    <div><span>Leaving</span><strong>${counts.leave}</strong></div>
    <div class="${counts.unresolved ? 'rollover-unresolved' : ''}"><span>Unresolved</span><strong>${counts.unresolved}</strong></div>
  </div>
  <div class="rollover-actions">
    <button type="button" id="downloadRolloverBackupBtn" class="btn-secondary">Download Year-End Backup</button>
    <button type="button" id="reviewYearRolloverBtn" class="btn-secondary">Review Rollover</button>
    <button type="button" id="cancelYearRolloverBtn" class="btn-text">Cancel</button>
  </div>
  <div id="yearRolloverReview"></div>`;

  host.innerHTML = html;

  const newYearInput = document.getElementById('rolloverNewYear');
  newYearInput.addEventListener('input', () => { draft.toYear = newYearInput.value.trim(); });

  host.querySelectorAll('.rollover-decision').forEach(select => {
    select.addEventListener('change', () => {
      const studentId = select.dataset.student;
      const student = students.find(s => s.id === studentId);
      if (!student) return;
      const decision = select.value;
      const current = draft.decisions[studentId] || {};
      current.decision = decision;
      if (decision === 'repeat') current.destinationClassId = student.classId;
      else if (decision === 'promote' && !current.destinationClassId) current.destinationClassId = rolloverDefaultDestination(student.classId);
      else if (decision === 'graduate' || decision === 'leave') current.destinationClassId = '';
      draft.decisions[studentId] = current;
      renderYearRollover();
    });
  });

  host.querySelectorAll('.rollover-destination').forEach(select => {
    select.addEventListener('change', () => {
      const studentId = select.dataset.student;
      draft.decisions[studentId] = Object.assign({}, draft.decisions[studentId] || {}, { destinationClassId: select.value });
      renderYearRollover();
    });
  });

  host.querySelectorAll('.rollover-mark-class').forEach(button => {
    button.addEventListener('click', () => {
      const classId = button.dataset.class;
      const destination = rolloverDefaultDestination(classId);
      students.filter(s => s.classId === classId).forEach(student => {
        draft.decisions[student.id] = destination
          ? { decision:'promote', destinationClassId:destination }
          : { decision:'graduate', destinationClassId:'' };
      });
      renderYearRollover();
    });
  });

  document.getElementById('downloadRolloverBackupBtn').addEventListener('click', downloadYearRolloverBackup);
  document.getElementById('reviewYearRolloverBtn').addEventListener('click', showYearRolloverReview);
  document.getElementById('cancelYearRolloverBtn').addEventListener('click', () => {
    yearRolloverDraft = null;
    renderYearRollover();
  });
}

function buildYearEndSnapshot(draft) {
  return {
    app: 'AlatiphA SchoolHub',
    type: 'academic-year-rollover',
    version: typeof APP_VERSION !== 'undefined' ? APP_VERSION : '',
    schoolId: currentSchoolId || '',
    createdAt: new Date().toISOString(),
    fromYear: draft.fromYear,
    toYear: draft.toYear,
    decisions: JSON.parse(JSON.stringify(draft.decisions || {})),
    data: {
      settings: DB.get(KEYS.settings, {}),
      classes: DB.get(KEYS.classes, []),
      subjects: DB.get(KEYS.subjects, []),
      students: DB.get(KEYS.students, []),
      grades: DB.get(KEYS.grades, {}),
      attendance: DB.get(KEYS.attendance, {}),
      teacherAttendance: DB.get(KEYS.teacherAttendance, {}),
      schoolCalendar: DB.get(KEYS.schoolCalendar, {}),
      remarks: DB.get(KEYS.remarks, {}),
      staff: DB.get(KEYS.staff, [])
    }
  };
}

function downloadYearRolloverBackup() {
  if (!yearRolloverDraft) return;
  const snapshot = buildYearEndSnapshot(yearRolloverDraft);
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `SchoolHub_Year_End_Backup_${rolloverSafeId(snapshot.fromYear) || 'year'}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function showYearRolloverReview() {
  if (!yearRolloverDraft) return;
  const draft = yearRolloverDraft;
  draft.toYear = String(document.getElementById('rolloverNewYear')?.value || draft.toYear || '').trim();
  const review = document.getElementById('yearRolloverReview');
  const counts = rolloverCounts(draft);
  const validYear = /^\d{4}\s*\/\s*\d{4}$/.test(draft.toYear) && draft.toYear !== draft.fromYear;
  const unresolved = counts.unresolved + (validYear ? 0 : 1);

  review.innerHTML = `<div class="rollover-confirm-card">
    <h4>Review Rollover</h4>
    <p><strong>${escapeHtml(draft.fromYear || 'Current year')} → ${escapeHtml(draft.toYear || 'New year not set')}</strong></p>
    <p>${counts.promote} promoted · ${counts.repeat} repeated · ${counts.graduate} completed · ${counts.leave} leaving</p>
    ${unresolved ? '<p class="form-validation">Resolve every destination and enter a different Academic Year before applying.</p>' : '<p class="hint">A full year-end snapshot will be created before any student is moved.</p>'}
    <button type="button" id="applyYearRolloverBtn" class="btn-primary" ${unresolved ? 'disabled' : ''}>Apply Rollover</button>
  </div>`;

  const apply = document.getElementById('applyYearRolloverBtn');
  if (apply) apply.addEventListener('click', applyYearRollover);
  review.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

function storeLocalRolloverSnapshot(snapshot, rolloverId) {
  const key = ns(`arc_year_rollover_snapshot_${rolloverId}`);
  localStorage.setItem(key, JSON.stringify(snapshot));
  const indexKey = ns('arc_year_rollover_index');
  let index = [];
  try { index = JSON.parse(localStorage.getItem(indexKey) || '[]'); } catch (e) {}
  if (!Array.isArray(index)) index = [];
  if (!index.some(item => item && item.id === rolloverId)) {
    index.push({ id:rolloverId, fromYear:snapshot.fromYear, toYear:snapshot.toYear, createdAt:snapshot.createdAt });
    localStorage.setItem(indexKey, JSON.stringify(index));
  }
}

function cloudRolloverSnapshot(snapshot, rolloverId, counts) {
  if (!FIREBASE_ENABLED || !currentSchoolId) return Promise.resolve();
  const metaRef = schoolRef().collection('yearRollovers').doc(rolloverId);
  const json = JSON.stringify(snapshot);
  const chunkSize = 450000;
  const chunks = [];
  for (let i = 0; i < json.length; i += chunkSize) chunks.push(json.slice(i, i + chunkSize));

  return metaRef.get().then(existing => {
    if (existing.exists) throw new Error(`A rollover for ${snapshot.fromYear} has already been recorded.`);
    const operations = [
      batch => batch.set(metaRef, {
        fromYear: snapshot.fromYear,
        toYear: snapshot.toYear,
        createdBy: currentUid || '',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        chunkCount: chunks.length,
        counts,
        immutable: true
      })
    ];
    chunks.forEach((chunk, index) => {
      operations.push(batch => batch.set(metaRef.collection('snapshot').doc(String(index).padStart(4,'0')), {
        index,
        total: chunks.length,
        encoding:'json',
        chunk
      }));
    });
    return commitChunks(operations);
  });
}

function rolloverUpdatedStudents(draft) {
  const now = new Date().toISOString();
  return DB.get(KEYS.students, []).map(student => {
    const decision = draft.decisions[student.id];
    if (!decision || student.isActive === false) return student;
    const fromClassId = student.classId;
    const next = Object.assign({}, student);
    next.classHistory = Object.assign({}, student.classHistory || {}, { [draft.fromYear]: fromClassId });
    next.rolloverHistory = Array.isArray(student.rolloverHistory) ? student.rolloverHistory.slice() : [];
    next.rolloverHistory.push({
      fromYear:draft.fromYear,
      toYear:draft.toYear,
      decision:decision.decision,
      fromClassId,
      toClassId:decision.destinationClassId || '',
      at:now
    });
    if (decision.decision === 'promote') {
      next.classId = decision.destinationClassId;
      next.isActive = true;
      next.enrollmentStatus = 'active';
    } else if (decision.decision === 'repeat') {
      next.classId = fromClassId;
      next.isActive = true;
      next.enrollmentStatus = 'active';
    } else if (decision.decision === 'graduate') {
      next.isActive = false;
      next.enrollmentStatus = 'graduated';
      next.completedYear = draft.fromYear;
    } else if (decision.decision === 'leave') {
      next.isActive = false;
      next.enrollmentStatus = 'left';
      next.leftYear = draft.fromYear;
    }
    return next;
  });
}

async function applyYearRollover() {
  if (!yearRolloverDraft || !requireHeadTeacher('apply an academic year rollover')) return;
  const draft = yearRolloverDraft;
  draft.toYear = String(document.getElementById('rolloverNewYear')?.value || draft.toYear || '').trim();
  const counts = rolloverCounts(draft);
  if (counts.unresolved) { alert('Resolve every student decision and destination first.'); return; }
  if (!/^\d{4}\s*\/\s*\d{4}$/.test(draft.toYear) || draft.toYear === draft.fromYear) {
    alert('Enter a valid new Academic Year, for example 2027/2028.'); return;
  }
  const settings = DB.get(KEYS.settings, {});
  if (String(settings.currentYear || '').trim() !== draft.fromYear) {
    alert('The current Academic Year changed after this rollover was prepared. Restart the rollover.'); return;
  }
  if (settings.currentTerm && settings.currentTerm !== 'Term 3') {
    const continueEarly = confirm(`Current term is ${settings.currentTerm}, not Term 3. Continue with end-of-year rollover anyway?`);
    if (!continueEarly) return;
  }
  if (!confirm(`Apply rollover from ${draft.fromYear} to ${draft.toYear}?\n\nThis will update the current class/enrolment status of ${rolloverStudents().length} students. A year-end snapshot is created first.`)) return;

  const applyBtn = document.getElementById('applyYearRolloverBtn');
  if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Applying…'; }

  try {
    if (FIREBASE_ENABLED && currentSchoolId && (cloudHydrationInProgress || !sessionDataReady)) {
      throw new Error('School data is still synchronizing. Wait for sync to finish and try again.');
    }

    const rolloverId = `year_${rolloverSafeId(draft.fromYear)}`;
    const snapshot = buildYearEndSnapshot(draft);
    storeLocalRolloverSnapshot(snapshot, rolloverId);
    if (FIREBASE_ENABLED && currentSchoolId) {
      await flushPendingCloudWrites();
      await safetyCall('applySchoolYearChange', {mode:'rollover',fromYear:draft.fromYear,toYear:draft.toYear,decisions:draft.decisions});
      await pullCloudData();
      yearRolloverDraft = null;
      loadSettingsForm(); renderStudents(); renderClasses(); renderYearRollover();
      alert('Academic Year Rollover complete. The archive and roster were saved atomically.');
      return;
    }

    const updatedStudents = rolloverUpdatedStudents(draft);
    const updatedSettings = Object.assign({}, settings, {
      currentYear: draft.toYear,
      currentTerm: 'Term 1',
      attendanceOutOf: '',
      nextTermBegins: '',
      lastYearRollover: {
        id: rolloverId,
        fromYear: draft.fromYear,
        toYear: draft.toYear,
        at: new Date().toISOString(),
        counts
      }
    });

    if (FIREBASE_ENABLED && currentSchoolId) {
      const studentRef = schoolRef().collection('students');
      const operations = updatedStudents
        .filter(student => draft.decisions[student.id])
        .map(student => batch => batch.set(
          studentRef.doc(String(student.id)),
          stripImagesForCloud('students', student),
          { merge:true }
        ));
      operations.push(batch => batch.set(schoolRef(), {
        profile: stripImagesForCloud('settings', updatedSettings),
        schemaVersion: CLOUD_SCHEMA_VERSION,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge:true }));
      await commitChunks(operations);
      setLastSyncedNow();
    }

    DB.set(KEYS.students, updatedStudents, {skipCloudSync:true});
    DB.set(KEYS.settings, updatedSettings, {skipCloudSync:true});
    auditAction('rollover', 'academicYear', rolloverId,
      `Academic year rollover ${draft.fromYear} → ${draft.toYear}: ${counts.promote} promoted, ${counts.repeat} repeated, ${counts.graduate} completed, ${counts.leave} leaving`);

    yearRolloverDraft = null;
    loadSettingsForm();
    renderStudents();
    renderClasses();
    renderYearRollover();
    alert(`Academic Year Rollover complete.\n\n${draft.fromYear} → ${draft.toYear}\nPromoted: ${counts.promote}\nRepeated: ${counts.repeat}\nCompleted: ${counts.graduate}\nLeaving: ${counts.leave}\n\nPrevious academic-year records remain preserved.`);
  } catch (error) {
    console.error('Academic year rollover failed:', error);
    alert('The rollover was NOT completed.\n\nA local year-end snapshot was preserved before changes were attempted.\n\n' + (error.message || error));
    if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Apply Rollover'; }
  }
}

const openYearRolloverBtn = document.getElementById('openYearRolloverBtn');
if (openYearRolloverBtn) {
  openYearRolloverBtn.addEventListener('click', () => {
    if (!requireHeadTeacher('start an academic year rollover')) return;
    const settings = DB.get(KEYS.settings, {});
    if (!String(settings.currentYear || '').trim()) {
      alert('Set the current Academic Year in Setup before starting rollover.');
      return;
    }
    if (!DB.get(KEYS.classes, []).length || !rolloverStudents().length) {
      alert('Add classes and active students before starting rollover.');
      return;
    }
    yearRolloverDraft = buildYearRolloverDraft();
    renderYearRollover();
    document.getElementById('yearRolloverWorkspace')?.scrollIntoView({behavior:'smooth', block:'start'});
  });
}



/* ---------- v40 Year-End emergency restore ---------- */
let pendingYearEndRestore = null;

function parseYearEndBackupFile(text) {
  let parsed;
  try { parsed = JSON.parse(String(text || '')); }
  catch (e) { throw new Error('This file is not valid JSON.'); }

  if (!parsed || parsed.app !== 'AlatiphA SchoolHub' || parsed.type !== 'academic-year-rollover' || !parsed.data) {
    throw new Error('This is not a SchoolHub Year-End Rollover backup.');
  }
  if (!parsed.fromYear || !parsed.toYear) {
    throw new Error('The rollover year information is missing from this backup.');
  }
  if (!Array.isArray(parsed.data.students) || !Array.isArray(parsed.data.classes) ||
      !parsed.data.settings || typeof parsed.data.settings !== 'object') {
    throw new Error('This Year-End backup is incomplete.');
  }
  if (parsed.schoolId && currentSchoolId && String(parsed.schoolId) !== String(currentSchoolId)) {
    throw new Error('This backup belongs to a different SchoolHub school.');
  }
  return parsed;
}

function yearEndRestoreCounts(snapshot) {
  const data = snapshot.data || {};
  return {
    students: Array.isArray(data.students) ? data.students.length : 0,
    classes: Array.isArray(data.classes) ? data.classes.length : 0,
    grades: data.grades && typeof data.grades === 'object' ? Object.keys(data.grades).length : 0,
    attendance: data.attendance && typeof data.attendance === 'object' ? Object.keys(data.attendance).length : 0,
    remarks: data.remarks && typeof data.remarks === 'object' ? Object.keys(data.remarks).length : 0
  };
}

function renderYearEndRestorePreview() {
  const host = document.getElementById('yearRolloverRestorePreview');
  if (!host) return;
  if (!pendingYearEndRestore) {
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }

  const snapshot = pendingYearEndRestore;
  const counts = yearEndRestoreCounts(snapshot);
  const created = snapshot.createdAt ? new Date(snapshot.createdAt) : null;
  const createdText = created && !Number.isNaN(created.getTime()) ? created.toLocaleString() : 'Unknown';
  const currentStudents = DB.get(KEYS.students, []);
  const backupIds = new Set(snapshot.data.students.map(s => String(s.id || '')));
  const newerStudents = currentStudents.filter(s => s && s.id && !backupIds.has(String(s.id))).length;

  host.classList.remove('hidden');
  host.innerHTML = `<div class="rollover-restore-card">
    <div class="rollover-restore-head">
      <div>
        <h4>Restore Academic Year</h4>
        <p><strong>${escapeHtml(snapshot.fromYear)} pre-rollover state</strong></p>
      </div>
      <button type="button" id="cancelYearEndRestoreBtn" class="btn-text">Cancel</button>
    </div>
    <div class="rollover-restore-meta">
      <div><span>Backup created</span><strong>${escapeHtml(createdText)}</strong></div>
      <div><span>Rollover target</span><strong>${escapeHtml(snapshot.toYear)}</strong></div>
      <div><span>Students in backup</span><strong>${counts.students}</strong></div>
      <div><span>Classes</span><strong>${counts.classes}</strong></div>
    </div>
    <p class="rollover-restore-explain">
      This emergency restore reverses the <strong>rollover changes</strong>: it restores each backed-up student's
      pre-rollover class/enrolment record and restores the school settings from the backup.
      Grades, attendance, remarks, staff, subjects, classes and calendar records are not deleted or replaced because
      the rollover itself does not rewrite them.
    </p>
    ${newerStudents ? `<p class="hint">${newerStudents} student record${newerStudents === 1 ? '' : 's'} created after this backup will be kept to avoid data loss.</p>` : ''}
    <div class="rollover-restore-stats">
      <span>${counts.grades} grade set${counts.grades === 1 ? '' : 's'} preserved in the backup</span>
      <span>${counts.attendance} attendance record${counts.attendance === 1 ? '' : 's'} preserved</span>
      <span>${counts.remarks} remark set${counts.remarks === 1 ? '' : 's'} preserved</span>
    </div>
    <div class="rollover-restore-actions">
      <button type="button" id="applyYearEndRestoreBtn" class="btn-primary">Restore Pre-Rollover State</button>
    </div>
  </div>`;

  document.getElementById('cancelYearEndRestoreBtn')?.addEventListener('click', () => {
    pendingYearEndRestore = null;
    const input = document.getElementById('restoreYearEndBackupInput');
    if (input) input.value = '';
    renderYearEndRestorePreview();
  });
  document.getElementById('applyYearEndRestoreBtn')?.addEventListener('click', applyYearEndEmergencyRestore);
}

function preserveBeforeEmergencyRestore() {
  const snapshot = {
    app:'AlatiphA SchoolHub',
    type:'pre-emergency-restore',
    createdAt:new Date().toISOString(),
    schoolId:currentSchoolId || '',
    data:{
      settings:DB.get(KEYS.settings, {}),
      students:DB.get(KEYS.students, [])
    }
  };
  const key = ns(`arc_pre_emergency_restore_${Date.now()}`);
  try { localStorage.setItem(key, JSON.stringify(snapshot)); }
  catch (e) { throw new Error('Could not preserve the pre-restore snapshot. Free device storage before retrying.'); }
}

function mergedStudentsForEmergencyRestore(snapshotStudents) {
  const current = DB.get(KEYS.students, []);
  const backupMap = new Map((snapshotStudents || []).filter(s => s && s.id).map(s => [String(s.id), s]));
  const restored = [];
  const seen = new Set();

  current.forEach(student => {
    const id = String(student && student.id || '');
    if (!id) return;
    if (backupMap.has(id)) restored.push(JSON.parse(JSON.stringify(backupMap.get(id))));
    else restored.push(student); // never delete students added after the backup
    seen.add(id);
  });
  backupMap.forEach((student, id) => {
    if (!seen.has(id)) restored.push(JSON.parse(JSON.stringify(student)));
  });
  return restored;
}

async function applyYearEndEmergencyRestore() {
  if (!pendingYearEndRestore || !requireHeadTeacher('restore a Year-End backup')) return;
  const snapshot = pendingYearEndRestore;
  const button = document.getElementById('applyYearEndRestoreBtn');
  const currentSettings = DB.get(KEYS.settings, {});
  const backupSettings = snapshot.data.settings || {};
  const currentYear = String(currentSettings.currentYear || '');
  const expectedPostRolloverYear = String(snapshot.toYear || '');

  if (FIREBASE_ENABLED && currentSchoolId && (cloudHydrationInProgress || !sessionDataReady)) {
    alert('School data is still synchronizing. Wait for sync to finish and try again.');
    return;
  }

  const yearWarning = currentYear && currentYear !== expectedPostRolloverYear
    ? `\n\nYour current Academic Year is ${currentYear}, while this backup was prepared for a rollover to ${expectedPostRolloverYear}.`
    : '';

  if (!confirm(`Restore the school to its pre-rollover roster/settings for ${snapshot.fromYear}?${yearWarning}\n\nNo grades, attendance, remarks, staff, classes, subjects or calendar records will be deleted.`)) return;

  if (button) { button.disabled = true; button.textContent = 'Restoring…'; }

  try {
    preserveBeforeEmergencyRestore();
    if (FIREBASE_ENABLED && currentSchoolId) {
      await flushPendingCloudWrites();
      const safeSnapshot = JSON.parse(JSON.stringify(snapshot));
      safeSnapshot.data.students = stripImagesForCloud('students', safeSnapshot.data.students);
      safeSnapshot.data.settings = stripImagesForCloud('settings', safeSnapshot.data.settings);
      await safetyCall('applySchoolYearChange', {mode:'restore',snapshot:safeSnapshot,expectedYear:currentYear});
      await pullCloudData();
      pendingYearEndRestore = null;
      loadSettingsForm(); renderClasses(); renderStudents(); renderYearRollover(); renderYearEndRestorePreview();
      alert('Year-End emergency restore complete. The archive and roster were saved atomically.');
      return;
    }

    const restoredStudents = mergedStudentsForEmergencyRestore(snapshot.data.students || []);
    const restoredSettings = JSON.parse(JSON.stringify(backupSettings));
    const backupIds = new Set((snapshot.data.students || []).map(s => String(s.id || '')));

    // Cloud first. Replace backed-up student documents so rollover-only fields
    // (classHistory, rolloverHistory, completion status, etc.) are removed too.
    // Students created after the backup are deliberately left untouched.
    if (FIREBASE_ENABLED && currentSchoolId) {
      const ops = [];
      restoredStudents.filter(s => backupIds.has(String(s.id))).forEach(student => {
        const cloudStudent = stripImagesForCloud('students', [student])[0];
        ops.push(batch => batch.set(studentRef(String(student.id)), cloudStudent));
      });
      ops.push(batch => batch.set(schoolRef(), {
        profile: stripImagesForCloud('settings', restoredSettings),
        schemaVersion: CLOUD_SCHEMA_VERSION,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge:true }));

      await commitChunks(ops);
      setLastSyncedNow();
    }

    // Only after every cloud batch succeeds do we change the active browser.
    DB.set(KEYS.students, restoredStudents, {skipCloudSync:true});
    DB.set(KEYS.settings, restoredSettings, {skipCloudSync:true});

    auditAction('restore', 'academicYear', `restore_${rolloverSafeId(snapshot.fromYear)}`,
      `Restored pre-rollover student roster/settings for ${snapshot.fromYear}`);

    pendingYearEndRestore = null;
    const input = document.getElementById('restoreYearEndBackupInput');
    if (input) input.value = '';
    loadSettingsForm();
    renderClasses();
    renderStudents();
    renderYearRollover();
    renderYearEndRestorePreview();

    alert(`Year-End emergency restore complete.\n\nAcademic Year restored: ${snapshot.fromYear}\nBacked-up student enrolment/class records restored: ${snapshot.data.students.length}\n\nNo grades, attendance, remarks, staff, classes, subjects or calendar records were deleted.`);
  } catch (error) {
    console.error('Year-End emergency restore failed:', error);
    alert('The emergency restore did not complete.\n\nNo local SchoolHub data was replaced. You can safely retry using the same Year-End backup.\n\n' + (error.message || error));
    if (button) { button.disabled = false; button.textContent = 'Restore Pre-Rollover State'; }
  }
}

const restoreYearEndBackupBtn = document.getElementById('restoreYearEndBackupBtn');
const restoreYearEndBackupInput = document.getElementById('restoreYearEndBackupInput');

if (restoreYearEndBackupBtn && restoreYearEndBackupInput) {
  restoreYearEndBackupBtn.addEventListener('click', () => {
    if (!requireHeadTeacher('restore a Year-End backup')) return;
    restoreYearEndBackupInput.value = '';
    restoreYearEndBackupInput.click();
  });

  restoreYearEndBackupInput.addEventListener('change', event => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      alert('That backup is too large to restore safely in the browser.');
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        pendingYearEndRestore = parseYearEndBackupFile(reader.result);
        renderYearEndRestorePreview();
        document.getElementById('yearRolloverRestorePreview')?.scrollIntoView({behavior:'smooth', block:'start'});
      } catch (error) {
        pendingYearEndRestore = null;
        renderYearEndRestorePreview();
        alert(error.message || 'Unable to read this Year-End backup.');
        event.target.value = '';
      }
    };
    reader.onerror = () => {
      alert('Unable to read this Year-End backup file.');
      event.target.value = '';
    };
    reader.readAsText(file);
  });
}


/* ---------- Backup & Restore ---------- */
document.getElementById('exportBackupBtn').addEventListener('click', () => {
  const payload = {
    app: 'AlatiphA SchoolHub',
    exportedAt: new Date().toISOString(),
    version: APP_VERSION,
    data: {
      settings: DB.get(KEYS.settings, {}),
      classes: DB.get(KEYS.classes, []),
      subjects: DB.get(KEYS.subjects, []),
      students: DB.get(KEYS.students, []),
      grades: DB.get(KEYS.grades, {}),
      attendance: DB.get(KEYS.attendance, {}),
      teacherAttendance: DB.get(KEYS.teacherAttendance, {}),
      schoolCalendar: DB.get(KEYS.schoolCalendar, {}),
      remarks: DB.get(KEYS.remarks, {}),
      staff: DB.get(KEYS.staff, [])
    }
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `alatipha-report-cards-backup-${dateStr}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

document.getElementById('importBackupInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch (err) {
      alert('That file is not a valid backup (invalid JSON).');
      e.target.value = '';
      return;
    }
    if (!parsed || !parsed.data) {
      alert('That file does not look like an AlatiphA SchoolHub backup.');
      e.target.value = '';
      return;
    }
    const ok = confirm('This will replace ALL current classes, students, subjects, grades, remarks and staff with the contents of this backup. This cannot be undone. Continue?');
    if (!ok) { e.target.value = ''; return; }
    const d = parsed.data;
    if (d.settings) DB.set(KEYS.settings, d.settings);
    if (d.classes) DB.set(KEYS.classes, d.classes);
    if (d.subjects) DB.set(KEYS.subjects, d.subjects);
    if (d.students) DB.set(KEYS.students, d.students);
    if (d.grades) DB.set(KEYS.grades, d.grades);
    if (d.attendance) DB.set(KEYS.attendance, d.attendance);
    if (d.teacherAttendance) DB.set(KEYS.teacherAttendance, d.teacherAttendance);
    if (d.schoolCalendar) DB.set(KEYS.schoolCalendar, d.schoolCalendar);
    if (d.remarks) DB.set(KEYS.remarks, d.remarks);
    if (d.staff) DB.set(KEYS.staff, d.staff);
    auditAction('restore', 'backup', 'local', 'Restored a local backup');
    alert('Backup restored. The app will now reload.');
    location.reload();
  };
  reader.readAsText(file);
});

/* ---------- Classes ---------- */
let editingClassId = null;

function renderClasses() {
  if (FIREBASE_ENABLED && !sessionDataReady) { const el = document.getElementById('classList'); if (el) el.innerHTML = '<li class="empty">Loading your school workspace…</li>'; return; }
  if (isTeacher()) {
    const list = document.getElementById('classList');
    const classes = getAccessibleClasses();
    list.innerHTML = classes.length ? classes.map(c => `<li><div><strong>${escapeHtml(c.name)}</strong><div class="meta">${DB.get(KEYS.students, []).filter(s => s.classId === c.id).length} student(s) on roll</div></div></li>`).join('') : '<li class="empty">No classes have been assigned to you yet.</li>';
    return;
  }
  fillStaffSelect(document.getElementById('newClassTeacherSelect'), '');
  const list = document.getElementById('classList');
  const classes = getAccessibleClasses();
  const staffById = {};
  DB.get(KEYS.staff, []).forEach(s => { staffById[s.id] = s; });
  list.innerHTML = '';
  if (!classes.length) { list.innerHTML = '<li class="empty">No classes yet — add one below to get started.</li>'; return; }
  classes.forEach(c => {
    const students = DB.get(KEYS.students, []).filter(s => s.classId === c.id);
    const li = document.createElement('li');
    if (editingClassId === c.id) {
      li.innerHTML = `<div class="edit-row">
        <input type="text" class="edit-class-name" value="${escapeHtml(c.name)}">
        <label>Class Teacher
          <select class="edit-class-teacher"></select>
        </label>
        <div class="edit-actions">
          <button class="save-btn save-class" data-id="${c.id}">Update</button>
          <button class="cancel-btn cancel-class">Cancel</button>
        </div>
      </div>`;
    } else {
      const teacher = c.classTeacherId ? staffById[c.classTeacherId] : null;
      const teacherPart = teacher ? `Class Teacher: ${escapeHtml(teacher.name)}` : 'Class Teacher: —';
      li.innerHTML = `<div class="class-list-main">
          <strong>${escapeHtml(c.name)}</strong>
          <div class="meta">${students.length} student(s) on roll</div>
          <div class="class-teacher-line">${teacherPart}</div>
        </div>
        <div class="class-list-actions">
          <button data-id="${c.id}" class="edit-class" type="button">Edit</button>
          <button data-id="${c.id}" class="del-class" type="button">Delete</button>
        </div>`;
    }
    list.appendChild(li);
  });
  list.querySelectorAll('.edit-row .edit-class-teacher').forEach(sel => {
    const li = sel.closest('li');
    const classId = li.querySelector('.save-class').dataset.id;
    const c = classes.find(x => x.id === classId);
    fillStaffSelect(sel, c ? c.classTeacherId : '');
  });
  list.querySelectorAll('.edit-class').forEach(btn => {
    btn.addEventListener('click', () => { editingClassId = btn.dataset.id; renderClasses(); });
  });
  list.querySelectorAll('.cancel-class').forEach(btn => {
    btn.addEventListener('click', () => { editingClassId = null; renderClasses(); });
  });
  list.querySelectorAll('.save-class').forEach(btn => {
    btn.addEventListener('click', () => {
      const li = btn.closest('li');
      const name = li.querySelector('.edit-class-name').value.trim();
      if (!name) return;
      const classTeacherId = li.querySelector('.edit-class-teacher').value;
      const classes = DB.get(KEYS.classes, []);
      const c = classes.find(x => x.id === btn.dataset.id);
      if (c) { c.name = name; c.classTeacherId = classTeacherId; }
      DB.set(KEYS.classes, classes);
      auditAction('update', 'class', c ? c.id : btn.dataset.id, `Updated class: ${name}`);
      editingClassId = null;
      renderClasses();
    });
  });
  list.querySelectorAll('.del-class').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this class and its students/grades?')) return;
      const id = btn.dataset.id;
      try {
        if (FIREBASE_ENABLED && currentSchoolId) {
          if (cloudHydrationInProgress || !sessionDataReady) throw new Error('School data is still synchronizing.');
          const refs = [
            schoolRef().collection('students').where('classId', '==', id).get(),
            schoolRef().collection('grades').where('classId', '==', id).get(),
            schoolRef().collection('attendance').where('classId', '==', id).get(),
            schoolRef().collection('remarks').where('classId', '==', id).get()
          ];
          const snaps = await Promise.all(refs);
          const ops = [batch => batch.delete(schoolRef().collection('classes').doc(String(id)))];
          snaps.forEach(snap => snap.forEach(doc => ops.push(batch => batch.delete(doc.ref))));
          await commitChunks(ops);
          setLastSyncedNow();
        }

        DB.set(KEYS.classes, DB.get(KEYS.classes, []).filter(c => c.id !== id), {skipCloudSync:true});
        DB.set(KEYS.students, DB.get(KEYS.students, []).filter(s => s.classId !== id), {skipCloudSync:true});
        const grades = DB.get(KEYS.grades, {});
        Object.keys(grades).forEach(k => { if (k.startsWith(id + '__')) delete grades[k]; });
        DB.set(KEYS.grades, grades, {skipCloudSync:true});
        const attendance = DB.get(KEYS.attendance, {});
        Object.keys(attendance).forEach(k => { if (k.startsWith(id + '__')) delete attendance[k]; });
        DB.set(KEYS.attendance, attendance, {skipCloudSync:true});
        const remarks = DB.get(KEYS.remarks, {});
        Object.keys(remarks).forEach(k => { if (k.startsWith(id + '__')) delete remarks[k]; });
        DB.set(KEYS.remarks, remarks, {skipCloudSync:true});
        auditAction('delete', 'class', id, 'Deleted class and its academic records');
        renderClasses();
      } catch (error) {
        alert('The class was NOT deleted. Existing data has been left unchanged.\n\n' + (error.message || error));
      }
    });
  });
}

const toggleAddClassBtn = document.getElementById('toggleAddClassBtn');
const addClassForm = document.getElementById('addClassForm');
if (toggleAddClassBtn && addClassForm) {
  toggleAddClassBtn.addEventListener('click', () => {
    const open = addClassForm.classList.toggle('hidden') === false;
    toggleAddClassBtn.textContent = open ? 'Collapse' : 'Expand';
    toggleAddClassBtn.setAttribute('aria-expanded', String(open));
    if (open) document.getElementById('newClassName')?.focus();
  });
}

document.getElementById('addClassBtn').addEventListener('click', () => {
  if (!requireHeadTeacher('manage classes')) return;
  const input = document.getElementById('newClassName');
  const name = input.value.trim();
  if (!name) {
    input.focus();
    return;
  }
  const classTeacherId = document.getElementById('newClassTeacherSelect').value;
  const classes = DB.get(KEYS.classes, []);
  classes.push({ id: uid(), name, classTeacherId });
  DB.set(KEYS.classes, classes);
  auditAction('create', 'class', classes[classes.length - 1].id, `Created class: ${name}`);
  input.value = '';
  if (addClassForm && toggleAddClassBtn) {
    addClassForm.classList.add('hidden');
    toggleAddClassBtn.textContent = 'Expand';
    toggleAddClassBtn.setAttribute('aria-expanded', 'false');
  }
  renderClasses();
});

/* ---------- Students ---------- */
function renderStudentClassSelect() {
  const sel = document.getElementById('studentClassSelect');
  fillClassSelect(sel);
  renderStudents();
}

function studentClassSelectionKey() {
  return `arc_student_class_selection__${String(currentSchoolId || currentUid || 'local')}`;
}

function fillClassSelect(sel) {
  const classes = getAccessibleClasses();
  const prev = sel.value;
  let saved = '';
  try { saved = localStorage.getItem(studentClassSelectionKey()) || ''; } catch (e) {}
  sel.innerHTML = classes.length
    ? classes.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')
    : '<option value="">No assigned classes</option>';
  const wanted = classes.some(c => c.id === prev) ? prev : (classes.some(c => c.id === saved) ? saved : '');
  if (wanted) sel.value = wanted;
}

let editingStudentId = null;

function calculateStudentAge(dob) {
  if (!dob) return '';
  const parts = String(dob).split('-').map(Number);
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return '';
  const birth = new Date(parts[0], parts[1] - 1, parts[2]);
  if (Number.isNaN(birth.getTime())) return '';
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const beforeBirthday = today.getMonth() < birth.getMonth() || (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate());
  if (beforeBirthday) age--;
  return age >= 0 ? String(age) : '';
}

function renderStudents() {
  if (FIREBASE_ENABLED && !sessionDataReady) { const el = document.getElementById('studentList'); if (el) el.innerHTML = '<li class="empty">Loading your school workspace…</li>'; return; }
  const sel = document.getElementById('studentClassSelect');
  if (!sel.options.length) fillClassSelect(sel);
  const query = document.getElementById('studentSearchInput').value.trim().toLowerCase();
  const searchMode = query.length > 0;
  const list = document.getElementById('studentList');
  list.innerHTML = '';

  let students;
  if (searchMode) {
    students = getAccessibleStudents().filter(s => {
      const haystack = [s.name, s.admissionId, s.guardianName, s.parentPhone, s.houseGps, s.disability]
        .map(v => String(v || '').toLowerCase()).join(' ');
      return haystack.includes(query);
    });
    if (!students.length) { list.innerHTML = '<li class="empty">No students match your search.</li>'; return; }
  } else {
    const classId = sel.value;
    if (classId && !requireClassAccess(classId)) { list.innerHTML = '<li class="empty">You do not have access to this class.</li>'; return; }
    if (!classId) { list.innerHTML = '<li class="empty">Add a class first.</li>'; return; }
    students = getAccessibleStudents().filter(s => s.classId === classId);
    if (!students.length) { list.innerHTML = '<li class="empty">No students yet — add one below.</li>'; return; }
  }

  const classesById = {};
  DB.get(KEYS.classes, []).forEach(c => { classesById[c.id] = c.name; });

  students.forEach(st => {
    const li = document.createElement('li');
    if (editingStudentId === st.id) {
      const photoPreview = st.photo
        ? `<img src="${st.photo}" alt="" class="edit-photo-preview">
           <button type="button" class="btn-text remove-student-photo" data-id="${st.id}">Remove photo</button>`
        : '';
      li.innerHTML = `<div class="edit-row">
        <label>Full name <span class="required-mark">*</span>
          <input type="text" class="edit-student-name" value="${escapeHtml(st.name)}" placeholder="Full name" required>
        </label>
        <label>Sex <span class="required-mark">*</span>
          <select class="edit-student-gender" required>
            <option value="">Select sex</option>
            <option value="M" ${st.gender === 'M' ? 'selected' : ''}>Male</option>
            <option value="F" ${st.gender === 'F' ? 'selected' : ''}>Female</option>
          </select>
        </label>
        <div class="student-dob-age-grid">
          <label>Date of Birth <span class="required-mark">*</span>
            <input type="date" class="edit-student-dob" value="${st.dob ? escapeHtml(st.dob) : ''}" required>
          </label>
          <label>Age
            <input type="text" class="edit-student-age" value="${escapeHtml(calculateStudentAge(st.dob))}" placeholder="Auto" readonly>
          </label>
        </div>
        <input type="text" class="edit-student-id" value="${st.admissionId ? escapeHtml(st.admissionId) : ''}" placeholder="Student ID (optional)">
        <input type="tel" class="edit-student-phone" value="${st.parentPhone ? escapeHtml(st.parentPhone) : ''}" placeholder="Parent phone (optional, for WhatsApp)">
        <label>Disability
          <select class="edit-student-disability">
            <option value="">Select</option>
            <option value="No" ${st.disability === 'No' ? 'selected' : ''}>No</option>
            <option value="Yes" ${st.disability === 'Yes' ? 'selected' : ''}>Yes</option>
          </select>
        </label>
        <input type="text" class="edit-student-guardian" value="${st.guardianName ? escapeHtml(st.guardianName) : ''}" placeholder="Guardian name">
        <input type="text" class="edit-student-house-gps" value="${st.houseGps ? escapeHtml(st.houseGps) : ''}" placeholder="House No. / GhanaPost GPS">
        ${photoPreview}
        <label>Passport Photo
          <input type="file" class="edit-student-photo-input" accept="image/*" data-student="${st.id}">
        </label>
        <div class="edit-actions">
          <button class="save-btn save-student" data-id="${st.id}">Update</button>
          <button class="cancel-btn cancel-student">Cancel</button>
        </div>
      </div>`;
    } else {
      const idPart = st.admissionId ? ` · ID ${escapeHtml(st.admissionId)}` : ' · ID not set';
      li.innerHTML = `<div class="student-list-main">
          <div class="student-list-identity">
            ${st.photo ? `<img src="${escapeHtml(st.photo)}" alt="" class="student-list-photo">` : `<span class="student-list-photo student-list-photo-empty" aria-hidden="true">${escapeHtml((st.name || '?').charAt(0).toUpperCase())}</span>`}
            <div class="student-list-copy">
              <strong>${escapeHtml(st.name || 'Unnamed student')}</strong>
              <div class="meta">${escapeHtml(st.gender || 'Sex not set')}${idPart}</div>
            </div>
          </div>
        </div>
        <div class="student-list-actions">
          <button data-id="${st.id}" class="view-student" type="button">View</button>
          <button data-id="${st.id}" class="edit-student" type="button">Edit</button>
          <button data-id="${st.id}" class="del-student" type="button">Delete</button>
        </div>`;
    }
    list.appendChild(li);
  });
  list.querySelectorAll('.view-student').forEach(btn => {
    btn.addEventListener('click', () => showStudentDetails(btn.dataset.id));
  });
  list.querySelectorAll('.edit-student').forEach(btn => {
    btn.addEventListener('click', () => { editingStudentId = btn.dataset.id; renderStudents(); });
  });
  list.querySelectorAll('.cancel-student').forEach(btn => {
    btn.addEventListener('click', () => { editingStudentId = null; renderStudents(); });
  });
  list.querySelectorAll('.edit-student-dob').forEach(input => {
    input.addEventListener('input', () => {
      const row = input.closest('.edit-row');
      const age = row && row.querySelector('.edit-student-age');
      if (age) age.value = calculateStudentAge(input.value);
    });
    input.addEventListener('change', () => {
      const row = input.closest('.edit-row');
      const age = row && row.querySelector('.edit-student-age');
      if (age) age.value = calculateStudentAge(input.value);
    });
  });
  list.querySelectorAll('.edit-student-photo-input').forEach(input => {
    input.addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      const students = DB.get(KEYS.students, []);
      const st = students.find(x => x.id === input.dataset.student);
      if (!st || !requireClassAccess(st.classId)) return;

      const assetPath = schoolAssetPath(file, 'student-photos', st.classId + '/' + st.id);
      const oldStoragePath = st.photoStoragePath || '';
      const cacheKey = imageCacheKey('student', st.id);
      const studentName = st.name || st.id;

      // v36: LOCAL-FIRST TRANSACTION.
      // The browser copy is the operational/reporting copy. Cloud upload is
      // backup/synchronization and must never prevent the local image from
      // being saved. This also prevents a transient Firebase getDownloadURL
      // failure from producing a false upload failure.
      try {
        const dataUrl = await fileToDataUrl(file);
        if (!isDataImage(dataUrl)) throw new Error('The selected file is not a readable image.');

        // 1. Persist the image locally FIRST.
        await cacheLocalImageWithMeta(cacheKey, dataUrl, {
          storagePath: assetPath,
          sourceUrl: '',
          updatedAt: new Date().toISOString()
        });

        // 2. Update the lightweight local student record.
        const currentStudents = DB.get(KEYS.students, []);
        const current = currentStudents.find(x => x.id === st.id);
        if (current) {
          current.photo = dataUrl;
          current.photoUrl = '';
          current.photoStoragePath = assetPath;
        }
        DB.set(KEYS.students, currentStudents);
        renderStudents();

        // 3. Record the action immediately. Audit logging must not depend on
        // Firebase Storage download-URL generation.
        auditAction('update', 'student-photo', st.id, `Updated student photo: ${studentName}`);

        // 4. Back up to Firebase Storage and publish metadata independently.
        try {
          const url = await uploadSchoolAsset(file, 'student-photos', st.classId + '/' + st.id);
          const studentsAfterUpload = DB.get(KEYS.students, []);
          const latest = studentsAfterUpload.find(x => x.id === st.id);
          if (latest) {
            latest.photo = dataUrl;
            latest.photoUrl = url || '';
            latest.photoStoragePath = assetPath;
          }
          DB.set(KEYS.students, studentsAfterUpload);

          if (FIREBASE_ENABLED && currentSchoolId) {
            await studentRef(st.id).set({
              photoUrl: url || '',
              photoStoragePath: assetPath,
              updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            await upsertImageManifest('student', st.id, {
              classId: st.classId,
              storagePath: assetPath,
              sourceUrl: url || '',
              storageUpdatedAt: new Date().toISOString()
            });
          }

          // Deterministic v21+ paths replace the same object. Remove only a
          // genuinely different legacy object.
          if (oldStoragePath && oldStoragePath !== assetPath) {
            await removeStoragePath(oldStoragePath);
          }

          renderStudents();
        } catch (cloudError) {
          // Local copy is already safe. Do not undo it or overwrite it with a
          // cloud URL. The next image sync/recovery can publish the local copy.
          console.warn('Student photo cloud backup pending:', cloudError);
          alert(`Student photo saved on this browser. Firebase backup is pending.\n\n${cloudError.message || cloudError}`);
        }
      } catch (err) {
        alert('Could not save the student photo locally: ' + (err.message || err));
      } finally {
        input.value = '';
      }
    });
  });
  list.querySelectorAll('.remove-student-photo').forEach(btn => {
    btn.addEventListener('click', () => {
      const students = DB.get(KEYS.students, []);
      const st = students.find(x => x.id === btn.dataset.id);
      if (st) { st.photo = ''; removeCachedLocalImage(imageCacheKey('student', st.id)); }
      DB.set(KEYS.students, students);
      const cloud = (FIREBASE_ENABLED && currentSchoolId && st)
        ? Promise.all([removeImageManifest('student', st.id), st.photoStoragePath ? removeStoragePath(st.photoStoragePath) : removeStorageFile(st.photoUrl || '')])
        : Promise.resolve();
      cloud.then(() => renderStudents()).catch(() => renderStudents());
    });
  });
  list.querySelectorAll('.save-student').forEach(btn => {
    btn.addEventListener('click', async () => {
      const li=btn.closest('li'),name=li.querySelector('.edit-student-name').value.trim(),dob=li.querySelector('.edit-student-dob').value.trim(),gender=li.querySelector('.edit-student-gender').value;
      if(!name||!gender||!dob){const missing=[];if(!name)missing.push('Full name');if(!gender)missing.push('Sex');if(!dob)missing.push('Date of Birth');alert(missing.join(', ')+(missing.length===1?' is required.':' are required.'));return;}
      const admissionId=li.querySelector('.edit-student-id').value.trim(),students=DB.get(KEYS.students,[]),current=students.find(x=>x.id===btn.dataset.id);
      if(!current||!requireClassAccess(current.classId))return;
      if(admissionId&&students.some(x=>x.id!==current.id&&String(x.admissionId||'').trim().toLowerCase()===admissionId.toLowerCase())){alert('Another student already uses this Student ID. Student IDs must be unique.');return;}
      const updated=Object.assign({},current,{name,dob,gender,admissionId,parentPhone:li.querySelector('.edit-student-phone').value.trim(),disability:li.querySelector('.edit-student-disability')?.value||'',guardianName:li.querySelector('.edit-student-guardian')?.value.trim()||'',houseGps:li.querySelector('.edit-student-house-gps')?.value.trim()||''});
      const token=sessionGeneration,userId=currentUid,schoolId=currentSchoolId,oldText=btn.textContent;btn.disabled=true;btn.textContent='Saving…';
      try{if(FIREBASE_ENABLED&&currentSchoolId){if(cloudHydrationInProgress||!sessionDataReady)throw new Error('School data is still synchronizing.');await schoolRef().collection('students').doc(String(updated.id)).set(stripImagesForCloud('students',updated),{merge:true});if(!isCurrentSession(token,userId,schoolId))return;setLastSyncedNow();}
        const latest=DB.get(KEYS.students,[]),pos=latest.findIndex(x=>x.id===updated.id);if(pos<0)throw new Error('Student details changed while saving. Please reopen the student.');latest[pos]=updated;DB.set(KEYS.students,latest,{skipCloudSync:true});auditAction('update','student',updated.id,`Updated student: ${updated.name}`);editingStudentId=null;renderStudents();renderClasses();
      }catch(error){btn.disabled=false;btn.textContent=oldText;alert('Student changes were NOT saved. Existing details have been left unchanged.\n\n'+(error.message||error));}
    });
  });
  list.querySelectorAll('.del-student').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this student and their grades?')) return;
      const id = btn.dataset.id;
      const token = sessionGeneration, userId = currentUid, schoolId = currentSchoolId;
      if (FIREBASE_ENABLED && currentSchoolId) {
        if (cloudHydrationInProgress || !sessionDataReady) { alert('School data is still synchronizing. Please wait a moment and try again.'); return; }
        try { await deleteSchoolRecord(schoolRef().collection('students').doc(id)); }
        catch (error) { alert('Could not delete this student from SchoolHub cloud. Nothing was removed. Please reconnect and try again.'); return; }
        if (!isCurrentSession(token, userId, schoolId)) return;
      }
      DB.set(KEYS.students, DB.get(KEYS.students, []).filter(s => s.id !== id), {skipCloudSync:true});
      auditAction('delete', 'student', id, `Deleted student: ${id}`);
      const grades = DB.get(KEYS.grades, {});
      Object.keys(grades).forEach(k => { if (grades[k][id]) delete grades[k][id]; });
      DB.set(KEYS.grades, grades);
      const attendance = DB.get(KEYS.attendance, {});
      Object.keys(attendance).forEach(k => { if (attendance[k] && attendance[k].entries && attendance[k].entries[id]) delete attendance[k].entries[id]; else if (attendance[k] && attendance[k][id]) delete attendance[k][id]; });
      DB.set(KEYS.attendance, attendance);
      const remarks = DB.get(KEYS.remarks, {});
      Object.keys(remarks).forEach(k => { if (remarks[k][id]) delete remarks[k][id]; });
      DB.set(KEYS.remarks, remarks);
      renderStudents();
      renderClasses();
    });
  });
}

document.getElementById('studentClassSelect').addEventListener('change', e => {
  try { localStorage.setItem(studentClassSelectionKey(), e.target.value || ''); } catch (err) {}
  renderStudents();
});
document.getElementById('studentSearchInput').addEventListener('input', renderStudents);

const toggleAddStudentBtn = document.getElementById('toggleAddStudentBtn');
const addStudentForm = document.getElementById('addStudentForm');
if (toggleAddStudentBtn && addStudentForm) {
  toggleAddStudentBtn.addEventListener('click', () => {
    const open = addStudentForm.classList.toggle('hidden') === false;
    toggleAddStudentBtn.textContent = open ? 'Collapse' : 'Expand';
    toggleAddStudentBtn.setAttribute('aria-expanded', String(open));
  });
}

const newStudentDob = document.getElementById('newStudentDob');
const newStudentAge = document.getElementById('newStudentAge');
if (newStudentDob && newStudentAge) {
  const updateNewStudentAge = () => { newStudentAge.value = calculateStudentAge(newStudentDob.value); };
  newStudentDob.addEventListener('input', updateNewStudentAge);
  newStudentDob.addEventListener('change', updateNewStudentAge);
}

document.getElementById('addStudentBtn').addEventListener('click', async () => {
  const classId=document.getElementById('studentClassSelect').value;if(!classId){alert('Add a class first.');return;}if(!requireClassAccess(classId))return;
  const nameInput=document.getElementById('newStudentName'),dobInput=document.getElementById('newStudentDob'),validation=document.getElementById('addStudentValidation'),name=nameInput.value.trim(),dob=dobInput.value.trim();
  if(!name||!dob){validation.textContent=!name&&!dob?'Full name and Date of Birth are required before the student can be added.':(!name?'Full name is required before the student can be added.':'Date of Birth is required before the student can be added.');validation.classList.add('show');return;}
  validation.classList.remove('show');const gender=document.getElementById('newStudentGender').value;if(!gender){validation.textContent='Sex is required before the student can be added.';validation.classList.add('show');return;}
  const admissionId=document.getElementById('newStudentId').value.trim(),students=DB.get(KEYS.students,[]);if(admissionId&&students.some(x=>String(x.admissionId||'').trim().toLowerCase()===admissionId.toLowerCase())){validation.textContent='Another student already uses this Student ID. Student IDs must be unique.';validation.classList.add('show');return;}
  const record={id:uid(),classId,name,dob,gender,admissionId,parentPhone:document.getElementById('newStudentPhone').value.trim(),disability:document.getElementById('newStudentDisability')?.value||'',guardianName:document.getElementById('newStudentGuardian')?.value.trim()||'',houseGps:document.getElementById('newStudentHouseGps')?.value.trim()||''};
  const btn=document.getElementById('addStudentBtn'),oldText=btn.textContent,token=sessionGeneration,userId=currentUid,schoolId=currentSchoolId;btn.disabled=true;btn.textContent='Saving…';
  try{if(FIREBASE_ENABLED&&currentSchoolId){if(cloudHydrationInProgress||!sessionDataReady)throw new Error('School data is still synchronizing.');await schoolRef().collection('students').doc(String(record.id)).set(stripImagesForCloud('students',record));if(!isCurrentSession(token,userId,schoolId))return;setLastSyncedNow();}
    const latest=DB.get(KEYS.students,[]);latest.push(record);DB.set(KEYS.students,latest,{skipCloudSync:true});nameInput.value='';dobInput.value='';newStudentAge.value='';document.getElementById('newStudentId').value='';document.getElementById('newStudentPhone').value='';if(document.getElementById('newStudentDisability'))document.getElementById('newStudentDisability').value='';if(document.getElementById('newStudentGuardian'))document.getElementById('newStudentGuardian').value='';if(document.getElementById('newStudentHouseGps'))document.getElementById('newStudentHouseGps').value='';renderStudents();renderClasses();addStudentForm.classList.add('hidden');toggleAddStudentBtn.textContent='Expand';toggleAddStudentBtn.setAttribute('aria-expanded','false');auditAction('create','student',record.id,`Added student: ${record.name}`);
  }catch(error){alert('Student was NOT added to SchoolHub.\n\n'+(error.message||error));}finally{if(isCurrentSession(token,userId,schoolId)){btn.disabled=false;btn.textContent=oldText;}}
});

// Bulk add: one student per line, optionally "Name, ID". Gender and
// parent phone are left unset — use Edit on each student afterward.
document.getElementById('bulkAddStudentsBtn').addEventListener('click', async () => {
  const classId=document.getElementById('studentClassSelect').value;
  if(!classId){alert('Add a class first.');return;} if(!requireClassAccess(classId))return;
  const textarea=document.getElementById('bulkStudentInput'),lines=textarea.value.split('\n').map(l=>l.trim()).filter(Boolean);
  if(!lines.length)return;
  const existing=DB.get(KEYS.students,[]),usedIds=new Set(existing.map(x=>String(x.admissionId||'').trim().toLowerCase()).filter(Boolean)),newRecords=[],errors=[];
  lines.forEach((line,index)=>{const parts=line.split(','),name=parts[0].trim(),admissionId=parts.length>1?parts.slice(1).join(',').trim():'';if(!name)return;const key=admissionId.toLowerCase();if(key&&usedIds.has(key)){errors.push(`Line ${index+1}: Student ID ${admissionId} is already in use.`);return;}if(key)usedIds.add(key);newRecords.push({id:uid(),classId,name,gender:'',admissionId,parentPhone:''});});
  if(errors.length){alert(errors.slice(0,20).join('\n'));return;} if(!newRecords.length)return;
  const token=sessionGeneration,userId=currentUid,schoolId=currentSchoolId;
  try{
    if(FIREBASE_ENABLED&&currentSchoolId){if(cloudHydrationInProgress||!sessionDataReady)throw new Error('School data is still synchronizing.');const ref=schoolRef().collection('students');await commitChunks(newRecords.map(record=>batch=>batch.set(ref.doc(String(record.id)),stripImagesForCloud('students',record))));if(!isCurrentSession(token,userId,schoolId))return;setLastSyncedNow();}
    DB.set(KEYS.students,existing.concat(newRecords),{skipCloudSync:true});textarea.value='';renderStudents();renderClasses();auditAction('import','students','',`Bulk added ${newRecords.length} student records.`);alert(`Added ${newRecords.length} student(s) and saved to SchoolHub.`);
  }catch(error){alert('Students were NOT added to SchoolHub. Your existing student list has been left unchanged.\n\n'+(error.message||error));}
});

async function showStudentDetails(studentId) {
  const st = DB.get(KEYS.students, []).find(x => x.id === studentId);
  if (!st) return;
  const classes = DB.get(KEYS.classes, []);
  const cls = classes.find(c => c.id === st.classId);
  const content = document.getElementById('studentDetailsContent');
  if (!content) return;

  const rows = [
    ['Full name', st.name || '—'],
    ['Student ID', st.admissionId || '—'],
    ['Sex', st.gender === 'M' ? 'Male' : (st.gender === 'F' ? 'Female' : '—')],
    ['Date of Birth', st.dob || '—'],
    ['Age', calculateStudentAge(st.dob) || '—'],
    ['Class', cls ? cls.name : '—'],
    ['Disability', st.disability || '—'],
    ['Guardian name', st.guardianName || '—'],
    ['Parent/Guardian phone', st.parentPhone || '—'],
    ['House No. / GhanaPost GPS', st.houseGps || '—']
  ];

  // Student photos are stored in IndexedDB rather than the structured student
  // record. Resolve the local cache first, then recover the image from Storage
  // when it is not yet cached on this browser.
  let photo = isDataImage(st.photo) ? st.photo : '';
  if (!photo) {
    try {
      photo = await getOrSyncReportImage(
        'student',
        st.id,
        st.photoStoragePath || '',
        st.photoUrl || '',
        st.classId && currentSchoolId
          ? `schools/${currentSchoolId}/student-photos/${st.classId}/${st.id}`
          : ''
      );
    } catch (e) {
      console.warn('Could not load student photo for details:', e);
    }
  }

  content.innerHTML = (photo
      ? `<div class="student-detail-photo-wrap"><img src="${escapeHtml(photo)}" alt="Student photo" class="student-detail-photo"></div>`
      : '') +
    rows.map(([label, value]) => `<div class="staff-detail-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');

  document.getElementById('studentDetailsDialog').classList.remove('hidden');
}

function closeStudentDetails() {
  const dialog = document.getElementById('studentDetailsDialog');
  if (dialog) dialog.classList.add('hidden');
}

const studentDetailsCloseBtn = document.getElementById('studentDetailsCloseBtn');
if (studentDetailsCloseBtn) studentDetailsCloseBtn.addEventListener('click', closeStudentDetails);
const studentDetailsDialog = document.getElementById('studentDetailsDialog');
if (studentDetailsDialog) studentDetailsDialog.addEventListener('click', e => { if (e.target === studentDetailsDialog) closeStudentDetails(); });

/* ---------- Subjects ---------- */
let editingSubjectId = null;
let subjectArrangeMode = false;
let draggedSubjectId = null;
let subjectDragMoved = false;
let subjectDragPointerId = null;

function saveSubjectOrderFromList(list) {
  const ids = Array.from(list.querySelectorAll('.subject-sort-item')).map(li => li.dataset.subjectId);
  const subjects = DB.get(KEYS.subjects, []);
  const byId = new Map(subjects.map(sub => [sub.id, sub]));
  const reordered = [];
  ids.forEach((id, index) => {
    const sub = byId.get(id);
    if (sub) {
      sub.order = index;
      reordered.push(sub);
    }
  });
  subjects.forEach(sub => {
    if (!reordered.includes(sub)) {
      sub.order = reordered.length;
      reordered.push(sub);
    }
  });
  DB.set(KEYS.subjects, reordered);
}

function moveSubjectRow(list, dragged, clientY) {
  const rows = Array.from(list.querySelectorAll('.subject-sort-item:not(.dragging)'));
  let closest = null;
  let closestOffset = Number.NEGATIVE_INFINITY;
  rows.forEach(row => {
    const rect = row.getBoundingClientRect();
    const offset = clientY - rect.top - rect.height / 2;
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset;
      closest = row;
    }
  });
  if (closest) list.insertBefore(dragged, closest);
  else list.appendChild(dragged);
}

function finishSubjectDrag(list) {
  if (!draggedSubjectId) return;
  const wasMoved = subjectDragMoved;
  const dragged = list.querySelector(`[data-subject-id="${CSS.escape(draggedSubjectId)}"]`);
  if (dragged) dragged.classList.remove('dragging');
  if (wasMoved) {
    saveSubjectOrderFromList(list);
    renderSubjects();
  }
  draggedSubjectId = null;
  subjectDragMoved = false;
  subjectDragPointerId = null;
}

function moveSubjectByStep(subjectId, direction) {
  if (!subjectArrangeMode) return;
  const subjects = sortSubjectsByOrder(DB.get(KEYS.subjects, []));
  const index = subjects.findIndex(sub => sub.id === subjectId);
  if (index < 0) return;
  const target = index + direction;
  if (target < 0 || target >= subjects.length) return;
  const temp = subjects[index];
  subjects[index] = subjects[target];
  subjects[target] = temp;
  subjects.forEach((sub, i) => { sub.order = i; });
  DB.set(KEYS.subjects, subjects);
  auditAction('update', 'subject-order', subjectId, 'Reordered subjects');
  renderSubjects();
}

// Delegated pointer handling makes touch dragging reliable on Android/iOS as
// well as mouse dragging on desktop. The document-level listeners avoid losing
// pointermove/pointerup when the finger or mouse leaves the small drag handle.
if (!window.__schoolhubSubjectDragHandlers) {
  window.__schoolhubSubjectDragHandlers = true;
  document.addEventListener('pointermove', event => {
    if (!draggedSubjectId) return;
    if (subjectDragPointerId !== null && event.pointerId !== subjectDragPointerId) return;
    const list = document.getElementById('subjectList');
    const row = list && list.querySelector(`[data-subject-id="${CSS.escape(draggedSubjectId)}"]`);
    if (!list || !row) return;
    moveSubjectRow(list, row, event.clientY);
    subjectDragMoved = true;
    event.preventDefault();
  }, { passive: false });
  document.addEventListener('pointerup', event => {
    if (!draggedSubjectId) return;
    if (subjectDragPointerId !== null && event.pointerId !== subjectDragPointerId) return;
    finishSubjectDrag(document.getElementById('subjectList'));
  });
  document.addEventListener('pointercancel', event => {
    if (!draggedSubjectId) return;
    if (subjectDragPointerId !== null && event.pointerId !== subjectDragPointerId) return;
    finishSubjectDrag(document.getElementById('subjectList'));
  });
}

function renderSubjects() {
  if (FIREBASE_ENABLED && !sessionDataReady) { const el = document.getElementById('subjectList'); if (el) el.innerHTML = '<li class="empty">Loading your school workspace…</li>'; return; }
  const list = document.getElementById('subjectList');
  const subjects = DB.get(KEYS.subjects, []);
  ensureSubjectOrder(subjects);
  const orderedSubjects = sortSubjectsByOrder(subjects);
  list.innerHTML = '';

  const arrangeBtn = document.getElementById('toggleSubjectArrangeBtn');
  const orderHint = document.getElementById('subjectOrderHint');
  if (arrangeBtn) arrangeBtn.textContent = subjectArrangeMode ? 'Done Arranging' : 'Arrange Order';
  if (orderHint) {
    orderHint.textContent = subjectArrangeMode
      ? 'Drag the handle to set the subject order. The first 4 are the core subjects; the next 2 best grades are added to the aggregate.'
      : 'Aggregate uses the first 4 subjects in this order, plus the 2 best grades from the remaining subjects.';
  }

  if (!orderedSubjects.length) {
    list.innerHTML = '<li class="empty">No subjects yet — add one below.</li>';
    return;
  }

  orderedSubjects.forEach((sub, index) => {
    const li = document.createElement('li');
    li.className = 'subject-sort-item' + (subjectArrangeMode ? ' arranging' : '');
    li.dataset.subjectId = sub.id;
    if (editingSubjectId === sub.id && !subjectArrangeMode) {
      li.innerHTML = `<div class="edit-row">
        <input type="text" class="edit-subject-name" value="${escapeHtml(sub.name)}">
        <div class="edit-actions">
          <button class="save-btn save-subject" data-id="${sub.id}">Update</button>
          <button class="cancel-btn cancel-subject">Cancel</button>
        </div>
      </div>`;
    } else if (subjectArrangeMode) {
      const role = index < 4 ? 'Core ' + (index + 1) : 'Best-subject pool';
      li.innerHTML = `<div class="subject-order-main">
          <span class="subject-drag-handle" role="button" tabindex="0" aria-label="Drag ${escapeHtml(sub.name)} to reorder" title="Drag to reorder">☷</span>
          <div class="subject-order-text"><strong>${escapeHtml(sub.name)}</strong><div class="subject-order-role">${escapeHtml(role)}</div></div>
        </div>
        <div class="subject-order-actions">
          <button type="button" class="subject-move-up" data-id="${sub.id}" aria-label="Move ${escapeHtml(sub.name)} up" title="Move up">▲</button>
          <button type="button" class="subject-move-down" data-id="${sub.id}" aria-label="Move ${escapeHtml(sub.name)} down" title="Move down">▼</button>
        </div>`;
    } else {
      li.innerHTML = `<div class="subject-row-main"><strong>${escapeHtml(sub.name)}</strong></div>
        <div class="actions">
          <button data-id="${sub.id}" class="edit-subject">Edit</button>
          <button data-id="${sub.id}" class="del-subject">Delete</button>
        </div>`;
    }
    list.appendChild(li);
  });

  list.querySelectorAll('.edit-subject').forEach(btn => {
    btn.addEventListener('click', () => { editingSubjectId = btn.dataset.id; renderSubjects(); });
  });
  list.querySelectorAll('.cancel-subject').forEach(btn => {
    btn.addEventListener('click', () => { editingSubjectId = null; renderSubjects(); });
  });
  list.querySelectorAll('.save-subject').forEach(btn => {
    btn.addEventListener('click', () => {
      const li = btn.closest('li');
      const name = li.querySelector('.edit-subject-name').value.trim();
      if (!name) return;
      const subjects = DB.get(KEYS.subjects, []);
      const sub = subjects.find(x => x.id === btn.dataset.id);
      if (subjects.some(x => x.id !== btn.dataset.id && subjectNameKey(x.name) === subjectNameKey(name))) {
        alert('A subject with that name already exists. Use its existing entry so scores stay together.');
        return;
      }
      if (sub) sub.name = name;
      DB.set(KEYS.subjects, subjects);
      auditAction('update', 'subject', sub ? sub.id : btn.dataset.id, `Updated subject: ${sub ? sub.name : ''}`);
      editingSubjectId = null;
      renderSubjects();
    });
  });
  list.querySelectorAll('.del-subject').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this subject from all classes?')) return;
      const id = btn.dataset.id;
      try {
        if (FIREBASE_ENABLED && currentSchoolId) {
          if (cloudHydrationInProgress || !sessionDataReady) throw new Error('School data is still synchronizing.');
          await deleteSchoolRecord(schoolRef().collection('subjects').doc(String(id)));
          setLastSyncedNow();
        }
        const subjects = DB.get(KEYS.subjects, []).filter(s => s.id !== id);
        subjects.forEach((sub, i) => { sub.order = i; });
        DB.set(KEYS.subjects, subjects, {skipCloudSync:true});
        auditAction('delete', 'subject', id, 'Deleted subject');
        renderSubjects();
      } catch (error) {
        alert('The subject was NOT deleted. Existing data has been left unchanged.\n\n' + (error.message || error));
      }
    });
  });

  if (subjectArrangeMode) {
    list.querySelectorAll('.subject-move-up').forEach(btn => {
      btn.addEventListener('click', () => moveSubjectByStep(btn.dataset.id, -1));
    });
    list.querySelectorAll('.subject-move-down').forEach(btn => {
      btn.addEventListener('click', () => moveSubjectByStep(btn.dataset.id, 1));
    });
    list.querySelectorAll('.subject-drag-handle').forEach(handle => {
      handle.addEventListener('pointerdown', event => {
        if (event.button !== undefined && event.button !== 0) return;
        const row = handle.closest('.subject-sort-item');
        if (!row) return;
        draggedSubjectId = row.dataset.subjectId;
        subjectDragPointerId = event.pointerId;
        subjectDragMoved = false;
        row.classList.add('dragging');
        try { handle.setPointerCapture(event.pointerId); } catch (e) {}
        event.preventDefault();
      });
    });
  }
}

document.getElementById('toggleSubjectArrangeBtn').addEventListener('click', () => {
  if (!requireHeadTeacher('arrange subjects')) return;
  editingSubjectId = null;
  subjectArrangeMode = !subjectArrangeMode;
  renderSubjects();
});

document.getElementById('addSubjectBtn').addEventListener('click', () => {
  if (!requireHeadTeacher('manage subjects')) return;
  const input = document.getElementById('newSubjectName');
  const name = input.value.trim();
  if (!name) return;
  const subjects = DB.get(KEYS.subjects, []);
  if (subjects.some(sub => subjectNameKey(sub.name) === subjectNameKey(name))) {
    alert('That subject already exists. Use the existing entry so scores stay together.');
    return;
  }
  subjects.forEach(sub => { sub.order = subjectOrderValue(sub, 0); });
  const maxOrder = subjects.reduce((max, sub) => Math.max(max, Number(sub.order) || 0), -1);
  subjects.push({ id: uid(), name, order: maxOrder + 1 });
  DB.set(KEYS.subjects, subjects);
  input.value = '';
  renderSubjects();
});


/* ---------- v40 Students tab upgrade ---------- */
const STUDENT_TRANSFER_FIELDS = [
  {key:'name', label:'Full Name'},
  {key:'admissionId', label:'Student ID'},
  {key:'gender', label:'Sex'},
  {key:'dob', label:'Date of Birth'},
  {key:'disability', label:'Disability'},
  {key:'guardianName', label:'Guardian Name'},
  {key:'parentPhone', label:'Parent/Guardian Phone'},
  {key:'houseGps', label:'House No. / GhanaPost GPS'},
  {key:'className', label:'Class'}
];
let pendingStudentImport = null;
let studentTableVisible = true;

function installStudentTabUpgrade() {
  const form = document.getElementById('addStudentForm');
  const addBtn = document.getElementById('addStudentBtn');
  if (form && addBtn && !document.getElementById('newStudentDisability')) {
    const host = document.createElement('div');
    host.className = 'student-extra-fields';
    host.innerHTML = `
      <label>Disability
        <select id="newStudentDisability"><option value="">Select</option><option value="No">No</option><option value="Yes">Yes</option></select>
      </label>
      <label>Guardian name <input type="text" id="newStudentGuardian" placeholder="Guardian name"></label>
      <label>House No. / GhanaPost GPS <input type="text" id="newStudentHouseGps" placeholder="e.g. House 12 / NT-123-4567"></label>`;
    addBtn.parentNode.insertBefore(host, addBtn);
  }

  const search = document.getElementById('studentSearchInput');
  if (search && !document.getElementById('studentDataToolbar')) {
    const toolbar = document.createElement('div');
    toolbar.id = 'studentDataToolbar';
    toolbar.className = 'staff-data-actions student-data-actions';
    toolbar.innerHTML = `
      <button type="button" id="exportStudentsBtn">Export to Excel</button>
      <button type="button" id="studentTemplateBtn">Download Template</button>
      <button type="button" id="importStudentsBtn">Import Students</button>
      <button type="button" id="printStudentsBtn">Print / Save as PDF</button>
      <input type="file" id="studentImportInput" accept=".xlsx,.xls,.csv" hidden>
      <div id="studentImportPreview" class="hidden" style="width:100%"></div>
      <button type="button" id="checkStudentRecoveryBtn" class="btn-secondary">Check for missing students</button>
      <div id="studentRecoveryPreview" class="staff-import-preview hidden" style="width:100%" aria-live="polite"></div>`;
    const classSelect = document.getElementById('studentClassSelect');
    const toolbarAnchor = (classSelect && classSelect.parentNode) ? classSelect.parentNode : search.parentNode;
    toolbarAnchor.parentNode.insertBefore(toolbar, toolbarAnchor.nextSibling);
    document.getElementById('exportStudentsBtn').addEventListener('click', () => exportStudentsWorkbook(false));
    document.getElementById('studentTemplateBtn').addEventListener('click', () => exportStudentsWorkbook(true));
    document.getElementById('importStudentsBtn').addEventListener('click', () => document.getElementById('studentImportInput').click());
    document.getElementById('studentImportInput').addEventListener('change', handleStudentImportFile);
    document.getElementById('printStudentsBtn').addEventListener('click', printStudentsDetailsTable);
    document.getElementById('checkStudentRecoveryBtn').addEventListener('click', checkStudentRecovery);
  }
}

function studentClassName(student) {
  const c = DB.get(KEYS.classes, []).find(x => x.id === student.classId);
  return c ? c.name : '';
}
function studentClassIdByName(name) {
  const wanted = String(name || '').trim().toLowerCase();
  const c = getAccessibleClasses().find(x => String(x.name || '').trim().toLowerCase() === wanted);
  return c ? c.id : '';
}
function studentTransferValue(st, key) {
  if (key === 'className') return studentClassName(st);
  if (key === 'gender') return st.gender === 'M' ? 'Male' : (st.gender === 'F' ? 'Female' : st.gender || '');
  return st[key] || '';
}

function normalizeRecoveryClassName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function currentClassIdForRecoveredStudent(record, backupClasses) {
  const classes = getAccessibleClasses();
  const direct = classes.find(c => String(c.id) === String(record.classId || ''));
  if (direct) return direct.id;
  const oldClass = (backupClasses || []).find(c => String(c.id) === String(record.classId || ''));
  if (!oldClass) return '';
  const wanted = normalizeRecoveryClassName(oldClass.name);
  const match = classes.find(c => normalizeRecoveryClassName(c.name) === wanted);
  return match ? match.id : '';
}

function studentRecoverySnapshots(schoolId) {
  const out = [];
  try {
    const prefix = recoveryKey(schoolId);
    let history = [];
    try { history = JSON.parse(localStorage.getItem(prefix + '__history_index') || '[]'); } catch (e) {}
    const keys = [prefix, prefix + '__staff_repair_original'].concat(Array.isArray(history) ? history : []);
    Array.from(new Set(keys)).forEach(key => {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const backup = JSON.parse(raw);
      if (String(backup.schoolId || '') !== String(schoolId || '')) return;
      const students = Array.isArray(backup.data?.students) ? backup.data.students : [];
      const classes = Array.isArray(backup.data?.classes) ? backup.data.classes : [];
      if (students.length) out.push({ key, students, classes, createdAt: backup.createdAt || '' });
    });
  } catch (e) { console.warn('Could not read student recovery snapshots:', e); }
  return out;
}

function collectMissingStudentCandidates(schoolId) {
  const existing = DB.get(KEYS.students, []);
  const byId = new Set(existing.map(s => String(s.id || '')).filter(Boolean));
  const byAdmission = new Set(existing.map(s => String(s.admissionId || '').trim().toLowerCase()).filter(Boolean));
  const seen = new Set();
  const missing = [];
  const unresolved = [];
  studentRecoverySnapshots(schoolId).forEach(snapshot => {
    snapshot.students.forEach(source => {
      if (!source || !source.id || !source.name) return;
      const id = String(source.id);
      const admission = String(source.admissionId || '').trim().toLowerCase();
      if (byId.has(id) || (admission && byAdmission.has(admission))) return;
      const dedupe = admission ? `a:${admission}` : `i:${id}`;
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      const classId = currentClassIdForRecoveredStudent(source, snapshot.classes);
      const oldClass = snapshot.classes.find(c => String(c.id) === String(source.classId || ''));
      const record = Object.assign({}, source, classId ? { classId } : {});
      const item = { record, className: oldClass?.name || studentClassName(record) || 'Unknown class', sourceDate: snapshot.createdAt || '' };
      if (classId) missing.push(item); else unresolved.push(item);
    });
  });
  return { missing, unresolved };
}

async function restoreRecoveredStudents(items, token, userId, schoolId) {
  if (!items.length || !isCurrentSession(token, userId, schoolId)) return;
  const existing = DB.get(KEYS.students, []);
  const byId = new Set(existing.map(s => String(s.id || '')).filter(Boolean));
  const byAdmission = new Set(existing.map(s => String(s.admissionId || '').trim().toLowerCase()).filter(Boolean));
  const additions = items.map(x => x.record).filter(record => {
    const id = String(record.id || '');
    const admission = String(record.admissionId || '').trim().toLowerCase();
    if (!id || !record.name || !record.classId || byId.has(id) || (admission && byAdmission.has(admission))) return false;
    byId.add(id); if (admission) byAdmission.add(admission);
    return true;
  });
  if (!additions.length) return;
  if (FIREBASE_ENABLED && currentSchoolId) {
    if (cloudHydrationInProgress || !sessionDataReady) throw new Error('School data is still synchronizing.');
    const ref = schoolRef().collection('students');
    await commitChunks(additions.map(record => batch => batch.restore(ref.doc(String(record.id)), stripImagesForCloud('students', record))));
    if (!isCurrentSession(token, userId, schoolId)) return;
    setLastSyncedNow();
  }
  DB.set(KEYS.students, existing.concat(additions), { skipCloudSync:true });
  auditAction('recover', 'students', '', `Restored ${additions.length} missing student record(s) from a saved SchoolHub copy.`);
  renderStudents(); renderClasses();
}

async function checkStudentRecovery() {
  if (!isHeadTeacher() && !isActiveGuest()) { alert('Only the Head Teacher can restore missing school-wide student records.'); return; }
  const host = document.getElementById('studentRecoveryPreview');
  if (!host) return;
  const token = sessionGeneration, userId = currentUid, schoolId = currentSchoolId;
  host.classList.remove('hidden');
  host.textContent = 'Checking saved student copies…';
  try {
    const found = collectMissingStudentCandidates(schoolId);
    if (!isCurrentSession(token, userId, schoolId)) return;
    host.innerHTML = `<h3>Student recovery check</h3><p>${found.missing.length ? `Found ${found.missing.length} student record(s) in saved copies that are missing from the current Students list. Select only the records you want restored.` : 'No additional student records were found in this browser’s saved recovery copies.'}</p>`;
    if (found.unresolved.length) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = `${found.unresolved.length} older record(s) could not be matched safely to a current class and were not offered for restoration.`;
      host.appendChild(note);
    }
    found.missing.forEach((item, index) => {
      const label = document.createElement('label');
      label.className = 'student-recovery-item';
      label.innerHTML = `<input type="checkbox" data-student-recovery-index="${index}"> <strong>${escapeHtml(item.record.name)}</strong> · ${escapeHtml(item.record.admissionId || 'No ID')} · ${escapeHtml(item.className)}`;
      host.appendChild(label);
    });
    if (!found.missing.length) return;
    const restore = document.createElement('button');
    restore.type = 'button'; restore.className = 'btn-primary'; restore.textContent = 'Restore selected students';
    host.appendChild(restore);
    restore.addEventListener('click', async () => {
      if (!isCurrentSession(token, userId, schoolId)) return;
      const selected = Array.from(host.querySelectorAll('input[data-student-recovery-index]:checked')).map(el => found.missing[Number(el.dataset.studentRecoveryIndex)]).filter(Boolean);
      if (!selected.length) { alert('Select at least one student to restore.'); return; }
      restore.disabled = true; restore.textContent = 'Restoring…';
      try {
        await restoreRecoveredStudents(selected, token, userId, schoolId);
        host.innerHTML = `<h3>Student recovery complete</h3><p>Restored ${selected.length} selected student record(s) to their classes and saved them to SchoolHub.</p>`;
      } catch (e) {
        restore.disabled = false; restore.textContent = 'Restore selected students';
        alert('Student recovery was NOT saved. Existing student data was left unchanged.\n\n' + (e.message || e));
      }
    });
  } catch (e) {
    host.textContent = 'Could not check student recovery copies: ' + (e.message || e);
  }
}

function exportStudentsWorkbook(templateOnly) {
  if (typeof XLSX === 'undefined') { alert('Spreadsheet tools are still loading. Please reconnect and try again.'); return; }
  const rows = [STUDENT_TRANSFER_FIELDS.map(f => f.label)];
  if (!templateOnly) {
    getAccessibleStudents().forEach(st => rows.push(STUDENT_TRANSFER_FIELDS.map(f => String(studentTransferValue(st, f.key)))));
  }
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  Object.keys(sheet).filter(k => k[0] !== '!').forEach(k => { sheet[k].t = 's'; sheet[k].z = '@'; delete sheet[k].f; });
  sheet['!cols'] = STUDENT_TRANSFER_FIELDS.map(f => ({wch: Math.max(16, f.label.length + 4)}));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Students');
  const help = XLSX.utils.aoa_to_sheet([
    ['Student import instructions'],
    ['Full Name, Student ID, Sex, Date of Birth and Class are required.'],
    ['Student ID is the matching key. Existing IDs update; new IDs add students.'],
    ['Class must exactly match an existing SchoolHub class name.'],
    ['Sex accepts Male/Female or M/F. Disability accepts Yes/No.'],
    ['Blank optional cells preserve existing details when updating.'],
    ['No student is deleted by an import. Preview changes before saving.']
  ]);
  help['!cols'] = [{wch:105}];
  XLSX.utils.book_append_sheet(book, help, 'Instructions');
  XLSX.writeFile(book, templateOnly ? 'SchoolHub_students_template.xlsx' : 'SchoolHub_students_' + new Date().toISOString().slice(0,10) + '.xlsx');
}

function readStudentWorkbook(book) {
  const sheet = book.Sheets[book.SheetNames.includes('Students') ? 'Students' : book.SheetNames[0]];
  if (!sheet || !sheet['!ref']) throw new Error('The Students sheet is empty.');
  const range = XLSX.utils.decode_range(sheet['!ref']);
  if (range.e.r - range.s.r > 5000 || range.e.c - range.s.c > 100) throw new Error('Import at most 5,000 students and 100 columns at a time.');
  const matrix = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({r,c})];
      if (cell?.f) throw new Error('The Students sheet contains formulas. Paste their values before importing.');
      if (cell?.t === 'e') throw new Error('The Students sheet contains an Excel error. Correct it before importing.');
      if (cell?.t === 'd') {
        const date = cell.v instanceof Date ? cell.v : new Date(cell.v);
        if (!Number.isFinite(date.getTime())) throw new Error('The Students sheet contains an invalid date.');
        row.push(`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`);
      } else row.push(cell == null ? '' : String(cell.w ?? cell.v ?? '').trim());
    }
    matrix.push(row);
  }
  const headers=(matrix.shift()||[]).map(x=>String(x).trim().toLowerCase()), index={}, headerErrors=[];
  STUDENT_TRANSFER_FIELDS.forEach(f => {
    const matches=headers.map((h,i)=>h===f.label.toLowerCase()||h===f.key.toLowerCase()?i:-1).filter(i=>i>=0);
    if(matches.length>1) headerErrors.push(`Duplicate column: ${f.label}.`);
    index[f.key]=matches.length?matches[0]:-1;
  });
  ['name','admissionId','gender','dob','className'].forEach(key=>{if(index[key]<0) headerErrors.push(`${STUDENT_TRANSFER_FIELDS.find(f=>f.key===key).label} column is required.`);});
  if(headerErrors.length) throw new Error(headerErrors.join(' '));
  return matrix.filter(r=>r.some(v=>String(v).trim())).map((r,rowIndex)=>{
    const values={}; STUDENT_TRANSFER_FIELDS.forEach(f=>values[f.key]=index[f.key]>=0?String(r[index[f.key]]??'').trim():'');
    return {row:rowIndex+2,values};
  });
}

function planStudentImport(rows) {
  const existing = DB.get(KEYS.students, []);
  const admissionGroups = new Map();
  existing.forEach(st => {
    const key = String(st.admissionId || '').trim().toLowerCase();
    if (!key) return;
    if (!admissionGroups.has(key)) admissionGroups.set(key, []);
    admissionGroups.get(key).push(st);
  });
  const byAdmission = new Map(Array.from(admissionGroups.entries()).filter(([,items]) => items.length === 1).map(([key,items]) => [key,items[0]]));
  const seen = new Set(), errors = [], changes = [];
  rows.forEach(item => {
    const v = item.values;
    const sid = String(v.admissionId || '').trim();
    const key = sid.toLowerCase();
    if (!v.name || !sid || !v.gender || !v.dob || !v.className) { errors.push(`Row ${item.row}: Full Name, Student ID, Sex, Date of Birth and Class are required.`); return; }
    if (seen.has(key)) { errors.push(`Row ${item.row}: duplicate Student ID ${sid}.`); return; }
    seen.add(key);
    const classId = studentClassIdByName(v.className);
    if (!classId) { errors.push(`Row ${item.row}: class "${v.className}" does not exist in SchoolHub.`); return; }
    const g = v.gender.toLowerCase();
    const gender = g === 'male' || g === 'm' ? 'M' : (g === 'female' || g === 'f' ? 'F' : '');
    if (!gender) { errors.push(`Row ${item.row}: Sex must be Male/Female or M/F.`); return; }
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.dob);
    const parsedDob = dateMatch ? new Date(`${v.dob}T00:00:00Z`) : null;
    if (!parsedDob || !Number.isFinite(parsedDob.getTime()) || parsedDob.toISOString().slice(0,10) !== v.dob) { errors.push(`Row ${item.row}: Date of Birth must be a valid YYYY-MM-DD date.`); return; }
    if (Object.values(v).some(value => String(value || '').length > 500)) { errors.push(`Row ${item.row}: one or more fields are too long.`); return; }
    let disability = v.disability;
    if (disability) {
      const d = disability.toLowerCase();
      disability = d === 'yes' || d === 'y' ? 'Yes' : (d === 'no' || d === 'n' ? 'No' : '');
      if (!disability) { errors.push(`Row ${item.row}: Disability must be Yes or No.`); return; }
    }
    const duplicates = admissionGroups.get(key) || [];
    if (duplicates.length > 1) { errors.push(`Row ${item.row}: Student ID ${sid} matches multiple existing students. Correct those records first.`); return; }
    const current = byAdmission.get(key);
    const merged = current ? Object.assign({}, current) : {id:uid()};
    merged.name = v.name; merged.admissionId = sid; merged.gender = gender; merged.dob = v.dob; merged.classId = classId;
    ['guardianName','parentPhone','houseGps'].forEach(k => { if (v[k]) merged[k] = v[k]; });
    if (disability) merged.disability = disability;
    changes.push({mode:current ? 'Update' : 'Add', record:merged});
  });
  return {errors, changes};
}

function showStudentImportPreview(rows) {
  const host = document.getElementById('studentImportPreview');
  const plan = planStudentImport(rows);
  if (plan.errors.length) {
    host.classList.remove('hidden');
    host.innerHTML = '<h3>Student import needs attention</h3><ul>' + plan.errors.slice(0,30).map(e => '<li>' + escapeHtml(e) + '</li>').join('') + '</ul>';
    return;
  }
  pendingStudentImport = {rows, snapshot:JSON.stringify(DB.get(KEYS.students, [])), token:sessionGeneration, uid:currentUid, schoolId:currentSchoolId};
  const added = plan.changes.filter(x => x.mode === 'Add').length;
  host.classList.remove('hidden');
  host.innerHTML = `<h3>Students import preview</h3><p>${added} to add · ${plan.changes.length-added} to update · ${plan.changes.length} total</p>
    <div class="table-scroll"><table class="grades-table"><thead><tr><th>Action</th><th>Student ID</th><th>Name</th><th>Class</th></tr></thead><tbody>` +
    plan.changes.map(x => `<tr><td>${x.mode}</td><td>${escapeHtml(x.record.admissionId)}</td><td>${escapeHtml(x.record.name)}</td><td>${escapeHtml(studentClassName(x.record))}</td></tr>`).join('') +
    `</tbody></table></div><div class="staff-data-actions"><button type="button" id="applyStudentImport" class="btn-primary">Save imported students</button><button type="button" id="cancelStudentImport">Cancel</button></div>`;
  document.getElementById('cancelStudentImport').onclick = clearStudentImport;
  document.getElementById('applyStudentImport').onclick = saveStudentImport;
  host.scrollIntoView({block:'start',behavior:'smooth'});
}

function clearStudentImport() {
  pendingStudentImport = null;
  const host = document.getElementById('studentImportPreview');
  if (host) { host.innerHTML=''; host.classList.add('hidden'); }
}

async function saveStudentImport() {
  const p = pendingStudentImport;
  if (!p || !isCurrentSession(p.token,p.uid,p.schoolId)) { clearStudentImport(); return; }
  const latest = DB.get(KEYS.students, []);
  if (JSON.stringify(latest) !== p.snapshot) { alert('Student details changed while this preview was open. Review the import again.'); showStudentImportPreview(p.rows); return; }
  const plan = planStudentImport(p.rows);
  if (plan.errors.length) { showStudentImportPreview(p.rows); return; }
  const map = new Map(latest.map(st => [String(st.id), st]));
  plan.changes.forEach(x => map.set(String(x.record.id), x.record));
  const merged = Array.from(map.values());
  const btn = document.getElementById('applyStudentImport');
  if (btn) { btn.disabled=true; btn.textContent='Saving to SchoolHub…'; }
  try {
    if (FIREBASE_ENABLED && currentSchoolId) {
      if (cloudHydrationInProgress || !sessionDataReady) throw new Error('School data is still synchronizing.');
      const ref = schoolRef().collection('students');
      const ops = plan.changes.map(x => batch => batch.set(ref.doc(String(x.record.id)), stripImagesForCloud('students', x.record), {merge:true}));
      await commitChunks(ops);
      if (!isCurrentSession(p.token,p.uid,p.schoolId)) return;
      setLastSyncedNow();
    }
    DB.set(KEYS.students, merged, {skipCloudSync:true});
    auditAction('import','students','',`Imported ${plan.changes.length} student records.`);
    clearStudentImport(); editingStudentId=null; renderStudents(); renderClasses();
    alert(`Students import saved to SchoolHub. ${plan.changes.filter(x=>x.mode==='Add').length} added; ${plan.changes.filter(x=>x.mode==='Update').length} updated.`);
  } catch (e) {
    if (btn) { btn.disabled=false; btn.textContent='Save imported students'; }
    alert('Students import was NOT saved to SchoolHub. Your existing student list has been left unchanged.\n\n' + (e.message || e));
  }
}

function handleStudentImportFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 5*1024*1024) { alert('Import file is too large. Maximum size is 5 MB.'); return; }
  if (typeof XLSX === 'undefined') { alert('Spreadsheet tools are still loading.'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const book = XLSX.read(reader.result, {type:'array', cellDates:true});
      showStudentImportPreview(readStudentWorkbook(book));
    } catch (err) { alert('Could not read the student spreadsheet: ' + (err.message || err)); }
  };
  reader.readAsArrayBuffer(file);
}

function currentStudentTableRows() {
  const query = String(document.getElementById('studentSearchInput')?.value || '').trim().toLowerCase();
  const selectedClass = document.getElementById('studentClassSelect')?.value || '';
  return getAccessibleStudents().filter(st => {
    if (!query && selectedClass && st.classId !== selectedClass) return false;
    if (!query) return true;
    return [st.name,st.admissionId,st.guardianName,st.parentPhone,st.houseGps,st.disability,studentClassName(st)].join(' ').toLowerCase().includes(query);
  });
}

function renderStudentDetailsTable() {
  installStudentTabUpgrade();
  const list = document.getElementById('studentList');
  if (!list || !list.parentNode) return;
  let panel = document.getElementById('studentDetailsTablePanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'studentDetailsTablePanel';
    panel.className = 'student-details-table-panel';
    list.parentNode.insertBefore(panel, list.nextSibling);
  }
  const rows = currentStudentTableRows();
  panel.innerHTML = `<div class="staff-data-actions"><button type="button" id="toggleStudentTableBtn">${studentTableVisible?'Hide table':'Show table'}</button></div>
    <div id="studentDetailsTableWrap" ${studentTableVisible?'':'hidden'}>
      <p class="hint">Scroll sideways to see all student details.</p>
      <div class="table-scroll" tabindex="0"><table class="grades-table student-details-table"><thead><tr>
      <th>Full Name</th><th>Student ID</th><th>Sex</th><th>DOB</th><th>Age</th><th>Disability</th><th>Guardian Name</th><th>Phone</th><th>House No. / GhanaPost GPS</th><th>Class</th><th>Actions</th>
      </tr></thead><tbody>` +
      (rows.length ? rows.map(st => `<tr><td>${escapeHtml(st.name||'—')}</td><td>${escapeHtml(st.admissionId||'—')}</td><td>${escapeHtml(st.gender==='M'?'Male':st.gender==='F'?'Female':'—')}</td><td>${escapeHtml(st.dob||'—')}</td><td>${escapeHtml(calculateStudentAge(st.dob)||'—')}</td><td>${escapeHtml(st.disability||'—')}</td><td>${escapeHtml(st.guardianName||'—')}</td><td>${escapeHtml(st.parentPhone||'—')}</td><td>${escapeHtml(st.houseGps||'—')}</td><td>${escapeHtml(studentClassName(st)||'—')}</td><td><button type="button" class="table-view-student" data-id="${st.id}">View</button> <button type="button" class="table-edit-student" data-id="${st.id}">Edit</button></td></tr>`).join('') : '<tr><td colspan="11" class="empty">No students to display.</td></tr>') +
      '</tbody></table></div></div>';
  document.getElementById('toggleStudentTableBtn').onclick = () => { studentTableVisible=!studentTableVisible; renderStudentDetailsTable(); };
  panel.querySelectorAll('.table-view-student').forEach(b => b.onclick=()=>showStudentDetails(b.dataset.id));
  panel.querySelectorAll('.table-edit-student').forEach(b => b.onclick=()=>{editingStudentId=b.dataset.id; renderStudents(); document.getElementById('studentList')?.scrollIntoView({behavior:'smooth'});});
}

function printDetailsTable(title, columns, records, valueFn) {
  if (!records.length) { alert('No records to print.'); return; }
  const frame = document.createElement('iframe');
  frame.style.cssText='position:fixed;left:-10000px;top:0;width:1200px;height:800px;border:0';
  const school = DB.get(KEYS.settings,{}).schoolName || 'School';
  const table = '<table><thead><tr>' + columns.map(c=>'<th>'+escapeHtml(c.label)+'</th>').join('') + '</tr></thead><tbody>' +
    records.map(r=>'<tr>'+columns.map(c=>'<td>'+escapeHtml(String(valueFn(r,c.key)||'—'))+'</td>').join('')+'</tr>').join('') + '</tbody></table>';
  frame.onload=()=>{frame.contentWindow.addEventListener('afterprint',()=>frame.remove(),{once:true});try{frame.contentWindow.focus();frame.contentWindow.print();}catch(e){frame.remove();alert('Unable to open printing.');}};
  frame.srcdoc='<!doctype html><html><head><meta charset="utf-8"><title>'+escapeHtml(title)+'</title><style>@page{size:A4 landscape;margin:10mm}body{font:10px Arial;color:#111}h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;margin:0 0 10px}p{margin:0 0 10px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #999;padding:5px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#eee}thead{display:table-header-group}tr{break-inside:avoid}</style></head><body><h1>'+escapeHtml(school)+'</h1><h2>'+escapeHtml(title)+'</h2><p>'+records.length+' record(s) · '+escapeHtml(new Date().toLocaleDateString())+'</p>'+table+'</body></html>';
  document.body.appendChild(frame);
}

function printStudentsDetailsTable() {
  const cols = STUDENT_TRANSFER_FIELDS.slice(0,-1).concat([{key:'age',label:'Age'},STUDENT_TRANSFER_FIELDS.slice(-1)[0]]);
  printDetailsTable('Students Details', cols, currentStudentTableRows(), (st,key)=>key==='age'?calculateStudentAge(st.dob):studentTransferValue(st,key));
}

/* Replace Staff screen-print behavior with a clean Staff Details table printout. */
function printStaffDetailsTableOnly() {
  if (!canManageStaffWorkspace()) return;
  const columns = StaffTransfer.columns(STAFF_FIELDS);
  const search = String(document.getElementById('staffSearch')?.value || '').trim().toLowerCase();
  const records = DB.get(KEYS.staff,[]).filter(st => !search || columns.some(f=>String(st[f.key]||'').toLowerCase().includes(search)));
  printDetailsTable('Staff Details', columns, records, (st,key)=>st[key] || (key==='notionalDate'?st.dateOfAppointment||'':''));
}

/* Keep the student table synchronized whenever the normal student renderer runs. */
const _schoolHubRenderStudents = renderStudents;
renderStudents = function() {
  const result = _schoolHubRenderStudents.apply(this, arguments);
  setTimeout(renderStudentDetailsTable, 0);
  return result;
};

setTimeout(() => {
  installStudentTabUpgrade();
  renderStudentDetailsTable();
  const staffPrint = document.getElementById('printStaffBtn');
  if (staffPrint) {
    const replacement = staffPrint.cloneNode(true);
    staffPrint.parentNode.replaceChild(replacement, staffPrint);
    replacement.addEventListener('click', printStaffDetailsTableOnly);
  }
}, 0);


/* ---------- Staff ---------- */
let editingStaffId = null;

const STAFF_FIELDS = [
  { key: 'sex', label: 'Sex', type: 'select', options: [['M','Male'],['F','Female']] },
  { key: 'dob', label: 'Date of Birth', type: 'date' },
  { key: 'staffId', label: 'Staff ID', type: 'text' },
  { key: 'registeredNo', label: 'Registered No.', type: 'text' },
  { key: 'licenseNo', label: 'License No.', type: 'text' },
  { key: 'emisNo', label: 'EMIS No.', type: 'text' },
  { key: 'ssnitNo', label: 'SSNIT No.', type: 'text' },
  { key: 'ghanaCardId', label: 'Ghana Card ID', type: 'text' },
  { key: 'rank', label: 'Rank/Grade', type: 'select', options: [
    ['Pupil Teacher','Pupil Teacher'],
    ['Superintendent II','Superintendent II'],
    ['Superintendent I','Superintendent I'],
    ['Senior Superintendent II','Senior Superintendent II'],
    ['Senior Superintendent I','Senior Superintendent I'],
    ['Principal Superintendent','Principal Superintendent'],
    ['Assistant Director II','Assistant Director II'],
    ['Assistant Director I','Assistant Director I'],
    ['Deputy Director','Deputy Director'],
    ['Other','Other']
  ] },
  { key: 'notionalDate', label: 'Notional Date', type: 'date' },
  { key: 'substantiveDate', label: 'Substantive Date', type: 'date' },
  { key: 'academicQualification', label: 'Academic Qualification', type: 'select', options: [
    ['Certificate','Certificate'],['Diploma','Diploma'],['HND','HND'],["Bachelor's Degree","Bachelor's Degree"],['Postgraduate Diploma','Postgraduate Diploma'],["Master's Degree","Master's Degree"],['PhD','PhD'],['Other','Other']
  ] },
  { key: 'professionalQualification', label: 'Professional Qualification', type: 'select', options: [
    ["Teacher's Certificate","Teacher's Certificate"],['Diploma in Basic Education','Diploma in Basic Education'],['Bachelor of Education','Bachelor of Education'],['Postgraduate teaching qualification','Postgraduate teaching qualification'],['Other','Other']
  ] },
  { key: 'bankBranch', label: 'Bank & Branch', type: 'text' },
  { key: 'bankAccount', label: 'Bank Account', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'tel' },
  { key: 'email', label: 'Email', type: 'email' }
];

function staffFieldControl(f, value) {
  const val = value || '';
  if (f.type === 'select') {
    const opts = (f.options || []).map(([v, label]) => `<option value="${escapeHtml(v)}" ${val === v ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
    return `<select class="edit-staff-${f.key}"><option value="">Select ${escapeHtml(f.label)}</option>${opts}</select>`;
  }
  return `<input type="${f.type}" class="edit-staff-${f.key}" value="${escapeHtml(val)}" ${f.key === 'staffId' ? 'required' : ''}>`;
}


function canManageStaffWorkspace() {
  return sessionReady && sessionDataReady && (isHeadTeacher() || isActiveGuest());
}

let staffTableVisible = true;
function renderStaff() {
  const list = document.getElementById('staffList');
  const count = document.getElementById('staffTableCount');
  const ready = canManageStaffWorkspace();
  ['exportStaffBtn', 'staffTemplateBtn', 'importStaffBtn', 'printStaffBtn'].forEach(id => { document.getElementById(id).disabled = !ready; });
  if (!ready) { list.innerHTML = '<p class="empty">Staff details are available to the Head Teacher once the workspace is ready.</p>'; count.textContent = ''; return; }
  const staff = DB.get(KEYS.staff, []);
  const columns = StaffTransfer.columns(STAFF_FIELDS);
  const search = document.getElementById('staffSearch').value.trim().toLowerCase();
  const visible = staff.filter(st => columns.some(f => String(st[f.key] || '').toLowerCase().includes(search)));
  count.textContent = 'Showing ' + visible.length + ' of ' + staff.length + ' staff';
  const header = columns.map(f => '<th scope="col">' + escapeHtml(f.label) + '</th>').join('');
  const rows = visible.map(st => '<tr>' + columns.map(f => '<td>' + (f.key === 'name' ? '<span class="staff-name-text">' : '') + escapeHtml(String(st[f.key] || (f.key === 'notionalDate' ? st.dateOfAppointment || '' : '') || '—')) + (f.key === 'name' ? '</span>' : '') + '</td>').join('') +
    '<td class="staff-table-actions"><button type="button" class="view-staff" data-id="' + escapeHtml(st.id) + '">View</button><button type="button" class="edit-staff" data-id="' + escapeHtml(st.id) + '">Edit</button><button type="button" class="del-staff" data-id="' + escapeHtml(st.id) + '">Delete</button></td></tr>').join('');
  list.innerHTML = visible.length ? '' : '<p class="empty">' + (staff.length ? 'No staff match your search.' : 'No staff yet. Add a staff member above or import a file.') + '</p>';
  const editor = document.createElement('ul');
  editor.className = 'list staff-editor-list';
  list.appendChild(editor);
  staff.filter(st => visible.includes(st) || editingStaffId === st.id).forEach(st => {
    const li = document.createElement('li');
    if (editingStaffId === st.id) {
      const fieldInputs = STAFF_FIELDS.map(f =>
        `<label>${f.label}${f.key === 'staffId' ? ' <span class="required-mark">*</span>' : ''}${staffFieldControl(f, st[f.key])}</label>`
      ).join('');
      const sigPreview = st.signature
        ? `<img src="${st.signature}" alt="" class="staff-signature-preview">
           <button type="button" class="btn-text remove-staff-signature" data-id="${st.id}">Remove signature</button>`
        : '';
      li.innerHTML = `<div class="edit-row">
        <label>Full name <span class="required-mark">*</span>
          <input type="text" class="edit-staff-name" value="${escapeHtml(st.name)}" placeholder="Full name" required>
        </label>
        ${fieldInputs}
        <label>Role
          <select class="edit-staff-role">
            <option value="Teacher" ${st.role === 'Teacher' ? 'selected' : ''}>Teacher</option>
            <option value="Head Teacher" ${st.role === 'Head Teacher' ? 'selected' : ''}>Head Teacher</option>
            <option value="Assistant Head Teacher" ${st.role === 'Assistant Head Teacher' ? 'selected' : ''}>Assistant Head Teacher</option>
            <option value="Other" ${st.role === 'Other' ? 'selected' : ''}>Other</option>
          </select>
        </label>
        ${sigPreview}
        <label>Signature
          <input type="file" class="edit-staff-signature-input" accept="image/*" data-staff="${st.id}">
        </label>
        <p class="edit-staff-validation form-validation" role="alert"></p>
        <div class="edit-actions">
          <button class="save-btn save-staff" data-id="${st.id}">Update</button>
          <button class="cancel-btn cancel-staff">Cancel</button>
        </div>
      </div>`;
    }
    if (editingStaffId !== st.id) {
      li.innerHTML = '<div class="staff-list-main"><strong>' + escapeHtml(st.name || 'Unnamed staff') + '</strong><div class="meta">' + escapeHtml(st.role || 'Teacher') + ' · Staff ID: ' + escapeHtml(st.staffId || '—') + '</div></div><div class="staff-list-actions"><button type="button" class="view-staff" data-id="' + escapeHtml(st.id) + '">View</button><button type="button" class="edit-staff" data-id="' + escapeHtml(st.id) + '">Edit</button><button type="button" class="del-staff" data-id="' + escapeHtml(st.id) + '">Delete</button></div>';
    }
    editor.appendChild(li);
  });

  const tableSection = document.createElement('div');
  tableSection.innerHTML = '<div class="staff-data-toolbar"><strong>Staff details table</strong><button type="button" id="toggleStaffTableBtn" aria-controls="staffDetailsTablePanel" aria-expanded="' + staffTableVisible + '">' + (staffTableVisible ? 'Hide table' : 'Show table') + '</button></div><div id="staffDetailsTablePanel"' + (staffTableVisible ? '' : ' hidden') + '><p class="hint">Scroll sideways to see all staff details.</p><div class="table-scroll staff-table-scroll" tabindex="0" role="region" aria-label="Staff details, scroll horizontally for more columns"><table class="grades-table staff-details-table"><caption class="sr-only">Staff details</caption><thead><tr>' + header + '<th scope="col">Actions</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  list.appendChild(tableSection);
  document.getElementById('toggleStaffTableBtn').addEventListener('click', event => {
    staffTableVisible = !staffTableVisible;
    document.getElementById('staffDetailsTablePanel').hidden = !staffTableVisible;
    event.currentTarget.textContent = staffTableVisible ? 'Hide table' : 'Show table';
    event.currentTarget.setAttribute('aria-expanded', String(staffTableVisible));
  });

  list.querySelectorAll('.view-staff').forEach(btn => {
    btn.addEventListener('click', () => showStaffDetails(btn.dataset.id));
  });
  list.querySelectorAll('.edit-staff').forEach(btn => {
    btn.addEventListener('click', () => { editingStaffId = btn.dataset.id; renderStaff(); document.querySelector('.staff-editor-list')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
  });
  list.querySelectorAll('.cancel-staff').forEach(btn => {
    btn.addEventListener('click', () => { editingStaffId = null; renderStaff(); });
  });
  list.querySelectorAll('.edit-staff-signature-input').forEach(input => {
    input.addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      const staffId = input.dataset.staff;
      const assetPath = schoolAssetPath(file, 'signatures', staffId);
      const existingStaff = DB.get(KEYS.staff, []).find(x => x.id === staffId);
      const oldStoragePath = existingStaff ? (existingStaff.signatureStoragePath || '') : '';
      const cacheKey = imageCacheKey('staff', staffId);
      try {
        const dataUrl = await fileToDataUrl(file);
        if (!isDataImage(dataUrl)) throw new Error('The selected file is not a readable image.');
        await cacheLocalImageWithMeta(cacheKey, dataUrl, { storagePath: assetPath, sourceUrl: '', updatedAt: new Date().toISOString() });
        const staffList = DB.get(KEYS.staff, []);
        const st = staffList.find(x => x.id === staffId);
        if (!st) throw new Error('Staff record not found.');
        st.signature = dataUrl; st.signatureUrl = ''; st.signatureStoragePath = assetPath;
        DB.set(KEYS.staff, staffList); renderStaff();
        auditAction('update', 'staff-signature', staffId, `Updated staff signature: ${st.name || staffId}`);
        try {
          const url = await uploadSchoolAsset(file, 'signatures', staffId);
          const latestStaff = DB.get(KEYS.staff, []); const latest = latestStaff.find(x => x.id === staffId);
          if (latest) { latest.signature = dataUrl; latest.signatureUrl = url || ''; latest.signatureStoragePath = assetPath; }
          DB.set(KEYS.staff, latestStaff);
          await persistStaffSignature(staffId, url || '', assetPath);
          await upsertImageManifest('staff', staffId, { storagePath: assetPath, sourceUrl: url || '', storageUpdatedAt: new Date().toISOString() });
          if (oldStoragePath && oldStoragePath !== assetPath) await removeStoragePath(oldStoragePath);
          renderStaff();
        } catch (cloudError) { console.warn('Staff signature cloud backup pending:', cloudError); alert(`Signature saved on this browser. Firebase backup is pending.\n\n${cloudError.message || cloudError}`); }
      } catch (err) { alert('Could not save the signature locally: ' + (err.message || err)); }
      finally { input.value = ''; }
    });
  });
  list.querySelectorAll('.remove-staff-signature').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!canManageStaffWorkspace()) return;
      const staffList = DB.get(KEYS.staff, []); const st = staffList.find(x => x.id === btn.dataset.id); if (!st) return;
      const oldUrl = st.signatureUrl || st.signature || '';
      const oldStoragePath = st.signatureStoragePath || '';
      st.signature = ''; st.signatureUrl = ''; st.signatureStoragePath = '';
      removeCachedLocalImage(imageCacheKey('staff', st.id)); DB.set(KEYS.staff, staffList);
      Promise.all([oldStoragePath ? removeStoragePath(oldStoragePath) : removeStorageFile(oldUrl), persistStaffSignature(st.id, ''), removeImageManifest('staff', st.id)])
        .then(() => renderStaff()).catch(err => alert('Could not remove the signature: ' + err.message));
    });
  });
  list.querySelectorAll('.save-staff').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!canManageStaffWorkspace()) return;
      const li = btn.closest('li');
      const validation = li.querySelector('.edit-staff-validation');
      const name = li.querySelector('.edit-staff-name').value.trim();
      const staffIdValue = li.querySelector('.edit-staff-staffId').value.trim();
      if (!name || !staffIdValue) {
        validation.textContent = !name && !staffIdValue ? 'Full name and Staff ID are required.' : (!name ? 'Full name is required.' : 'Staff ID is required.');
        validation.classList.add('show');
        return;
      }
      validation.classList.remove('show');
      const staffList = DB.get(KEYS.staff, []); const st = staffList.find(x => x.id === btn.dataset.id);
      if (st) {
        st.name = name; st.role = li.querySelector('.edit-staff-role').value;
        STAFF_FIELDS.forEach(f => { st[f.key] = li.querySelector(`.edit-staff-${f.key}`).value.trim(); });
      }
      DB.set(KEYS.staff, staffList); auditAction('update', 'staff', st ? st.id : btn.dataset.id, `Updated staff: ${st ? st.name : ''}`);
      editingStaffId = null; renderStaff(); renderClasses();
    });
  });
  list.querySelectorAll('.del-staff').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!canManageStaffWorkspace()) return;
      if (!confirm('Delete this staff member? Any class or Head Teacher signature assignment referencing them will be cleared.')) return;
      const id = btn.dataset.id;
      const token = sessionGeneration, userId = currentUid, schoolId = currentSchoolId;
      if (currentSchoolId) {
        try { await deleteSchoolRecord(staffRef(id)); }
        catch (error) { alert('Could not delete this staff member. Please reconnect and try again.'); return; }
        if (!isCurrentSession(token, userId, schoolId)) return;
      }
      DB.set(KEYS.staff, DB.get(KEYS.staff, []).filter(s => s.id !== id), {skipCloudSync:true});
      auditAction('delete', 'staff', id, 'Deleted staff record');
      const classes = DB.get(KEYS.classes, []); classes.forEach(c => { if (c.classTeacherId === id) c.classTeacherId = ''; }); DB.set(KEYS.classes, classes);
      const settings = DB.get(KEYS.settings, {}); if (settings.headTeacherId === id) { settings.headTeacherId = ''; DB.set(KEYS.settings, settings); }
      renderStaff(); renderClasses();
    });
  });
}

function showStaffDetails(staffId) {
  if (!canManageStaffWorkspace()) return;
  const st = DB.get(KEYS.staff, []).find(x => x.id === staffId);
  if (!st) return;
  const content = document.getElementById('staffDetailsContent');
  if (!content) return;
  const sexLabel = st.sex === 'M' ? 'Male' : (st.sex === 'F' ? 'Female' : '—');
  const rows = [
    ['Full name', st.name || '—'],
    ['Sex', sexLabel],
    ['DOB', st.dob || '—'],
    ['Staff ID', st.staffId || '—'],
    ['Registered No.', st.registeredNo || '—'],
    ['License No.', st.licenseNo || '—'],
    ['EMIS No.', st.emisNo || '—'],
    ['SSNIT No.', st.ssnitNo || '—'],
    ['Ghana Card ID', st.ghanaCardId || '—'],
    ['Rank/Grade', st.rank || '—'],
    ['Notional Date', st.notionalDate || st.dateOfAppointment || '—'],
    ['Substantive Date', st.substantiveDate || '—'],
    ['Academic Qualification', st.academicQualification || '—'],
    ['Professional Qualification', st.professionalQualification || '—'],
    ['Bank & Branch', st.bankBranch || '—'],
    ['Bank Account', st.bankAccount || '—'],
    ['Phone', st.phone || '—'],
    ['Email', st.email || '—'],
    ['Role', st.role || 'Staff']
  ];
  content.innerHTML = rows.map(([label, value]) => `<div class="staff-detail-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('') +
    (st.signature ? `<img src="${st.signature}" alt="Staff signature" class="staff-detail-signature">` : '<p class="hint" style="text-align:center;margin:14px 0 0;">No signature uploaded.</p>');
  document.getElementById('staffDetailsDialog').classList.remove('hidden');
}

function closeStaffDetails() {
  const dialog = document.getElementById('staffDetailsDialog');
  if (dialog) dialog.classList.add('hidden');
}

const toggleAddStaffBtn = document.getElementById('toggleAddStaffBtn');
const addStaffForm = document.getElementById('addStaffForm');
if (toggleAddStaffBtn && addStaffForm) {
  toggleAddStaffBtn.addEventListener('click', () => {
    const open = addStaffForm.classList.toggle('hidden') === false;
    toggleAddStaffBtn.textContent = open ? 'Collapse' : 'Expand';
    toggleAddStaffBtn.setAttribute('aria-expanded', String(open));
  });
}
const staffDetailsCloseBtn = document.getElementById('staffDetailsCloseBtn');
if (staffDetailsCloseBtn) staffDetailsCloseBtn.addEventListener('click', closeStaffDetails);
const staffDetailsDialog = document.getElementById('staffDetailsDialog');
if (staffDetailsDialog) staffDetailsDialog.addEventListener('click', e => { if (e.target === staffDetailsDialog) closeStaffDetails(); });

document.getElementById('addStaffBtn').addEventListener('click', async () => {
  if (!requireHeadTeacher('manage staff')) return;
  const nameInput = document.getElementById('newStaffName');
  const staffIdInput = document.getElementById('newStaff_staffId');
  const validation = document.getElementById('addStaffValidation');
  const name = nameInput.value.trim();
  const staffIdValue = staffIdInput.value.trim();
  if (!name || !staffIdValue) {
    validation.textContent = !name && !staffIdValue ? 'Full name and Staff ID are required before the staff member can be added.' : (!name ? 'Full name is required before the staff member can be added.' : 'Staff ID is required before the staff member can be added.');
    validation.classList.add('show');
    if (!name) nameInput.focus(); else staffIdInput.focus();
    return;
  }
  validation.classList.remove('show');
  const role = document.getElementById('newStaffRole').value;
  const values = {};
  STAFF_FIELDS.forEach(f => { values[f.key] = document.getElementById('newStaff_' + f.key).value.trim(); });
  const file = document.getElementById('newStaffSignature').files[0];
  const existingStaff = DB.get(KEYS.staff, []).find(s => String(s.staffId || '').trim().toLowerCase() === staffIdValue.toLowerCase());
  if (existingStaff) {
    validation.textContent = `Staff ID ${staffIdValue} is already assigned to ${existingStaff.name || 'another staff member'}. Use a unique Staff ID.`;
    validation.classList.add('show'); staffIdInput.focus(); return;
  }
  const staffId = uid(); const signaturePath = file ? schoolAssetPath(file, 'signatures', staffId) : ''; let signatureDataUrl = ''; let signatureUrl = '';
  try {
    if (file) { signatureDataUrl = await fileToDataUrl(file); if (!isDataImage(signatureDataUrl)) throw new Error('The selected signature file is not a readable image.'); await cacheLocalImageWithMeta(imageCacheKey('staff', staffId), signatureDataUrl, { storagePath: signaturePath, sourceUrl: '', updatedAt: new Date().toISOString() }); }
    const staffList = DB.get(KEYS.staff, []);
    const record = Object.assign({ id: staffId, name, role, signature: signatureDataUrl, signatureUrl: '', signatureStoragePath: signaturePath }, values);
    staffList.push(record); DB.set(KEYS.staff, staffList); auditAction('create', 'staff', record.id, `Added staff: ${record.name}`);
    nameInput.value = ''; STAFF_FIELDS.forEach(f => { document.getElementById('newStaff_' + f.key).value = ''; }); document.getElementById('newStaffSignature').value = ''; validation.classList.remove('show');
    renderStaff();
    addStaffForm.classList.add('hidden'); toggleAddStaffBtn.textContent = 'Expand'; toggleAddStaffBtn.setAttribute('aria-expanded', 'false');
    if (file) {
      try {
        signatureUrl = await uploadSchoolAsset(file, 'signatures', staffId); const latestStaff = DB.get(KEYS.staff, []); const latest = latestStaff.find(x => x.id === staffId); if (latest) latest.signatureUrl = signatureUrl || ''; DB.set(KEYS.staff, latestStaff);
        await persistStaffSignature(staffId, signatureUrl || '', signaturePath); await upsertImageManifest('staff', staffId, { storagePath: signaturePath, sourceUrl: signatureUrl || '', storageUpdatedAt: new Date().toISOString() });
      } catch (cloudError) { console.warn('New staff signature cloud backup pending:', cloudError); alert(`Staff member saved locally. Signature Firebase backup is pending.\n\n${cloudError.message || cloudError}`); }
    }
    renderStaff();
  } catch (err) { alert('Could not save the staff member: ' + (err.message || err)); }
});



/* ---------- Inline Help / FAQ / Privacy / Terms ---------- */
const INLINE_DOCS = {
  faq: { title: 'Help & FAQ', templateId: 'inlineDocTemplateFaq' },
  privacy: { title: 'Privacy Notice', templateId: 'inlineDocTemplatePrivacy' },
  terms: { title: 'Terms of Use', templateId: 'inlineDocTemplateTerms' }
};

function openInlineDoc(name) {
  const config = INLINE_DOCS[name];
  const dialog = document.getElementById('inlineDocDialog');
  const title = document.getElementById('inlineDocTitle');
  const body = document.getElementById('inlineDocBody');
  const template = config ? document.getElementById(config.templateId) : null;
  if (!config || !dialog || !title || !body || !template) return;

  title.textContent = config.title;
  body.innerHTML = '';
  body.appendChild(template.content.cloneNode(true));
  body.scrollTop = 0;
  dialog.classList.remove('hidden');

  const profileDropdown = document.getElementById('profileDropdown');
  if (profileDropdown) profileDropdown.classList.add('hidden');
}

function closeInlineDoc() {
  const dialog = document.getElementById('inlineDocDialog');
  if (dialog) dialog.classList.add('hidden');
}

document.addEventListener('click', event => {
  const opener = event.target.closest('[data-inline-doc]');
  if (opener) {
    event.preventDefault();
    openInlineDoc(opener.dataset.inlineDoc);
    return;
  }
  if (event.target.id === 'inlineDocCloseBtn' || event.target.id === 'inlineDocBottomCloseBtn') {
    closeInlineDoc();
  }
});

const inlineDocDialog = document.getElementById('inlineDocDialog');
if (inlineDocDialog) {
  inlineDocDialog.addEventListener('click', event => {
    if (event.target === inlineDocDialog) closeInlineDoc();
  });
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && inlineDocDialog && !inlineDocDialog.classList.contains('hidden')) closeInlineDoc();
});


/* ---------- Staff spreadsheet controls ---------- */
function exportStaffWorkbook(templateOnly = false) {
  if (!canManageStaffWorkspace()) return;
  if (typeof XLSX === 'undefined') { alert('Spreadsheet tools are still loading. Please reconnect and try again.'); return; }
  const fields = StaffTransfer.columns(STAFF_FIELDS);
  const staff = templateOnly ? [] : DB.get(KEYS.staff, []);
  const rows = [fields.map(f => f.label), ...staff.map(st => fields.map(f => String(st[f.key] || (f.key === 'notionalDate' ? st.dateOfAppointment || '' : ''))))];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  // Export identifiers, bank accounts and phone numbers as text, including leading zeros.
  Object.keys(sheet).filter(key => key[0] !== '!').forEach(key => { sheet[key].t = 's'; sheet[key].z = '@'; delete sheet[key].f; });
  sheet['!cols'] = fields.map(f => ({ wch: Math.max(18, Math.min(34, f.label.length + 6)) }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Staff');
  const instructions = [
    ['Staff import instructions'],
    ['Full name and Staff ID are required for every row. Keep Staff IDs unique and formatted as text.'],
    ['Existing Staff IDs update their matching records. New Staff IDs add new records.'],
    ['Blank cells and omitted columns preserve existing details. No records are deleted.'],
    ['Signatures, class assignments and linked accounts stay unchanged.'],
    ['Enter dates as YYYY-MM-DD or use Excel date cells.'],
    ['Use the Staff sheet. Preview the import in SchoolHub before saving.'],
    ...fields.filter(f => f.options).map(f => [f.label, f.options.map(o => o[0]).join(', ')])
  ];
  const help = XLSX.utils.aoa_to_sheet(instructions); help['!cols'] = [{ wch: 105 }, { wch: 100 }];
  XLSX.utils.book_append_sheet(book, help, 'Instructions');
  XLSX.writeFile(book, templateOnly ? 'SchoolHub_staff_template.xlsx' : 'SchoolHub_staff_' + new Date().toISOString().slice(0, 10) + '.xlsx');
}

function staffRowsFromWorkbook(book) {
  const sheet = book.Sheets[book.SheetNames.includes('Staff') ? 'Staff' : book.SheetNames[0]];
  if (!sheet || !sheet['!ref']) throw new Error('The staff sheet is empty.');
  const range = XLSX.utils.decode_range(sheet['!ref']);
  if (range.e.r - range.s.r > 5000 || range.e.c - range.s.c > 100) throw new Error('Import at most 5,000 staff rows and 100 columns at a time.');
  const rows = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({r, c})];
      if (cell?.f) throw new Error('The staff sheet contains formulas. Paste their values before importing.');
      if (cell?.t === 'e') throw new Error('The staff sheet contains an Excel error. Correct it before importing.');
      if (cell?.t === 'd') {
        const date = cell.v instanceof Date ? cell.v : new Date(cell.v);
        if (!Number.isFinite(date.getTime())) throw new Error('The staff sheet contains an invalid date.');
        row.push(`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`);
      } else row.push(cell == null ? '' : String(cell.w ?? cell.v ?? ''));
    }
    rows.push(row);
  }
  return rows;
}

function clearStaffImport() {
  pendingStaffImport = null;
  const host = document.getElementById('staffImportPreview');
  host.innerHTML = ''; host.classList.add('hidden');
}

function showStaffImportPreview(rows) {
  const existing = DB.get(KEYS.staff, []);
  const result = StaffTransfer.plan(rows, existing, STAFF_FIELDS);
  const host = document.getElementById('staffImportPreview');
  host.classList.remove('hidden');
  pendingStaffImport = null;
  if (result.errors.length) {
    host.innerHTML = '<h3>Correct the file before importing</h3><p>No staff records have been changed.</p><ul>' + result.errors.slice(0, 30).map(error => '<li>' + escapeHtml(error) + '</li>').join('') + '</ul>' + (result.errors.length > 30 ? '<p>Showing the first 30 errors.</p>' : '') + '<button type="button" id="cancelStaffImport">Close</button>';
  } else {
    const added = result.changes.filter(c => !c.existingId).length;
    pendingStaffImport = { rows, snapshot: JSON.stringify(existing), token: sessionGeneration, schoolId: currentSchoolId, uid: currentUid };
    host.innerHTML = '<h3>Review staff import</h3><p>' + added + ' new staff; ' + (result.changes.length-added) + ' existing staff to update. Blank cells preserve existing details.</p><div class="table-scroll"><table class="grades-table"><thead><tr><th>Action</th><th>Staff ID</th><th>Full name</th></tr></thead><tbody>' + result.changes.map(c => '<tr><td>' + (c.existingId ? 'Update' : 'Add') + '</td><td>' + escapeHtml(c.values.staffId) + '</td><td>' + escapeHtml(c.values.name) + '</td></tr>').join('') + '</tbody></table></div><div class="staff-data-actions"><button type="button" id="applyStaffImport" class="btn-primary">Save imported staff</button><button type="button" id="cancelStaffImport">Cancel</button></div>';
    document.getElementById('applyStaffImport').addEventListener('click', async () => {
      const pending = pendingStaffImport;
      if (!pending || !canManageStaffWorkspace() || !isCurrentSession(pending.token, pending.uid, pending.schoolId)) { clearStaffImport(); return; }
      const latest = DB.get(KEYS.staff, []);
      if (JSON.stringify(latest) !== pending.snapshot) { showStaffImportPreview(pending.rows); alert('Staff details changed while this preview was open. Review the refreshed preview before saving.'); return; }
      const checked = StaffTransfer.plan(pending.rows, latest, STAFF_FIELDS);
      if (checked.errors.length) { showStaffImportPreview(pending.rows); return; }
      const mergedStaff = StaffTransfer.merge(latest, checked.changes, uid);
      const saveButton = document.getElementById('applyStaffImport');
      if (saveButton) { saveButton.disabled = true; saveButton.textContent = 'Saving to SchoolHub…'; }
      try {
        if (FIREBASE_ENABLED && currentSchoolId) {
          if (!isHeadTeacher() || currentStatus !== 'active' || cloudHydrationInProgress || !sessionDataReady) throw new Error('The school workspace is not ready for a cloud staff import. Please wait for synchronization to finish and try again.');
          await syncCollectionArray(schoolRef().collection('staff'), mergedStaff, staff => stripImagesForCloud('staff', staff), { preserveMissing: true });
          if (!isCurrentSession(pending.token, pending.uid, pending.schoolId)) return;
          setLastSyncedNow();
        }
        DB.set(KEYS.staff, mergedStaff, {skipCloudSync:true});
        auditAction('import', 'staff', '', 'Imported ' + checked.changes.length + ' staff records.');
        clearStaffImport(); editingStaffId = null;
        renderStaff(); renderClasses(); refreshHeadTeacherSelect();
        alert('Staff import saved to SchoolHub. ' + added + ' added; ' + (checked.changes.length-added) + ' updated.');
      } catch (error) {
        if (saveButton) { saveButton.disabled = false; saveButton.textContent = 'Save imported staff'; }
        alert('Staff import was NOT saved to SchoolHub. Your existing staff list has been left unchanged.\n\n' + (error.message || error));
      }
    });
  }
  document.getElementById('cancelStaffImport').addEventListener('click', clearStaffImport);
  host.scrollIntoView({block:'start',behavior:'smooth'});
}

function printStaffDetails() {
  if (!canManageStaffWorkspace()) return;
  const columns = StaffTransfer.columns(STAFF_FIELDS);
  const search = document.getElementById('staffSearch').value.trim().toLowerCase();
  const staff = DB.get(KEYS.staff, []).filter(st => columns.some(f => String(st[f.key] || '').toLowerCase().includes(search)));
  if (!staff.length) { alert('No staff to print. Clear your search or add staff first.'); return; }
  document.getElementById('staffPrintFrame')?.remove();
  const frame = document.createElement('iframe');
  frame.id = 'staffPrintFrame';
  frame.title = 'Staff print preview';
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1100px;height:800px;border:0';
  const identity = columns.slice(0, 2), details = columns.slice(2);
  const sections = [];
  for (let i = 0; i < details.length; i += 5) {
    const fields = identity.concat(details.slice(i, i + 5));
    sections.push('<section><h1>' + escapeHtml(DB.get(KEYS.settings, {}).schoolName || 'School') + '</h1><h2>Staff details — Part ' + (i / 5 + 1) + '</h2><p>' + staff.length + ' staff · ' + escapeHtml(new Date().toLocaleDateString()) + (search ? ' · Search: ' + escapeHtml(search) : '') + '</p><table><thead><tr>' + fields.map(f => '<th>' + escapeHtml(f.label) + '</th>').join('') + '</tr></thead><tbody>' + staff.map(st => '<tr>' + fields.map(f => '<td>' + escapeHtml(String(st[f.key] || (f.key === 'notionalDate' ? st.dateOfAppointment || '' : '') || '—')) + '</td>').join('') + '</tr>').join('') + '</tbody></table></section>');
  }
  frame.onload = () => {
    frame.contentWindow.addEventListener('afterprint', () => frame.remove(), { once: true });
    try { frame.contentWindow.focus(); frame.contentWindow.print(); }
    catch (error) { frame.remove(); alert('Unable to open printing. Please try again.'); }
  };
  frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><title>Staff details</title><style>@page{size:A4 landscape;margin:12mm}body{font:11px Arial,sans-serif;color:#111}h1{font-size:20px;margin:0 0 6px}h2{font-size:15px}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #aaa;padding:7px;text-align:left;overflow-wrap:anywhere}th{background:#eee}thead{display:table-header-group}tr{break-inside:avoid}section+section{break-before:page}</style></head><body>' + sections.join('') + '</body></html>';
  document.body.appendChild(frame);
}

document.getElementById('checkStaffRecoveryBtn').addEventListener('click', async () => {
  if (!canManageStaffWorkspace()) return;
  const token = sessionGeneration, userId = currentUid, schoolId = currentSchoolId;
  const host = document.getElementById('staffRecoveryPreview');
  host.classList.remove('hidden'); host.textContent = 'Checking saved copies…';
  try {
    let candidates = [];
    for (const key of [recoveryKey(schoolId), recoveryKey(schoolId) + '__staff_repair_original']) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const backup = JSON.parse(raw);
      if (schoolId && String(backup.schoolId) === String(schoolId) && Array.isArray(backup.data?.staff)) candidates.push(...backup.data.staff);
    }
    if (schoolId) {
      const [school, cloud] = await Promise.all([schoolRef().get(), schoolRef().collection('staff').get()]);
      if (school.exists && Array.isArray(school.data().staff)) candidates.push(...school.data().staff);
      cloud.forEach(doc => candidates.push(Object.assign({}, doc.data(), { id: doc.id })));
    }
    if (!isCurrentSession(token, userId, schoolId)) return;
    const existing = DB.get(KEYS.staff, []);
    const knownIds = new Set(existing.map(s => String(s.id)));
    const knownStaffIds = new Set(existing.map(s => String(s.staffId || '').trim().toLowerCase()).filter(Boolean));
    const missing = [];
    for (const record of candidates.reverse()) {
      if (!record || !record.id || !record.name) continue;
      const id = String(record.id), staffId = String(record.staffId || '').trim().toLowerCase();
      if (knownIds.has(id) || (staffId && knownStaffIds.has(staffId))) continue;
      knownIds.add(id); if (staffId) knownStaffIds.add(staffId);
      missing.push(record);
    }
    host.innerHTML = '<h3>Staff recovery check</h3><p>' + (missing.length ? 'Found ' + missing.length + ' staff in saved copies who are not in the current list. Select only staff who should be restored.' : 'No additional staff found in this browser’s saved copies or the current cloud records. An older backup or another device may still have them.') + '</p>';
    missing.forEach((record, index) => {
      const label = document.createElement('label');
      label.innerHTML = '<input type="checkbox" data-recovery-index="' + index + '"> ' + escapeHtml(record.name) + ' · Staff ID: ' + escapeHtml(record.staffId || '—');
      host.appendChild(label);
    });
    if (!missing.length) return;
    const restore = document.createElement('button'); restore.type = 'button'; restore.textContent = 'Restore selected staff';
    host.appendChild(restore);
    restore.addEventListener('click', async () => {
      if (!isCurrentSession(token, userId, schoolId) || !canManageStaffWorkspace()) return;
      const selected = Array.from(host.querySelectorAll('input:checked')).map(el => missing[Number(el.dataset.recoveryIndex)]);
      if (!selected.length) return;
      const latest = DB.get(KEYS.staff, []);
      const additions = selected.filter(record => !latest.some(s => String(s.id) === String(record.id) || (record.staffId && String(s.staffId || '').trim().toLowerCase() === String(record.staffId).trim().toLowerCase())));
      try {
        if(FIREBASE_ENABLED&&currentSchoolId){
          if(navigator.onLine===false||offlineAuthenticatedMode)throw new Error('Reconnect before restoring staff.');
          await commitChunks(additions.map(record=>batch=>batch.restore(staffRef(String(record.id)),stripImagesForCloud('staff',record))));
          if(!isCurrentSession(token,userId,schoolId))return;
        }
        DB.set(KEYS.staff, latest.concat(additions), {skipCloudSync:true});
        host.textContent = additions.length + ' staff restored.';
        renderStaff(); renderClasses(); refreshHeadTeacherSelect();
      } catch (error) { host.textContent = 'Could not save restored staff: ' + error.message; }
    });
  } catch (error) {
    if (isCurrentSession(token, userId, schoolId)) host.textContent = 'Could not finish the recovery check: ' + error.message;
  }
});
document.getElementById('printStaffBtn').addEventListener('click', printStaffDetails);
document.getElementById('staffSearch').addEventListener('input', renderStaff);
document.getElementById('exportStaffBtn').addEventListener('click', () => exportStaffWorkbook(false));
document.getElementById('staffTemplateBtn').addEventListener('click', () => exportStaffWorkbook(true));
document.getElementById('importStaffBtn').addEventListener('click', () => {
  if (canManageStaffWorkspace()) document.getElementById('staffImportFile').click();
});
document.getElementById('staffImportFile').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file || !canManageStaffWorkspace()) return;
  clearStaffImport();
  const token = sessionGeneration, schoolId = currentSchoolId, userId = currentUid;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('Choose a spreadsheet smaller than 5 MB.');
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error('Choose an Excel or CSV file.');
    if (typeof XLSX === 'undefined') throw new Error('Spreadsheet tools are still loading. Please reconnect and try again.');
    const bytes = await file.arrayBuffer();
    if (!isCurrentSession(token, userId, schoolId) || !canManageStaffWorkspace()) return;
    const book = XLSX.read(bytes, { type:'array', cellDates:true, raw:true });
    showStaffImportPreview(staffRowsFromWorkbook(book));
  } catch (error) {
    if (isCurrentSession(token, userId, schoolId)) alert('Could not import staff: ' + error.message);
  }
});

/* ---------- Attendance: Students + Teachers + School Calendar ---------- */
function attendanceKey(classId, term, year, date) {
  return `${classId}__${term}__${year}__${date}`;
}

function teacherAttendanceKey(term, year, date) {
  return `${term}__${year}__${date}`;
}

function calendarKey(term, year, date) {
  return `${term}__${year}__${date}`;
}

function termYearKey(term, year) {
  return term && year ? `${term}__${year}` : '';
}

function getTermDates(term, year) {
  const settings = DB.get(KEYS.settings, {});
  const targetTerm = term || settings.currentTerm;
  const targetYear = year || settings.currentYear;
  const key = termYearKey(targetTerm, targetYear);
  const map = settings.termDates && typeof settings.termDates === 'object' ? settings.termDates : {};

  const candidates = [
    map[key],
    map[encodeURIComponent(key)],
    settings.termDates && settings.termDates[targetTerm],
    settings.termDates && settings.termDates[String(targetYear)]
  ];
  for (const item of candidates) {
    if (item && item.start && item.end && parseDateOnly(item.start) && parseDateOnly(item.end)) {
      return { start: dateOnlyString(parseDateOnly(item.start)), end: dateOnlyString(parseDateOnly(item.end)) };
    }
  }

  // Backward-compatible support for older versions that stored one active
  // term range directly in Settings.
  const start = settings.termStartDate || settings.termOpens || settings.termStart || '';
  const end = settings.termEndDate || settings.termCloses || settings.termEnd || '';
  if (start && end && parseDateOnly(start) && parseDateOnly(end)) {
    return { start: dateOnlyString(parseDateOnly(start)), end: dateOnlyString(parseDateOnly(end)) };
  }
  return null;
}

function parseDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  const text = String(value).trim();
  if (!text) return null;

  // Primary storage format is yyyy-mm-dd from <input type="date">.
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  // Accept dd/mm/yyyy and dd-mm-yyyy as a recovery path for older backups
  // or manually imported settings.
  m = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function dateOnlyString(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function addDaysDateOnly(d, days) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + days);
  return x;
}

function isWeekdayDate(d) {
  const day = d.getDay();
  return day !== 0 && day !== 6;
}

function schoolCalendarRecordsForTerm(term, year) {
  const all = DB.get(KEYS.schoolCalendar, {});
  const prefix = `${term}__${year}__`;
  return Object.keys(all).filter(k => k.startsWith(prefix)).map(key => ({ key, date: key.slice(prefix.length), record: all[key] || {} }))
    .sort((a,b) => a.date.localeCompare(b.date));
}

function calendarRecord(term, year, date) {
  return DB.get(KEYS.schoolCalendar, {})[calendarKey(term, year, date)] || null;
}

function calculateTimesOpen(term, year, throughDate) {
  const dates = getTermDates(term, year);

  // Term dates are authoritative. If an older workspace has attendance
  // records but no saved term range, use the earliest/latest recorded open
  // attendance dates as a temporary recovery range instead of displaying 0
  // and suppressing every ratio. The Setup term dates should still be set for
  // a complete academic-calendar calculation.
  let start = dates ? parseDateOnly(dates.start) : null;
  let end = dates ? parseDateOnly(dates.end) : null;

  if (!start || !end) {
    const datesFound = [];
    const allStudentAttendance = DB.get(KEYS.attendance, {});
    const studentRecords = Object.keys(allStudentAttendance).filter(k => k.indexOf(`__${term}__${year}__`) !== -1).map(key => ({ key, date: key.split('__').slice(-1)[0], record: allStudentAttendance[key] || {} }));
    const teacherRecords = teacherAttendanceRecordsForTerm(term, year);
    studentRecords.concat(teacherRecords).forEach(item => {
      if (item && item.date && attendanceDayType(term, year, item.date) === 'open') datesFound.push(item.date);
    });
    schoolCalendarRecordsForTerm(term, year).forEach(item => {
      if (item && item.date && String(item.record.type || '').toLowerCase() === 'open') datesFound.push(item.date);
    });
    const parsed = datesFound.map(parseDateOnly).filter(Boolean).sort((a,b) => a - b);
    if (parsed.length) { start = parsed[0]; end = parsed[parsed.length - 1]; }
  }

  if (!start || !end || start > end) return 0;
  let limit = end;
  if (throughDate) {
    const t = parseDateOnly(throughDate) || new Date();
    if (t < limit) limit = t;
  } else {
    const today = new Date();
    const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (todayOnly < limit && todayOnly >= start) limit = todayOnly;
    if (todayOnly < start) return 0;
  }
  if (limit < start) return 0;
  const exceptions = new Map(schoolCalendarRecordsForTerm(term, year).map(x => [x.date, String(x.record.type || '').toLowerCase()]));
  let count = 0;
  for (let d = new Date(start); d <= limit; d = addDaysDateOnly(d, 1)) {
    if (!isWeekdayDate(d)) continue;
    const type = exceptions.get(dateOnlyString(d));
    if (type === 'holiday' || type === 'midterm') continue;
    count++;
  }
  return count;
}

function calendarLabel(type) {
  if (type === 'holiday') return 'Holiday';
  if (type === 'midterm') return 'Midterm';
  if (type === 'weekend') return 'Weekend';
  if (type === 'outside') return 'Outside Term';
  return 'School Open';
}

function attendanceDayType(term, year, date) {
  const rec = calendarRecord(term, year, date);
  return rec && rec.type ? String(rec.type).toLowerCase() : 'open';
}

function attendanceDateToday() {
  const d = new Date();
  return dateOnlyString(d);
}

function attendanceRecordsForTerm(classId, term, year) {
  const all = DB.get(KEYS.attendance, {});
  const prefix = `${classId}__${term}__${year}__`;
  return Object.keys(all).filter(k => k.startsWith(prefix)).map(key => ({ key, date: key.slice(prefix.length), record: all[key] || {} }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function attendanceSummary(classId, term, year) {
  const students = getAccessibleStudents().filter(s => s.classId === classId);
  const records = attendanceRecordsForTerm(classId, term, year);
  const summary = {};
  students.forEach(st => summary[st.id] = { present: 0, absent: 0, late: 0, total: 0, recorded: 0 });
  records.forEach(({ record, date }) => {
    if (attendanceDayType(term, year, date) !== 'open') return;
    const entries = record.entries || record;
    students.forEach(st => {
      const status = entries && entries[st.id] ? String(entries[st.id]).toUpperCase() : '';
      if (!status) return;
      summary[st.id].recorded++;
      if (status === 'P') summary[st.id].present++;
      else if (status === 'L') summary[st.id].late++;
      else if (status === 'A') summary[st.id].absent++;
      summary[st.id].total = summary[st.id].present + summary[st.id].late;
    });
  });
  return { records, summary };
}

function teacherAttendanceRecordsForTerm(term, year) {
  const all = DB.get(KEYS.teacherAttendance, {});
  const prefix = `${term}__${year}__`;
  return Object.keys(all).filter(k => k.startsWith(prefix))
    .map(key => ({ key, date: key.slice(prefix.length), record: all[key] || {} }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function isTeacherStaffRecord(st) {
  const role = String(st && st.role || '').toLowerCase().replace(/\s+/g, '');
  // A Head Teacher is also a teaching staff member and must be included in
  // teacher attendance and the average teacher attendance ratio. Assistant
  // Head Teachers are included too when their Staff role identifies them as
  // teaching staff.
  return role === 'teacher' || role === 'headteacher' || role === 'assistantheadteacher'
    || role.includes('teacher');
}

function ensureHeadTeacherStaffRecord() {
  if (!isHeadTeacher() || !currentUid || !currentSchoolId) return Promise.resolve(null);

  const settings = DB.get(KEYS.settings, {});
  let staffList = DB.get(KEYS.staff, []);
  const authUser = firebase.auth().currentUser;
  const accountEmail = String((currentUserData && currentUserData.email) || (authUser && authUser.email) || '').trim().toLowerCase();
  const accountName = String((currentUserData && (currentUserData.displayName || currentUserData.name)) || (authUser && authUser.displayName) || '').trim().toLowerCase();
  let staff = staffList.find(s => s.userUid === currentUid);

  // Also recognize an existing Staff record by the Head Teacher's account
  // email or display name, preventing duplicate personnel records after an
  // older version was used before account-to-Staff linking.
  if (!staff && accountEmail) staff = staffList.find(s => String(s.email || '').trim().toLowerCase() === accountEmail) || null;
  if (!staff && accountName) staff = staffList.find(s => String(s.name || '').trim().toLowerCase() === accountName) || null;

  // If the Head Teacher was already selected in Setup, reuse that Staff
  // record and establish the missing account link rather than creating a
  // duplicate.
  if (!staff && settings.headTeacherId) {
    staff = staffList.find(s => s.id === settings.headTeacherId) || null;
  }

  if (staff) {
    let changed = false;
    if (staff.userUid !== currentUid) { staff.userUid = currentUid; changed = true; }
    if (!staff.email) {
      const email = currentUserData && currentUserData.email
        ? currentUserData.email
        : (firebase.auth().currentUser && firebase.auth().currentUser.email) || '';
      if (email) { staff.email = email; changed = true; }
    }
    if (!staff.role || !String(staff.role).toLowerCase().includes('teacher')) {
      staff.role = 'Head Teacher';
      changed = true;
    }
    if (settings.headTeacherId !== staff.id) {
      settings.headTeacherId = staff.id;
      DB.set(KEYS.settings, settings);
    }
    if (changed) {
      DB.set(KEYS.staff, staffList);
      return staffRef(staff.id).set(stripImagesForCloud('staff', staff), { merge: true })
        .then(() => firebase.firestore().collection('users').doc(currentUid).set({ staffId: staff.id, staffLinkedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true }))
        .then(() => staff);
    }
    return Promise.resolve(staff);
  }

  const email = String((currentUserData && currentUserData.email) || (authUser && authUser.email) || '').trim();
  const displayName = String((currentUserData && (currentUserData.displayName || currentUserData.name)) || (authUser && authUser.displayName) || '').trim();
  const fallbackName = displayName || staffNameFromMember({ email }) || 'Head Teacher';
  const staffId = uid();
  staff = {
    id: staffId,
    userUid: currentUid,
    email,
    name: fallbackName,
    role: 'Head Teacher',
    dob: '', staffId: '', registeredNo: '', licenseNo: '', ssnitNo: '',
    ghanaCardId: '', dateOfAppointment: '', rank: '', phone: '',
    signature: '', signatureUrl: '', signatureStoragePath: '',
    createdAt: new Date().toISOString()
  };

  staffList.push(staff);
  DB.set(KEYS.staff, staffList);
  settings.headTeacherId = staffId;
  DB.set(KEYS.settings, settings);

  return staffRef(staffId).set(stripImagesForCloud('staff', staff), { merge: true })
    .then(() => firebase.firestore().collection('users').doc(currentUid).set({
      staffId: staffId,
      staffLinkedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true }))
    .then(() => staff);
}

function teacherAttendanceSummary(term, year) {
  const staff = DB.get(KEYS.staff, []).filter(isTeacherStaffRecord);
  const records = teacherAttendanceRecordsForTerm(term, year);
  const summary = {};
  staff.forEach(st => summary[st.id] = { present: 0, absent: 0, late: 0, total: 0, excused: 0, leave: 0, recorded: 0 });
  records.forEach(({ record, date }) => {
    if (attendanceDayType(term, year, date) !== 'open') return;
    const entries = record.entries || record;
    staff.forEach(st => {
      const status = entries && entries[st.id] ? String(entries[st.id]).toUpperCase() : '';
      if (!status) return;
      summary[st.id].recorded++;
      if (status === 'P') summary[st.id].present++;
      else if (status === 'L') summary[st.id].late++;
      else if (status === 'A') summary[st.id].absent++;
      else if (status === 'E') summary[st.id].excused++;
      else if (status === 'O') summary[st.id].leave++;
      summary[st.id].total = summary[st.id].present + summary[st.id].late;
    });
  });
  return { records, summary };
}

function attendanceRatio(summary, timesOpen, isTeacher) {
  const attended = Number(summary && summary.total || 0);
  let denominator = Number(timesOpen || 0);

  // For teachers, approved Excused and On Leave days are not days they were
  // expected to attend, so remove them from the individual denominator.
  if (isTeacher && summary) {
    denominator -= Number(summary.excused || 0) + Number(summary.leave || 0);
  }

  return denominator > 0 ? Math.min(100, (attended / denominator) * 100) : null;
}


function averageAttendanceRatio(summary, timesOpen, isTeacher) {
  const ratios = Object.values(summary || {})
    .map(s => attendanceRatio(s, timesOpen, isTeacher))
    .filter(v => Number.isFinite(v));
  if (!ratios.length) return null;
  return ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
}

function formatAttendanceRatio(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
}


/* ---------- v38.7.1 Attendance Reports ---------- */
function attendanceOpenDates(term, year, throughDate) {
  const td = getTermDates(term, year);
  if (!td) return [];
  const start = parseDateOnly(td.start), end0 = parseDateOnly(td.end);
  if (!start || !end0 || start > end0) return [];
  let end = end0;
  if (throughDate) {
    const t = parseDateOnly(throughDate);
    if (t && t < end) end = t;
  } else {
    const today = parseDateOnly(attendanceDateToday());
    if (today && today < end && today >= start) end = today;
    if (today && today < start) return [];
  }
  const out = [];
  const exceptions = new Map(schoolCalendarRecordsForTerm(term, year).map(x => [x.date, String(x.record.type || '').toLowerCase()]));
  for (let d = new Date(start); d <= end; d = addDaysDateOnly(d, 1)) {
    if (!isWeekdayDate(d)) continue;
    const date = dateOnlyString(d);
    const type = exceptions.get(date);
    if (type === 'holiday' || type === 'midterm') continue;
    out.push(date);
  }
  return out;
}

function attendanceStatusLabel(status) {
  return ({P:'Present', L:'Late', A:'Absent', E:'Excused', O:'On Leave'})[String(status || '').toUpperCase()] || 'Not recorded';
}

function attendanceStatusCodeForStudent(classId, term, year, date, studentId) {
  const rec = DB.get(KEYS.attendance, {})[attendanceKey(classId, term, year, date)] || {};
  const entries = rec.entries || rec;
  return entries && entries[studentId] ? String(entries[studentId]).toUpperCase() : '';
}

function attendanceStatusCodeForTeacher(term, year, date, staffId) {
  const rec = DB.get(KEYS.teacherAttendance, {})[teacherAttendanceKey(term, year, date)] || {};
  const entries = rec.entries || rec;
  return entries && entries[staffId] ? String(entries[staffId]).toUpperCase() : '';
}

function attendanceReportDateDefault() {
  const settings = DB.get(KEYS.settings, {});
  const today = attendanceDateToday();
  const dates = attendanceOpenDates(settings.currentTerm, settings.currentYear, today);
  return dates.length ? dates[dates.length - 1] : today;
}

function attendanceReportPupilHistory(student, term, year) {
  const dates = attendanceOpenDates(term, year);
  const rows = [];
  dates.forEach(date => {
    const status = attendanceStatusCodeForStudent(student.classId, term, year, date, student.id);
    rows.push({ date, status, label: attendanceStatusLabel(status) });
  });
  return rows;
}

function attendanceReportTeacherHistory(staff, term, year) {
  const dates = attendanceOpenDates(term, year);
  return dates.map(date => {
    const status = attendanceStatusCodeForTeacher(term, year, date, staff.id);
    return { date, status, label: attendanceStatusLabel(status) };
  });
}

function attendanceReportPupilStats(student, term, year, timesOpen) {
  // Canonical pupil totals come from attendanceSummary(), the same source used
  // by the Students tab, Summary, Class Reports and Analytics. History is
  // retained only for the chronological streak calculation.
  const history = attendanceReportPupilHistory(student, term, year);
  const summaryMap = attendanceSummary(student.classId, term, year).summary || {};
  const sm = summaryMap[student.id] || { present: 0, late: 0, absent: 0, total: 0, recorded: 0 };
  const present = Number(sm.present || 0);
  const late = Number(sm.late || 0);
  const absent = Number(sm.absent || 0);
  const total = Number(sm.total || (present + late));
  const recorded = Number(sm.recorded || 0);
  const ratio = attendanceRatio({ present, late, total, absent }, timesOpen, false);
  let current = 0, longest = 0, run = 0;
  history.forEach(r => {
    if (r.status === 'A') {
      run++;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  });
  current = run;
  return { present, late, total, absent, recorded, ratio, currentAbsenceStreak: current, longestAbsenceStreak: longest, history };
}

function attendanceReportTeacherStats(staff, term, year, timesOpen) {
  // Use the same authoritative local summary used by the Teacher Attendance
  // tab. The previous report implementation rebuilt the totals from a
  // separate date-history path, which could disagree with the live teacher
  // attendance data after a save/sync. That is why the Teacher Attendance tab
  // could show Present/Late totals while the Reports tab showed zeros.
  const history = attendanceReportTeacherHistory(staff, term, year);
  const summaryMap = teacherAttendanceSummary(term, year).summary || {};
  const sm = summaryMap[staff.id] || {present:0, late:0, absent:0, excused:0, leave:0, recorded:0};
  const present = Number(sm.present || 0);
  const late = Number(sm.late || 0);
  const absent = Number(sm.absent || 0);
  const excused = Number(sm.excused || 0);
  const leave = Number(sm.leave || 0);
  const total = present + late;
  const recorded = Number(sm.recorded || 0);
  const ratio = attendanceRatio({present, late, total, absent, excused, leave}, timesOpen, true);

  // Streaks are still derived from the chronological history so they reflect
  // the actual dates on which the teacher was marked Absent.
  let current=0, longest=0, run=0;
  history.forEach(r => {
    if (r.status === 'A') {
      run++;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  });
  current = run;
  return {present, late, total, absent, excused, leave, recorded, ratio,
          currentAbsenceStreak:current, longestAbsenceStreak:longest, history};
}

function attendanceReportClassRows(classId, term, year, timesOpen) {
  const students = DB.get(KEYS.students, []).filter(s => s.classId === classId);
  return students.map(st => ({ student:st, stats:attendanceReportPupilStats(st,term,year,timesOpen) }));
}

function attendanceReportTeacherRows(term, year, timesOpen) {
  return DB.get(KEYS.staff, []).filter(isTeacherStaffRecord).map(st => ({ staff:st, stats:attendanceReportTeacherStats(st,term,year,timesOpen) }));
}

function attendanceReportDaily(date, term, year, classId, kind) {
  const dayType = attendanceDayType(term, year, date);
  if (dayType !== 'open') return { dayType, rows:[] };
  if (kind === 'teachers') {
    return { dayType, rows: DB.get(KEYS.staff,[]).filter(isTeacherStaffRecord).map(st=>({name:st.name,role:st.role||'Teacher',status:attendanceStatusCodeForTeacher(term,year,date,st.id),className:''})) };
  }
  const classes = classId ? getAccessibleClasses().filter(c=>c.id===classId) : getAccessibleClasses();
  const rows=[];
  classes.forEach(c=>DB.get(KEYS.students,[]).filter(s=>s.classId===c.id).forEach(st=>rows.push({name:st.name,className:c.name,status:attendanceStatusCodeForStudent(c.id,term,year,date,st.id)})));
  return {dayType,rows};
}

function attendanceReportEscapeLines(text) { return String(text||'').split(/\n/); }

function renderAttendanceReports() {
  const wrap=document.getElementById('attendanceReportsWrap');
  if(!wrap) return;
  const settings=DB.get(KEYS.settings,{});
  const term=String(settings.currentTerm||'Term 1');
  const year=String(settings.currentYear||'');
  const timesOpen=calculateTimesOpen(term,year);
  let mode=document.getElementById('attendanceReportType')?.value||'term';
  if (!isHeadTeacher() && (mode==='daily-teachers' || mode==='teacher')) mode='term';
  const savedClass=document.getElementById('attendanceReportClass')?.value||'';
  const savedPerson=document.getElementById('attendanceReportPerson')?.value||'';
  const savedDate=document.getElementById('attendanceReportDate')?.value||attendanceReportDateDefault();
  let html=`<div class="attendance-report-builder"><div class="attendance-report-builder-head"><div><h3>Attendance Reports</h3><p class="hint">Generate daily, class, individual, teacher, or term attendance reports.</p></div><div class="attendance-report-actions"><button type="button" id="printAttendanceReportBtn" class="btn-primary">Print Report</button><button type="button" id="downloadAttendanceReportBtn" class="btn-primary">Download Report</button></div></div>`;
  html+=`<div class="attendance-report-controls"><label>Report Type<select id="attendanceReportType"><option value="term" ${mode==='term'?'selected':''}>Term Summary</option><option value="daily-students" ${mode==='daily-students'?'selected':''}>Daily Pupil Report</option>${isHeadTeacher()?`<option value="daily-teachers" ${mode==='daily-teachers'?'selected':''}>Daily Teacher Report</option>`:''}<option value="class" ${mode==='class'?'selected':''}>Class Attendance Report</option><option value="pupil" ${mode==='pupil'?'selected':''}>Individual Pupil Report</option>${isHeadTeacher()?`<option value="teacher" ${mode==='teacher'?'selected':''}>Individual Teacher Report</option>`:''}</select></label>`;
  if(mode.startsWith('daily')) html+=`<label>Date<input type="date" id="attendanceReportDate" value="${escapeHtml(savedDate)}"></label>`;
  if(['class','pupil'].includes(mode)) html+=`<label>Class<select id="attendanceReportClass"><option value="">Select Class</option>${getAccessibleClasses().map(c=>`<option value="${escapeHtml(c.id)}" ${savedClass===c.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('')}</select></label>`;
  if(mode==='pupil') { const cls=savedClass?DB.get(KEYS.students,[]).filter(s=>s.classId===savedClass):getAccessibleStudents(); html+=`<label>Pupil<select id="attendanceReportPerson"><option value="">Select Pupil</option>${cls.map(s=>`<option value="${escapeHtml(s.id)}" ${savedPerson===s.id?'selected':''}>${escapeHtml(s.name)}</option>`).join('')}</select></label>`; }
  if(mode==='teacher') html+=`<label>Teacher<select id="attendanceReportPerson"><option value="">Select Teacher</option>${DB.get(KEYS.staff,[]).filter(isTeacherStaffRecord).map(s=>`<option value="${escapeHtml(s.id)}" ${savedPerson===s.id?'selected':''}>${escapeHtml(s.name)}</option>`).join('')}</select></label>`;
  if(mode==='daily-students') html+=`<label>Class<select id="attendanceReportClass"><option value="">All Classes</option>${getAccessibleClasses().map(c=>`<option value="${escapeHtml(c.id)}" ${savedClass===c.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('')}</select></label>`;
  html+='</div>';

  if(mode==='term') {
    const students=attendanceReportOverallStudent(term,year,timesOpen), teachers=attendanceReportOverallTeacher(term,year,timesOpen);
    html+=`<div class="attendance-report-cards"><div><span>Times Open</span><strong>${timesOpen} days</strong></div><div><span>Holidays</span><strong>${schoolCalendarRecordsForTerm(term,year).filter(x=>String(x.record.type||'').toLowerCase()==='holiday').length}</strong></div><div><span>Midterm</span><strong>${schoolCalendarRecordsForTerm(term,year).filter(x=>String(x.record.type||'').toLowerCase()==='midterm').length}</strong></div><div><span>Pupils</span><strong>${students.pupils}</strong></div><div><span>Average Pupil Ratio</span><strong>${formatAttendanceRatio(students.averageRatio)}</strong></div>${isHeadTeacher()?`<div><span>Teachers</span><strong>${teachers.teachers}</strong></div><div><span>Average Teacher Ratio</span><strong>${formatAttendanceRatio(teachers.averageRatio)}</strong></div>`:''}</div>`;
    html+='<h4 class="attendance-report-section-title">Class Attendance</h4><div class="table-scroll"><table class="grades-table attendance-report-table"><thead><tr><th>Class</th><th>Pupils</th><th>Present</th><th>Late</th><th>Total</th><th>Absent</th><th>Average Ratio</th></tr></thead><tbody>';
    getAccessibleClasses().forEach(c=>{const x=attendanceSummaryClassStats(c.id,term,year,timesOpen);html+=`<tr><td>${escapeHtml(c.name)}</td><td>${x.pupils}</td><td>${x.present}</td><td>${x.late}</td><td>${x.total}</td><td>${x.absent}</td><td>${formatAttendanceRatio(x.averageRatio)}</td></tr>`;});
    html+='</tbody></table></div>';
    if(isHeadTeacher()){html+='<h4 class="attendance-report-section-title">Teacher Attendance</h4><div class="table-scroll"><table class="grades-table attendance-report-table"><thead><tr><th>Teacher</th><th>Role</th><th>Present</th><th>Late</th><th>Total</th><th>Absent</th><th>Excused</th><th>Leave</th><th>Ratio</th></tr></thead><tbody>';attendanceReportTeacherRows(term,year,timesOpen).forEach(x=>html+=`<tr><td>${escapeHtml(x.staff.name)}</td><td>${escapeHtml(x.staff.role||'Teacher')}</td><td>${x.stats.present}</td><td>${x.stats.late}</td><td>${x.stats.total}</td><td>${x.stats.absent}</td><td>${x.stats.excused}</td><td>${x.stats.leave}</td><td>${formatAttendanceRatio(x.stats.ratio)}</td></tr>`);html+='</tbody></table></div>';}
  } else if(mode==='daily-students' || mode==='daily-teachers') {
    const date=savedDate; const kind=mode==='daily-teachers'?'teachers':'students'; const data=attendanceReportDaily(date,term,year,savedClass,kind); const d=parseDateOnly(date); const day=d?d.toLocaleDateString(undefined,{weekday:'long',year:'numeric',month:'long',day:'numeric'}):date;
    html+=`<div class="attendance-report-note"><strong>${escapeHtml(day)}</strong> · ${escapeHtml(calendarLabel(data.dayType))}${data.dayType==='open'?'':' · Attendance is not recorded on this date.'}</div>`;
    if(data.dayType==='open'){let p=0,l=0,a=0,e=0,o=0,m=0;data.rows.forEach(r=>{if(r.status)m++;if(r.status==='P')p++;else if(r.status==='L')l++;else if(r.status==='A')a++;else if(r.status==='E')e++;else if(r.status==='O')o++;});html+=`<div class="attendance-report-cards"><div><span>Recorded</span><strong>${m} / ${data.rows.length}</strong></div><div><span>Present</span><strong>${p}</strong></div><div><span>Late</span><strong>${l}</strong></div><div><span>Absent</span><strong>${a}</strong></div>${kind==='teachers'?`<div><span>Excused</span><strong>${e}</strong></div><div><span>On Leave</span><strong>${o}</strong></div>`:''}</div>`;html+='<div class="table-scroll"><table class="grades-table attendance-report-table"><thead><tr><th>Name</th>'+ (kind==='students'?'<th>Class</th>':'<th>Role</th>') +'<th>Status</th></tr></thead><tbody>';data.rows.forEach(r=>html+=`<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(kind==='students'?r.className:r.role)}</td><td>${escapeHtml(r.status?attendanceStatusLabel(r.status):'Not recorded')}</td></tr>`);html+='</tbody></table></div>';}
  } else if(mode==='class') {
    const cls=DB.get(KEYS.classes,[]).find(c=>c.id===savedClass); if(!cls) html+='<p class="empty">Select a class to generate the report.</p>'; else {const rows=attendanceReportClassRows(cls.id,term,year,timesOpen);const avg=rows.map(x=>x.stats.ratio).filter(Number.isFinite);const ar=avg.length?avg.reduce((a,b)=>a+b,0)/avg.length:null;html+=`<div class="attendance-report-cards"><div><span>Class</span><strong>${escapeHtml(cls.name)}</strong></div><div><span>Pupils</span><strong>${rows.length}</strong></div><div><span>Times Open</span><strong>${timesOpen}</strong></div><div><span>Average Ratio</span><strong>${formatAttendanceRatio(ar)}</strong></div></div><div class="table-scroll"><table class="grades-table attendance-report-table"><thead><tr><th>Pupil</th><th>Present</th><th>Late</th><th>Total</th><th>Absent</th><th>Ratio</th><th>Current Streak</th><th>Longest Streak</th></tr></thead><tbody>`;rows.forEach(x=>html+=`<tr><td>${escapeHtml(x.student.name)}</td><td>${x.stats.present}</td><td>${x.stats.late}</td><td>${x.stats.total}</td><td>${x.stats.absent}</td><td>${formatAttendanceRatio(x.stats.ratio)}</td><td>${x.stats.currentAbsenceStreak}</td><td>${x.stats.longestAbsenceStreak}</td></tr>`);html+='</tbody></table></div>';}
  } else if(mode==='pupil') {
    const st=DB.get(KEYS.students,[]).find(s=>s.id===savedPerson && canAccessClass(s.classId)); if(!st) html+='<p class="empty">Select a class and pupil to generate the report.</p>'; else {const cls=DB.get(KEYS.classes,[]).find(c=>c.id===st.classId);const x=attendanceReportPupilStats(st,term,year,timesOpen);html+=`<div class="attendance-report-cards"><div><span>Pupil</span><strong>${escapeHtml(st.name)}</strong></div><div><span>Class</span><strong>${escapeHtml(cls?cls.name:'')}</strong></div><div><span>Times Open</span><strong>${timesOpen}</strong></div><div><span>Present</span><strong>${x.present}</strong></div><div><span>Late</span><strong>${x.late}</strong></div><div><span>Absent</span><strong>${x.absent}</strong></div><div><span>Attendance Ratio</span><strong>${formatAttendanceRatio(x.ratio)}</strong></div><div><span>Current Absence Streak</span><strong>${x.currentAbsenceStreak}</strong></div><div><span>Longest Absence Streak</span><strong>${x.longestAbsenceStreak}</strong></div></div><h4 class="attendance-report-section-title">Attendance History</h4><div class="table-scroll"><table class="grades-table attendance-report-table"><thead><tr><th>Date</th><th>Day</th><th>Status</th></tr></thead><tbody>`;x.history.forEach(r=>{const d=parseDateOnly(r.date);html+=`<tr><td>${escapeHtml(r.date)}</td><td>${d?escapeHtml(d.toLocaleDateString(undefined,{weekday:'short'})):''}</td><td>${escapeHtml(r.label)}</td></tr>`;});html+='</tbody></table></div>';}
  } else if(mode==='teacher') {
    const st=DB.get(KEYS.staff,[]).find(s=>s.id===savedPerson && isTeacherStaffRecord(s)); if(!st) html+='<p class="empty">Select a teacher to generate the report.</p>'; else {const x=attendanceReportTeacherStats(st,term,year,timesOpen);html+=`<div class="attendance-report-cards"><div><span>Teacher</span><strong>${escapeHtml(st.name)}</strong></div><div><span>Role</span><strong>${escapeHtml(st.role||'Teacher')}</strong></div><div><span>Times Open</span><strong>${timesOpen}</strong></div><div><span>Present</span><strong>${x.present}</strong></div><div><span>Late</span><strong>${x.late}</strong></div><div><span>Absent</span><strong>${x.absent}</strong></div><div><span>Excused</span><strong>${x.excused}</strong></div><div><span>On Leave</span><strong>${x.leave}</strong></div><div><span>Attendance Ratio</span><strong>${formatAttendanceRatio(x.ratio)}</strong></div><div><span>Current Absence Streak</span><strong>${x.currentAbsenceStreak}</strong></div><div><span>Longest Absence Streak</span><strong>${x.longestAbsenceStreak}</strong></div></div><h4 class="attendance-report-section-title">Attendance History</h4><div class="table-scroll"><table class="grades-table attendance-report-table"><thead><tr><th>Date</th><th>Day</th><th>Status</th></tr></thead><tbody>`;x.history.forEach(r=>{const d=parseDateOnly(r.date);html+=`<tr><td>${escapeHtml(r.date)}</td><td>${d?escapeHtml(d.toLocaleDateString(undefined,{weekday:'short'})):''}</td><td>${escapeHtml(r.label)}</td></tr>`;});html+='</tbody></table></div>';}
  }
  html+=`<p class="attendance-report-note">Attendance ratios use Times Open. Present and Late count as attendance. Holidays, Midterm and weekends are excluded from Times Open. Unrecorded attendance is shown as Not recorded and is not counted as Present or Absent.</p></div>`;
  wrap.innerHTML=html;
  const type=document.getElementById('attendanceReportType'); if(type)type.addEventListener('change',renderAttendanceReports);
  const cls=document.getElementById('attendanceReportClass'); if(cls)cls.addEventListener('change',()=>{ if(mode==='pupil') { renderAttendanceReports(); } else renderAttendanceReports(); });
  const person=document.getElementById('attendanceReportPerson'); if(person)person.addEventListener('change',renderAttendanceReports);
  const date=document.getElementById('attendanceReportDate'); if(date)date.addEventListener('change',renderAttendanceReports);
  const pb=document.getElementById('printAttendanceReportBtn');if(pb)pb.addEventListener('click',printAttendanceReport);
  const db=document.getElementById('downloadAttendanceReportBtn');if(db)db.addEventListener('click',downloadAttendanceReportPdf);
}

function attendanceReportCurrentSelection() {
  const settings=DB.get(KEYS.settings,{}); const term=String(settings.currentTerm||'Term 1'); const year=String(settings.currentYear||'');
  return {settings,term,year,type:document.getElementById('attendanceReportType')?.value||'term',classId:document.getElementById('attendanceReportClass')?.value||'',personId:document.getElementById('attendanceReportPerson')?.value||'',date:document.getElementById('attendanceReportDate')?.value||attendanceReportDateDefault()};
}

function attendanceReportTitle(sel) {
  const names={term:'Term Attendance Summary', 'daily-students':'Daily Pupil Attendance Report','daily-teachers':'Daily Teacher Attendance Report',class:'Class Attendance Report',pupil:'Individual Pupil Attendance Report',teacher:'Individual Teacher Attendance Report'};
  return names[sel.type] || 'Attendance Report';
}

function buildAttendanceReportPrintHost() {
  const host=document.createElement('div'); host.className='attendance-print-host';
  const wrap=document.getElementById('attendanceReportsWrap');
  host.innerHTML=`<div class="attendance-print-report"><div class="attendance-report-heading"><h2>${escapeHtml(DB.get(KEYS.settings,{}).schoolName||'School')}</h2><h3>${escapeHtml(attendanceReportTitle(attendanceReportCurrentSelection()))}</h3><p>${escapeHtml(DB.get(KEYS.settings,{}).currentTerm||'')} ${escapeHtml(DB.get(KEYS.settings,{}).currentYear||'')}</p></div>${wrap?wrap.innerHTML:''}</div>`;
  const actions=host.querySelector('.attendance-report-actions'); if(actions)actions.remove();
  const controls=host.querySelector('.attendance-report-controls'); if(controls)controls.remove();
  host.querySelectorAll('button').forEach(b=>b.remove());
  document.body.appendChild(host); return host;
}

function printAttendanceReport(){
  const host=buildAttendanceReportPrintHost(); document.body.classList.add('attendance-print-mode');
  const cleanup=()=>{document.body.classList.remove('attendance-print-mode');if(host.parentNode)host.parentNode.removeChild(host);window.removeEventListener('afterprint',cleanup);};
  window.addEventListener('afterprint',cleanup,{once:true}); setTimeout(()=>{try{window.print();}catch(e){cleanup();alert('Unable to open the print dialog. Please try again.');}setTimeout(cleanup,15000);},100);
}

async function downloadAttendanceReportPdf(){
  const button = document.getElementById('downloadAttendanceReportBtn');
  const sel = attendanceReportCurrentSelection();
  const safeTitle = attendanceReportTitle(sel).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
  const safePeriod = `${sel.term}_${sel.year}`.replace(/[^a-z0-9_]+/gi, '_').replace(/^_+|_+$/g, '');
  return downloadAttendancePrintLayoutPdf({
    button,
    buildHost: buildAttendanceReportPrintHost,
    filename: `${safeTitle || 'Attendance_Report'}_${safePeriod || 'Report'}.pdf`
  });
}


function renderAttendanceView() {
  installAttendanceDateNavigator();
  const studentOption = document.getElementById('attendanceStudentOption');
  const teacherOption = document.getElementById('attendanceTeacherOption');
  const calendarOption = document.getElementById('attendanceCalendarOption');
  const summaryOption = document.getElementById('attendanceSummaryOption');
  const analysisOption = document.getElementById('attendanceAnalysisOption');
  const reportsOption = document.getElementById('attendanceReportsOption');
  if (!studentOption || !teacherOption || !calendarOption || !summaryOption || !analysisOption || !reportsOption) return;
  teacherOption.classList.toggle('hidden', !isHeadTeacher());
  reportsOption.classList.toggle('hidden', false);
  const active = document.querySelector('#attendanceModeBar .attendance-mode.active');
  const mode = (active && active.dataset.mode) || 'students';
  if (mode === 'teachers' && !isHeadTeacher()) return setAttendanceMode('students');
  setAttendanceMode(mode);
}

function setAttendanceMode(mode) {
  if (mode === 'teachers' && !isHeadTeacher()) mode = 'students';
  saveAttendanceTabState(mode);
  document.querySelectorAll('#attendanceModeBar .attendance-mode').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === mode));
  const studentPanel = document.getElementById('studentAttendancePanel');
  const teacherPanel = document.getElementById('teacherAttendancePanel');
  const calendarPanel = document.getElementById('schoolCalendarPanel');
  const summaryPanel = document.getElementById('attendanceSummaryPanel');
  const analysisPanel = document.getElementById('attendanceAnalysisPanel');
  const reportsPanel = document.getElementById('attendanceReportsPanel');
  if (studentPanel) studentPanel.classList.toggle('hidden', mode !== 'students');
  if (teacherPanel) teacherPanel.classList.toggle('hidden', mode !== 'teachers');
  if (calendarPanel) calendarPanel.classList.toggle('hidden', mode !== 'calendar');
  if (summaryPanel) summaryPanel.classList.toggle('hidden', mode !== 'summary');
  if (analysisPanel) analysisPanel.classList.toggle('hidden', mode !== 'analysis');
  if (reportsPanel) reportsPanel.classList.toggle('hidden', mode !== 'reports');
  if (mode === 'students') renderAttendanceClassSelect();
  else if (mode === 'teachers') renderTeacherAttendanceForm();
  else if (mode === 'calendar') renderSchoolCalendar();
  else if (mode === 'summary') renderAttendanceSummary();
  else if (mode === 'analysis') renderAttendanceAnalysis();
  else renderAttendanceReports();
}

function renderAttendanceClassSelect() {
  const sel = document.getElementById('attendanceClassSelect');
  if (!sel) return;
  fillClassSelect(sel);
  renderAttendanceForm();
}

function attendanceSummaryHeader(label, timesOpen, averageRatio) {
  return `<div class="attendance-summary-pills"><div class="attendance-summary-pill"><span>Times Open</span><strong>${timesOpen || 0} day${timesOpen === 1 ? '' : 's'}</strong></div><div class="attendance-summary-pill"><span>${label}</span><strong>${formatAttendanceRatio(averageRatio)}</strong></div></div>`;
}

function renderAttendanceForm() {
  const wrap = document.getElementById('attendanceFormWrap');
  const saveBtn = document.getElementById('saveAttendanceBtn');
  if (!wrap) return;
  const classId = document.getElementById('attendanceClassSelect').value;
  if (classId && !canAccessClass(classId)) { wrap.innerHTML = '<p class="empty">You do not have access to this class.</p>'; if (saveBtn) saveBtn.disabled = true; return; }
  if (!classId) { wrap.innerHTML = '<p class="empty">Add a class first.</p>'; if (saveBtn) saveBtn.disabled = true; return; }
  const settings = DB.get(KEYS.settings, {});
  if (!settings.currentTerm || !settings.currentYear) { wrap.innerHTML = '<p class="empty">Set the current Term and Academic Year in Setup first.</p>'; if (saveBtn) saveBtn.disabled = true; return; }
  const date = document.getElementById('attendanceDate').value || attendanceDateToday();
  document.getElementById('attendanceDate').value = date;
  const dayType = attendanceDayType(settings.currentTerm, settings.currentYear, date);
  const timesOpen = calculateTimesOpen(settings.currentTerm, settings.currentYear);
  const students = getAccessibleStudents().filter(s => s.classId === classId);
  if (!students.length) { wrap.innerHTML = '<p class="empty">No students in this class.</p>'; if (saveBtn) saveBtn.disabled = true; return; }
  if (dayType !== 'open') {
    const rec = calendarRecord(settings.currentTerm, settings.currentYear, date) || {};
    wrap.innerHTML = `<div class="attendance-non-school-day"><strong>${calendarLabel(dayType)}</strong><span>${escapeHtml(rec.note || 'No attendance is recorded for this date.')}</span></div>`;
    if (saveBtn) saveBtn.disabled = true;
    return;
  }
  if (saveBtn) saveBtn.disabled = false;
  const key = attendanceKey(classId, settings.currentTerm, settings.currentYear, date);
  const all = DB.get(KEYS.attendance, {});
  const record = all[key] || {};
  const entries = record.entries || record;
  const summary = attendanceSummary(classId, settings.currentTerm, settings.currentYear).summary;
  const averageRatio = averageAttendanceRatio(summary, timesOpen);

  let html = attendanceSummaryHeader('Average Pupil Attendance Ratio', timesOpen, averageRatio);
  html += `<div class="attendance-toolbar"><button type="button" id="attendanceAllPresent" class="btn-text">Mark All Present</button><button type="button" id="attendanceAllAbsent" class="btn-text">Mark All Absent</button><button type="button" id="attendanceUnmarkAll" class="btn-text">Unmark All</button></div>`;
  html += '<div class="table-scroll"><table class="grades-table attendance-table"><thead><tr><th class="name-col">Student</th><th>Status</th><th>Present</th><th>Late</th><th>Total</th><th>Absent</th><th>Attendance Ratio</th></tr></thead><tbody>';
  students.forEach(st => {
    const status = String(entries[st.id] || '').toUpperCase();
    const sm = summary[st.id] || { present: 0, absent: 0, late: 0, total: 0 };
    html += `<tr><td class="name-col">${escapeHtml(st.name)}</td><td><select class="attendance-status" data-student="${st.id}">
      <option value="" ${!status ? 'selected' : ''}>— Not marked —</option>
      <option value="P" ${status === 'P' ? 'selected' : ''}>Present</option>
      <option value="A" ${status === 'A' ? 'selected' : ''}>Absent</option>
      <option value="L" ${status === 'L' ? 'selected' : ''}>Late</option>
    </select></td><td>${sm.present}</td><td>${sm.late}</td><td><strong>${sm.total}</strong></td><td>${sm.absent}</td><td><strong>${formatAttendanceRatio(attendanceRatio(sm, timesOpen))}</strong></td></tr>`;
  });
  html += '</tbody></table></div>';
  html += `<p class="hint">${attendanceRecordsForTerm(classId, settings.currentTerm, settings.currentYear).filter(r => attendanceDayType(settings.currentTerm, settings.currentYear, r.date) === 'open').length} open-school attendance day(s) recorded for ${escapeHtml(settings.currentTerm)} ${escapeHtml(settings.currentYear)}. Times Open is ${timesOpen || 0} day(s), excluding weekends, holidays and midterm.</p>`;
  wrap.innerHTML = html;
  document.getElementById('attendanceAllPresent').addEventListener('click', () => wrap.querySelectorAll('.attendance-status').forEach(s => s.value = 'P'));
  document.getElementById('attendanceAllAbsent').addEventListener('click', () => wrap.querySelectorAll('.attendance-status').forEach(s => s.value = 'A'));
  document.getElementById('attendanceUnmarkAll').addEventListener('click', () => wrap.querySelectorAll('.attendance-status').forEach(s => s.value = ''));
}

function renderTeacherAttendanceForm() {
  const wrap = document.getElementById('teacherAttendanceFormWrap');
  const saveBtn = document.getElementById('saveTeacherAttendanceBtn');
  if (!wrap) return;
  if (!isHeadTeacher()) { wrap.innerHTML = '<p class="empty">Only the Head Teacher can access teacher attendance.</p>'; if (saveBtn) saveBtn.disabled = true; return; }
  const settings = DB.get(KEYS.settings, {});
  if (!settings.currentTerm || !settings.currentYear) { wrap.innerHTML = '<p class="empty">Set the current Term and Academic Year in Setup first.</p>'; if (saveBtn) saveBtn.disabled = true; return; }
  const date = document.getElementById('teacherAttendanceDate').value || attendanceDateToday();
  document.getElementById('teacherAttendanceDate').value = date;
  const dayType = attendanceDayType(settings.currentTerm, settings.currentYear, date);
  const timesOpen = calculateTimesOpen(settings.currentTerm, settings.currentYear);
  const teachers = DB.get(KEYS.staff, []).filter(isTeacherStaffRecord);
  if (!teachers.length) { wrap.innerHTML = '<p class="empty">No teachers have been added to Staff yet.</p>'; if (saveBtn) saveBtn.disabled = true; return; }
  if (dayType !== 'open') {
    const rec = calendarRecord(settings.currentTerm, settings.currentYear, date) || {};
    wrap.innerHTML = `<div class="attendance-non-school-day"><strong>${calendarLabel(dayType)}</strong><span>${escapeHtml(rec.note || 'No teacher attendance is recorded for this date.')}</span></div>`;
    if (saveBtn) saveBtn.disabled = true;
    return;
  }
  if (saveBtn) saveBtn.disabled = false;
  const key = teacherAttendanceKey(settings.currentTerm, settings.currentYear, date);
  const record = DB.get(KEYS.teacherAttendance, {})[key] || {};
  const entries = record.entries || record;
  const summary = teacherAttendanceSummary(settings.currentTerm, settings.currentYear).summary;
  const averageRatio = averageAttendanceRatio(summary, timesOpen, true);
  let html = attendanceSummaryHeader('Average Teacher Attendance Ratio', timesOpen, averageRatio);
  html += `<div class="attendance-toolbar"><button type="button" id="teacherAttendanceAllPresent" class="btn-text">Mark All Present</button><button type="button" id="teacherAttendanceAllAbsent" class="btn-text">Mark All Absent</button></div>`;
  html += '<div class="table-scroll"><table class="grades-table attendance-table"><thead><tr><th class="name-col">Teacher</th><th>Status</th><th>Present</th><th>Late</th><th>Total</th><th>Absent</th><th>Excused</th><th>Leave</th><th>Attendance Ratio</th></tr></thead><tbody>';
  teachers.forEach(st => {
    const status = String(entries[st.id] || '').toUpperCase();
    const sm = summary[st.id] || { present: 0, absent: 0, late: 0, total: 0, excused: 0, leave: 0 };
    html += `<tr><td class="name-col">${escapeHtml(st.name)}</td><td><select class="teacher-attendance-status" data-staff="${st.id}">
      <option value="" ${!status ? 'selected' : ''}>— Not marked —</option>
      <option value="P" ${status === 'P' ? 'selected' : ''}>Present</option>
      <option value="A" ${status === 'A' ? 'selected' : ''}>Absent</option>
      <option value="L" ${status === 'L' ? 'selected' : ''}>Late</option>
      <option value="E" ${status === 'E' ? 'selected' : ''}>Excused</option>
      <option value="O" ${status === 'O' ? 'selected' : ''}>On Leave</option>
    </select></td><td>${sm.present}</td><td>${sm.late}</td><td><strong>${sm.total}</strong></td><td>${sm.absent}</td><td>${sm.excused}</td><td>${sm.leave}</td><td><strong>${formatAttendanceRatio(attendanceRatio(sm, timesOpen, true))}</strong></td></tr>`;
  });
  html += '</tbody></table></div>';
  html += `<p class="hint">${teacherAttendanceRecordsForTerm(settings.currentTerm, settings.currentYear).filter(r => attendanceDayType(settings.currentTerm, settings.currentYear, r.date) === 'open').length} open-school teacher attendance day(s) recorded for ${escapeHtml(settings.currentTerm)} ${escapeHtml(settings.currentYear)}. Times Open is ${timesOpen || 0} day(s), excluding weekends, holidays and midterm.</p>`;
  wrap.innerHTML = html;
  document.getElementById('teacherAttendanceAllPresent').addEventListener('click', () => wrap.querySelectorAll('.teacher-attendance-status').forEach(s => s.value = 'P'));
  document.getElementById('teacherAttendanceAllAbsent').addEventListener('click', () => wrap.querySelectorAll('.teacher-attendance-status').forEach(s => s.value = 'A'));
}

let editingSchoolCalendarDate = null;

function renderSchoolCalendar() {
  const wrap = document.getElementById('schoolCalendarWrap');
  if (!wrap) return;
  const settings = DB.get(KEYS.settings, {});
  const term = settings.currentTerm || 'Term 1';
  const year = settings.currentYear || '';
  const dates = getTermDates(term, year);
  const records = schoolCalendarRecordsForTerm(term, year);
  const timesOpen = calculateTimesOpen(term, year);
  const holidays = records.filter(x => String(x.record.type).toLowerCase() === 'holiday').length;
  const midterms = records.filter(x => String(x.record.type).toLowerCase() === 'midterm').length;
  let html = `<div class="attendance-summary-pills"><div class="attendance-summary-pill"><span>Times Open</span><strong>${timesOpen || 0} day${timesOpen === 1 ? '' : 's'}</strong></div><div class="attendance-summary-pill"><span>Holidays</span><strong>${holidays}</strong></div><div class="attendance-summary-pill"><span>Midterm</span><strong>${midterms}</strong></div></div>`;
  html += `<div class="calendar-editor"><h3>School Calendar</h3><p class="hint">${dates ? `Current term: ${escapeHtml(term)} ${escapeHtml(year)} · ${escapeHtml(dates.start)} to ${escapeHtml(dates.end)}` : 'Set the Term Opens and Term Closes dates in Setup first.'}</p>`;
  html += '<div class="row"><label>Date<input type="date" id="calendarDate"></label><label>Day Type<select id="calendarType"><option value="open">School Open</option><option value="holiday">Holiday</option><option value="midterm">Midterm</option></select></label></div>';
  html += '<label>Note / Occasion (optional)<input type="text" id="calendarNote" placeholder="e.g. Independence Day / Midterm Break"></label>';
  html += '<div class="attendance-toolbar"><button type="button" id="saveCalendarDay" class="btn-primary">Save Calendar Day</button><button type="button" id="clearCalendarDay" class="btn-text">Clear / Set School Open</button></div></div>';
  html += '<div class="table-scroll"><table class="grades-table attendance-table"><thead><tr><th>Date</th><th>Day</th><th>Type</th><th>Note</th><th>Action</th></tr></thead><tbody>';
  if (!records.length) html += '<tr><td colspan="5" class="empty">No holidays or midterm days have been added for this term.</td></tr>';
  records.forEach(x => {
    const d = parseDateOnly(x.date);
    const day = d ? d.toLocaleDateString(undefined, {weekday:'short'}) : '';
    html += `<tr><td>${escapeHtml(x.date)}</td><td>${escapeHtml(day)}</td><td>${escapeHtml(calendarLabel(String(x.record.type || '').toLowerCase()))}</td><td>${escapeHtml(x.record.note || '')}</td><td><div class="calendar-row-actions"><button type="button" class="calendar-edit" data-date="${escapeHtml(x.date)}">Edit</button><button type="button" class="calendar-delete" data-date="${escapeHtml(x.date)}">Remove</button></div></td></tr>`;
  });
  html += '</tbody></table></div>';
  html += '<p class="hint">Only weekdays inside the term count toward Times Open. Holiday and Midterm days are excluded. Weekends are automatically excluded.</p>';
  wrap.innerHTML = html;
  const canEdit = isHeadTeacher();
  ['calendarDate','calendarType','calendarNote','saveCalendarDay','clearCalendarDay'].forEach(id => { const el=document.getElementById(id); if(el) el.disabled=!canEdit; });
  document.querySelectorAll('.calendar-edit').forEach(btn => btn.addEventListener('click', () => {
    const originalDate = btn.dataset.date;
    const rec = calendarRecord(term, year, originalDate) || {};
    editingSchoolCalendarDate = originalDate;
    document.getElementById('calendarDate').value = originalDate;
    document.getElementById('calendarType').value = rec.type || 'holiday';
    document.getElementById('calendarNote').value = rec.note || '';
    const saveBtn = document.getElementById('saveCalendarDay');
    if (saveBtn) saveBtn.textContent = 'Update Calendar Day';
  }));
  document.querySelectorAll('.calendar-delete').forEach(btn => btn.addEventListener('click', async () => {
    if (!requireHeadTeacher('change the school calendar')) return;
    const key = calendarKey(term, year, btn.dataset.date);
    try {
      if (FIREBASE_ENABLED && currentSchoolId) {
        if (cloudHydrationInProgress || !sessionDataReady) throw new Error('School data is still synchronizing.');
        await schoolCalendarRef(key).delete();
        setLastSyncedNow();
      }
      const all = DB.get(KEYS.schoolCalendar, {});
      delete all[key];
      DB.set(KEYS.schoolCalendar, all, {skipCloudSync:true});
      auditAction('delete', 'schoolCalendar', key, `Removed calendar exception for ${btn.dataset.date}`);
      refreshAttendanceAfterCalendarChange();
    } catch (error) {
      alert('The calendar day was NOT removed. Existing data has been left unchanged.\n\n' + (error.message || error));
    }
  }));
  document.getElementById('saveCalendarDay').addEventListener('click', async () => {
    if (!requireHeadTeacher('change the school calendar')) return;
    const date = document.getElementById('calendarDate').value;
    const type = document.getElementById('calendarType').value;
    const note = document.getElementById('calendarNote').value.trim();
    if (!date) { alert('Select a calendar date.'); return; }
    const dates = getTermDates(term, year);
    if (dates && (date < dates.start || date > dates.end)) { alert('The calendar date must be inside the current term dates.'); return; }
    if (!isWeekdayDate(parseDateOnly(date))) { alert('This school calendar is for weekdays. Weekends are automatically excluded from Times Open.'); return; }
    const all = DB.get(KEYS.schoolCalendar, {});
    const key = calendarKey(term, year, date);
    const originalDate = editingSchoolCalendarDate;
    const originalKey = originalDate ? calendarKey(term, year, originalDate) : '';
    const dateChanged = !!originalKey && originalKey !== key;
    try {
      if (FIREBASE_ENABLED && currentSchoolId) {
        if (cloudHydrationInProgress || !sessionDataReady) throw new Error('School data is still synchronizing.');
        if (dateChanged) {
          const batch = firebase.firestore().batch();
          if (type !== 'open') {
            batch.set(schoolCalendarRef(key), { term, year, date, type, note, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
          } else {
            batch.delete(schoolCalendarRef(key));
          }
          batch.delete(schoolCalendarRef(originalKey));
          await batch.commit();
        } else if (type === 'open') {
          await schoolCalendarRef(key).delete();
        } else {
          await schoolCalendarRef(key).set({ term, year, date, type, note, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
        }
        setLastSyncedNow();
      }
      if (dateChanged) delete all[originalKey];
      if (type === 'open') delete all[key];
      else all[key] = { term, year, date, type, note, updatedAt: new Date().toISOString() };
      DB.set(KEYS.schoolCalendar, all, {skipCloudSync:true});
      const action = originalDate ? 'update' : (type === 'open' ? 'delete' : 'create');
      const summary = originalDate && originalDate !== date
        ? `Moved calendar exception ${originalDate} → ${date} · ${calendarLabel(type)}${note ? ` · ${note}` : ''}`
        : `Set ${date} as ${calendarLabel(type)}${note ? ` · ${note}` : ''}`;
      auditAction(action, 'schoolCalendar', key, summary);
      editingSchoolCalendarDate = null;
      refreshAttendanceAfterCalendarChange();
      alert(`School calendar updated: ${date} · ${calendarLabel(type)}.`);
    } catch (error) {
      alert('The school calendar was NOT changed. Existing data has been left unchanged.\n\n' + (error.message || error));
    }
  });
  document.getElementById('clearCalendarDay').addEventListener('click', async () => {
    if (!requireHeadTeacher('change the school calendar')) return;
    const date = document.getElementById('calendarDate').value;
    if (!date) { alert('Select a calendar date.'); return; }
    const key = calendarKey(term, year, date);
    try {
      if (FIREBASE_ENABLED && currentSchoolId) {
        if (cloudHydrationInProgress || !sessionDataReady) throw new Error('School data is still synchronizing.');
        await schoolCalendarRef(key).delete();
        setLastSyncedNow();
      }
      const all = DB.get(KEYS.schoolCalendar, {});
      delete all[key];
      DB.set(KEYS.schoolCalendar, all, {skipCloudSync:true});
      auditAction('delete', 'schoolCalendar', key, `Set ${date} as School Open`);
      refreshAttendanceAfterCalendarChange();
    } catch (error) {
      alert('The calendar day was NOT cleared. Existing data has been left unchanged.\n\n' + (error.message || error));
    }
  });
}

function attendanceSummaryClassStats(classId, term, year, timesOpen) {
  const students = getAccessibleStudents().filter(s => s.classId === classId);
  const result = { pupils: students.length, present: 0, late: 0, total: 0, absent: 0, averageRatio: null };
  const smap = attendanceSummary(classId, term, year).summary;
  const ratios = [];
  students.forEach(st => {
    const sm = smap[st.id] || { present: 0, late: 0, total: 0, absent: 0 };
    result.present += Number(sm.present || 0);
    result.late += Number(sm.late || 0);
    result.total += Number(sm.total || 0);
    result.absent += Number(sm.absent || 0);
    const ratio = attendanceRatio(sm, timesOpen, false);
    if (Number.isFinite(ratio)) ratios.push(ratio);
  });
  result.averageRatio = ratios.length ? ratios.reduce((a,b) => a+b, 0) / ratios.length : null;
  return result;
}

function attendanceReportOverallStudent(term, year, timesOpen) {
  const classes = getAccessibleClasses();
  let pupils = 0, present = 0, late = 0, total = 0, absent = 0;
  const ratios = [];
  classes.forEach(c => {
    const x = attendanceSummaryClassStats(c.id, term, year, timesOpen);
    pupils += x.pupils; present += x.present; late += x.late; total += x.total; absent += x.absent;
    if (Number.isFinite(x.averageRatio)) ratios.push(x.averageRatio);
  });
  return { pupils, present, late, total, absent, averageRatio: ratios.length ? ratios.reduce((a,b)=>a+b,0)/ratios.length : null };
}

function attendanceReportOverallTeacher(term, year, timesOpen) {
  const teachers = DB.get(KEYS.staff, []).filter(isTeacherStaffRecord);
  const smap = teacherAttendanceSummary(term, year).summary;
  let present = 0, late = 0, total = 0, absent = 0, excused = 0, leave = 0;
  const ratios = [];
  teachers.forEach(st => {
    const sm = smap[st.id] || { present:0, late:0, total:0, absent:0, excused:0, leave:0 };
    present += Number(sm.present || 0); late += Number(sm.late || 0); total += Number(sm.total || 0);
    absent += Number(sm.absent || 0); excused += Number(sm.excused || 0); leave += Number(sm.leave || 0);
    const ratio = attendanceRatio(sm, timesOpen, true);
    if (Number.isFinite(ratio)) ratios.push(ratio);
  });
  return { teachers: teachers.length, present, late, total, absent, excused, leave, averageRatio: ratios.length ? ratios.reduce((a,b)=>a+b,0)/ratios.length : null };
}

function attendanceSummaryPrintHtml() {
  const settings = DB.get(KEYS.settings, {});
  const term = settings.currentTerm || 'Term 1';
  const year = settings.currentYear || '';
  const timesOpen = calculateTimesOpen(term, year);
  const calendar = schoolCalendarRecordsForTerm(term, year);
  const holidays = calendar.filter(x => String(x.record.type || '').toLowerCase() === 'holiday').length;
  const midterms = calendar.filter(x => String(x.record.type || '').toLowerCase() === 'midterm').length;
  const school = DB.get(KEYS.settings, {}).schoolName || 'School';
  const students = attendanceReportOverallStudent(term, year, timesOpen);
  const teachers = attendanceReportOverallTeacher(term, year, timesOpen);
  const classes = getAccessibleClasses();
  const staff = DB.get(KEYS.staff, []).filter(isTeacherStaffRecord);
  const teacherMap = teacherAttendanceSummary(term, year).summary;

  const esc = escapeHtml;
  let html = `<div class="attendance-print-report"><div class="attendance-report-heading"><h2>${esc(school)}</h2><h3>Attendance Summary Report</h3><p>${esc(term)} ${esc(year)}${timesOpen ? ` · Times Open: ${timesOpen} days` : ''}</p></div>`;
  html += `<div class="attendance-report-cards"><div><span>Times Open</span><strong>${timesOpen} days</strong></div><div><span>Holidays</span><strong>${holidays}</strong></div><div><span>Midterm</span><strong>${midterms}</strong></div><div><span>Pupils</span><strong>${students.pupils}</strong></div><div><span>Avg Pupil Ratio</span><strong>${formatAttendanceRatio(students.averageRatio)}</strong></div><div><span>Teachers</span><strong>${teachers.teachers}</strong></div><div><span>Avg Teacher Ratio</span><strong>${formatAttendanceRatio(teachers.averageRatio)}</strong></div></div>`;

  html += '<h3 class="attendance-report-section-title">Class Attendance</h3><div class="table-scroll"><table class="grades-table attendance-report-table"><thead><tr><th>Class</th><th>Pupils</th><th>Present</th><th>Late</th><th>Total</th><th>Absent</th><th>Average Ratio</th></tr></thead><tbody>';
  if (!classes.length) html += '<tr><td colspan="7" class="empty">No accessible classes.</td></tr>';
  classes.forEach(c => { const x=attendanceSummaryClassStats(c.id,term,year,timesOpen); html += `<tr><td>${esc(c.name)}</td><td>${x.pupils}</td><td>${x.present}</td><td>${x.late}</td><td><strong>${x.total}</strong></td><td>${x.absent}</td><td><strong>${formatAttendanceRatio(x.averageRatio)}</strong></td></tr>`; });
  html += '</tbody></table></div>';

  if (isHeadTeacher()) {
    html += '<h3 class="attendance-report-section-title">Teacher Attendance</h3><div class="table-scroll"><table class="grades-table attendance-report-table"><thead><tr><th>Teacher</th><th>Role</th><th>Present</th><th>Late</th><th>Total</th><th>Absent</th><th>Excused</th><th>Leave</th><th>Ratio</th></tr></thead><tbody>';
    if (!staff.length) html += '<tr><td colspan="9" class="empty">No teaching staff.</td></tr>';
    staff.forEach(st => { const sm=teacherMap[st.id] || {present:0,late:0,total:0,absent:0,excused:0,leave:0}; html += `<tr><td>${esc(st.name)}</td><td>${esc(st.role || 'Teacher')}</td><td>${sm.present}</td><td>${sm.late}</td><td><strong>${sm.total}</strong></td><td>${sm.absent}</td><td>${sm.excused}</td><td>${sm.leave}</td><td><strong>${formatAttendanceRatio(attendanceRatio(sm,timesOpen,true))}</strong></td></tr>`; });
    html += '</tbody></table></div>';
  }

  html += '<h3 class="attendance-report-section-title">School Calendar Exceptions</h3><div class="table-scroll"><table class="grades-table attendance-report-table"><thead><tr><th>Date</th><th>Day</th><th>Type</th><th>Note</th></tr></thead><tbody>';
  if (!calendar.filter(x => String(x.record.type || '').toLowerCase() !== 'open').length) html += '<tr><td colspan="4" class="empty">No holidays or midterm days recorded.</td></tr>';
  calendar.filter(x => String(x.record.type || '').toLowerCase() !== 'open').forEach(x => { const d=parseDateOnly(x.date); const day=d?d.toLocaleDateString(undefined,{weekday:'short'}):''; html += `<tr><td>${esc(x.date)}</td><td>${esc(day)}</td><td>${esc(calendarLabel(String(x.record.type||'').toLowerCase()))}</td><td>${esc(x.record.note||'')}</td></tr>`; });
  html += '</tbody></table></div><p class="attendance-report-footnote">Generated from SchoolHub attendance records. Late counts as attendance. Holidays, midterm days and weekends are excluded from Times Open.</p></div>';
  return html;
}


function attendanceCompletionForDate(term, year, date) {
  const parsedDate = parseDateOnly(date);
  let dayType = attendanceDayType(term, year, date);
  const termDates = getTermDates(term, year);
  if (parsedDate && !isWeekdayDate(parsedDate)) dayType = 'weekend';
  else if (termDates) {
    const ts = parseDateOnly(termDates.start);
    const te = parseDateOnly(termDates.end);
    if (ts && te && (parsedDate < ts || parsedDate > te)) dayType = 'outside';
  }
  const result = {
    date,
    dayType,
    student: { total: 0, full: 0, partial: 0, missing: 0, marked: 0, students: 0 },
    teacher: { total: 0, full: 0, partial: 0, missing: 0, marked: 0, teachers: 0 }
  };
  if (result.dayType !== 'open') return result;

  const attendance = DB.get(KEYS.attendance, {});
  const classes = getAccessibleClasses();
  classes.forEach(c => {
    const students = getAccessibleStudents().filter(st => st.classId === c.id);
    if (!students.length) return;
    result.student.total++;
    result.student.students += students.length;
    const key = attendanceKey(c.id, term, year, date);
    const record = attendance[key] || {};
    const entries = record.entries || record;
    const marked = students.filter(st => String(entries && entries[st.id] || '').trim() !== '').length;
    result.student.marked += marked;
    if (marked === students.length) result.student.full++;
    else if (marked > 0) result.student.partial++;
    else result.student.missing++;
  });

  if (isHeadTeacher()) {
    const teachers = DB.get(KEYS.staff, []).filter(isTeacherStaffRecord);
    result.teacher.total = teachers.length ? 1 : 0;
    result.teacher.teachers = teachers.length;
    if (teachers.length) {
      const key = teacherAttendanceKey(term, year, date);
      const record = DB.get(KEYS.teacherAttendance, {})[key] || {};
      const entries = record.entries || record;
      const marked = teachers.filter(st => String(entries && entries[st.id] || '').trim() !== '').length;
      result.teacher.marked = marked;
      if (marked === teachers.length) result.teacher.full = 1;
      else if (marked > 0) result.teacher.partial = 1;
      else result.teacher.missing = 1;
    }
  }
  return result;
}

function attendanceCompletionTermSummary(term, year) {
  const result = {
    openDaysElapsed: calculateTimesOpen(term, year),
    student: { recordedDays: 0, fullyRecordedDays: 0, totalClassDays: 0, fullClassDays: 0, partialClassDays: 0, missingClassDays: 0 },
    teacher: { recordedDays: 0, fullyRecordedDays: 0 }
  };
  const dates = getTermDates(term, year);
  if (!dates) return result;
  const start = parseDateOnly(dates.start), end = parseDateOnly(dates.end);
  if (!start || !end) return result;
  let limit = end;
  const today = parseDateOnly(new Date());
  if (today && today < limit && today >= start) limit = today;
  if (!today || today < start) return result;

  for (let d = new Date(start); d <= limit; d = addDaysDateOnly(d, 1)) {
    if (!isWeekdayDate(d)) continue;
    const date = dateOnlyString(d);
    if (attendanceDayType(term, year, date) !== 'open') continue;
    const day = attendanceCompletionForDate(term, year, date);
    if (day.student.total) {
      result.student.totalClassDays += day.student.total;
      result.student.fullClassDays += day.student.full;
      result.student.partialClassDays += day.student.partial;
      result.student.missingClassDays += day.student.missing;
      if (day.student.full > 0) result.student.recordedDays++;
      if (day.student.full === day.student.total) result.student.fullyRecordedDays++;
    }
    if (isHeadTeacher() && day.teacher.total) {
      if (day.teacher.full) result.teacher.recordedDays++;
      if (day.teacher.full === day.teacher.total) result.teacher.fullyRecordedDays++;
    }
  }
  return result;
}

function attendanceCompletionBadge(state) {
  if (state === 'complete') return '<span class="attendance-completion-badge complete">Complete</span>';
  if (state === 'partial') return '<span class="attendance-completion-badge partial">Partial</span>';
  return '<span class="attendance-completion-badge missing">Not recorded</span>';
}


function openSchoolDatesForTerm(term, year) {
  const dates = getTermDates(term, year);
  if (!dates) return [];
  const start = parseDateOnly(dates.start), end = parseDateOnly(dates.end);
  if (!start || !end || start > end) return [];
  const exceptions = new Map(schoolCalendarRecordsForTerm(term, year).map(x => [x.date, String(x.record.type || '').toLowerCase()]));
  const out = [];
  for (let d = new Date(start); d <= end; d = addDaysDateOnly(d, 1)) {
    if (!isWeekdayDate(d)) continue;
    const key = dateOnlyString(d);
    const type = exceptions.get(key);
    if (type === 'holiday' || type === 'midterm') continue;
    const today = parseDateOnly(attendanceDateToday());
    if (today && d > today) continue;
    out.push(key);
  }
  return out;
}

function studentAttendanceAnalysis(classId, term, year, timesOpen) {
  const students = getAccessibleStudents().filter(s => !classId || s.classId === classId);
  const classes = {};
  const byId = {};
  getAccessibleClasses().forEach(c => { classes[c.id] = c.name; });
  const summary = {};
  students.forEach(st => {
    const sm = { present: 0, late: 0, total: 0, absent: 0, recorded: 0, currentAbsenceStreak: 0, longestAbsenceStreak: 0 };
    const records = attendanceRecordsForTerm(st.classId, term, year);
    const statusByDate = {};
    records.forEach(({date, record}) => {
      if (attendanceDayType(term, year, date) !== 'open') return;
      const entries = record.entries || record;
      const status = String(entries && entries[st.id] || '').toUpperCase();
      if (status) statusByDate[date] = status;
      if (status === 'P') sm.present++;
      else if (status === 'L') sm.late++;
      else if (status === 'A') sm.absent++;
      if (status) sm.recorded++;
    });
    sm.total = sm.present + sm.late;
    const openDates = openSchoolDatesForTerm(term, year).filter(d => statusByDate[d]);
    let run = 0;
    openDates.forEach(d => {
      if (statusByDate[d] === 'A') { run++; sm.longestAbsenceStreak = Math.max(sm.longestAbsenceStreak, run); }
      else run = 0;
    });
    for (let i = openDates.length - 1; i >= 0; i--) {
      if (statusByDate[openDates[i]] === 'A') sm.currentAbsenceStreak++;
      else break;
    }
    sm.ratio = attendanceRatio(sm, timesOpen, false);
    sm.className = classes[st.classId] || st.classId || '';
    byId[st.id] = sm;
    summary[st.id] = sm;
  });
  return { students, summary: byId };
}

function teacherAttendanceAnalysis(term, year, timesOpen) {
  const teachers = DB.get(KEYS.staff, []).filter(isTeacherStaffRecord);
  const records = teacherAttendanceRecordsForTerm(term, year);
  const openDates = openSchoolDatesForTerm(term, year);
  const summary = {};
  teachers.forEach(st => {
    const sm = { present:0, late:0, total:0, absent:0, excused:0, leave:0, recorded:0, currentAbsenceStreak:0, longestAbsenceStreak:0 };
    const statusByDate = {};
    records.forEach(({date, record}) => {
      if (attendanceDayType(term, year, date) !== 'open') return;
      const entries = record.entries || record;
      const status = String(entries && entries[st.id] || '').toUpperCase();
      if (status) statusByDate[date] = status;
      if (status) sm.recorded++;
      if (status === 'P') sm.present++;
      else if (status === 'L') sm.late++;
      else if (status === 'A') sm.absent++;
      else if (status === 'E') sm.excused++;
      else if (status === 'O') sm.leave++;
    });
    sm.total = sm.present + sm.late;
    let run = 0;
    openDates.filter(d => statusByDate[d]).forEach(d => {
      if (statusByDate[d] === 'A') { run++; sm.longestAbsenceStreak = Math.max(sm.longestAbsenceStreak, run); }
      else run = 0;
    });
    for (let i = openDates.length - 1; i >= 0; i--) {
      if (statusByDate[openDates[i]] === 'A') sm.currentAbsenceStreak++;
      else break;
    }
    sm.ratio = attendanceRatio(sm, timesOpen, true);
    summary[st.id] = sm;
  });
  return { teachers, summary };
}

function attendanceAnalyticsBuild(term, year, timesOpen) {
  /*
   * v38.9 UNIFIED ATTENDANCE ENGINE
   * ---------------------------------
   * Analytics must consume the same authoritative summaries used by the
   * Attendance and Reports tabs. The previous v38.8 implementation rebuilt
   * pupil totals from a separate class-map path. That path could disagree
   * with attendanceSummary(), producing 0% analytics while Reports showed
   * the correct attendance.
   */
  const classes = getAccessibleClasses();
  const students = getAccessibleStudents();
  const openDates = attendanceOpenDates(term, year);

  // Build one authoritative pupil summary per class, then enrich each pupil
  // with history-derived streaks. Totals, recorded marks and ratios all come
  // from attendanceSummary()/attendanceRatio().
  const classSummaryMaps = {};
  classes.forEach(c => {
    classSummaryMaps[c.id] = attendanceSummary(c.id, term, year).summary || {};
  });

  const pupilRows = students.map(st => {
    const base = classSummaryMaps[st.classId] && classSummaryMaps[st.classId][st.id]
      ? classSummaryMaps[st.classId][st.id]
      : { present: 0, late: 0, absent: 0, total: 0, recorded: 0 };

    const sm = {
      present: Number(base.present || 0),
      late: Number(base.late || 0),
      absent: Number(base.absent || 0),
      total: Number(base.total || 0),
      recorded: Number(base.recorded || 0)
    };
    sm.ratio = attendanceRatio(sm, timesOpen, false);
    sm.completion = timesOpen > 0 ? Math.min(100, (sm.recorded / timesOpen) * 100) : null;

    const history = attendanceReportPupilHistory(st, term, year);
    let current = 0, longest = 0, run = 0;
    history.forEach(r => {
      if (r.status === 'A') {
        run++;
        longest = Math.max(longest, run);
      } else {
        run = 0;
      }
    });
    current = run;
    sm.currentAbsenceStreak = current;
    sm.longestAbsenceStreak = longest;

    return { student: st, summary: sm };
  });

  // Teacher totals are already authoritative through teacherAttendanceSummary().
  const teacherData = teacherAttendanceAnalysis(term, year, timesOpen);
  const teacherRows = teacherData.teachers.map(st => ({
    staff: st,
    summary: teacherData.summary[st.id] || {
      present: 0, late: 0, total: 0, absent: 0,
      excused: 0, leave: 0, recorded: 0,
      ratio: null, currentAbsenceStreak: 0, longestAbsenceStreak: 0
    }
  }));

  // Daily figures use the same attendance status source as the daily
  // Attendance screen, while the term totals above use the canonical summary.
  const daily = openDates.map(date => {
    let pupilExpected = students.length;
    let pupilMarked = 0, pupilAttended = 0, pupilAbsent = 0, pupilLate = 0;

    students.forEach(st => {
      const status = attendanceStatusCodeForStudent(st.classId, term, year, date, st.id);
      if (status) pupilMarked++;
      if (status === 'P') pupilAttended++;
      else if (status === 'L') { pupilAttended++; pupilLate++; }
      else if (status === 'A') pupilAbsent++;
    });

    let teacherExpected = isHeadTeacher() ? teacherRows.length : 0;
    let teacherMarked = 0, teacherAttended = 0, teacherAbsent = 0, teacherLate = 0;
    if (isHeadTeacher()) {
      teacherRows.forEach(({ staff }) => {
        const status = attendanceStatusCodeForTeacher(term, year, date, staff.id);
        if (status) teacherMarked++;
        if (status === 'P') teacherAttended++;
        else if (status === 'L') { teacherAttended++; teacherLate++; }
        else if (status === 'A') teacherAbsent++;
      });
    }

    return {
      date,
      pupilExpected,
      pupilMarked,
      pupilAttended,
      pupilAbsent,
      pupilLate,
      pupilCompletion: pupilExpected ? (pupilMarked / pupilExpected) * 100 : null,
      pupilRate: pupilExpected ? (pupilAttended / pupilExpected) * 100 : null,
      teacherExpected,
      teacherMarked,
      teacherAttended,
      teacherAbsent,
      teacherLate,
      teacherCompletion: teacherExpected ? (teacherMarked / teacherExpected) * 100 : null,
      teacherRate: teacherExpected ? (teacherAttended / teacherExpected) * 100 : null
    };
  });

  // School-level attendance rate is total attended marks divided by total
  // expected marks. Completion is recorded marks divided by expected marks.
  const pupilAttended = pupilRows.reduce((n, x) => n + Number(x.summary.total || 0), 0);
  const pupilAbsent = pupilRows.reduce((n, x) => n + Number(x.summary.absent || 0), 0);
  const pupilLate = pupilRows.reduce((n, x) => n + Number(x.summary.late || 0), 0);
  const pupilRecorded = pupilRows.reduce((n, x) => n + Number(x.summary.recorded || 0), 0);
  const pupilExpected = students.length * Number(timesOpen || 0);
  const pupilCompletion = pupilExpected > 0 ? Math.min(100, (pupilRecorded / pupilExpected) * 100) : null;
  const pupilRate = pupilExpected > 0 ? Math.min(100, (pupilAttended / pupilExpected) * 100) : null;

  const teacherAttended = teacherRows.reduce((n, x) => n + Number(x.summary.total || 0), 0);
  const teacherAbsent = teacherRows.reduce((n, x) => n + Number(x.summary.absent || 0), 0);
  const teacherLate = teacherRows.reduce((n, x) => n + Number(x.summary.late || 0), 0);
  const teacherRecorded = teacherRows.reduce((n, x) => n + Number(x.summary.recorded || 0), 0);
  const teacherExpected = teacherRows.reduce((n, x) =>
    n + Math.max(0, Number(timesOpen || 0) - Number(x.summary.excused || 0) - Number(x.summary.leave || 0)), 0);
  const teacherCompletionDenominator = teacherRows.reduce((n, x) =>
    n + Math.max(0, Number(timesOpen || 0) - Number(x.summary.excused || 0) - Number(x.summary.leave || 0)), 0);
  const teacherCompletion = teacherCompletionDenominator > 0
    ? Math.min(100, (teacherRecorded / teacherCompletionDenominator) * 100)
    : null;
  const teacherRate = teacherExpected > 0 ? Math.min(100, (teacherAttended / teacherExpected) * 100) : null;

  const classRows = classes.map(c => {
    const rows = pupilRows.filter(x => x.student.classId === c.id);
    const expected = rows.length * Number(timesOpen || 0);
    const attended = rows.reduce((n, x) => n + Number(x.summary.total || 0), 0);
    const absent = rows.reduce((n, x) => n + Number(x.summary.absent || 0), 0);
    const late = rows.reduce((n, x) => n + Number(x.summary.late || 0), 0);
    const marked = rows.reduce((n, x) => n + Number(x.summary.recorded || 0), 0);
    const ratios = rows.map(x => x.summary.ratio).filter(Number.isFinite);
    return {
      classInfo: c,
      pupils: rows.length,
      expected,
      attended,
      absent,
      late,
      marked,
      completion: expected > 0 ? Math.min(100, (marked / expected) * 100) : null,
      ratio: expected > 0 ? Math.min(100, (attended / expected) * 100) : null,
      averageIndividualRatio: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null
    };
  });

  return {
    classes,
    students,
    teachers: teacherRows,
    pupilRows,
    teacherRows,
    classRows,
    daily,
    pupilRate,
    pupilCompletion,
    pupilAttended,
    pupilAbsent,
    pupilLate,
    teacherRate,
    teacherCompletion,
    teacherAttended,
    teacherAbsent,
    teacherLate,
    openDates
  };
}

function analyticsPercentBar(value, label, cssClass='') {
  const v = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return `<div class="attendance-analytics-bar ${cssClass}"><span style="width:${v.toFixed(1)}%"></span></div><div class="attendance-analytics-bar-label"><span>${escapeHtml(label)}</span><strong>${Number.isFinite(value) ? value.toFixed(1)+'%' : '—'}</strong></div>`;
}

function renderAttendanceAnalysis() {
  const wrap = document.getElementById('attendanceAnalysisWrap');
  if (!wrap) return;
  const settings = DB.get(KEYS.settings, {});
  const term = settings.currentTerm || '';
  const year = settings.currentYear || '';
  if (!term || !year) { wrap.innerHTML = '<p class="empty">Set the current Term and Academic Year in Setup first.</p>'; return; }

  const timesOpen = calculateTimesOpen(term, year);
  const data = attendanceAnalyticsBuild(term, year, timesOpen);
  const threshold = 75;
  const lowPupils = data.pupilRows.filter(x=>Number.isFinite(x.summary.ratio) && x.summary.ratio < threshold).sort((a,b)=>a.summary.ratio-b.summary.ratio);
  const lowTeachers = data.teacherRows.filter(x=>Number.isFinite(x.summary.ratio) && x.summary.ratio < threshold).sort((a,b)=>a.summary.ratio-b.summary.ratio);
  const avgPupil = data.pupilRows.map(x=>x.summary.ratio).filter(Number.isFinite);
  const avgTeacher = data.teacherRows.map(x=>x.summary.ratio).filter(Number.isFinite);
  const avgPupilRatio = avgPupil.length ? avgPupil.reduce((a,b)=>a+b,0)/avgPupil.length : null;
  const avgTeacherRatio = avgTeacher.length ? avgTeacher.reduce((a,b)=>a+b,0)/avgTeacher.length : null;
  const avgCompletion = data.daily.length ? data.daily.reduce((n,d)=>n+(d.pupilCompletion||0),0)/data.daily.length : null;
  const bestClass = data.classRows.filter(x=>Number.isFinite(x.ratio)&&x.pupils).sort((a,b)=>b.ratio-a.ratio)[0];
  const concernClass = data.classRows.filter(x=>Number.isFinite(x.ratio)&&x.pupils).sort((a,b)=>a.ratio-b.ratio)[0];

  let html = `<div class="attendance-analytics-head"><div><h3>Attendance Analytics</h3><p class="hint">${escapeHtml(term)} ${escapeHtml(year)} · ${timesOpen} school-open day${timesOpen===1?'':'s'} · data excludes weekends, holidays and midterm.</p></div></div>`;
  html += `<div class="attendance-analysis-cards"><div><span>Pupil Attendance Rate</span><strong>${formatAttendanceRatio(data.pupilRate)}</strong></div><div><span>Pupil Completion</span><strong>${formatAttendanceRatio(data.pupilCompletion)}</strong></div>${isHeadTeacher()?`<div><span>Teacher Attendance Rate</span><strong>${formatAttendanceRatio(data.teacherRate)}</strong></div><div><span>Teacher Completion</span><strong>${formatAttendanceRatio(data.teacherCompletion)}</strong></div>`:''}<div><span>Total Pupil Absences</span><strong>${data.pupilAbsent}</strong></div><div><span>Total Pupil Late</span><strong>${data.pupilLate}</strong></div>${isHeadTeacher()?`<div><span>Teacher Absences</span><strong>${data.teacherAbsent}</strong></div><div><span>Teacher Late</span><strong>${data.teacherLate}</strong></div>`:''}</div>`;

  html += `<div class="attendance-analytics-grid"><div class="attendance-analytics-panel"><h4>School Performance</h4><p class="hint">Average individual ratios and daily recording completion.</p><div class="attendance-analytics-metric"><span>Average Pupil Ratio</span>${analyticsPercentBar(avgPupilRatio,'Pupils')}</div>${isHeadTeacher()?`<div class="attendance-analytics-metric"><span>Average Teacher Ratio</span>${analyticsPercentBar(avgTeacherRatio,'Teachers')}</div>`:''}<div class="attendance-analytics-metric"><span>Average Pupil Recording Completion</span>${analyticsPercentBar(avgCompletion,'Recorded')}</div>${bestClass?`<div class="attendance-analytics-highlight"><span>Best-performing class</span><strong>${escapeHtml(bestClass.classInfo.name)} · ${formatAttendanceRatio(bestClass.ratio)}</strong></div>`:''}${concernClass&&concernClass!==bestClass?`<div class="attendance-analytics-highlight"><span>Class needing attention</span><strong>${escapeHtml(concernClass.classInfo.name)} · ${formatAttendanceRatio(concernClass.ratio)}</strong></div>`:''}</div>`;
  html += `<div class="attendance-analytics-panel"><h4>Attendance Distribution</h4><div class="attendance-analytics-distribution"><div><strong>${data.pupilAttended}</strong><span>Present + Late</span></div><div><strong>${data.pupilAbsent}</strong><span>Absent</span></div><div><strong>${data.pupilRows.reduce((n,x)=>n+x.summary.recorded,0)}</strong><span>Recorded pupil marks</span></div>${isHeadTeacher()?`<div><strong>${data.teacherAttended}</strong><span>Teacher Present + Late</span></div><div><strong>${data.teacherAbsent}</strong><span>Teacher Absent</span></div>`:''}</div><p class="hint">An unrecorded mark is not treated as Present or Absent, but it reduces the attendance/completion rate.</p></div></div>`;

  html += `<h4 class="attendance-analysis-section-title">Class Comparison</h4><div class="table-scroll"><table class="grades-table attendance-report-table"><thead><tr><th>Class</th><th>Pupils</th><th>Present + Late</th><th>Absent</th><th>Completion</th><th>Attendance Rate</th></tr></thead><tbody>`;
  if(!data.classRows.length) html += '<tr><td colspan="6" class="empty">No classes found.</td></tr>';
  data.classRows.forEach(x=>{html+=`<tr><td>${escapeHtml(x.classInfo.name)}</td><td>${x.pupils}</td><td>${x.attended}</td><td>${x.absent}</td><td>${formatAttendanceRatio(x.completion)}</td><td><strong>${formatAttendanceRatio(x.ratio)}</strong></td></tr>`;});
  html += '</tbody></table></div>';

  html += `<h4 class="attendance-analysis-section-title">Daily Attendance Trend</h4><div class="attendance-analytics-trend">`;
  if(!data.daily.length) html += '<p class="empty">No open-school dates are available for this term.</p>';
  data.daily.forEach(d=>{const day=parseDateOnly(d.date);const label=day?day.toLocaleDateString(undefined,{day:'2-digit',month:'short'}):d.date;html+=`<div class="attendance-analytics-day"><div class="attendance-analytics-day-head"><strong>${escapeHtml(label)}</strong><span>${d.pupilMarked}/${d.pupilExpected} pupils marked</span></div>${analyticsPercentBar(d.pupilRate,'Attendance')}${analyticsPercentBar(d.pupilCompletion,'Completion')}${isHeadTeacher()&&d.teacherExpected?analyticsPercentBar(d.teacherRate,'Teacher attendance'):''}</div>`;});
  html += '</div>';

  html += `<div class="attendance-analytics-grid"><div class="attendance-analytics-panel"><h4>Pupils Requiring Attention</h4><p class="hint">Below ${threshold}% attendance ratio.</p><div class="attendance-analytics-risk-list">`;
  if(!lowPupils.length) html += '<p class="empty">No pupils are below the 75% threshold.</p>';
  lowPupils.slice(0,10).forEach(x=>html+=`<div><span>${escapeHtml(x.student.name)} <small>${escapeHtml((data.classRows.find(c=>c.classInfo.id===x.student.classId)||{}).classInfo?.name||'')}</small></span><strong>${formatAttendanceRatio(x.summary.ratio)}</strong></div>`);
  html += '</div></div>';
  if(isHeadTeacher()) {
    html += `<div class="attendance-analytics-panel"><h4>Teachers Requiring Attention</h4><p class="hint">Below ${threshold}% attendance ratio.</p><div class="attendance-analytics-risk-list">`;
    if(!lowTeachers.length) html += '<p class="empty">No teachers are below the 75% threshold.</p>';
    lowTeachers.slice(0,10).forEach(x=>html+=`<div><span>${escapeHtml(x.staff.name)} <small>${escapeHtml(x.staff.role||'Teacher')}</small></span><strong>${formatAttendanceRatio(x.summary.ratio)}</strong></div>`);
    html += '</div></div>';
  }
  html += '</div>';
  html += `<p class="hint">Analytics uses Present + Late as attendance. Pupil ratios use Times Open as the denominator. Teacher ratios exclude approved Excused and On Leave days from each teacher's denominator. Completion measures whether attendance was actually recorded.</p>`;
  wrap.innerHTML = html;
}

function renderAttendanceSummary() {
  const wrap = document.getElementById('attendanceSummaryWrap');
  if (!wrap) return;
  const settings = DB.get(KEYS.settings, {});
  const term = settings.currentTerm || '';
  const year = settings.currentYear || '';
  if (!term || !year) { wrap.innerHTML = '<p class="empty">Set the current Term and Academic Year in Setup first.</p>'; return; }
  const timesOpen = calculateTimesOpen(term, year);
  const monitoringDate = document.getElementById('attendanceSummaryDate')?.value || attendanceDateToday();
  const completion = attendanceCompletionForDate(term, year, monitoringDate);
  const completionTerm = attendanceCompletionTermSummary(term, year);
  const students = attendanceReportOverallStudent(term, year, timesOpen);
  const teachers = attendanceReportOverallTeacher(term, year, timesOpen);
  const calendar = schoolCalendarRecordsForTerm(term, year);
  const holidays = calendar.filter(x => String(x.record.type || '').toLowerCase() === 'holiday').length;
  const midterms = calendar.filter(x => String(x.record.type || '').toLowerCase() === 'midterm').length;
  let html = `<div class="attendance-dashboard"><div class="attendance-dashboard-head"><div><h3>Attendance Dashboard</h3><p class="hint">${escapeHtml(term)} ${escapeHtml(year)} · completion monitoring</p></div><label>Monitoring Date<input type="date" id="attendanceSummaryDate" value="${escapeHtml(monitoringDate)}"></label></div>`;
  html += `<div class="attendance-dashboard-cards"><div><span>Times Open</span><strong>${timesOpen} days</strong><small>school-open days elapsed</small></div><div><span>Student Attendance Days</span><strong>${completionTerm.student.fullyRecordedDays} / ${timesOpen}</strong><small>fully recorded school days</small></div><div><span>Class Completion</span><strong>${completionTerm.student.fullClassDays} / ${completionTerm.student.totalClassDays || 0}</strong><small>class-days fully recorded</small></div>${isHeadTeacher() ? `<div><span>Teacher Attendance Days</span><strong>${completionTerm.teacher.fullyRecordedDays} / ${timesOpen}</strong><small>fully recorded school days</small></div>` : ''}</div>`;
  if (completion.dayType !== 'open') {
    html += `<div class="attendance-dashboard-alert"><strong>${escapeHtml(calendarLabel(completion.dayType))}</strong><span>No attendance is expected on ${escapeHtml(monitoringDate)}. ${escapeHtml((calendarRecord(term, year, monitoringDate) || {}).note || '')}</span></div>`;
  } else {
    html += `<div class="attendance-completion-grid"><div><h4>Student Attendance Completion</h4><div class="completion-progress"><span style="width:${completion.student.total ? Math.round((completion.student.full / completion.student.total) * 100) : 0}%"></span></div><p><strong>${completion.student.full}</strong> complete · <strong>${completion.student.partial}</strong> partial · <strong>${completion.student.missing}</strong> not recorded of ${completion.student.total} class(es)</p></div>`;
    if (isHeadTeacher()) html += `<div><h4>Teacher Attendance Completion</h4><div class="completion-progress"><span style="width:${completion.teacher.total ? Math.round((completion.teacher.full / completion.teacher.total) * 100) : 0}%"></span></div><p><strong>${completion.teacher.full}</strong> complete · <strong>${completion.teacher.partial}</strong> partial · <strong>${completion.teacher.missing}</strong> not recorded</p></div>`;
    html += '</div>';
    html += '<h4 class="attendance-dashboard-section-title">Daily Class Completion</h4><div class="table-scroll"><table class="grades-table attendance-report-table"><thead><tr><th>Class</th><th>Pupils</th><th>Marked</th><th>Status</th></tr></thead><tbody>';
    const attendanceAll = DB.get(KEYS.attendance, {});
    const dashClasses = getAccessibleClasses();
    if (!dashClasses.length) html += '<tr><td colspan="4" class="empty">No accessible classes.</td></tr>';
    dashClasses.forEach(c => {
      const pupils = getAccessibleStudents().filter(st => st.classId === c.id);
      const rec = attendanceAll[attendanceKey(c.id, term, year)] || {};
      const entries = rec.entries || rec;
      const marked = pupils.filter(st => String(entries && entries[st.id] || '').trim() !== '').length;
      const state = marked === pupils.length && pupils.length ? 'complete' : (marked > 0 ? 'partial' : 'missing');
      html += `<tr><td>${escapeHtml(c.name)}</td><td>${pupils.length}</td><td>${marked} / ${pupils.length}</td><td>${attendanceCompletionBadge(state)}</td></tr>`;
    });
    html += '</tbody></table></div>';
    if (isHeadTeacher()) {
      const teachers = DB.get(KEYS.staff, []).filter(isTeacherStaffRecord);
      const rec = DB.get(KEYS.teacherAttendance, {})[teacherAttendanceKey(term, year, monitoringDate)] || {};
      const entries = rec.entries || rec;
      const marked = teachers.filter(st => String(entries && entries[st.id] || '').trim() !== '').length;
      const state = marked === teachers.length && teachers.length ? 'complete' : (marked > 0 ? 'partial' : 'missing');
      html += `<h4 class="attendance-dashboard-section-title">Daily Teacher Completion</h4><div class="attendance-dashboard-inline"><span>${marked} / ${teachers.length} teachers marked</span>${attendanceCompletionBadge(state)}</div>`;
    }
  }
  html += '</div>';
  html += `<div class="attendance-summary-report-head"><div><h3>Attendance Summary</h3><p class="hint">${escapeHtml(term)} ${escapeHtml(year)}${timesOpen ? ` · ${timesOpen} school-open day(s)` : ''}</p></div><div class="attendance-summary-report-actions"><button type="button" id="printAttendanceSummaryBtn" class="btn-primary">Print Report</button><button type="button" id="pdfAttendanceSummaryBtn" class="btn-primary">Download Report</button></div></div>`;
  html += `<div class="attendance-report-cards"><div><span>Times Open</span><strong>${timesOpen} days</strong></div><div><span>Holidays</span><strong>${holidays}</strong></div><div><span>Midterm</span><strong>${midterms}</strong></div><div><span>Pupils</span><strong>${students.pupils}</strong></div><div><span>Average Pupil Ratio</span><strong>${formatAttendanceRatio(students.averageRatio)}</strong></div>${isHeadTeacher() ? `<div><span>Teachers</span><strong>${teachers.teachers}</strong></div><div><span>Average Teacher Ratio</span><strong>${formatAttendanceRatio(teachers.averageRatio)}</strong></div>` : ''}</div>`;
  html += '<div class="attendance-report-note">Attendance ratios use Times Open. Present and Late count as attendance. Approved teacher Excused and On Leave days are excluded from the individual teacher denominator.</div>';
  html += '<h3 class="attendance-report-section-title">Class Attendance</h3><div class="table-scroll"><table class="grades-table attendance-report-table"><thead><tr><th>Class</th><th>Pupils</th><th>Present</th><th>Late</th><th>Total</th><th>Absent</th><th>Average Ratio</th></tr></thead><tbody>';
  const classes=getAccessibleClasses();
  if (!classes.length) html += '<tr><td colspan="7" class="empty">No accessible classes.</td></tr>';
  classes.forEach(c=>{const x=attendanceSummaryClassStats(c.id,term,year,timesOpen); html += `<tr><td>${escapeHtml(c.name)}</td><td>${x.pupils}</td><td>${x.present}</td><td>${x.late}</td><td><strong>${x.total}</strong></td><td>${x.absent}</td><td><strong>${formatAttendanceRatio(x.averageRatio)}</strong></td></tr>`;});
  html += '</tbody></table></div>';
  if (isHeadTeacher()) {
    const staff=DB.get(KEYS.staff,[]).filter(isTeacherStaffRecord); const smap=teacherAttendanceSummary(term,year).summary;
    html += '<h3 class="attendance-report-section-title">Teacher Attendance</h3><div class="table-scroll"><table class="grades-table attendance-report-table"><thead><tr><th>Teacher</th><th>Role</th><th>Present</th><th>Late</th><th>Total</th><th>Absent</th><th>Excused</th><th>Leave</th><th>Ratio</th></tr></thead><tbody>';
    if(!staff.length) html += '<tr><td colspan="9" class="empty">No teaching staff.</td></tr>';
    staff.forEach(st=>{const sm=smap[st.id]||{present:0,late:0,total:0,absent:0,excused:0,leave:0}; html += `<tr><td>${escapeHtml(st.name)}</td><td>${escapeHtml(st.role||'Teacher')}</td><td>${sm.present}</td><td>${sm.late}</td><td><strong>${sm.total}</strong></td><td>${sm.absent}</td><td>${sm.excused}</td><td>${sm.leave}</td><td><strong>${formatAttendanceRatio(attendanceRatio(sm,timesOpen,true))}</strong></td></tr>`;});
    html += '</tbody></table></div>';
  }
  html += '<h3 class="attendance-report-section-title">Calendar Exceptions</h3><div class="table-scroll"><table class="grades-table attendance-report-table"><thead><tr><th>Date</th><th>Day</th><th>Type</th><th>Note</th></tr></thead><tbody>';
  const exceptions=calendar.filter(x=>String(x.record.type||'').toLowerCase()!=='open');
  if(!exceptions.length) html += '<tr><td colspan="4" class="empty">No holidays or midterm days recorded.</td></tr>';
  exceptions.forEach(x=>{const d=parseDateOnly(x.date); const day=d?d.toLocaleDateString(undefined,{weekday:'short'}):''; html += `<tr><td>${escapeHtml(x.date)}</td><td>${escapeHtml(day)}</td><td>${escapeHtml(calendarLabel(String(x.record.type||'').toLowerCase()))}</td><td>${escapeHtml(x.record.note||'')}</td></tr>`;});
  html += '</tbody></table></div>';
  wrap.innerHTML=html;
  const summaryDateInput = document.getElementById('attendanceSummaryDate');
  if (summaryDateInput) summaryDateInput.addEventListener('change', renderAttendanceSummary);
  const printBtn=document.getElementById('printAttendanceSummaryBtn');
  if(printBtn) printBtn.addEventListener('click', printAttendanceSummary);
  const pdfBtn=document.getElementById('pdfAttendanceSummaryBtn');
  if(pdfBtn) pdfBtn.addEventListener('click', downloadAttendanceSummaryPdf);
}

function buildAttendancePrintHost() {
  const host = document.createElement('div');
  host.className = 'attendance-print-host';
  host.innerHTML = attendanceSummaryPrintHtml();
  document.body.appendChild(host);
  return host;
}


async function downloadAttendancePrintLayoutPdf(options) {
  const opts = options || {};
  const button = opts.button || null;
  const originalText = button ? button.textContent : '';
  let host = null;

  if (button) {
    button.disabled = true;
    button.textContent = 'Preparing Report…';
  }

  try {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      throw new Error('PDF library is not available. Please refresh SchoolHub and try again.');
    }
    if (typeof window.html2canvas !== 'function') {
      throw new Error('PDF rendering tools are not available. Please refresh SchoolHub and try again.');
    }
    if (typeof opts.buildHost !== 'function') {
      throw new Error('Report layout is unavailable.');
    }

    // Reuse the exact DOM used by the Print command. This keeps Print and
    // Download Report visually identical and prevents the two layouts drifting.
    host = opts.buildHost();
    host.classList.add('attendance-pdf-capture-host');

    // Give web fonts/layout a moment to settle before capturing.
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (e) {}
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const canvas = await window.html2canvas(host, {
      backgroundColor: '#ffffff',
      scale: 2,
      useCORS: true,
      logging: false,
      windowWidth: 1100,
      scrollX: 0,
      scrollY: 0
    });

    const JsPDF = window.jspdf.jsPDF;
    const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 8;
    const printableW = pageW - margin * 2;
    const printableH = pageH - margin * 2;

    const imgW = printableW;
    const imgH = canvas.height * imgW / canvas.width;
    const pageCanvasPx = Math.max(1, Math.floor(canvas.width * printableH / printableW));
    const totalPages = Math.max(1, Math.ceil(canvas.height / pageCanvasPx));

    for (let page = 0; page < totalPages; page++) {
      const sourceY = page * pageCanvasPx;
      const sourceH = Math.min(pageCanvasPx, canvas.height - sourceY);
      const slice = document.createElement('canvas');
      slice.width = canvas.width;
      slice.height = sourceH;
      const ctx = slice.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, slice.width, slice.height);
      ctx.drawImage(canvas, 0, sourceY, canvas.width, sourceH, 0, 0, canvas.width, sourceH);

      if (page > 0) doc.addPage();
      const sliceH = sourceH * imgW / canvas.width;
      doc.addImage(slice.toDataURL('image/jpeg', 0.96), 'JPEG', margin, margin, imgW, sliceH, undefined, 'FAST');
    }

    const filename = String(opts.filename || 'Attendance_Report.pdf')
      .replace(/[\\/:*?"<>|]+/g, '_');
    doc.save(filename);
  } catch (e) {
    console.error('Attendance PDF generation failed:', e);
    alert(e && e.message ? e.message : 'Unable to create the PDF. Please try again.');
  } finally {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    if (button) {
      button.disabled = false;
      button.textContent = originalText || 'Download Report';
    }
  }
}

function printAttendanceSummary() {
  // Do not use window.open(). Mobile browsers may turn that into an
  // about:blank page or block the print window. Print the report in-place.
  const host = buildAttendancePrintHost();
  document.body.classList.add('attendance-print-mode');
  const cleanup = () => {
    document.body.classList.remove('attendance-print-mode');
    if (host && host.parentNode) host.parentNode.removeChild(host);
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup, { once: true });
  setTimeout(() => {
    try { window.print(); }
    catch (e) { cleanup(); alert('Unable to open the print dialog. Please try again.'); }
    setTimeout(cleanup, 15000);
  }, 100);
}

async function downloadAttendanceSummaryPdf() {
  const button = document.getElementById('pdfAttendanceSummaryBtn');
  const settings = DB.get(KEYS.settings, {});
  const term = String(settings.currentTerm || 'Term 1');
  const year = String(settings.currentYear || '');
  const safe = `${term}_${year}`.replace(/[^a-z0-9_]+/gi, '_').replace(/^_+|_+$/g, '');
  return downloadAttendancePrintLayoutPdf({
    button,
    buildHost: buildAttendancePrintHost,
    filename: `Attendance_Summary_${safe || 'Report'}.pdf`
  });
}

function refreshAttendanceAfterCalendarChange() {
  const settings = DB.get(KEYS.settings, {});
  settings.attendanceOutOf = String(calculateTimesOpen(settings.currentTerm, settings.currentYear) || '');
  DB.set(KEYS.settings, settings);
  const active = document.querySelector('#attendanceModeBar .attendance-mode.active');
  setAttendanceMode((active && active.dataset.mode) || 'students');
  loadSettingsForm();
}

function shiftAttendanceDate(days) {
  const input = document.getElementById('attendanceDate');
  if (!input) return;
  const current = parseDateOnly(input.value || attendanceDateToday()) || new Date();
  input.value = dateOnlyString(addDaysDateOnly(current, days));
  renderAttendanceForm();
}

function shiftTeacherAttendanceDate(days) {
  const input = document.getElementById('teacherAttendanceDate');
  if (!input) return;
  const current = parseDateOnly(input.value || attendanceDateToday()) || new Date();
  input.value = dateOnlyString(addDaysDateOnly(current, days));
  renderTeacherAttendanceForm();
}

function installAttendanceDateNavigator() {
  const input = document.getElementById('attendanceDate');
  if (!input || document.getElementById('attendanceDateNavigator')) return;
  const parent = input.parentNode, nav = document.createElement('div');
  nav.id='attendanceDateNavigator'; nav.className='attendance-date-navigator';
  const prev=document.createElement('button'), next=document.createElement('button');
  prev.type=next.type='button'; prev.id='attendancePrevDate'; next.id='attendanceNextDate';
  prev.className=next.className='btn-text'; prev.textContent='<'; next.textContent='>';
  prev.setAttribute('aria-label','Previous date'); next.setAttribute('aria-label','Next date');
  parent.insertBefore(nav,input); nav.append(prev,input,next);
  prev.addEventListener('click',()=>shiftAttendanceDate(-1)); next.addEventListener('click',()=>shiftAttendanceDate(1));
}

function installTeacherAttendanceDateNavigator() {
  const input = document.getElementById('teacherAttendanceDate');
  if (!input || document.getElementById('teacherAttendanceDateNavigator')) return;
  const parent = input.parentNode, nav = document.createElement('div');
  nav.id='teacherAttendanceDateNavigator'; nav.className='attendance-date-navigator teacher-attendance-date-navigator';
  const prev=document.createElement('button'), next=document.createElement('button');
  prev.type=next.type='button'; prev.id='teacherAttendancePrevDate'; next.id='teacherAttendanceNextDate';
  prev.className=next.className='btn-text'; prev.textContent='<'; next.textContent='>';
  prev.setAttribute('aria-label','Previous date'); next.setAttribute('aria-label','Next date');
  parent.insertBefore(nav,input); nav.append(prev,input,next);
  prev.addEventListener('click',()=>shiftTeacherAttendanceDate(-1));
  next.addEventListener('click',()=>shiftTeacherAttendanceDate(1));
}

installAttendanceDateNavigator();
installTeacherAttendanceDateNavigator();

document.getElementById('attendanceClassSelect').addEventListener('change', renderAttendanceForm);
document.getElementById('attendanceDate').addEventListener('change', renderAttendanceForm);
document.getElementById('teacherAttendanceDate').addEventListener('change', renderTeacherAttendanceForm);
document.querySelectorAll('#attendanceModeBar .attendance-mode').forEach(btn => btn.addEventListener('click', () => setAttendanceMode(btn.dataset.mode)));

document.getElementById('saveAttendanceBtn').addEventListener('click', () => {
  const classId = document.getElementById('attendanceClassSelect').value;
  if (!classId || !requireClassAccess(classId)) return;
  const settings = DB.get(KEYS.settings, {});
  if (!settings.currentTerm || !settings.currentYear) { alert('Set the current Term and Academic Year in Setup first.'); return; }
  const date = document.getElementById('attendanceDate').value;
  if (!date) { alert('Select an attendance date.'); return; }
  if (attendanceDayType(settings.currentTerm, settings.currentYear, date) !== 'open') { alert('Attendance cannot be recorded on a Holiday or Midterm day.'); return; }
  const statuses = {};
  document.querySelectorAll('#attendanceFormWrap .attendance-status').forEach(select => { if (select.value) statuses[select.dataset.student] = select.value; });
  const key = attendanceKey(classId, settings.currentTerm, settings.currentYear, date);
  const all = DB.get(KEYS.attendance, {});
  all[key] = { classId, term: settings.currentTerm, year: settings.currentYear, date, entries: statuses };
  DB.set(KEYS.attendance, all);

  const summary = attendanceSummary(classId, settings.currentTerm, settings.currentYear).summary;
  const remarksAll = DB.get(KEYS.remarks, {});
  const remarkKey = gradeKey(classId, settings.currentTerm, settings.currentYear);
  const classRemarks = remarksAll[remarkKey] || {};
  Object.keys(summary).forEach(studentId => {
    if (!classRemarks[studentId]) classRemarks[studentId] = {};
    classRemarks[studentId].attendance = summary[studentId].total;
  });
  remarksAll[remarkKey] = classRemarks;
  DB.set(KEYS.remarks, remarksAll);
  auditAction('update', 'studentAttendance', key, `Saved student attendance for ${date} · ${settings.currentTerm} ${settings.currentYear}`);
  renderAttendanceForm();
  alert('Student attendance saved. Term attendance totals have been updated.');
});

document.getElementById('saveTeacherAttendanceBtn').addEventListener('click', () => {
  if (!requireHeadTeacher('record or edit teacher attendance')) return;
  const settings = DB.get(KEYS.settings, {});
  if (!settings.currentTerm || !settings.currentYear) { alert('Set the current Term and Academic Year in Setup first.'); return; }
  const date = document.getElementById('teacherAttendanceDate').value;
  if (!date) { alert('Select a teacher attendance date.'); return; }
  if (attendanceDayType(settings.currentTerm, settings.currentYear, date) !== 'open') { alert('Teacher attendance cannot be recorded on a Holiday or Midterm day.'); return; }
  const entries = {};
  document.querySelectorAll('#teacherAttendanceFormWrap .teacher-attendance-status').forEach(select => { if (select.value) entries[select.dataset.staff] = select.value; });
  const key = teacherAttendanceKey(settings.currentTerm, settings.currentYear, date);
  const all = DB.get(KEYS.teacherAttendance, {});
  all[key] = { term: settings.currentTerm, year: settings.currentYear, date, entries };
  DB.set(KEYS.teacherAttendance, all);
  auditAction('update', 'teacherAttendance', key, `Saved teacher attendance for ${date} · ${settings.currentTerm} ${settings.currentYear}`);
  renderTeacherAttendanceForm();
  alert('Teacher attendance saved.');
});

/* ---------- Grades entry (Class Score /60 + Exam Score /100 per subject) ---------- */
function renderGradesClassSelect() {
  const sel = document.getElementById('gradesClassSelect');
  fillClassSelect(sel);
  renderGradesTable();
}

function renderGradesTable() {
  const classId = document.getElementById('gradesClassSelect').value;
  if (classId && !canAccessClass(classId)) { document.getElementById('gradesTableWrap').innerHTML = '<p class="empty">You do not have access to this class.</p>'; return; }
  const wrap = document.getElementById('gradesTableWrap');
  if (!classId) { wrap.innerHTML = '<p class="empty">Add a class first.</p>'; return; }
  const students = getAccessibleStudents().filter(s => s.classId === classId);
  const subjects = getAccessibleSubjects();
  if (!students.length || !subjects.length) {
    wrap.innerHTML = '<p class="empty">Add students and subjects first.</p>';
    return;
  }
  const settings = DB.get(KEYS.settings, {});
  const simple = settings.reportLayout === 'simple';
  const key = gradeKey(classId, settings.currentTerm, settings.currentYear);
  const allGrades = DB.get(KEYS.grades, {});
  const classGrades = allGrades[key] || {};

  let html = '';
  if (simple) {
    html += '<p class="hint">Simple layout is active — Class Score is hidden and not used. Enter Exam Score only.</p>';
  }
  html += '<div class="table-scroll"><table class="grades-table"><thead>';
  html += '<tr><th class="name-col" rowspan="2">Student</th>';
  subjects.forEach(sub => { html += `<th colspan="${simple ? 1 : 2}">${escapeHtml(sub.name)}</th>`; });
  html += '</tr><tr>';
  subjects.forEach(() => {
    html += simple ? '<th class="sub-col">Exam /100</th>' : '<th class="sub-col">Class /60</th><th class="sub-col">Exam /100</th>';
  });
  html += '</tr></thead><tbody>';
  students.forEach(st => {
    html += `<tr><td class="name-col">${escapeHtml(st.name)}</td>`;
    subjects.forEach(sub => {
      const entry = classGrades[st.id] && classGrades[st.id][sub.id];
      const eVal = entry && entry.e !== undefined ? entry.e : '';
      if (!simple) {
        const cVal = entry && entry.c !== undefined ? entry.c : '';
        html += `<td><input type="number" min="0" max="60" inputmode="numeric" data-student="${st.id}" data-subject="${sub.id}" data-part="c" value="${cVal}"></td>`;
      }
      html += `<td><input type="number" min="0" max="100" inputmode="numeric" data-student="${st.id}" data-subject="${sub.id}" data-part="e" value="${eVal}"></td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  wrap.innerHTML = html;

  // Live-clamp so an out-of-range value never sits waiting to be saved.
  wrap.querySelectorAll('input[type="number"]').forEach(input => {
    const max = input.dataset.part === 'c' ? 60 : 100;
    input.addEventListener('input', () => {
      const clamped = clampScore(input.value, max);
      if (String(clamped) !== input.value) input.value = clamped;
    });
    input.addEventListener('blur', () => {
      input.value = clampScore(input.value, max);
    });
  });
}

document.getElementById('gradesClassSelect').addEventListener('change', renderGradesTable);

document.getElementById('saveGradesBtn').addEventListener('click', () => {
  const classId = document.getElementById('gradesClassSelect').value;
  if (!classId) return;
  if (!requireClassAccess(classId)) return;
  const settings = DB.get(KEYS.settings, {});
  if (!settings.currentTerm || !settings.currentYear) {
    alert('Set the current Term and Academic Year in Setup first.');
    return;
  }
  const key = gradeKey(classId, settings.currentTerm, settings.currentYear);
  const allGrades = DB.get(KEYS.grades, {});
  const classGrades = allGrades[key] || {};
  document.querySelectorAll('#gradesTableWrap input').forEach(input => {
    const studentId = input.dataset.student;
    const subjectId = input.dataset.subject;
    const part = input.dataset.part;
    const max = part === 'c' ? 60 : 100;
    const clamped = clampScore(input.value, max);
    if (!classGrades[studentId]) classGrades[studentId] = {};
    if (!classGrades[studentId][subjectId]) classGrades[studentId][subjectId] = {};
    if (clamped === '') { delete classGrades[studentId][subjectId][part]; }
    else { classGrades[studentId][subjectId][part] = clamped; }
  });
  allGrades[key] = classGrades;
  DB.set(KEYS.grades, allGrades);
  auditAction('update', 'grades', key, `Saved grades for ${settings.currentTerm}, ${settings.currentYear}`);
  alert('Grades saved.');
});

/* ---------- Bulk Grade (Excel export/import for offline entry) ---------- */
function subjectColumnHeaders(sub, simple) {
  return simple ? [`${sub.name} - Exam (100)`] : [`${sub.name} - Class (60)`, `${sub.name} - Exam (100)`];
}

document.getElementById('exportGradesXlsxBtn').addEventListener('click', () => {
  const classId = document.getElementById('gradesClassSelect').value;
  if (!classId) { alert('Add a class first.'); return; }
  const settings = DB.get(KEYS.settings, {});
  if (!settings.currentTerm || !settings.currentYear) {
    alert('Set the current Term and Academic Year in Setup first.');
    return;
  }
  const simple = settings.reportLayout === 'simple';
  const students = getAccessibleStudents().filter(s => s.classId === classId);
  const subjects = DB.get(KEYS.subjects, []);
  if (!students.length || !subjects.length) { alert('Add students and subjects first.'); return; }
  const key = gradeKey(classId, settings.currentTerm, settings.currentYear);
  const classGrades = DB.get(KEYS.grades, {})[key] || {};

  const header = ['Student Name', 'Student ID'];
  subjects.forEach(sub => header.push(...subjectColumnHeaders(sub, simple)));

  const rows = [header];
  students.forEach(st => {
    const row = [st.name, st.admissionId || ''];
    subjects.forEach(sub => {
      const entry = classGrades[st.id] && classGrades[st.id][sub.id];
      if (simple) {
        row.push(entry && entry.e !== undefined ? entry.e : '');
      } else {
        row.push(entry && entry.c !== undefined ? entry.c : '', entry && entry.e !== undefined ? entry.e : '');
      }
    });
    rows.push(row);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Grades');
  const classInfo = DB.get(KEYS.classes, []).find(c => c.id === classId);
  const namePart = (classInfo ? classInfo.name : 'class').replace(/[^a-z0-9]+/gi, '_');
  const termPart = (settings.currentTerm || '').replace(/[^a-z0-9]+/gi, '_');
  const yearPart = (settings.currentYear || '').replace(/[^a-z0-9]+/gi, '_');
  XLSX.writeFile(wb, `${namePart}_${termPart}_${yearPart}_grades.xlsx`);
});

document.getElementById('importGradesXlsxInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const classId = document.getElementById('gradesClassSelect').value;
  if (!classId) { alert('Select a class first.'); e.target.value = ''; return; }
  const settings = DB.get(KEYS.settings, {});
  if (!settings.currentTerm || !settings.currentYear) {
    alert('Set the current Term and Academic Year in Setup first.');
    e.target.value = '';
    return;
  }
  const simple = settings.reportLayout === 'simple';

  const reader = new FileReader();
  reader.onload = evt => {
    let workbook;
    try {
      const data = new Uint8Array(evt.target.result);
      workbook = XLSX.read(data, { type: 'array' });
    } catch (err) {
      alert('Could not read that file. Make sure it is a .xlsx, .xls or .csv file.');
      e.target.value = '';
      return;
    }
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (!rows.length) { alert('That file has no data.'); e.target.value = ''; return; }

    const header = rows[0].map(h => String(h).trim());
    const nameIdx = header.indexOf('Student Name');
    const idIdx = header.indexOf('Student ID');
    if (nameIdx === -1) {
      alert('That file does not look like an exported grade sheet (missing "Student Name" column).');
      e.target.value = '';
      return;
    }

    const subjects = DB.get(KEYS.subjects, []);
    const subjectCols = subjects.map(sub => simple
      ? { subject: sub, eIdx: header.indexOf(`${sub.name} - Exam (100)`) }
      : {
          subject: sub,
          cIdx: header.indexOf(`${sub.name} - Class (60)`),
          eIdx: header.indexOf(`${sub.name} - Exam (100)`)
        });

    const students = getAccessibleStudents().filter(s => s.classId === classId);
    const byId = {}, byName = {};
    students.forEach(s => {
      if (s.admissionId) byId[s.admissionId.trim().toLowerCase()] = s;
      byName[s.name.trim().toLowerCase()] = s;
    });

    const ok = confirm(`This will replace all scores for this class, ${settings.currentTerm} ${settings.currentYear}, with what's in the file. Continue?`);
    if (!ok) { e.target.value = ''; return; }

    const key = gradeKey(classId, settings.currentTerm, settings.currentYear);
    const allGrades = DB.get(KEYS.grades, {});
    const classGrades = {};
    let matched = 0, skipped = 0;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row.length) continue;
      const rowId = idIdx !== -1 ? String(row[idIdx] || '').trim().toLowerCase() : '';
      const rowName = String(row[nameIdx] || '').trim().toLowerCase();
      if (!rowName && !rowId) continue;
      const student = (rowId && byId[rowId]) || byName[rowName];
      if (!student) { skipped++; continue; }
      matched++;
      classGrades[student.id] = {};
      subjectCols.forEach(sc => {
        const entry = {};
        if (!simple && sc.cIdx !== -1) {
          const c = clampScore(row[sc.cIdx], 60);
          if (c !== '') entry.c = c;
        }
        if (sc.eIdx !== -1) {
          const ev = clampScore(row[sc.eIdx], 100);
          if (ev !== '') entry.e = ev;
        }
        if (Object.keys(entry).length) classGrades[student.id][sc.subject.id] = entry;
      });
    }

    allGrades[key] = classGrades;
    DB.set(KEYS.grades, allGrades);
    renderGradesTable();
    alert(`Import complete. ${matched} student(s) updated${skipped ? `, ${skipped} row(s) skipped (no matching student)` : ''}.`);
    e.target.value = '';
  };
  reader.readAsArrayBuffer(file);
});

/* ---------- Remarks Comment Bank ---------- */
// Source: Polished Report Card Comment Bank supplied for SchoolHub remarks dropdowns.
const REMARK_COMMENT_BANK = {
  conduct: ["Respectful", "Humble", "Calm", "Approachable", "Kind", "Caring", "Sociable", "Friendly", "Quiet", "Responsible", "Reliable", "Dependable", "Polite", "Courteous", "Obedient", "Cooperative", "Helpful", "Thoughtful", "Patient", "Attentive", "Composed", "Gentle", "Cheerful", "Active", "Proactive", "Resourceful", "Dedicated", "Serious", "Punctual", "Regular in attendance", "Neat", "Well-mannered", "Well-behaved", "Confident", "Considerate", "Leadership qualities", "Works well with classmates", "Follows classroom routines", "Participates in classroom activities", "Participates in class discussions", "Works independently", "Works cooperatively with peers", "Reads well", "Shows good manners and positive social behaviour", "Respectful and obedient", "Calm and respectful", "Calm and quiet", "Humble and respectful", "Respectful and hardworking", "Friendly and sociable", "Calm and approachable", "Calm and obedient", "Calm and hardworking", "Quiet and respectful", "Polite and respectful", "Responsible and dependable", "Punctual and respectful", "Regular and respectful", "Regular and punctual", "Active and sociable", "Approachable and respectful", "Helpful and hardworking", "Hardworking and caring", "Good team player", "Shows improvement", "Shows strong effort and persistence", "Shows enthusiasm for learning", "Eager to learn and explore new ideas", "Accepts challenges positively", "Shows good leadership skills", "Has good comprehension", "Has legible handwriting", "Needs to improve concentration", "Needs encouragement to build confidence", "Needs consistent support to improve", "Needs to be more punctual", "Needs to attend school regularly", "Needs to be more attentive in class", "Can improve with guidance", "Talkative", "Loud", "Noisy", "Playful", "Shy", "Reserved", "Quick-tempered", "Easily distracted", "Inattentive", "Passive in class", "Lazy", "Truant", "Frequently late to school", "Not regular in attendance", "Needs to improve behaviour", "Needs to be more serious", "Needs to participate more actively", "Needs to learn to work with others", "Needs close guidance and support", "Needs to avoid disturbing others"],
  attitude: ["Hardworking", "Serious", "Calm", "Humble", "Respectful", "Polite", "Obedient", "Responsible", "Dependable", "Diligent", "Dedicated", "Studious", "Persistent", "Resilient", "Patient", "Kind", "Friendly", "Cooperative", "Helpful", "Honest", "Communicative", "Interactive", "Cordial", "Creative", "Confident", "Proactive", "Thoughtful", "Considerate", "Brave", "Lively", "Enthusiastic", "Attentive", "Composed", "Self-motivated", "Works independently", "Works well with peers", "Works carefully and neatly", "Checks work before submission", "Listens to feedback", "Accepts advice positively", "Takes ownership of learning", "Shows enthusiasm for learning", "Eager to learn and participate", "Participates actively in class", "Contributes to discussions", "Shows leadership skills", "Shows commitment to studies", "Maintains a positive attitude", "Makes a sincere effort", "Tries consistently despite challenges", "Shows potential for improvement", "Needs to be more serious", "Needs better concentration", "Needs more attention in class", "Needs more practice", "Needs additional support", "Needs guidance to follow instructions", "Needs encouragement to build confidence", "Needs better time management", "Needs to be more proactive", "Needs to participate more actively", "Needs to improve attendance", "Needs to improve punctuality", "Needs to work harder", "Needs extra support at home", "Needs closer supervision", "Slow in learning", "Slow in writing", "Lazy in studies", "Not serious in class", "Not attentive in class", "Easily distracted", "Loses focus easily", "Talkative in class", "Playful in class", "Passive in class", "Reluctant to participate", "Inactive in lessons", "Sleeps in class", "Truant", "Frequently late to school", "Needs to improve behaviour", "Needs to learn to work with others", "Needs support to catch up with peers"],
  interest: ["Reading", "Writing", "Spelling", "Mathematics", "Science", "Integrated Science", "Natural Science", "Environmental Studies", "English Language", "Ghanaian Language", "French", "Religious and Moral Education", "History", "Computing", "Literacy", "Numeracy", "Phonics", "Creative Arts", "Art and Design", "Drawing", "Colouring", "Crafts", "Music", "Singing", "Dancing", "Drumming", "Drama", "Sports", "Football", "Netball", "Handball", "Volleyball", "Athletics", "Games", "Outdoor activities", "Indoor activities", "Social activities", "Group work", "Group assignments", "Peer teaching", "Leadership", "Volunteering", "Storytelling", "Creative writing", "Calculation", "Comprehension", "Making friends", "Gardening", "Cooking", "Cleaning", "Sweeping", "Woodwork", "Trading", "Repairs", "Fashion", "Modelling", "Cultural activities", "Prayer", "Shows interest in all subjects", "Shows keen interest in academic work", "Shows interest in Mathematics", "Shows interest in Science", "Shows interest in creativity", "Shows strong understanding of subjects", "Shows great creativity", "Enjoys reading", "Enjoys sports", "Enjoys music and dance", "Enjoys outdoor activities", "Enjoys group activities", "Enjoys educational games", "Interested in social activities", "Interested in reading and writing", "Interested in sports and arts", "Interested in music and sports", "Interested in reading and mathematics", "Interested in reading and science", "Interested in drawing and colouring", "Interested in football and artwork", "Interested in dancing and singing", "Interested in games and reading", "Interested in group learning", "Shows improvement", "Needs encouragement to develop interests", "Needs to show more interest in learning"],
  comment: ["Keep it up.", "Well done. Keep it up.", "Good performance. Keep it up.", "Excellent performance. Keep it up.", "Excellent progress. Keep it up.", "Splendid performance. Keep it up.", "Impressive performance. Keep it up.", "Outstanding effort and progress. Keep it up.", "Great work. Keep it up.", "Great work. Continue working hard.", "Keep working hard.", "Continue learning and improving.", "Keep aiming for excellence.", "You have the potential to do better.", "Can do better.", "Could do better. Keep working hard.", "There is room for improvement.", "More room for improvement. Keep working hard.", "Shows good progress.", "Shows steady improvement.", "Has improved. Keep it up.", "Has made good progress.", "Making good progress. Keep it up.", "Excellent effort.", "Good effort. Continue working hard.", "Shows enthusiasm for learning.", "Shows a positive attitude towards learning.", "Excellent participation in class.", "Shows good leadership qualities.", "Hardworking and sincere.", "A pleasant student to have in class.", "A well-rounded student with good potential.", "Works carefully and neatly.", "Needs to be more serious with studies.", "Needs to work harder.", "Needs to improve concentration in class.", "Needs to pay more attention in class.", "Needs to improve time management.", "Needs to improve punctuality.", "Needs to attend school regularly.", "Needs to study more at home.", "Needs more practice and revision.", "Needs additional support at home.", "Needs close supervision and encouragement at home.", "Needs extra tuition and support.", "Needs special attention at home.", "Needs help to improve reading.", "Needs help to improve handwriting.", "Needs help with English composition.", "Needs to improve spelling and handwriting.", "Needs to work on basic concepts.", "Needs to follow instructions carefully.", "Needs to be more cooperative in group work.", "Needs to learn to work well with others.", "Needs to change negative behaviour.", "Needs to stop playing and concentrate on learning.", "Needs to be more punctual and regular at school.", "Be more serious and work harder next term.", "Be more serious and attend school regularly.", "Be more serious and attend school on time.", "Study hard and continue improving.", "Revise regularly and work consistently.", "With consistent effort and guidance, improvement is possible.", "With regular support, the pupil can achieve better results.", "Can achieve better results with improved focus.", "Continue working hard and maintain the positive attitude.", "Keep improving and strive for excellence.", "Excellent. Continue the good work.", "Very good performance. Keep it up.", "Satisfactory performance. There is room for improvement.", "Needs to put in more effort.", "Needs to sit up and concentrate more.", "Needs to take studies more seriously.", "Needs more attention in class and at home.", "Needs continuous support to improve performance."]
};

function normalizeRemarkChoice(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/[.\u3002]+$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function remarksSelectOptions(items, current) {
  const value = current == null ? '' : String(current).trim();
  let html = '<option value=\"\">Select an option...</option>';
  const normalizedCurrent = normalizeRemarkChoice(value);
  const matchedItem = value ? items.find(item => normalizeRemarkChoice(item) === normalizedCurrent) : null;

  // If an existing saved remark differs only by punctuation/case/spacing from
  // a bank option (e.g. “Keep it up” vs “Keep it up.”), use the bank option
  // directly. This avoids showing a misleading duplicate “Current:” entry.
  if (value && !matchedItem) {
    html += `<option value=\"${escapeHtml(value)}\" selected>${escapeHtml(value)}</option>`;
  }

  items.forEach(item => {
    const selected = matchedItem ? item === matchedItem : item === value;
    html += `<option value=\"${escapeHtml(item)}\"${selected ? ' selected' : ''}>${escapeHtml(item)}</option>`;
  });
  return html;
}

/* ---------- Remarks: one student at a time ---------- */
const remarksState = {
  classId: '',
  students: [],
  index: 0,
  filter: ''
};

function remarksCurrentStudent() {
  return remarksState.students[remarksState.index] || null;
}

function remarksStudentComplete(studentId, classRemarks) {
  const r = (classRemarks && classRemarks[studentId]) || {};
  return [r.conduct, r.attitude, r.interest, r.comment].every(v => String(v || '').trim() !== '');
}

function updateRemarksStudentSelect() {
  const sel = document.getElementById('remarksStudentSelect');
  const search = document.getElementById('remarksStudentSearch');
  if (!sel) return;

  const filter = String(search ? search.value : remarksState.filter || '').trim().toLowerCase();
  remarksState.filter = filter;

  const current = remarksCurrentStudent();
  const matches = remarksState.students.filter(st => {
    if (!filter) return true;
    return String(st.name || '').toLowerCase().includes(filter) || String(st.id || '').toLowerCase().includes(filter);
  });

  sel.innerHTML = matches.map(st => {
    const originalIndex = remarksState.students.findIndex(x => x.id === st.id);
    return `<option value="${escapeHtml(st.id)}"${current && current.id === st.id ? ' selected' : ''}>${String(originalIndex + 1).padStart(2, '0')} · ${escapeHtml(st.name || 'Unnamed student')}</option>`;
  }).join('');

  if (current && !matches.some(st => st.id === current.id) && matches.length) {
    remarksState.index = remarksState.students.findIndex(st => st.id === matches[0].id);
    sel.value = matches[0].id;
    renderRemarksForm();
  }
}

function renderRemarksClassSelect() {
  const sel = document.getElementById('remarksClassSelect');
  fillClassSelect(sel);
  const savedClass = sel.value;
  remarksState.classId = savedClass || '';
  remarksState.index = 0;
  remarksState.filter = '';
  const search = document.getElementById('remarksStudentSearch');
  if (search) search.value = '';
  renderRemarksForm();
}

function renderRemarksForm() {
  const classId = document.getElementById('remarksClassSelect').value;
  const wrap = document.getElementById('remarksFormWrap');
  const toolbar = document.getElementById('remarksStudentToolbar');
  const search = document.getElementById('remarksStudentSearch');
  const progress = document.getElementById('remarksProgress');
  const prevBtn = document.getElementById('remarksPrevBtn');
  const nextBtn = document.getElementById('remarksNextBtn');
  const saveBtn = document.getElementById('saveRemarksBtn');
  const saveNextBtn = document.getElementById('saveNextRemarksBtn');

  if (classId && !canAccessClass(classId)) {
    remarksState.students = [];
    wrap.innerHTML = '<p class="empty">You do not have access to this class.</p>';
    if (toolbar) toolbar.classList.add('hidden');
    return;
  }
  if (!classId) {
    remarksState.students = [];
    wrap.innerHTML = '<p class="empty">Add a class first.</p>';
    if (toolbar) toolbar.classList.add('hidden');
    return;
  }

  const students = getAccessibleStudents().filter(s => s.classId === classId);
  remarksState.classId = classId;
  remarksState.students = students;
  if (remarksState.index >= students.length) remarksState.index = Math.max(0, students.length - 1);

  if (!students.length) {
    wrap.innerHTML = '<p class="empty">No students in this class.</p>';
    if (toolbar) toolbar.classList.add('hidden');
    return;
  }

  if (toolbar) toolbar.classList.remove('hidden');
  const settings = DB.get(KEYS.settings, {});
  const key = gradeKey(classId, settings.currentTerm, settings.currentYear);
  const allRemarks = DB.get(KEYS.remarks, {});
  const classRemarks = allRemarks[key] || {};
  const student = remarksCurrentStudent();
  const r = classRemarks[student.id] || {};

  updateRemarksStudentSelect();

  const completed = students.filter(st => remarksStudentComplete(st.id, classRemarks)).length;
  if (progress) progress.textContent = `${completed} / ${students.length} completed`;
  const counter = document.getElementById('remarksStudentCounter');
  if (counter) counter.textContent = `${remarksState.index + 1} / ${students.length}`;
  if (prevBtn) prevBtn.disabled = remarksState.index <= 0;
  if (nextBtn) nextBtn.disabled = remarksState.index >= students.length - 1;
  if (saveNextBtn) saveNextBtn.disabled = students.length < 2;
  if (search) search.value = remarksState.filter;

  wrap.innerHTML = `<div class="remarks-card remarks-card-single" data-student="${escapeHtml(student.id)}">
      <div class="remarks-student-heading">
        <h3>${escapeHtml(student.name)}</h3>
        <span class="remarks-student-position">${remarksState.index + 1} of ${students.length}</span>
      </div>
      <label>Attendance (days present)
        <input type="number" min="0" class="rm-attendance" value="${r.attendance !== undefined ? escapeHtml(r.attendance) : ''}">
      </label>
      <label>Promoted / Repeated to
        <input type="text" class="rm-promoted" placeholder="e.g. Basic Two (2)" value="${r.promoted ? escapeHtml(r.promoted) : ''}">
      </label>
      <label>Fees Due (GH¢)
        <input type="number" min="0" step="0.01" class="rm-fees" value="${r.feesDue !== undefined ? escapeHtml(r.feesDue) : ''}">
      </label>
      <label>Conduct / Character
        <select class="rm-conduct" aria-label="Conduct / Character">
          ${remarksSelectOptions(REMARK_COMMENT_BANK.conduct, r.conduct)}
        </select>
      </label>
      <label>Attitude
        <select class="rm-attitude" aria-label="Attitude">
          ${remarksSelectOptions(REMARK_COMMENT_BANK.attitude, r.attitude)}
        </select>
      </label>
      <label>Interest
        <select class="rm-interest" aria-label="Interest">
          ${remarksSelectOptions(REMARK_COMMENT_BANK.interest, r.interest)}
        </select>
      </label>
      <label>Form Teacher's Comment
        <select class="rm-comment" aria-label="Form Teacher's Comment">
          ${remarksSelectOptions(REMARK_COMMENT_BANK.comment, r.comment)}
        </select>
      </label>
    </div>`;
}

function navigateRemarks(delta) {
  const nextIndex = remarksState.index + delta;
  if (nextIndex < 0 || nextIndex >= remarksState.students.length) return;
  remarksState.index = nextIndex;
  renderRemarksForm();
}

function selectRemarksStudent(studentId) {
  const idx = remarksState.students.findIndex(st => st.id === studentId);
  if (idx < 0) return;
  remarksState.index = idx;
  renderRemarksForm();
}

function saveCurrentRemarks(showAlert = true) {
  const classId = document.getElementById('remarksClassSelect').value;
  const card = document.querySelector('.remarks-card-single');
  const student = remarksCurrentStudent();
  if (!classId || !card || !student) return false;
  if (!requireClassAccess(classId)) return false;

  const settings = DB.get(KEYS.settings, {});
  if (!settings.currentTerm || !settings.currentYear) {
    alert('Set the current Term and Academic Year in Setup first.');
    return false;
  }

  const key = gradeKey(classId, settings.currentTerm, settings.currentYear);
  const allRemarks = DB.get(KEYS.remarks, {});
  const classRemarks = allRemarks[key] || {};
  classRemarks[student.id] = {
    attendance: card.querySelector('.rm-attendance').value.trim(),
    promoted: card.querySelector('.rm-promoted').value.trim(),
    feesDue: card.querySelector('.rm-fees').value.trim(),
    conduct: card.querySelector('.rm-conduct').value.trim(),
    attitude: card.querySelector('.rm-attitude').value.trim(),
    interest: card.querySelector('.rm-interest').value.trim(),
    comment: card.querySelector('.rm-comment').value.trim()
  };
  allRemarks[key] = classRemarks;
  DB.set(KEYS.remarks, allRemarks);
  auditAction('update', 'remarks', `${key}__${student.id}`, `Saved remarks for ${student.name}, ${settings.currentTerm}, ${settings.currentYear}`);
  if (showAlert) alert(`Remarks saved for ${student.name}.`);
  return true;
}

document.getElementById('remarksClassSelect').addEventListener('change', () => {
  remarksState.index = 0;
  remarksState.filter = '';
  const search = document.getElementById('remarksStudentSearch');
  if (search) search.value = '';
  renderRemarksForm();
});

document.getElementById('remarksStudentSearch').addEventListener('input', updateRemarksStudentSelect);
document.getElementById('remarksStudentSelect').addEventListener('change', e => selectRemarksStudent(e.target.value));
document.getElementById('remarksPrevBtn').addEventListener('click', () => navigateRemarks(-1));
document.getElementById('remarksNextBtn').addEventListener('click', () => navigateRemarks(1));
document.getElementById('saveRemarksBtn').addEventListener('click', () => saveCurrentRemarks(true));
document.getElementById('saveNextRemarksBtn').addEventListener('click', () => {
  if (!saveCurrentRemarks(false)) return;
  if (remarksState.index < remarksState.students.length - 1) {
    remarksState.index += 1;
    renderRemarksForm();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

// Aggregate = sum of grades of the first 4 subjects (in the order
// subjects are listed) + the 2 best (lowest-numbered, i.e. best) grades
// among the remaining subjects. Lower aggregate is better; 6 is the
// best possible score. This mirrors standard BECE-style aggregate scoring.
function computeAggregate(entries) {
  if (!entries.length) return null;
  const core = entries.slice(0, 4);
  const electives = entries.slice(4);
  const coreSum = core.reduce((a, b) => a + b.grade, 0);
  const bestTwo = electives.slice().sort((a, b) => a.grade - b.grade).slice(0, 2);
  const bestTwoSum = bestTwo.reduce((a, b) => a + b.grade, 0);
  return coreSum + bestTwoSum;
}

/* ---------- Results computation ---------- */
function computeClassResults(classId, term, year) {
  const students = studentsForClassYear(classId, year);
  const subjects = getAccessibleSubjects();
  const key = gradeKey(classId, term, year);
  const classGrades = DB.get(KEYS.grades, {})[key] || {};
  const settings = DB.get(KEYS.settings, {});
  const simple = settings.reportLayout === 'simple';

  const results = students.map(st => {
    const scores = classGrades[st.id] || {};
    // entries follow the subjects list order — required for "first 4" to be meaningful
    const entries = subjects
      .filter(sub => {
        const sc = scores[sub.id];
        if (!sc) return false;
        return simple ? sc.e !== undefined : (sc.c !== undefined && sc.e !== undefined);
      })
      .map(sub => {
        const raw = scores[sub.id];
        if (simple) {
          // Simple layout: Class Score is never entered or used — Exam
          // Score alone (already out of 100) is the subject's Total.
          const total = Number(raw.e);
          return {
            subject: sub, rawExam: Number(raw.e), total,
            grade: getGradeFor(total), remark: getRemarkFor(total)
          };
        }
        const classScaled = scaleClass(Number(raw.c));
        const examScaled = scaleExam(Number(raw.e));
        const total = classScaled + examScaled;
        return {
          subject: sub, rawClass: Number(raw.c), rawExam: Number(raw.e),
          classScaled, examScaled, total,
          grade: getGradeFor(total), remark: getRemarkFor(total)
        };
      });
    const totalSum = entries.reduce((a, b) => a + b.total, 0);
    const avg = entries.length ? totalSum / entries.length : 0;
    const aggregate = computeAggregate(entries);
    return {
      student: st, entries, totalSum, avg, aggregate,
      overallRemark: entries.length ? getRemarkFor(avg) : null
    };
  });

  // Rank by aggregate ascending — lower aggregate is better, matching
  // how the aggregate is actually used to place students.
  const ranked = results.filter(r => r.aggregate !== null).slice().sort((a, b) => a.aggregate - b.aggregate);
  let rank = 0, lastAgg = null, seen = 0;
  ranked.forEach(r => {
    seen++;
    if (r.aggregate !== lastAgg) { rank = seen; lastAgg = r.aggregate; }
    r.position = rank;
    r.outOf = ranked.length;
  });
  results.forEach(r => {
    const match = ranked.find(x => x.student.id === r.student.id);
    r.position = match ? match.position : null;
    r.outOf = ranked.length;
  });
  return results;
}

// Per-subject class-wide position: e.g. "8th in Mathematics" for this class/term.
function computeSubjectPositions(classId, term, year) {
  const students = studentsForClassYear(classId, year);
  const subjects = getAccessibleSubjects();
  const key = gradeKey(classId, term, year);
  const classGrades = DB.get(KEYS.grades, {})[key] || {};
  const settings = DB.get(KEYS.settings, {});
  const simple = settings.reportLayout === 'simple';
  const positions = {};

  subjects.forEach(sub => {
    const rows = [];
    students.forEach(st => {
      const sc = classGrades[st.id] && classGrades[st.id][sub.id];
      if (!sc) return;
      const has = simple ? sc.e !== undefined : (sc.c !== undefined && sc.e !== undefined);
      if (!has) return;
      const total = simple ? Number(sc.e) : (scaleClass(Number(sc.c)) + scaleExam(Number(sc.e)));
      rows.push({ studentId: st.id, total });
    });
    rows.sort((a, b) => b.total - a.total);
    let rank = 0, last = null, seen = 0;
    const map = {};
    rows.forEach(r => {
      seen++;
      if (r.total !== last) { rank = seen; last = r.total; }
      map[r.studentId] = { position: rank, outOf: rows.length };
    });
    positions[sub.id] = map;
  });
  return positions;
}

/* ---------- Report Card Themes ---------- */
const REPORT_THEMES={
 bw:{id:'bw',name:'Theme 1',title:'Black & White',description:'A clean, printer-friendly monochrome report card with strong typography and minimal decoration.',primary:[20,20,20],dark:[10,10,10],accent:[20,20,20],paper:[255,255,255],light:[248,248,248],pale:[238,238,238],text:[20,20,20],muted:[82,82,82],rule:[190,190,190],white:[255,255,255],red:[120,30,30],headerH:39,headerRadius:0,tableRadius:0,cardRadius:0,footerH:7,footerAccent:1,headerTitleSize:15.5,bodyFont:'helvetica',cardTitle:7,panelTitle:7.5,tableFont:7.1,signatureH:20,legendH:17,infoH:35,cardH:30,borderless:false},
 schoolhub:{id:'schoolhub',name:'Theme 2',title:'SchoolHub Professional',description:'The current AlatiphA SchoolHub design with teal, green, gold and clean white cards.',primary:[24,112,99],dark:[22,80,69],accent:[201,162,39],paper:[241,239,230],light:[248,249,246],pale:[231,242,238],text:[22,36,28],muted:[92,111,99],rule:[205,220,214],white:[255,255,255],red:[156,58,40],headerH:39,headerRadius:4,tableRadius:2.5,cardRadius:2.5,footerH:9,footerAccent:1,headerTitleSize:15,bodyFont:'helvetica',cardTitle:7,panelTitle:7.5,tableFont:7.1,signatureH:21,legendH:18,infoH:36,cardH:31,borderless:false},
 modern:{id:'modern',name:'Theme 3',title:'Modern Academic',description:'A contemporary blue-green layout with crisp panels and a lighter visual hierarchy.',primary:[36,108,125],dark:[24,58,76],accent:[226,170,64],paper:[246,248,247],light:[238,244,246],pale:[229,241,243],text:[25,40,48],muted:[88,105,114],rule:[205,218,222],white:[255,255,255],red:[175,65,55],headerH:37,headerRadius:3,tableRadius:1.5,cardRadius:3,footerH:8,footerAccent:.8,headerTitleSize:15.5,bodyFont:'helvetica',cardTitle:7.2,panelTitle:7.4,tableFont:7,signatureH:20,legendH:17,infoH:35,cardH:30,borderless:false},
 classic:{id:'classic',name:'Theme 4',title:'Classic Academic',description:'A formal traditional report card with warm paper, structured borders and academic typography.',primary:[105,74,55],dark:[63,55,46],accent:[164,126,55],paper:[247,243,233],light:[251,249,244],pale:[240,233,218],text:[42,39,34],muted:[101,94,82],rule:[211,201,183],white:[255,255,255],red:[151,58,45],headerH:38,headerRadius:1.5,tableRadius:.8,cardRadius:1.5,footerH:8,footerAccent:.8,headerTitleSize:15,bodyFont:'times',cardTitle:7.1,panelTitle:7.2,tableFont:7,signatureH:20,legendH:17,infoH:35,cardH:30,borderless:false},
 executive:{id:'executive',name:'Theme 5',title:'Executive',description:'A premium compact presentation with deep navy, gold accents and high-contrast information panels.',primary:[31,65,92],dark:[20,37,55],accent:[198,156,48],paper:[242,244,244],light:[247,248,249],pale:[232,237,241],text:[25,34,43],muted:[90,101,111],rule:[204,212,218],white:[255,255,255],red:[166,58,52],headerH:39,headerRadius:4,tableRadius:2,cardRadius:2,footerH:8,footerAccent:.8,headerTitleSize:15.5,bodyFont:'helvetica',cardTitle:7.2,panelTitle:7.5,tableFont:7,signatureH:20,legendH:17,infoH:35,cardH:30,borderless:false},
 sage:{id:'sage',name:'Theme 6',title:'Sage Minimal',description:'A calm, borderless green layout using open space, soft panels and restrained accents.',primary:[52,102,84],dark:[31,67,55],accent:[183,145,62],paper:[248,247,240],light:[244,246,242],pale:[232,238,232],text:[32,47,40],muted:[91,105,96],rule:[214,221,214],white:[255,255,255],red:[150,62,48],headerH:38,headerRadius:5,tableRadius:0,cardRadius:4,footerH:7,footerAccent:.7,headerTitleSize:15.5,bodyFont:'helvetica',cardTitle:7.1,panelTitle:7.4,tableFont:7,signatureH:20,legendH:17,infoH:35,cardH:30,borderless:true},
 blueair:{id:'blueair',name:'Theme 7',title:'Blue Air',description:'An airy borderless blue design with soft fills, open sections and modern typography.',primary:[39,96,130],dark:[26,58,82],accent:[77,137,158],paper:[248,250,251],light:[243,247,249],pale:[231,240,245],text:[28,42,51],muted:[91,106,116],rule:[211,222,229],white:[255,255,255],red:[158,59,55],headerH:38,headerRadius:5,tableRadius:0,cardRadius:4,footerH:7,footerAccent:.7,headerTitleSize:15.5,bodyFont:'helvetica',cardTitle:7.1,panelTitle:7.4,tableFont:7,signatureH:20,legendH:17,infoH:35,cardH:30,borderless:true},
 rose:{id:'rose',name:'Theme 8',title:'Rose Editorial',description:'A refined burgundy and blush editorial style with selective borders and elegant typography.',primary:[126,57,72],dark:[76,34,45],accent:[190,132,115],paper:[249,244,242],light:[252,249,248],pale:[242,229,229],text:[47,35,38],muted:[111,88,93],rule:[222,204,207],white:[255,255,255],red:[145,49,55],headerH:38,headerRadius:2,tableRadius:1,cardRadius:2,footerH:8,footerAccent:.8,headerTitleSize:15.5,bodyFont:'times',cardTitle:7.1,panelTitle:7.4,tableFont:7,signatureH:20,legendH:17,infoH:35,cardH:30,borderless:false}
};
function getReportTheme(settings){return REPORT_THEMES[(settings&&settings.reportTheme)||'bw']||REPORT_THEMES.bw;}
function renderReportThemePicker(){const host=document.getElementById('reportThemePicker');if(!host)return;const activeId=DB.get(KEYS.settings,{}).reportTheme||'bw';host.innerHTML=`<div class="report-theme-active"><div class="report-theme-active-icon">✦</div><div><span class="report-theme-kicker">ACTIVE THEME</span><h3>${escapeHtml(REPORT_THEMES[activeId].title)}</h3><p>${escapeHtml(REPORT_THEMES[activeId].description)}</p></div></div><div class="report-theme-grid">${Object.values(REPORT_THEMES).map(t=>`<article class="report-theme-card ${t.id===activeId?'active':''}"><div class="report-theme-preview" data-theme="${t.id}"><div class="rtp-head"><span></span><b>${escapeHtml(t.title)}</b><i></i></div><div class="rtp-meta"><span></span><span></span></div><div class="rtp-table"><b></b><b></b><b></b><b></b><b></b></div><div class="rtp-bottom"><span></span><span></span></div><div class="rtp-footer"></div></div><div class="report-theme-card-body"><h3>${escapeHtml(t.name)} <small>${escapeHtml(t.title)}</small></h3><p>${escapeHtml(t.description)}</p><div class="report-theme-actions"><button type="button" class="report-theme-preview-btn" data-theme-preview="${t.id}">⌕ Preview</button><button type="button" class="btn-primary report-theme-apply" data-theme-apply="${t.id}">${t.id===activeId?'✓ Active':'Apply'}</button></div></div></article>`).join('')}</div>`;host.querySelectorAll('[data-theme-apply]').forEach(b=>b.addEventListener('click',()=>applyReportTheme(b.dataset.themeApply)));host.querySelectorAll('[data-theme-preview]').forEach(b=>b.addEventListener('click',()=>previewReportTheme(b.dataset.themePreview)));}
async function applyReportTheme(themeId){if(!enforceGuestTrial())return;if(!REPORT_THEMES[themeId])return;if(isActiveGuest() && themeId!=='bw'){requireSchoolAccountForPaidFeature('using a premium report theme');return;}if(!requireHeadTeacher('change the report card theme'))return;if(themeId!=='bw' && !(await ensureCreditsAvailable(1,'using a premium report theme')))return;const s=DB.get(KEYS.settings,{});s.reportTheme=themeId;DB.set(KEYS.settings,s);const sel=document.getElementById('reportThemeSelect');if(sel)sel.value=themeId;auditAction('update','report-theme',themeId,`Applied report card theme: ${REPORT_THEMES[themeId].title}`);renderReportThemePicker();}
async function previewReportTheme(themeId){if(!enforceGuestTrial())return;if(isActiveGuest() && themeId!=='bw'){requireSchoolAccountForPaidFeature('previewing a premium report theme');return;}const settings=DB.get(KEYS.settings,{}),classId=document.getElementById('reportsClassSelect')?.value;if(!classId){alert('Select a class first to preview a report card.');return;}const results=computeClassResults(classId,settings.currentTerm,settings.currentYear);if(!results.length){alert('There are no students with results in this class yet.');return;}const result=results[0],positions=computeSubjectPositions(classId,settings.currentTerm,settings.currentYear),numOnRoll=DB.get(KEYS.students,[]).filter(s=>s.classId===classId).length,classInfo=DB.get(KEYS.classes,[]).find(c=>c.id===classId),remarksAll=DB.get(KEYS.remarks,{})[gradeKey(classId,settings.currentTerm,settings.currentYear)]||{},previewSettings=Object.assign({},settings,{reportTheme:themeId});try{const assets=await prepareReportAssets(result,previewSettings,classInfo);const {jsPDF}=window.jspdf;const doc=new jsPDF({orientation:'portrait',unit:'mm',format:'a4'});drawReportPage(doc,result,previewSettings,positions,numOnRoll,classInfo,remarksAll[result.student.id]||{},assets);drawReportPreviewWatermark(doc);window.open(doc.output('bloburl'),'_blank');}catch(e){alert('Unable to preview this theme: '+(e.message||e));}}

function drawReportPreviewWatermark(doc) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(24);
  doc.setTextColor(180, 50, 50);
  for (let y = 70; y < 290; y += 55) doc.text('SAMPLE - NOT FOR OFFICIAL USE', 105, y, { align: 'center', angle: 25 });
}

/* ---------- Reports ---------- */
document.getElementById('reportThemesBtn')?.addEventListener('click', () => {
  const picker = document.getElementById('reportThemePicker');
  if (!picker) return;
  picker.classList.toggle('hidden');
  if (!picker.classList.contains('hidden')) renderReportThemePicker();
});

function renderReportsClassSelect() {
  const sel = document.getElementById('reportsClassSelect');
  fillClassSelect(sel);
  renderReportsStudentList();
  renderClassStatistics();
}

function renderReportCreditStatus() {
  const host = document.getElementById('reportCreditStatus');
  if (!host) return;
  const canManageBilling = isHeadTeacher();
  if (!FIREBASE_ENABLED || !currentSchoolId) {
    host.innerHTML = `<span><strong>${bwFreeRemaining()} of 10 free guest Black &amp; White reports remaining.</strong> Register your school for its term allowance and credits.</span>` +
      (canManageBilling ? `<div class="credit-actions"><button type="button" class="btn-secondary" id="reportBillingLink">Billing &amp; Credits</button></div>` : '');
  } else if (!canManageBilling) {
    host.innerHTML = `<span><strong>${bwFreeRemaining()} of 10 free Black &amp; White reports left this term.</strong> ${reportBillingMessage()}</span>`;
  } else {
    const balance = displayedBillingBalance();
    const status = BILLING_SUSPENDED ? reportBillingMessage() : '10 free single Black & White reports per school per term, then 1 credit each; batches require credits.';
    host.innerHTML = `<span><strong>${balance} ${isBillingTestMode() ? 'test' : 'report'} credit${balance === 1 ? '' : 's'}</strong> available for this school · GH₵${(balance * REPORT_CREDIT_PRICE_GHS).toFixed(2)} ${isBillingTestMode() ? 'test value (no real money)' : 'value'} · <strong>${bwFreeRemaining()} of 10 free Black &amp; White reports left this term</strong> · <em>${status}</em></span><div class="credit-actions"><button type="button" class="btn-secondary" id="reportBillingLink">Billing &amp; Credits</button></div>`;
  }
  document.getElementById('reportBillingLink')?.addEventListener('click', () => { if (isHeadTeacher()) showView('billing'); });
}

function renderReportsStudentList() {
  renderReportCreditStatus();
  if (isHeadTeacher()) refreshBillingAccount(true).then(() => renderReportCreditStatus());
  const classId = document.getElementById('reportsClassSelect').value;
  if (classId && !canAccessClass(classId)) { document.getElementById('reportsStudentList').innerHTML = '<li class="empty">You do not have access to this class.</li>'; return; }
  const list = document.getElementById('reportsStudentList');
  list.innerHTML = '';
  if (!classId) { list.innerHTML = '<li class="empty">Add a class first.</li>'; return; }
  const settings = DB.get(KEYS.settings, {});
  const results = computeClassResults(classId, settings.currentTerm, settings.currentYear);
  if (!results.length) { list.innerHTML = '<li class="empty">No students in this class.</li>'; return; }
  results.forEach(r => {
    const li = document.createElement('li');
    li.className = 'report-student-row';
    li.innerHTML = `<div class="report-student-info"><strong>${escapeHtml(r.student.name)}</strong>
        <div class="meta">${r.entries.length} subject(s) · Avg ${r.avg.toFixed(1)}</div></div>
      <div class="actions report-student-actions">
        <button class="gen" data-id="${r.student.id}">Generate PDF</button>
        <button class="share" data-id="${r.student.id}">Share</button>
      </div>`;
    list.appendChild(li);
  });
  list.querySelectorAll('.gen').forEach(btn => {
    btn.addEventListener('click', () => {
      const studentId = btn.dataset.id;
      const result = results.find(r => r.student.id === studentId);
      const positions = computeSubjectPositions(classId, settings.currentTerm, settings.currentYear);
      const numOnRoll = studentsForClassYear(classId, year).length;
      const classInfo = DB.get(KEYS.classes, []).find(c => c.id === classId);
      const remarksAll = DB.get(KEYS.remarks, {})[gradeKey(classId, settings.currentTerm, settings.currentYear)] || {};
      generateSinglePDF(result, positions, numOnRoll, classInfo, remarksAll[studentId] || {});
    });
  });
  list.querySelectorAll('.share').forEach(btn => {
    btn.addEventListener('click', () => {
      const studentId = btn.dataset.id;
      const result = results.find(r => r.student.id === studentId);
      const classInfo = DB.get(KEYS.classes, []).find(c => c.id === classId);
      shareResultViaWhatsApp(result, classInfo, settings);
    });
  });
}

// Opens a WhatsApp chat with the student's saved parent phone number,
// pre-filled with a short summary of their result. No server involved —
// this is just the public wa.me deep link, so it works whether or not
// WhatsApp is installed (falls back to WhatsApp Web).
function shareResultViaWhatsApp(result, classInfo, settings) {
  const phone = (result.student.parentPhone || '').replace(/[^0-9+]/g, '');
  if (!phone) {
    alert('No parent phone number saved for this student. Add one via Edit in the Students tab.');
    return;
  }
  const digits = phone.replace(/\+/g, '');
  const lines = [
    `${settings.schoolName || 'School'} — Report Card`,
    `Name: ${result.student.name}`,
    `Class: ${classInfo ? classInfo.name : ''}  Term: ${settings.currentTerm || ''}  Year: ${settings.currentYear || ''}`,
    `Class Position: ${result.position ? ordinal(result.position) : '-'}`,
    `Total Score: ${result.totalSum}`,
    `Aggregate: ${result.aggregate !== null ? result.aggregate : '-'}`
  ];
  const message = lines.join('\n');
  const url = `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
  window.open(url, '_blank');
}

// Pass/fail threshold matches the report's existing weak-grade rule:
// Grade 1-6 (score 50+) is a pass, Grade 7-9 (score below 50) is a fail.
function computeClassStatistics(classId, term, year) {
  const results = computeClassResults(classId, term, year);
  const subjects = getAccessibleSubjects();

  const subjectStats = subjects.map(sub => {
    const scores = [];
    results.forEach(r => {
      const en = r.entries.find(e => e.subject.id === sub.id);
      if (en) scores.push({ value: en.total, grade: en.grade, studentName: r.student.name });
    });
    if (!scores.length) return { subject: sub, count: 0 };
    const sum = scores.reduce((a, b) => a + b.value, 0);
    const average = sum / scores.length;
    const highest = scores.reduce((a, b) => (b.value > a.value ? b : a));
    const lowest = scores.reduce((a, b) => (b.value < a.value ? b : a));
    const passCount = scores.filter(s => s.grade <= 6).length;
    const passRate = (passCount / scores.length) * 100;
    return { subject: sub, count: scores.length, average, highest, lowest, passRate };
  });

  const withAgg = results.filter(r => r.aggregate !== null);
  const allEntries = results.flatMap(r => r.entries);
  const classAverage = allEntries.length ? allEntries.reduce((a, b) => a + b.total, 0) / allEntries.length : 0;
  const overallPassCount = allEntries.filter(e => e.grade <= 6).length;
  const overallPassRate = allEntries.length ? (overallPassCount / allEntries.length) * 100 : 0;
  const topStudent = withAgg.length ? withAgg.slice().sort((a, b) => a.aggregate - b.aggregate)[0] : null;

  return {
    subjectStats, studentsWithResults: withAgg.length, totalStudents: results.length,
    classAverage, overallPassRate, topStudent
  };
}

let statsExpanded = false; // secondary info — collapsed by default

function renderClassStatistics() {
  const classId = document.getElementById('reportsClassSelect').value;
  const wrap = document.getElementById('classStatsWrap');
  if (!classId) { wrap.innerHTML = ''; return; }
  const settings = DB.get(KEYS.settings, {});
  const stats = computeClassStatistics(classId, settings.currentTerm, settings.currentYear);

  let bodyHtml;
  if (!stats.studentsWithResults) {
    bodyHtml = '<p class="empty">No grades entered yet for this class.</p>';
  } else {
    bodyHtml = `<p class="hint">${stats.studentsWithResults} of ${stats.totalStudents} student(s) have results · `
      + `Class Average ${stats.classAverage.toFixed(1)} · Pass Rate ${stats.overallPassRate.toFixed(0)}%`
      + (stats.topStudent ? ` · Top: ${escapeHtml(stats.topStudent.student.name)} (Aggregate ${stats.topStudent.aggregate})` : '')
      + '</p>';
    bodyHtml += '<div class="table-scroll"><table class="grades-table"><thead><tr>'
      + '<th class="name-col">Subject</th><th>Avg</th><th>Highest</th><th>Lowest</th><th>Pass %</th></tr></thead><tbody>';
    stats.subjectStats.forEach(s => {
      if (!s.count) {
        bodyHtml += `<tr><td class="name-col">${escapeHtml(s.subject.name)}</td><td colspan="4">No data</td></tr>`;
        return;
      }
      bodyHtml += `<tr><td class="name-col">${escapeHtml(s.subject.name)}</td>`
        + `<td>${s.average.toFixed(1)}</td>`
        + `<td>${s.highest.value} (${escapeHtml(s.highest.studentName)})</td>`
        + `<td>${s.lowest.value} (${escapeHtml(s.lowest.studentName)})</td>`
        + `<td>${s.passRate.toFixed(0)}%</td></tr>`;
    });
    bodyHtml += '</tbody></table></div>';
  }

  wrap.innerHTML = `
    <div class="stats-header">
      <h3 class="subsection-title">Class Statistics</h3>
      <button id="statsToggleBtn" type="button" class="stats-toggle">${statsExpanded ? 'Hide' : 'Show'}</button>
    </div>
    <div class="stats-body" style="display:${statsExpanded ? 'block' : 'none'}">${bodyHtml}</div>
  `;
  document.getElementById('statsToggleBtn').addEventListener('click', () => {
    statsExpanded = !statsExpanded;
    renderClassStatistics();
  });
}

document.getElementById('reportsClassSelect').addEventListener('change', () => {
  renderReportsStudentList();
  renderClassStatistics();
});

document.getElementById('generateAllBtn').addEventListener('click', () => {
  const classId = document.getElementById('reportsClassSelect').value;
  if (!classId) { alert('Add a class first.'); return; }
  const settings = DB.get(KEYS.settings, {});
  const results = computeClassResults(classId, settings.currentTerm, settings.currentYear);
  if (!results.length) { alert('No students in this class.'); return; }
  const positions = computeSubjectPositions(classId, settings.currentTerm, settings.currentYear);
  const numOnRoll = studentsForClassYear(classId, year).length;
  const classInfo = DB.get(KEYS.classes, []).find(c => c.id === classId);
  const remarksAll = DB.get(KEYS.remarks, {})[gradeKey(classId, settings.currentTerm, settings.currentYear)] || {};
  generateBatchPDF(results, positions, numOnRoll, classInfo, remarksAll);
});

/* ---------- CSV export ---------- */
function csvValue(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

document.getElementById('exportCsvBtn').addEventListener('click', () => {
  const classId = document.getElementById('reportsClassSelect').value;
  if (!classId) { alert('Add a class first.'); return; }
  const settings = DB.get(KEYS.settings, {});
  const simple = settings.reportLayout === 'simple';
  const results = computeClassResults(classId, settings.currentTerm, settings.currentYear);
  if (!results.length) { alert('No students in this class.'); return; }
  const positions = computeSubjectPositions(classId, settings.currentTerm, settings.currentYear);
  const subjects = DB.get(KEYS.subjects, []);
  const classInfo = DB.get(KEYS.classes, []).find(c => c.id === classId);

  const header = ['Name', 'ID'];
  subjects.forEach(sub => {
    if (simple) {
      header.push(`${sub.name} Score`, `${sub.name} Grade`, `${sub.name} Position`, `${sub.name} Remark`);
    } else {
      header.push(`${sub.name} Class`, `${sub.name} Exam`, `${sub.name} Total`, `${sub.name} Grade`, `${sub.name} Position`, `${sub.name} Remark`);
    }
  });
  header.push('Total Score', 'Aggregate', 'Class Position');

  const rows = [header];
  results.forEach(r => {
    const row = [r.student.name, r.student.admissionId || ''];
    subjects.forEach(sub => {
      const en = r.entries.find(e => e.subject.id === sub.id);
      const pos = positions[sub.id] && positions[sub.id][r.student.id];
      if (!en) {
        row.push(...(simple ? ['', '', '', ''] : ['', '', '', '', '', '']));
        return;
      }
      const posText = pos ? ordinal(pos.position) : '';
      if (simple) {
        row.push(en.total, en.grade, posText, en.remark);
      } else {
        row.push(en.classScaled, en.examScaled, en.total, en.grade, posText, en.remark);
      }
    });
    row.push(r.totalSum, r.aggregate !== null ? r.aggregate : '', r.position ? ordinal(r.position) : '');
    rows.push(row);
  });

  const csv = rows.map(row => row.map(csvValue).join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const namePart = (classInfo ? classInfo.name : 'class').replace(/[^a-z0-9]+/gi, '_');
  const termPart = (settings.currentTerm || '').replace(/[^a-z0-9]+/gi, '_');
  const yearPart = (settings.currentYear || '').replace(/[^a-z0-9]+/gi, '_');
  a.href = url;
  a.download = `${namePart}_${termPart}_${yearPart}_results.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

/* ---------- Term History (browse past terms, start a new one) ---------- */

// Distinct {term, year} combinations that actually have saved grade or
// remarks data, newest first.
function getHistoryTermYearList() {
  const grades = DB.get(KEYS.grades, {});
  const remarks = DB.get(KEYS.remarks, {});
  const set = new Set();
  const collect = obj => Object.keys(obj).forEach(k => {
    const parts = k.split('__');
    if (parts.length === 3) set.add(parts[1] + '__' + parts[2]);
  });
  collect(grades);
  collect(remarks);
  return Array.from(set)
    .map(s => { const [term, year] = s.split('__'); return { term, year }; })
    .sort((a, b) => (b.year !== a.year ? b.year.localeCompare(a.year) : b.term.localeCompare(a.term)));
}

function renderHistoryTermYearSelect() {
  const sel = document.getElementById('historyTermYearSelect');
  const combos = getHistoryTermYearList();
  const prev = sel.value;
  if (!combos.length) {
    sel.innerHTML = '<option value="">No historical data yet</option>';
  } else {
    sel.innerHTML = combos.map(c => `<option value="${c.term}__${c.year}">${escapeHtml(c.term)} · ${escapeHtml(c.year)}</option>`).join('');
    if (combos.some(c => `${c.term}__${c.year}` === prev)) sel.value = prev;
  }
  renderHistoryClassSelect();
}

function renderHistoryClassSelect() {
  const termYear = document.getElementById('historyTermYearSelect').value;
  const sel = document.getElementById('historyClassSelect');
  if (!termYear) { sel.innerHTML = '<option value="">-</option>'; renderHistoryBody(); return; }
  const [term, year] = termYear.split('__');
  const classIds = new Set();
  const collect = obj => Object.keys(obj).forEach(k => {
    const parts = k.split('__');
    if (parts.length === 3 && parts[1] === term && parts[2] === year) classIds.add(parts[0]);
  });
  collect(DB.get(KEYS.grades, {}));
  collect(DB.get(KEYS.remarks, {}));
  const classes = getAccessibleClasses().filter(c => classIds.has(c.id));
  const prev = sel.value;
  sel.innerHTML = classes.length
    ? classes.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')
    : '<option value="">No classes with data</option>';
  if (classes.some(c => c.id === prev)) sel.value = prev;
  renderHistoryBody();
}

function currentHistorySelection() {
  const termYear = document.getElementById('historyTermYearSelect').value;
  const classId = document.getElementById('historyClassSelect').value;
  if (!termYear || !classId) return null;
  const [term, year] = termYear.split('__');
  return { classId, term, year };
}

function historicalSettings(term, year) {
  return Object.assign({}, DB.get(KEYS.settings, {}), { currentTerm: term, currentYear: year });
}

function renderHistoryBody() {
  const sel = currentHistorySelection();
  const statsWrap = document.getElementById('historyStatsWrap');
  const list = document.getElementById('historyStudentList');
  if (!sel) {
    statsWrap.innerHTML = '';
    list.innerHTML = '<li class="empty">Pick a Term/Year and Class above to browse.</li>';
    return;
  }
  const { classId, term, year } = sel;
  const results = computeClassResults(classId, term, year);
  if (!results.length) {
    statsWrap.innerHTML = '';
    list.innerHTML = '<li class="empty">No students found for this class.</li>';
    return;
  }
  const stats = computeClassStatistics(classId, term, year);
  statsWrap.innerHTML = stats.studentsWithResults
    ? `<p class="hint">${stats.studentsWithResults} of ${stats.totalStudents} student(s) have results · `
      + `Class Average ${stats.classAverage.toFixed(1)} · Pass Rate ${stats.overallPassRate.toFixed(0)}%`
      + (stats.topStudent ? ` · Top: ${escapeHtml(stats.topStudent.student.name)} (Aggregate ${stats.topStudent.aggregate})` : '')
      + '</p>'
    : '<p class="empty">No grades recorded for this class in this term.</p>';

  list.innerHTML = '';
  results.forEach(r => {
    const li = document.createElement('li');
    li.innerHTML = `<div><strong>${escapeHtml(r.student.name)}</strong>
        <div class="meta">${r.entries.length} subject(s) · Avg ${r.avg.toFixed(1)} · Position ${r.position ? ordinal(r.position) : '-'}</div></div>
      <div class="actions"><button class="gen" data-id="${r.student.id}">PDF</button></div>`;
    list.appendChild(li);
  });
  list.querySelectorAll('.gen').forEach(btn => {
    btn.addEventListener('click', () => {
      const result = results.find(r => r.student.id === btn.dataset.id);
      const settings = historicalSettings(term, year);
      const positions = computeSubjectPositions(classId, term, year);
      const numOnRoll = studentsForClassYear(classId, year).length;
      const classInfo = DB.get(KEYS.classes, []).find(c => c.id === classId);
      const remarksAll = DB.get(KEYS.remarks, {})[gradeKey(classId, term, year)] || {};
      generateSinglePDF(result, positions, numOnRoll, classInfo, remarksAll[result.student.id] || {}, settings);
    });
  });
}

document.getElementById('historyTermYearSelect').addEventListener('change', renderHistoryClassSelect);
document.getElementById('historyClassSelect').addEventListener('change', renderHistoryBody);

document.getElementById('historyGenerateAllBtn').addEventListener('click', () => {
  const sel = currentHistorySelection();
  if (!sel) { alert('Pick a Term/Year and Class first.'); return; }
  const { classId, term, year } = sel;
  const results = computeClassResults(classId, term, year);
  if (!results.length) { alert('No students in this class.'); return; }
  const settings = historicalSettings(term, year);
  const positions = computeSubjectPositions(classId, term, year);
  const numOnRoll = studentsForClassYear(classId, year).length;
  const classInfo = DB.get(KEYS.classes, []).find(c => c.id === classId);
  const remarksAll = DB.get(KEYS.remarks, {})[gradeKey(classId, term, year)] || {};
  generateBatchPDF(results, positions, numOnRoll, classInfo, remarksAll, settings);
});

document.getElementById('historyExportCsvBtn').addEventListener('click', () => {
  const sel = currentHistorySelection();
  if (!sel) { alert('Pick a Term/Year and Class first.'); return; }
  const { classId, term, year } = sel;
  const settings = historicalSettings(term, year);
  const simple = settings.reportLayout === 'simple';
  const results = computeClassResults(classId, term, year);
  if (!results.length) { alert('No students in this class.'); return; }
  const positions = computeSubjectPositions(classId, term, year);
  const subjects = DB.get(KEYS.subjects, []);
  const classInfo = DB.get(KEYS.classes, []).find(c => c.id === classId);

  const header = ['Name', 'ID'];
  subjects.forEach(sub => {
    if (simple) header.push(`${sub.name} Score`, `${sub.name} Grade`, `${sub.name} Position`, `${sub.name} Remark`);
    else header.push(`${sub.name} Class`, `${sub.name} Exam`, `${sub.name} Total`, `${sub.name} Grade`, `${sub.name} Position`, `${sub.name} Remark`);
  });
  header.push('Total Score', 'Aggregate', 'Class Position');

  const rows = [header];
  results.forEach(r => {
    const row = [r.student.name, r.student.admissionId || ''];
    subjects.forEach(sub => {
      const en = r.entries.find(e => e.subject.id === sub.id);
      const pos = positions[sub.id] && positions[sub.id][r.student.id];
      if (!en) { row.push(...(simple ? ['', '', '', ''] : ['', '', '', '', '', ''])); return; }
      const posText = pos ? ordinal(pos.position) : '';
      if (simple) row.push(en.total, en.grade, posText, en.remark);
      else row.push(en.classScaled, en.examScaled, en.total, en.grade, posText, en.remark);
    });
    row.push(r.totalSum, r.aggregate !== null ? r.aggregate : '', r.position ? ordinal(r.position) : '');
    rows.push(row);
  });

  const csv = rows.map(row => row.map(csvValue).join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const namePart = (classInfo ? classInfo.name : 'class').replace(/[^a-z0-9]+/gi, '_');
  const termPart = term.replace(/[^a-z0-9]+/gi, '_');
  const yearPart = year.replace(/[^a-z0-9]+/gi, '_');
  a.href = url;
  a.download = `${namePart}_${termPart}_${yearPart}_results.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// "Start New Term" just moves the current Term/Year forward. Classes,
// students and subjects are shared across every term already, so
// there's nothing to duplicate — grade entry for the new term starts
// blank automatically, and every past term stays saved and browsable
// above.
document.getElementById('startNewTermBtn').addEventListener('click', () => {
  const newTerm = document.getElementById('newTermSelect').value;
  const newYear = document.getElementById('newTermYearInput').value.trim();
  if (!newYear) { alert('Enter the academic year for the new term.'); return; }
  const s = DB.get(KEYS.settings, {});
  const ok = confirm(`Set the current term to ${newTerm}, ${newYear}? Classes, students and subjects carry over automatically — grade entry for this new term will start blank.`);
  if (!ok) return;
  s.currentTerm = newTerm;
  s.currentYear = newYear;
  DB.set(KEYS.settings, s);
  auditAction('update', 'term', `${newTerm}__${newYear}`, `Started new term: ${newTerm}, ${newYear}`);
  loadSettingsForm();
  document.getElementById('newTermYearInput').value = '';
  renderHistoryTermYearSelect();
  alert(`Current term is now ${newTerm}, ${newYear}.`);
});

/* ---------- Phase 4: School Billing & Report Credits ---------- */
// Billing is temporarily suspended while the Staff module is being expanded.
// All billing/payment code remains in this build for later reactivation.
const BILLING_SUSPENDED = true;
const TEST_CREDIT_DEDUCTIONS = true;
function testCreditDeductionsEnabled() { return TEST_CREDIT_DEDUCTIONS && isBillingTestMode(); }
function reportBillingIsFree() { return BILLING_SUSPENDED && !testCreditDeductionsEnabled(); }
function reportBillingMessage() {
  if (testCreditDeductionsEnabled()) return 'Test deductions enabled. Premium single reports use 1 test credit; class batches use 1 per report. Each school gets 10 free single Black & White reports per term, then 1 test credit per report. Live billing is disabled; no real money is charged.';
  return 'Live billing disabled. All report generation, including class batch PDFs, is free. No credits are deducted.';
}
function isBillingTestMode() { return String(window.PAYSTACK_PUBLIC_KEY || '').startsWith('pk_test_'); }
function pendingPaymentKey() { return `arc_pending_payment_${currentSchoolId}_${currentUid}`; }
function pendingPaymentReference() { return localStorage.getItem(pendingPaymentKey()) || ''; }
let checkoutBusy = false;
let verificationBusy = false;
const REPORT_CREDIT_PRICE_GHS = 0.20;
const BW_FREE_REPORT_LIMIT = 10;
const GUEST_BW_USAGE_KEY = 'arc_guest_bw_reports_used';
function bwAllowanceKey(settings = DB.get(KEYS.settings, {})) {
  return encodeURIComponent(JSON.stringify([String(settings.currentYear || '').trim(), String(settings.currentTerm || '').trim()]));
}
function bwFreeRemaining() {
  if (!currentUid && !currentSchoolId) return Math.max(0, BW_FREE_REPORT_LIMIT - Number(localStorage.getItem(GUEST_BW_USAGE_KEY) || 0));
  const usage = DB.get(KEYS.billing, {}).testBwUsageByTerm || {};
  return Math.max(0, BW_FREE_REPORT_LIMIT - Number(usage[bwAllowanceKey()] || 0));
}
const REPORT_CREDIT_PACKAGES = [
  { id: '10', credits: 10, amount: 2.00 },
  { id: '50', credits: 50, amount: 10.00 },
  { id: '100', credits: 100, amount: 20.00 },
  { id: '250', credits: 250, amount: 50.00 },
  { id: '500', credits: 500, amount: 100.00 },
  { id: '1000', credits: 1000, amount: 200.00 }
];

function billingFunctions() {
  if (!FIREBASE_ENABLED || !firebase.functions) throw new Error('Billing services are not available.');
  return firebase.functions();
}
function localBillingBalance() {
  const b = DB.get(KEYS.billing, { balance: 0 });
  return Math.max(0, Number(b.balance || 0));
}
function displayedBillingBalance() {
  const account = DB.get(KEYS.billing, {});
  return isBillingTestMode() ? Math.max(0, Number(account.testBalance || 0)) : localBillingBalance();
}
function setLocalBillingBalance(balance) {
  const b = DB.get(KEYS.billing, {});
  b.balance = Math.max(0, Number(balance || 0));
  b.currency = 'GHS';
  b.updatedAt = new Date().toISOString();
  DB.set(KEYS.billing, b);
}
async function refreshBillingAccount(silent = true) {
  if (!FIREBASE_ENABLED || !currentSchoolId || !firebase.firestore) return null;
  const billingSchool = currentSchoolId;
  const billingUid = currentUid;
  try {
    const snap = await schoolRef().collection('billing').doc('account').get();
    if (currentSchoolId !== billingSchool || currentUid !== billingUid) return null;
    const data = snap.exists ? snap.data() : { balance: 0, currency: 'GHS' };
    setLocalBillingBalance(Number(data.balance || 0));
    const cachedAccount = DB.get(KEYS.billing, {});
    cachedAccount.testBalance = Math.max(0, Number(data.testBalance || 0));
    cachedAccount.testBwUsageByTerm = data.testBwUsageByTerm || {};
    DB.set(KEYS.billing, cachedAccount);
    return data;
  } catch (e) {
    if (!silent) alert('Unable to load the school billing balance: ' + (e.message || e));
    return null;
  }
}
function hasSchoolBillingAccount() {
  return !!(FIREBASE_ENABLED && currentSchoolId && currentUid);
}
function requireSchoolAccountForPaidFeature(actionText) {
  if (!FIREBASE_ENABLED || !currentSchoolId || !currentUid) {
    alert(`Please sign in to your school account before ${actionText}.`);
    return false;
  }
  return true;
}
async function ensureCreditsAvailable(count = 1, actionText = 'continue') {
  if (!enforceGuestTrial()) return false;
  if (!currentUid && !requireSchoolAccountForPaidFeature(actionText)) return false;
  if (reportBillingIsFree()) return true;
  if (!requireSchoolAccountForPaidFeature(actionText)) return false;
  const balance = displayedBillingBalance();
  if (balance >= count) return true;
  await refreshBillingAccount(true);
  if (displayedBillingBalance() >= count) return true;
  alert(`This action requires ${count} report credit${count === 1 ? '' : 's'}. Your school currently has ${displayedBillingBalance()} credit${displayedBillingBalance() === 1 ? '' : 's'}. The Head Teacher can buy more from Billing & Credits.`);
  return false;
}
async function consumeReportCredits(count, requestId = crypto.randomUUID(), reportType = 'paid') {
  if (!Number.isInteger(count) || count < 1) throw new Error('Invalid report credit count.');
  if (reportBillingIsFree()) return { balance: displayedBillingBalance(), suspended: true };
  if (!requireSchoolAccountForPaidFeature('generating report cards')) throw new Error('School account required.');
  if (!firebase.functions) throw new Error('Billing service is not available.');
  const fn = billingFunctions().httpsCallable('consumeReportCredits');
  const deductionSchool = currentSchoolId;
  const deductionUid = currentUid;
  let result;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { result = await fn({ count, requestId, mode: 'test', reportType }); break; }
    catch (error) {
      if (attempt || !['functions/unavailable', 'functions/deadline-exceeded', 'functions/internal'].includes(error.code)) throw error;
    }
  }
  if (result.data?.mode !== 'test') throw new Error('Unexpected credit deduction mode.');
  const balance = Number(result.data.balance);
  if (currentSchoolId === deductionSchool && currentUid === deductionUid) {
    const account = DB.get(KEYS.billing, {});
    account.testBalance = balance;
    if (result.data.allowanceKey && result.data.freeRemaining != null) {
      account.testBwUsageByTerm = { ...(account.testBwUsageByTerm || {}), [result.data.allowanceKey]: BW_FREE_REPORT_LIMIT - Number(result.data.freeRemaining) };
    }
    DB.set(KEYS.billing, account);
    renderReportCreditStatus();
  }
  auditAction('consume', 'report-credit', '', `Used ${result.data.consumed} report credits to generate ${count} report card(s).`);
  return result.data;
}
async function buyReportCredits(packageId) {
  if (checkoutBusy) return;
  if (!isHeadTeacher()) { alert('Only the Head Teacher can purchase report credits for the school.'); return; }
  const pack = REPORT_CREDIT_PACKAGES.find(p => p.id === String(packageId));
  if (!pack) return;
  if (!window.PAYSTACK_PUBLIC_KEY) {
    alert('Payment is not configured yet. Add your Paystack public key to firebase-config.js, then reload SchoolHub.');
    return;
  }
  if (!firebase.functions || !window.PaystackPop) {
    alert('Payment services are still loading. Please refresh and try again.');
    return;
  }
  const btn = document.querySelector(`[data-buy-credits="${pack.id}"]`);
  checkoutBusy = true;
  const paymentSchool = currentSchoolId;
  const paymentUid = currentUid;
  const pendingKey = pendingPaymentKey();
  let popupStarted = false;
  if (btn) { btn.disabled = true; btn.textContent = 'Opening payment…'; }
  try {
    const init = await billingFunctions().httpsCallable('initializeReportCreditPurchase')({ packageId: pack.id });
    const data = init.data || {};
    if (!data.accessCode || !data.reference || data.mode !== 'test') throw new Error('A valid test checkout was not returned.');
    localStorage.setItem(pendingKey, data.reference);
    if (currentSchoolId !== paymentSchool || currentUid !== paymentUid) return;
    await renderBilling();
    const popup = new PaystackPop();
    popup.resumeTransaction(data.accessCode, {
      onSuccess: () => {
        checkoutBusy = false;
        if (currentSchoolId === paymentSchool && currentUid === paymentUid) verifyPendingCreditPayment(data.reference);
      },
      onCancel: () => { checkoutBusy = false; renderBilling(); },
      onError: () => { checkoutBusy = false; alert('Checkout could not open. Your payment reference is saved; use Verify Payment if you already paid.'); renderBilling(); }
    });
    popupStarted = true;
  } catch (e) {
    console.error('Credit purchase initialization failed:', e);
    alert(e.message || 'Unable to start payment.');
  } finally {
    if (!popupStarted) checkoutBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = `Buy ${pack.credits}`; }
  }
}
async function verifyPendingCreditPayment(reference) {
  if (verificationBusy) return;
  reference = String(reference || pendingPaymentReference()).trim();
  if (!reference) { alert('No pending payment reference was found.'); return; }
  if (!isHeadTeacher()) { alert('Only the Head Teacher can verify a purchase.'); return; }
  verificationBusy = true;
  const paymentSchool = currentSchoolId;
  const paymentUid = currentUid;
  const pendingKey = pendingPaymentKey();
  try {
    const result = await billingFunctions().httpsCallable('verifyReportCreditPurchase')({ reference });
    if (!result.data?.credited) throw new Error('Payment has not been confirmed yet.');
    if (localStorage.getItem(pendingKey) === reference) localStorage.removeItem(pendingKey);
    if (currentSchoolId !== paymentSchool || currentUid !== paymentUid) return;
    if (result.data.mode !== 'test') setLocalBillingBalance(Number(result.data.balance || 0));
    auditAction('purchase', 'report-credit', reference, `Purchased report credits. Payment reference: ${reference}.`);
    await renderBilling();
    alert(`Payment verified successfully. Your school now has ${Number(result.data?.balance || 0)} ${result.data.mode === 'test' ? 'test credits. No real money was charged' : 'report credits'}.`);
  } catch (e) {
    console.error('Payment verification failed:', e);
    alert(e.message || 'Payment could not be verified yet. If you just paid, wait a moment and try Verify Payment again.');
  } finally {
    verificationBusy = false;
  }
}
async function renderBilling() {
  const wrap = document.getElementById('billingWrap');
  if (!wrap) return;
  if (BILLING_SUSPENDED && !isBillingTestMode()) {
    wrap.innerHTML = `<div class="billing-card"><h3>Billing &amp; Credits</h3><p class="hint">Billing and report credits are temporarily suspended while SchoolHub is being updated. No payment or credit is required during this period.</p></div>`;
    return;
  }
  if (!FIREBASE_ENABLED || !currentSchoolId) {
    wrap.innerHTML = `<div class="billing-card"><h3>School Billing</h3><p class="hint">Billing and report credits are available after you sign in to a school account.</p></div>`;
    return;
  }
  const billingSchool = currentSchoolId;
  await refreshBillingAccount(true);
  if (billingSchool !== currentSchoolId) return;
  const balance = displayedBillingBalance();
  const school = DB.get(KEYS.settings, {}).schoolName || 'Your School';
  const head = isHeadTeacher();
  const pending = pendingPaymentReference();
  let recent = [];
  if (head) {
    try {
      const records = await schoolRef().collection('billingTransactions').where('uid', '==', currentUid).get();
      recent = records.docs.map(d => ({ reference: d.id, ...d.data() })).sort((a,b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)).slice(0, 10);
    } catch (e) { console.warn('Payment history unavailable'); }
  }
  if (billingSchool !== currentSchoolId) return;
  wrap.innerHTML = `
    ${isBillingTestMode() ? `<div class="billing-note"><strong>Paystack test checkout</strong><span>No real money is charged. Test credits are separate from live credits. ${reportBillingMessage()}</span></div>` : ''}
    <div class="billing-summary-card">
      <div><span class="billing-kicker">${escapeHtml(school)}</span><h3>Report Credits</h3><p class="hint">School-owned credits shared by authorized teachers.</p></div>
      <div class="billing-balance"><strong>${balance}</strong><span>${isBillingTestMode() ? 'test credits' : 'credits'}</span><small>GH₵${(balance * REPORT_CREDIT_PRICE_GHS).toFixed(2)} ${isBillingTestMode() ? 'test value (no real money)' : 'remaining value'}</small></div>
    </div>
    <div class="billing-info-grid">
      <div class="billing-info-card"><strong>${testCreditDeductionsEnabled() ? 'Test credits' : BILLING_SUSPENDED ? 'Free' : 'GH₵0.20'}</strong><span>${testCreditDeductionsEnabled() ? '1 per premium single report or per report in a batch' : BILLING_SUSPENDED ? 'all report generation while billing is disabled' : 'per generated report card'}</span></div>
      <div class="billing-info-card"><strong>Free</strong><span>students, classes, grades, attendance and remarks</span></div>
      <div class="billing-info-card"><strong>Free preview</strong><span>report themes can be previewed before purchase</span></div>
    </div>
    ${head ? `<div class="billing-section"><div class="billing-section-head"><div><h3>Buy Report Credits</h3><p class="hint">The Head Teacher purchases credits for the whole school. Teachers never pay individually.</p></div></div><div class="billing-packages">${REPORT_CREDIT_PACKAGES.map(p => `<article class="billing-package"><strong>${p.credits}</strong><span>report credits</span><b>GH₵${p.amount.toFixed(2)}</b><small>GH₵0.20 each</small><button type="button" class="btn-primary" data-buy-credits="${p.id}">Buy ${p.credits}</button></article>`).join('')}</div></div>` : `<div class="billing-section"><h3>School Credits</h3><p class="hint">Your Head Teacher manages purchases for the school. ${BILLING_SUSPENDED ? reportBillingMessage() : "Your report generation uses the school's shared credit balance."}</p></div>`}
    ${head && pending ? `<div class="billing-pending"><strong>Payment pending</strong><span>Reference: ${escapeHtml(pending)}</span><button type="button" id="verifyBillingPaymentBtn" class="btn-primary">Verify Payment</button></div>` : ''}
    ${head && recent.length ? `<div class="billing-section"><h3>Recent payments</h3>${recent.map(p => `<div class="billing-pending"><span>${escapeHtml(p.reference)} · ${Number(p.credits)} ${p.mode === 'test' ? 'test ' : ''}credits · ${escapeHtml(p.status)}</span><button type="button" class="btn-primary" data-verify-payment="${escapeHtml(p.reference)}">${p.status === 'credited' ? 'Check receipt' : 'Verify Payment'}</button></div>`).join('')}</div>` : ''}
    <div class="billing-note"><strong>How it works</strong><span>${BILLING_SUSPENDED ? reportBillingMessage() : 'One generated report card uses one credit. Printing or downloading that generated report does not charge another credit. Credits belong to the school and can be used by authorized teachers.'}</span></div>
  `;
  wrap.querySelectorAll('[data-buy-credits]').forEach(b => b.addEventListener('click', () => buyReportCredits(b.dataset.buyCredits)));
  wrap.querySelectorAll('[data-verify-payment]').forEach(b => b.addEventListener('click', () => verifyPendingCreditPayment(b.dataset.verifyPayment)));
  document.getElementById('verifyBillingPaymentBtn')?.addEventListener('click', () => verifyPendingCreditPayment());
}

/* ---------- PDF generation ---------- */
const INK = [22, 36, 28];
const GOLD = [162, 128, 33];
const RED_INK = [150, 55, 40];

// Looks up the assigned Class Teacher (per class) and Head Teacher (per
// school, from Setup) staff records, returning their names and uploaded
// signature images (if any) for use on the report card.
function getStaffSignatures(classInfo, settings, resolvedAssets) {
  const staffList = DB.get(KEYS.staff, []);
  const classTeacherId = classInfo && classInfo.classTeacherId ? classInfo.classTeacherId : '';
  const headTeacherId = settings && settings.headTeacherId ? settings.headTeacherId : '';
  const classTeacher = classTeacherId ? staffList.find(s => s.id === classTeacherId) : null;
  const headTeacher = headTeacherId ? staffList.find(s => s.id === headTeacherId) : null;
  return {
    classTeacherName: (resolvedAssets && resolvedAssets.classTeacherName) || (classTeacher ? classTeacher.name : ''),
    classTeacherSignature: resolvedAssets && resolvedAssets.classTeacherSignature !== undefined
      ? resolvedAssets.classTeacherSignature : (classTeacher ? (classTeacher.signatureUrl || classTeacher.signature || '') : ''),
    headTeacherName: (resolvedAssets && resolvedAssets.headTeacherName) || (headTeacher ? headTeacher.name : ''),
    headTeacherSignature: resolvedAssets && resolvedAssets.headTeacherSignature !== undefined
      ? resolvedAssets.headTeacherSignature : (headTeacher ? (headTeacher.signatureUrl || headTeacher.signature || '') : '')
  };
}

function drawReportPage(doc, result, settings, positions, numOnRoll, classInfo, studentRemarks, resolvedAssets) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const left = 12, right = pageWidth - 12, contentW = right - left;

  // AlatiphA SchoolHub PWA palette: teal/green primary, gold accent,
  // warm paper and white content surfaces. Avoid pure black in the report.
  const theme = getReportTheme(settings);
  const PRIMARY = theme.primary;
  const PRIMARY_DARK = theme.dark;
  const TEXT = theme.text;
  const GOLD = theme.accent;
  const PAPER = theme.paper;
  const LIGHT = theme.light;
  const PALE_GREEN = theme.pale;
  const MUTED = theme.muted;
  const RED = theme.red;
  const WHITE = theme.white;
  const RULE = theme.rule;
  const BORDERLESS = !!theme.borderless;

  const setFill = c => doc.setFillColor(c[0], c[1], c[2]);
  const setText = c => doc.setTextColor(c[0], c[1], c[2]);
  const setDraw = c => doc.setDrawColor(c[0], c[1], c[2]);
  const safe = v => (v === undefined || v === null || v === '' ? '-' : String(v));

  // Page background.
  setFill(PAPER);
  doc.rect(0, 0, pageWidth, pageHeight, 'F');

  // Compact branded header. Year and term are intentionally NOT repeated here;
  // they are already shown in TERM SUMMARY.
  setFill(PRIMARY_DARK);
  doc.roundedRect(left, 8, contentW, theme.headerH, theme.headerRadius, theme.headerRadius, 'F');
  setFill(GOLD);
  doc.roundedRect(left, 8 + theme.headerH - 3, contentW, 3, 1.5, 1.5, 'F');

  const logoImage = resolvedAssets && resolvedAssets.logo !== undefined ? resolvedAssets.logo : settings.logo;
  const photoImage = resolvedAssets && resolvedAssets.photo !== undefined ? resolvedAssets.photo : result.student.photo;

  if (logoImage) {
    try { doc.addImage(logoImage, 'PNG', left + 5, 12, 27, 27); }
    catch (e) { try { doc.addImage(logoImage, 'JPEG', left + 5, 12, 27, 27); } catch (e2) {} }
  }

  if (photoImage) {
    const pw = 25, ph = 30;
    try { doc.addImage(photoImage, 'PNG', right - pw - 5, 11, pw, ph); }
    catch (e) { try { doc.addImage(photoImage, 'JPEG', right - pw - 5, 11, pw, ph); } catch (e2) {} }
    // Student photo is intentionally borderless so no gold frame competes with the portrait.
  }

  const schoolName = (settings.schoolName && settings.schoolName.trim()) ? settings.schoolName.trim() : 'School Name Not Set';
  const headerCenter = pageWidth / 2;

  // Header hierarchy: School identity is grouped together at the top;
  // report identity is visually separated below it. The header height is
  // intentionally unchanged so the rest of the report keeps its layout.
  setText(WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(schoolName, headerCenter, 18.5, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.4);
  const contact = [settings.address, settings.email].filter(Boolean).join('  •  ');
  if (contact) doc.text(contact, headerCenter, 23.5, { align: 'center' });

  // Subtle divider keeps the school identity and report identity distinct.
  setDraw([210, 235, 229]);
  doc.setLineWidth(0.35);
  doc.line(headerCenter - 34, 26.5, headerCenter + 34, 26.5);

  // Larger report title, with the SchoolHub descriptor immediately beneath it.
  setText(WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11.5);
  doc.text('TERMINAL REPORT CARD', headerCenter, 32.5, { align: 'center' });
  setText([230, 245, 240]);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.4);
  doc.text('AlatiphA SchoolHub  •  Efficient School Management', headerCenter, 38, { align: 'center' });

  // Reusable compact two-column card. Values are constrained to the card so
  // long IDs, class names and totals can never spill outside the container.
  const cardY = 52, cardH = theme.cardH, gap = 4, cardW = (contentW - gap) / 2;
  function card(x, title, rows, width = cardW) {
    setFill(WHITE); doc.roundedRect(x, cardY, width, cardH, 2.5, 2.5, 'F');
    if (!BORDERLESS) { setDraw(RULE); doc.setLineWidth(0.25); doc.roundedRect(x, cardY, width, cardH, theme.cardRadius, theme.cardRadius, 'S'); }
    setFill(PRIMARY); doc.roundedRect(x, cardY, width, 6.5, 2.5, 2.5, 'F');
    doc.rect(x, cardY + 4, width, 2.5, 'F');
    setText(WHITE); doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.text(title, x + 4, cardY + 4.5);

    const labelW = 42;
    const valueX = x + 4 + labelW;
    const valueW = width - labelW - 8;
    let yy = cardY + 12;
    rows.forEach(r => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(6.0); setText(PRIMARY_DARK);
      doc.text(r[0], x + 4, yy);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6.2); setText(TEXT);
      const lines = doc.splitTextToSize(safe(r[1]), valueW);
      doc.text(lines[0], valueX, yy);
      yy += 5.6;
    });
  }

  card(left, 'STUDENT INFORMATION', [
    ['Name:', result.student.name],
    ['Roll / ID:', result.student.admissionId || result.student.id || '-'],
    ['Class:', classInfo ? classInfo.name : ''],
    ['Position:', result.position ? ordinal(result.position) : '-']
  ]);
  card(left + cardW + gap, 'TERM SUMMARY', [
    ['Academic Year:', settings.currentYear || '-'],
    ['Term:', settings.currentTerm || '-'],
    ['Total Score:', result.totalSum],
    ['Aggregate:', result.aggregate !== null ? result.aggregate : '-']
  ]);

  const simple = settings.reportLayout === 'simple';
  const tableY = 88;
  const headers = simple
    ? ['Subject', 'Score', 'Grade', 'Position', 'Remark']
    : ['Subject', ['Class', '(50%)'], ['Exam', '(50%)'], ['Total', '(100%)'], 'Grade', 'Position', 'Remark'];
  const baseColW = simple ? [58, 22, 20, 23, 57] : [48, 20, 20, 21, 16, 19, 36];
  const baseTableW = baseColW.reduce((a, b) => a + b, 0);
  const tableW = contentW;
  const tableScale = tableW / baseTableW;
  const colW = baseColW.map(w => w * tableScale);
  const colX = [left];
  colW.forEach(w => colX.push(colX[colX.length - 1] + w));
  const headerH = simple ? 9 : 13;
  const rowH = 7.5;
  const centerCols = simple ? [1,2,3] : [1,2,3,4,5];

  setFill(PRIMARY); doc.roundedRect(left, tableY, tableW, headerH, 2.5, 2.5, 'F');
  doc.rect(left, tableY + headerH - 2.5, tableW, 2.5, 'F');
  setText(WHITE); doc.setFont('helvetica', 'bold'); doc.setFontSize(7.3);
  headers.forEach((h, i) => {
    const cx = colX[i] + colW[i] / 2;
    if (Array.isArray(h)) {
      doc.text(h[0], cx, tableY + 4.8, { align: 'center' });
      doc.setFontSize(6.2); doc.text(h[1], cx, tableY + 10.2, { align: 'center' }); doc.setFontSize(7.3);
    } else {
      doc.text(h, cx, tableY + (simple ? 5.7 : 7.7), { align: 'center' });
    }
  });

  let y = tableY + headerH;
  result.entries.forEach((en, idx) => {
    const weak = en.grade >= 7;
    const pos = positions[en.subject.id] && positions[en.subject.id][result.student.id];
    setFill(idx % 2 === 0 ? WHITE : LIGHT);
    doc.rect(left, y, tableW, rowH, 'F');
    if (!BORDERLESS) { setDraw(RULE); doc.setLineWidth(0.22); doc.rect(left, y, tableW, rowH);
      for (let i = 1; i < colX.length - 1; i++) doc.line(colX[i], y, colX[i], y + rowH); }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.1); setText(TEXT);

    const values = simple
      ? [en.subject.name, en.total, en.grade, pos ? ordinal(pos.position) : '-', en.remark]
      : [en.subject.name, en.classScaled, en.examScaled, en.total, en.grade, pos ? ordinal(pos.position) : '-', en.remark];
    values.forEach((v, i) => {
      const center = centerCols.includes(i);
      if (i === (simple ? 2 : 4) && weak) setText(RED);
      if (center) doc.text(safe(v), colX[i] + colW[i] / 2, y + 5, { align: 'center' });
      else {
        const max = colW[i] - 5;
        const lines = doc.splitTextToSize(safe(v), max);
        doc.text(lines[0], colX[i] + 2.5, y + 5);
      }
      setText(TEXT);
    });
    y += rowH;
  });

  // School Information and Learner Profile use a fixed label/value grid.
  // This prevents long labels or values from crossing the panel boundary.
  y += 5;
  const infoY = y, infoH = theme.infoH, infoGap = 4, infoW = (contentW - infoGap) / 2;
  function infoPanel(x, title, rows) {
    setFill(WHITE); doc.roundedRect(x, infoY, infoW, infoH, theme.cardRadius, theme.cardRadius, 'F');
    if (!BORDERLESS) { setDraw(RULE); doc.setLineWidth(0.25); doc.roundedRect(x, infoY, infoW, infoH, theme.cardRadius, theme.cardRadius, 'S'); }
    setFill(PRIMARY); doc.roundedRect(x, infoY, infoW, 7, 2.5, 2.5, 'F'); doc.rect(x, infoY + 4.5, infoW, 2.5, 'F');
    setText(WHITE); doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.text(title, x + 4, infoY + 4.9);

    const labelW = 52;
    const valueX = x + 4 + labelW;
    const valueW = infoW - labelW - 8;
    let yy = infoY + 13;
    rows.forEach(r => {
      doc.setFont('helvetica','bold'); doc.setFontSize(5.5); setText(PRIMARY_DARK); doc.text(r[0], x + 4, yy);
      doc.setFont('helvetica','normal'); doc.setFontSize(6.0); setText(TEXT);
      const lines = doc.splitTextToSize(safe(r[1]), valueW);
      doc.text(lines[0], valueX, yy);
      yy += 5.2;
    });
  }

  const attOutOf = calculateTimesOpen(settings.currentTerm, settings.currentYear) || settings.attendanceOutOf || '-';
  infoPanel(left, 'SCHOOL INFORMATION', [
    ['Attendance:', `${studentRemarks.attendance || 0} out of ${attOutOf}`],
    ['Number on Roll:', numOnRoll],
    ['Promoted/Repeated:', studentRemarks.promoted || '-'],
    ['Fees Due:', `GH¢ ${studentRemarks.feesDue || '0.00'}`],
    ['Next Term Begins:', settings.nextTermBegins || '-']
  ]);
  infoPanel(left + infoW + infoGap, 'LEARNER PROFILE', [
    ['Conduct/Character:', studentRemarks.conduct || '-'],
    ['Attitude:', studentRemarks.attitude || '-'],
    ['Interest:', studentRemarks.interest || '-'],
    ["Teacher's Comment:", studentRemarks.comment || '-']
  ]);
  y = infoY + infoH + 5;

  // Three equal-width signature/date cards, arranged symmetrically:
  // Class Teacher | Date of Issue | Head Teacher.
  // Signature cards remain WHITE because uploaded signature images normally
  // have white backgrounds, while the Head Teacher card sits on the right.
  const sig = getStaffSignatures(classInfo, settings, resolvedAssets);
  const sigGap = 5, sigW = (contentW - (sigGap * 2)) / 3;
  const sigY = y, sigH = theme.signatureH;
  function signatureBox(x, title, image) {
    setFill(WHITE); doc.roundedRect(x, sigY, sigW, sigH, theme.cardRadius, theme.cardRadius, 'F');
    if (!BORDERLESS) { setDraw(RULE); doc.setLineWidth(0.25); doc.roundedRect(x, sigY, sigW, sigH, theme.cardRadius, theme.cardRadius, 'S'); }
    if (image) {
      try { doc.addImage(image, 'PNG', x + sigW/2 - 18, sigY + 2, 36, 11); }
      catch (e) { try { doc.addImage(image, 'JPEG', x + sigW/2 - 18, sigY + 2, 36, 11); } catch (e2) {} }
    }
    setDraw(PRIMARY); doc.setLineWidth(0.35); doc.line(x + 12, sigY + 13.5, x + sigW - 12, sigY + 13.5);
    setText(PRIMARY_DARK); doc.setFont('helvetica','bold'); doc.setFontSize(7.2); doc.text(title, x + sigW/2, sigY + 18.5, {align:'center'});
  }
  signatureBox(left, 'CLASS TEACHER', sig.classTeacherSignature);

  const dateX = left + sigW + sigGap;
  setFill(WHITE); doc.roundedRect(dateX, sigY, sigW, sigH, theme.cardRadius, theme.cardRadius, 'F');
  if (BORDERLESS) { setFill(PALE_GREEN); doc.rect(dateX, sigY, sigW, 1, 'F'); } else { setDraw(GOLD); doc.setLineWidth(0.5); doc.roundedRect(dateX, sigY, sigW, sigH, theme.cardRadius, theme.cardRadius, 'S'); }
  setText(PRIMARY_DARK); doc.setFont('helvetica','bold'); doc.setFontSize(6.8); doc.text('DATE OF ISSUE', dateX + sigW/2, sigY + 8, {align:'center'});
  doc.setFont('helvetica','normal'); doc.setFontSize(7.2); doc.text(new Date().toLocaleDateString(), dateX + sigW/2, sigY + 14.5, {align:'center'});
  setText(GOLD); doc.setFont('helvetica','bold'); doc.setFontSize(6); doc.text('SchoolHub', dateX + sigW/2, sigY + 19, {align:'center'});

  signatureBox(dateX + sigW + sigGap, 'HEAD TEACHER', sig.headTeacherSignature);

  // Two-line grading and remarks guides, deliberately compact so each fits
  // completely inside its container.
  y = sigY + sigH + 5;
  const legendGap = 4, legendW = (contentW - legendGap) / 2, legendH = theme.legendH;
  function legendBox(x, title, lines) {
    setFill(WHITE); doc.roundedRect(x, y, legendW, legendH, theme.cardRadius, theme.cardRadius, 'F');
    if (!BORDERLESS) { setDraw(RULE); doc.setLineWidth(0.25); doc.roundedRect(x, y, legendW, legendH, theme.cardRadius, theme.cardRadius, 'S'); }
    setFill(PRIMARY); doc.roundedRect(x, y, legendW, 6.5, 2.5, 2.5, 'F'); doc.rect(x, y + 4, legendW, 2.5, 'F');
    setText(WHITE); doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.text(title, x + 4, y + 4.5);
    let yy = y + 11;
    lines.forEach(line => { doc.setFont('helvetica','normal'); doc.setFontSize(5.8); setText(TEXT); doc.text(line, x + 4, yy); yy += 5; });
  }
  legendBox(left, 'GRADING SCALE', [
    '80-100 = 1   75-79 = 2   70-74 = 3   65-69 = 4   60-64 = 5',
    '50-59 = 6    45-49 = 7   40-44 = 8   0-39 = 9'
  ]);
  legendBox(left + legendW + legendGap, 'REMARKS GUIDE', [
    '80-100 Highly Proficient   54-79 Proficient',
    '46-53 Approaching Proficiency   40-45 Developing   0-39 Emerging'
  ]);

  // Compact footer branding.
  const footerH = theme.footerH;
  const footerY = pageHeight - footerH;
  setFill(PRIMARY_DARK); doc.rect(0, footerY, pageWidth, footerH, 'F');
  setFill(GOLD); doc.rect(0, footerY, pageWidth, theme.footerAccent, 'F');
  setText(PAPER); doc.setFont('helvetica','normal'); doc.setFontSize(6.4);
  doc.text('Phone: +233243443688', left, footerY + 6);
  doc.setFont('helvetica','bold'); doc.text('Designed with AlatiphA SchoolHub', pageWidth / 2, footerY + 6, {align:'center'});
  doc.setFont('helvetica','normal'); doc.text('Email: alatipha@ymail.com', right, footerY + 6, {align:'right'});
}

async function storageRefToDataUrl(ref) {
  if (!ref) return '';
  const meta = await ref.getMetadata();
  const bytes = await ref.getBytes(10 * 1024 * 1024);
  const mime = (meta && meta.contentType) || 'application/octet-stream';
  const blob = new Blob([bytes], { type: mime });
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read image bytes.'));
    reader.readAsDataURL(blob);
  });
}

// jsPDF is deliberately fed PNG data URLs. Firebase Storage may contain JPG,
// JPEG, WEBP, GIF, HEIC-derived browser formats, or other image MIME types.
// Returning the original data URL and then forcing addImage(..., 'PNG') is not
// safe because the declared MIME type and the jsPDF decoder can disagree.
// Normalize the already-downloaded image through a browser Image + canvas.
async function normalizeReportImage(dataUrl) {
  if (!dataUrl || !/^data:image\//i.test(String(dataUrl))) return '';
  const value = String(dataUrl);

  // PNG is already exactly what the report renderer expects.
  if (/^data:image\/png[;,]/i.test(value)) return value;

  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;
        if (!width || !height) throw new Error('Image has no usable dimensions.');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Could not create image canvas.');
        ctx.drawImage(img, 0, 0, width, height);
        const png = canvas.toDataURL('image/png');
        if (!png || png === 'data:,') throw new Error('Could not convert image to PNG.');
        resolve(png);
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error('Browser could not decode the report image.'));
    img.src = value;
  });
}

async function reportImageToDataUrl(source) {
  if (!source) return '';
  const value = String(source);

  if (/^data:image\//i.test(value)) {
    try {
      return await normalizeReportImage(value);
    } catch (err) {
      console.warn('Report data image normalization failed:', err);
      return '';
    }
  }

  // IMPORTANT: Firebase Storage getBytes() is used here instead of relying on
  // a public download URL. The browser therefore reads the object through the
  // authenticated Firebase Storage SDK and then normalizes it locally.
  if (typeof firebase !== 'undefined' && firebase.storage) {
    try {
      const ref = /^https?:\/\//i.test(value)
        ? firebase.storage().refFromURL(value)
        : firebase.storage().ref().child(value.replace(/^\/+/, ''));
      const data = await storageRefToDataUrl(ref);
      if (data) return await normalizeReportImage(data);
    } catch (err) {
      console.warn('Firebase Storage report image read/normalize failed:', value, err);
    }
  }

  // Backwards-compatible fallback for old blob/download URLs.
  if (/^blob:/i.test(value) || /^https?:\/\//i.test(value)) {
    try {
      const response = await fetch(value, { mode: 'cors', credentials: 'omit' });
      if (!response.ok) throw new Error(`Image request failed: ${response.status}`);
      const blob = await response.blob();
      const raw = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Could not read image.'));
        reader.readAsDataURL(blob);
      });
      return await normalizeReportImage(raw);
    } catch (err) {
      console.warn('Report image URL fallback failed:', err);
    }
  }

  return '';
}

async function findStorageAssetDataUrl(folderPath, prefixes) {
  if (!FIREBASE_ENABLED || !currentSchoolId || !folderPath) return '';
  try {
    const ref = firebase.storage().ref(folderPath);
    const result = await ref.listAll();
    const list = Array.isArray(prefixes) ? prefixes : [prefixes];
    const item = result.items.find(it => list.some(prefix => prefix && String(it.name).indexOf(String(prefix)) === 0));
    return item ? await storageRefToDataUrl(item) : '';
  } catch (err) {
    console.warn('Report Storage lookup failed:', folderPath, err);
    return '';
  }
}

async function resolveReportAsset(primarySource, fallbackFolder, fallbackPrefixes) {
  if (primarySource) {
    const data = await reportImageToDataUrl(primarySource);
    if (data) return data;
  }
  return findStorageAssetDataUrl(fallbackFolder, fallbackPrefixes);
}

async function getOrSyncReportImage(kind, id, storagePath, sourceUrl, deterministicPath) {
  const key = imageCacheKey(kind, id);
  let data = await getCachedLocalImageAsync(key);
  if (data) return data;

  // If background synchronization has not completed yet, a report can still
  // obtain its required image without reopening the authentication gate.
  const source = storagePath || sourceUrl || deterministicPath || '';
  if (!source || !FIREBASE_ENABLED || !currentSchoolId) return '';

  try {
    const result = await syncOneCloudImage(kind, id, source.indexOf('schools/') === 0 ? source : storagePath, sourceUrl, false);
    if (result && result.ok) {
      data = await getCachedLocalImageAsync(key);
      if (data) return data;
    }
  } catch (e) {
    console.warn('On-demand report image sync failed:', kind, id, e);
  }
  return '';
}

async function prepareReportAssets(result, settings, classInfo) {
  const staffList = DB.get(KEYS.staff, []);
  const studentList = DB.get(KEYS.students, []);
  const classId = classInfo ? classInfo.id : (result && result.student ? result.student.classId : '');

  let classTeacher = classInfo && classInfo.classTeacherId
    ? staffList.find(s => s.id === classInfo.classTeacherId) : null;

  // Keep the existing role-based fallback for schools whose class assignment
  // was created before classTeacherId was stored.
  if (!classTeacher && classId) {
    const cls = DB.get(KEYS.classes, []).find(c => c.id === classId);
    if (cls && cls.classTeacherId) classTeacher = staffList.find(s => s.id === cls.classTeacherId) || null;
  }

  let headTeacher = settings && settings.headTeacherId
    ? staffList.find(s => s.id === settings.headTeacherId) : null;
  if (!headTeacher) {
    headTeacher = staffList.find(s => {
      const role = String(s.role || '').toLowerCase().replace(/\s+/g, '');
      return role === 'headteacher';
    }) || null;
  }

  // Never trust the stale student object captured by an earlier render.
  // Resolve the current local record by ID immediately before printing.
  const studentId = result && result.student ? result.student.id : '';
  const student = studentList.find(s => s.id === studentId) || (result && result.student ? result.student : null);

  const logo = settings ? (isDataImage(settings.logo) ? settings.logo : await getOrSyncReportImage('logo', 'school', settings.logoStoragePath || '', settings.logoUrl || '', `schools/${currentSchoolId}/logos/school-logo`)) : '';
  const photo = student ? (isDataImage(student.photo) ? student.photo : await getOrSyncReportImage('student', student.id, student.photoStoragePath || '', student.photoUrl || '', student.classId ? `schools/${currentSchoolId}/student-photos/${student.classId}/${student.id}` : '')) : '';
  const classTeacherSignature = classTeacher ? (isDataImage(classTeacher.signature) ? classTeacher.signature : await getOrSyncReportImage('staff', classTeacher.id, classTeacher.signatureStoragePath || '', classTeacher.signatureUrl || '', `schools/${currentSchoolId}/signatures/${classTeacher.id}`)) : '';
  const headTeacherSignature = headTeacher ? (isDataImage(headTeacher.signature) ? headTeacher.signature : await getOrSyncReportImage('staff', headTeacher.id, headTeacher.signatureStoragePath || '', headTeacher.signatureUrl || '', `schools/${currentSchoolId}/signatures/${headTeacher.id}`)) : '';

  return {
    logo,
    photo,
    classTeacherSignature,
    headTeacherSignature,
    classTeacherName: classTeacher ? classTeacher.name : '',
    headTeacherName: headTeacher ? headTeacher.name : ''
  };
}

function reportUsesCredits(settings) {
  return getReportTheme(settings).id !== 'bw';
}

async function downloadGeneratedReport(doc, filename, count, reportType = 'paid') {
  if (!enforceGuestTrial()) return;
  // Serialize before deducting, then download the same prepared PDF.
  const url = URL.createObjectURL(doc.output('blob'));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  try {
    if (reportType === 'bw-single' && isActiveGuest()) {
      if (bwFreeRemaining() <= 0) {
        alert('Your 10 free guest reports are used. Register your school to continue.');
        return;
      }
      localStorage.setItem(GUEST_BW_USAGE_KEY, String(BW_FREE_REPORT_LIMIT - bwFreeRemaining() + 1));
      renderReportCreditStatus();
    } else if (count) {
      try { await consumeReportCredits(count, crypto.randomUUID(), reportType); }
      catch (error) { alert(error.message || 'Test credits could not be deducted. The report was not downloaded.'); return; }
    }
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}
let reportGenerationBusy = false;
async function generateSinglePDF(result, positions, numOnRoll, classInfo, studentRemarks, settingsOverride) {
  if (!enforceGuestTrial() || reportGenerationBusy) return;
  reportGenerationBusy = true;
  try {
  if (!result.entries.length) { alert('No grades entered for this student yet.'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const settings = settingsOverride || DB.get(KEYS.settings, {});
  if (reportUsesCredits(settings) && !await ensureCreditsAvailable(1, 'generating a premium report card')) return;
  let assets;
  try {
    assets = await prepareReportAssets(result, settings, classInfo);
  } catch (assetError) {
    console.warn('Report image preparation failed:', assetError);
    assets = { logo: '', photo: '', classTeacherSignature: '', headTeacherSignature: '', classTeacherName: '', headTeacherName: '' };
  }
  drawReportPage(doc, result, settings, positions, numOnRoll, classInfo, studentRemarks, assets);
  await downloadGeneratedReport(doc, `${result.student.name.replace(/\s+/g, '_')}_report.pdf`, 1, reportUsesCredits(settings) ? 'paid' : 'bw-single');
  } finally { reportGenerationBusy = false; }
}

async function generateBatchPDF(results, positions, numOnRoll, classInfo, remarksAll, settingsOverride) {
  if (!enforceGuestTrial() || reportGenerationBusy) return;
  reportGenerationBusy = true;
  try {
  const usable = results.filter(r => r.entries.length > 0);
  if (!usable.length) { alert('No grades entered for this class yet.'); return; }
  const settings = settingsOverride || DB.get(KEYS.settings, {});

  // Batch report generation is always a paid feature. This applies to every
  // report theme, including the free Black & White theme. A class batch may
  // contain many report cards, so the school must have enough credits for
  // every report that will be generated.
  if (!await ensureCreditsAvailable(usable.length, 'generating the class report batch')) return;

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  for (let i = 0; i < usable.length; i++) {
    if (i > 0) doc.addPage();
    const r = usable[i];
    let assets;
    try {
      assets = await prepareReportAssets(r, settings, classInfo);
    } catch (assetError) {
      console.warn('Report image preparation failed:', assetError);
      assets = { logo: '', photo: '', classTeacherSignature: '', headTeacherSignature: '', classTeacherName: '', headTeacherName: '' };
    }
    drawReportPage(doc, r, settings, positions, numOnRoll, classInfo, remarksAll[r.student.id] || {}, assets);
  }
  await downloadGeneratedReport(doc, 'class_report_cards.pdf', usable.length);
  } finally { reportGenerationBusy = false; }
}

/* ---------- utils ---------- */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

/* ---------- Accounts (Firebase Auth) — optional, off until firebase-config.js has real values ---------- */
const FIREBASE_ENABLED = !!(window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey && window.FIREBASE_CONFIG.apiKey !== 'YOUR_API_KEY');
const GUEST_MODE_KEY = 'arc_guest_mode';
const GUEST_TRIAL_KEY = 'arc_guest_trial_started';
const GUEST_TRIAL_DURATION = 7 * 24 * 60 * 60 * 1000;

function guestTrialRemaining(now = Date.now()) {
  const raw = localStorage.getItem(GUEST_TRIAL_KEY);
  if (raw === null) return GUEST_TRIAL_DURATION;
  const started = Number(raw);
  if (!Number.isFinite(started) || started <= 0 || started > now) return 0;
  return Math.max(0, started + GUEST_TRIAL_DURATION - now);
}

function isActiveGuest() {
  return !currentUid && !currentSchoolId && sessionReady
    && localStorage.getItem(GUEST_MODE_KEY) === '1' && guestTrialRemaining() > 0;
}

function updateGuestTrialUI() {
  const remaining = guestTrialRemaining();
  const button = document.getElementById('authGuestBtn');
  button.disabled = remaining <= 0;
  button.textContent = remaining <= 0 ? 'Guest trial ended — register your school'
    : localStorage.getItem(GUEST_TRIAL_KEY) === null ? 'Start 7-day guest trial'
    : `Continue guest trial (${Math.ceil(remaining / 86400000)} days left)`;
  document.getElementById('guestTrialNotice').textContent = remaining <= 0
    ? 'Your guest trial has ended. Create an account and register your school to continue. Your guest data is still saved on this device.'
    : 'Try SchoolHub for 7 days, then create an account and register your school. Guest data is saved on this device only.';
}

function enforceGuestTrial() {
  if (currentUid || currentSchoolId || localStorage.getItem(GUEST_MODE_KEY) !== '1') return true;
  // Existing guests receive their first seven-day window when opening this update.
  if (localStorage.getItem(GUEST_TRIAL_KEY) === null) localStorage.setItem(GUEST_TRIAL_KEY, String(Date.now()));
  if (guestTrialRemaining() > 0) return true;
  sessionReady = false;
  sessionDataReady = false;
  hideSyncingMessage();
  showAuthGate();
  updateGuestTrialUI();
  return false;
}

// Check open tabs as well as reloads; block an expired interaction before its handler runs.
setInterval(enforceGuestTrial, 1000);
window.addEventListener('focus', enforceGuestTrial);
document.addEventListener('visibilitychange', enforceGuestTrial);
['click', 'change', 'submit', 'keydown'].forEach(type => document.addEventListener(type, event => {
  if (!enforceGuestTrial() && !event.target.closest('#authGate, #lockScreen')) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true));
let authMode = 'login'; // 'login' or 'signup', toggled in the gate

function hasExistingLocalData() {
  const candidates = ['arc_classes'];
  if (currentUid) candidates.push(`arc_classes__${currentUid}`);
  return candidates.some(k => {
    try { const v = JSON.parse(localStorage.getItem(k)); return Array.isArray(v) && v.length > 0; } catch (e) { return false; }
  });
}

// One-time copy of this device's pre-schools local data into a
// brand-new school at the moment it's registered — so a Head Teacher
// who already used the app solo doesn't see everything appear empty.
// Never runs for "Join a school" — that would mean injecting one
// device's old data into someone else's school.
function migrateDataIntoSchool(schoolId) {
  const legacyKeys = ['arc_settings', 'arc_classes', 'arc_subjects', 'arc_students', 'arc_grades', 'arc_attendance', 'arc_teacher_attendance', 'arc_school_calendar', 'arc_remarks', 'arc_staff'];
  legacyKeys.forEach(base => {
    const schoolKey = `${base}__${schoolId}`;
    if (localStorage.getItem(schoolKey) !== null) return;
    const uidKey = currentUid ? `${base}__${currentUid}` : null;
    const source = (uidKey && localStorage.getItem(uidKey) !== null) ? uidKey : (localStorage.getItem(base) !== null ? base : null);
    if (source) localStorage.setItem(schoolKey, localStorage.getItem(source));
  });
}

/* ---------- Cloud Sync (Firestore) ----------
   Phase 3 uses school-scoped subcollections instead of one large shared
   school document. Teachers only download and write documents for their
   assigned classes/subjects. Head Teachers can synchronize the whole school.
*/
const LAST_SYNCED_KEY = 'arc_last_synced';
const CLOUD_SCHEMA_VERSION = 4;

function schoolRef() {
  return firebase.firestore().collection('schools').doc(currentSchoolId);
}

function classRef(id) {
  return schoolRef().collection('classes').doc(id);
}

function studentRef(id) {
  return schoolRef().collection('students').doc(id);
}

function subjectRef(id) {
  return schoolRef().collection('subjects').doc(id);
}

// Firestore document IDs cannot contain path separators.
// Local SchoolHub keys may contain '/' in academic years such as 2025/2026.
// Encode the complete local key for Firestore, then decode it when reading back.
function cloudKey(key) {
  return encodeURIComponent(String(key));
}

function localKeyFromCloudId(id) {
  try {
    return decodeURIComponent(String(id));
  } catch (e) {
    return String(id);
  }
}

function gradeRef(key) {
  return schoolRef().collection('grades').doc(cloudKey(key));
}

function remarkRef(key) {
  return schoolRef().collection('remarks').doc(cloudKey(key));
}
function attendanceRef(key) {
  return schoolRef().collection('attendance').doc(cloudKey(key));
}
function teacherAttendanceRef(key) {
  return schoolRef().collection('teacherAttendance').doc(cloudKey(key));
}
function schoolCalendarRef(key) {
  return schoolRef().collection('schoolCalendar').doc(cloudKey(key));
}

function staffRef(id) {
  return schoolRef().collection('staff').doc(id);
}

// v32: Firestore is the authoritative image manifest. Firebase Storage holds
// the binary, while this collection tells every browser exactly which image
// belongs to which school record. This avoids relying on Storage folder listing.
function imageAssetDocId(kind, id) {
  return encodeURIComponent(`${kind}__${id}`);
}

function imageAssetRef(kind, id) {
  return schoolRef().collection('imageAssets').doc(imageAssetDocId(kind, id));
}

function upsertImageManifest(kind, id, data) {
  if (!FIREBASE_ENABLED || !currentSchoolId || !kind || !id) return Promise.resolve();
  const payload = Object.assign({
    kind: String(kind),
    recordId: String(id),
    schoolId: String(currentSchoolId),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, data || {});
  return imageAssetRef(kind, id).set(payload, { merge: true });
}

function removeImageManifest(kind, id) {
  if (!FIREBASE_ENABLED || !currentSchoolId || !kind || !id) return Promise.resolve();
  return imageAssetRef(kind, id).delete().catch(() => {});
}


/* ---------- Firebase Storage ---------- */
function storageRef(path) {
  return firebase.storage().ref().child(path);
}

function schoolAssetPath(file, kind, id) {
  // v21: one deterministic Storage object per asset. Re-uploading the same
  // student's photo, staff signature, or school logo replaces the old object
  // instead of creating another file with a different name.
  if (!currentSchoolId) return '';
  if (kind === 'student-photos' && id && String(id).indexOf('/') !== -1) {
    const parts = String(id).split('/');
    return `schools/${currentSchoolId}/student-photos/${parts[0]}/${parts[1]}`;
  }
  return `schools/${currentSchoolId}/${kind}/${id || uid()}`;
}

function fileToDataUrl(file) {
  if (!file) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read image file.'));
    reader.readAsDataURL(file);
  });
}

// v23 local image architecture:
// localStorage contains structured application data only.
// IndexedDB contains image data. Firebase Storage remains the cloud backup.
const IMAGE_DB_NAME = 'AlatiphA-SchoolHub-Images';
const IMAGE_DB_VERSION = 3;
const IMAGE_DB_STORE = 'images';
let imageDbPromise = null;
const imageMemoryCache = new Map();

// Missing cloud images are optional. Remember Storage 404s for this session so
// stale Firestore photo metadata cannot trigger the same failed request over
// and over while the rest of SchoolHub is synchronizing.
const missingCloudImageCache = new Map();
const MISSING_CLOUD_IMAGE_TTL_MS = 30 * 60 * 1000;

function missingCloudImageKey(kind, id) {
  return `${currentSchoolId || 'local'}__${kind || 'image'}__${id || 'default'}`;
}

function isMissingStorageObjectError(error) {
  if (!error) return false;
  const code = String(error.code || '').toLowerCase();
  const message = String(error.message || error || '').toLowerCase();
  return code === 'storage/object-not-found' ||
    code === 'object-not-found' ||
    /(^|\D)404(\D|$)/.test(message) ||
    message.includes('object does not exist') ||
    message.includes('object-not-found');
}

function rememberMissingCloudImage(kind, id) {
  missingCloudImageCache.set(missingCloudImageKey(kind, id), Date.now() + MISSING_CLOUD_IMAGE_TTL_MS);
}

function isKnownMissingCloudImage(kind, id) {
  const key = missingCloudImageKey(kind, id);
  const until = Number(missingCloudImageCache.get(key) || 0);
  if (!until) return false;
  if (Date.now() >= until) {
    missingCloudImageCache.delete(key);
    return false;
  }
  return true;
}

function clearMissingCloudImage(kind, id) {
  missingCloudImageCache.delete(missingCloudImageKey(kind, id));
}

function stripImagesForLocalStorage(key, value) {
  if (key === KEYS.settings && value && typeof value === 'object') {
    const c = Object.assign({}, value);
    delete c.logo;
    return c;
  }
  if (key === KEYS.students && Array.isArray(value)) {
    return value.map(s => { const c = Object.assign({}, s); delete c.photo; return c; });
  }
  if (key === KEYS.staff && Array.isArray(value)) {
    return value.map(s => { const c = Object.assign({}, s); delete c.signature; return c; });
  }
  return value;
}

function restoreLocalImagesForDbKey(key, value) {
  if (key === KEYS.settings && value && typeof value === 'object') {
    const logo = imageMemoryCache.get(imageCacheKey('logo', 'school')) || '';
    return logo ? Object.assign({}, value, { logo }) : value;
  }
  if (key === KEYS.students && Array.isArray(value)) {
    return value.map(s => {
      const photo = imageMemoryCache.get(imageCacheKey('student', s.id)) || '';
      return photo ? Object.assign({}, s, { photo }) : s;
    });
  }
  if (key === KEYS.staff && Array.isArray(value)) {
    return value.map(s => {
      const signature = imageMemoryCache.get(imageCacheKey('staff', s.id)) || '';
      return signature ? Object.assign({}, s, { signature }) : s;
    });
  }
  return value;
}

function openImageDB() {
  if (imageDbPromise) return imageDbPromise;
  imageDbPromise = new Promise(resolve => {
    try {
      if (!window.indexedDB) return resolve(null);
      const req = indexedDB.open(IMAGE_DB_NAME, IMAGE_DB_VERSION);
      req.onupgradeneeded = () => {
        try {
          if (!req.result.objectStoreNames.contains(IMAGE_DB_STORE)) req.result.createObjectStore(IMAGE_DB_STORE);
        } catch (e) {}
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
  return imageDbPromise;
}

function cacheLocalImage(cacheKey, dataUrl) {
  return cacheLocalImageWithMeta(cacheKey, dataUrl, null);
}

function getCachedLocalImage(cacheKey) {
  return cacheKey ? (imageMemoryCache.get(cacheKey) || '') : '';
}

function getCachedLocalImageAsync(cacheKey) {
  const fast = getCachedLocalImage(cacheKey);
  if (fast) return Promise.resolve(fast);
  return openImageDB().then(db => new Promise(resolve => {
    if (!db) return resolve('');
    try {
      const tx = db.transaction(IMAGE_DB_STORE, 'readonly');
      const req = tx.objectStore(IMAGE_DB_STORE).get(cacheKey);
      req.onsuccess = () => {
        const raw = req.result;
        const value = raw && typeof raw === 'object' && raw.dataUrl ? String(raw.dataUrl) : String(raw || '');
        if (value) imageMemoryCache.set(cacheKey, value);
        resolve(value);
      };
      req.onerror = () => resolve('');
    } catch (e) { resolve(''); }
  }));
}

function getImageCacheCount() {
  return openImageDB().then(db => new Promise(resolve => {
    if (!db) return resolve(null);
    try {
      const tx = db.transaction(IMAGE_DB_STORE, 'readonly');
      const req = tx.objectStore(IMAGE_DB_STORE).count();
      req.onsuccess = () => resolve(Number(req.result || 0));
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  })).catch(() => null);
}

function removeCachedLocalImage(cacheKey) {
  if (!cacheKey) return;
  imageMemoryCache.delete(cacheKey);
  openImageDB().then(db => {
    if (!db) return;
    try { db.transaction(IMAGE_DB_STORE, 'readwrite').objectStore(IMAGE_DB_STORE).delete(cacheKey); } catch (e) {}
  });
}

async function migrateLegacyImageLocalStorage() {
  const legacy = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.indexOf('schoolhub_image__') === 0) legacy.push(key);
    }
  } catch (e) {}
  for (const fullKey of legacy) {
    try {
      const cacheKey = fullKey.substring('schoolhub_image__'.length);
      const value = localStorage.getItem(fullKey) || '';
      if (cacheKey && isDataImage(value)) await cacheLocalImage(cacheKey, value);
      localStorage.removeItem(fullKey);
    } catch (e) { console.warn('Could not migrate legacy image cache:', fullKey, e); }
  }
}

async function migrateInlineImagesFromLocalRecords() {
  // v21/v22 could still have Base64 images embedded in the structured records.
  // Move those images into IndexedDB before replacing the records with the
  // small metadata-only versions. This is especially important for Chrome
  // installations that have already hit localStorage quota.
  const records = [
    { key: KEYS.settings, kind: 'logo', id: 'school', field: 'logo' },
    { key: KEYS.students, kind: 'student', idField: 'id', field: 'photo' },
    { key: KEYS.staff, kind: 'staff', idField: 'id', field: 'signature' }
  ];

  for (const item of records) {
    let parsed;
    try {
      const raw = localStorage.getItem(item.key);
      if (!raw) continue;
      parsed = JSON.parse(raw);
    } catch (e) {
      continue;
    }

    let changed = false;
    if (item.kind === 'logo') {
      if (parsed && isDataImage(parsed[item.field])) {
        await cacheLocalImage(imageCacheKey('logo', 'school'), parsed[item.field]);
        changed = true;
      }
    } else if (Array.isArray(parsed)) {
      for (const record of parsed) {
        const image = record && record[item.field];
        const id = record && record[item.idField];
        if (id && isDataImage(image)) {
          await cacheLocalImage(imageCacheKey(item.kind, id), image);
          changed = true;
        }
      }
    }

    if (changed) {
      const clean = stripImagesForLocalStorage(item.key, parsed);
      const payload = JSON.stringify(clean);
      try {
        localStorage.removeItem(item.key);
        localStorage.setItem(item.key, payload);
      } catch (e) {
        console.warn('Could not compact legacy image-bearing record:', item.key, e);
      }
    }
  }
}

function isDataImage(value) {
  return /^data:image\//i.test(String(value || ''));
}

function imageCacheKey(kind, id) {
  return `${currentSchoolId || 'local'}__${kind}__${id || 'default'}`;
}

async function hydrateImageCacheFromStorage(kind, id, storagePath, url) {
  const key = imageCacheKey(kind, id);
  const existing = await getCachedLocalImageAsync(key);
  if (existing) return existing;
  const source = storagePath || url || '';
  if (!source || !FIREBASE_ENABLED || !firebase.storage) return '';
  try {
    const data = await reportImageToDataUrl(source);
    if (data) {
      await cacheLocalImage(key, data);
      return data;
    }
  } catch (e) {
    console.warn('Could not hydrate local image cache:', kind, id, e);
  }
  return '';
}

async function hydrateLocalImageCaches(profile, students, staff) {
  // v27 compatibility shim. Images belong in IndexedDB only. Do not copy
  // Base64/data URLs back into localStorage records. Cloud synchronization
  // is handled by syncImagesFromCloud(), and reports read IndexedDB directly.
  return;
}


const LAST_IMAGE_SYNC_KEY = 'arc_last_image_sync';

function imageMetaKey(kind, id) {
  return imageCacheKey(kind, id) + '__meta';
}

function cacheLocalImageWithMeta(cacheKey, dataUrl, meta) {
  if (!cacheKey || !dataUrl) return Promise.resolve('');
  const value = String(dataUrl);
  imageMemoryCache.set(cacheKey, value);
  return openImageDB().then(db => {
    if (!db) return value;
    return new Promise(resolve => {
      try {
        const tx = db.transaction(IMAGE_DB_STORE, 'readwrite');
        tx.objectStore(IMAGE_DB_STORE).put({
          dataUrl: value,
          storagePath: meta && meta.storagePath ? String(meta.storagePath) : '',
          sourceUrl: meta && meta.sourceUrl ? String(meta.sourceUrl) : '',
          updatedAt: meta && meta.updatedAt ? String(meta.updatedAt) : '',
          cachedAt: Date.now()
        }, cacheKey);
        tx.oncomplete = () => resolve(value);
        tx.onerror = () => { console.warn('Could not cache image metadata:', cacheKey, tx.error); resolve(value); };
        tx.onabort = () => resolve(value);
      } catch (e) { console.warn('Could not cache image metadata:', cacheKey, e); resolve(value); }
    });
  });
}

function getCachedImageRecordAsync(cacheKey) {
  return openImageDB().then(db => new Promise(resolve => {
    if (!db) return resolve(null);
    try {
      const tx = db.transaction(IMAGE_DB_STORE, 'readonly');
      const req = tx.objectStore(IMAGE_DB_STORE).get(cacheKey);
      req.onsuccess = () => {
        const v = req.result;
        if (!v) return resolve(null);
        if (typeof v === 'string') return resolve({ dataUrl: v, storagePath: '', sourceUrl: '', updatedAt: '', cachedAt: 0 });
        resolve(v && typeof v === 'object' ? v : null);
      };
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  }));
}

async function cloudImageDescriptor(kind, id, storagePath, sourceUrl) {
  if (!storagePath && !sourceUrl) return null;
  let updatedAt = '';
  try {
    const ref = storagePath ? storageRef(storagePath) : firebase.storage().refFromURL(sourceUrl);
    const meta = await ref.getMetadata();
    updatedAt = meta && meta.updated ? String(meta.updated) : '';
    clearMissingCloudImage(kind, id);
    return { storagePath: storagePath || (meta && meta.fullPath ? meta.fullPath : ''), sourceUrl: sourceUrl || '', updatedAt, missing: false };
  } catch (e) {
    const missing = isMissingStorageObjectError(e);
    if (missing) rememberMissingCloudImage(kind, id);
    return { storagePath: storagePath || '', sourceUrl: sourceUrl || '', updatedAt: '', missing };
  }
}

async function blobToDataUrlForSync(blob) {
  if (!blob) throw new Error('Storage returned an empty response.');
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not convert downloaded image.'));
    reader.readAsDataURL(blob);
  });
}

async function fetchImageUrlForSync(url) {
  if (!url) throw new Error('No download URL was available.');
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 20000) : null;
  try {
    const response = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller ? controller.signal : undefined
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
    const blob = await response.blob();
    if (!blob || !blob.size) throw new Error('Downloaded image is empty.');
    const raw = await blobToDataUrlForSync(blob);
    const normalized = await normalizeReportImage(raw);
    if (!normalized) throw new Error(`Browser could not decode image (${blob.type || 'unknown MIME'}).`);
    return normalized;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function downloadCloudImageDataUrl(descriptor) {
  const attempts = [];
  const path = descriptor && descriptor.storagePath ? String(descriptor.storagePath) : '';
  const suppliedUrl = descriptor && descriptor.sourceUrl ? String(descriptor.sourceUrl) : '';

  // v34: Prefer a fresh Firebase download URL + ordinary CORS fetch. This
  // avoids browser-specific failures in Storage getBytes(), while keeping the
  // Storage rules unchanged. The SDK is retained as a fallback.
  if (path && FIREBASE_ENABLED && firebase.storage) {
    try {
      const ref = storageRef(path);
      const freshUrl = await ref.getDownloadURL();
      const data = await fetchImageUrlForSync(freshUrl);
      return { data, method: 'fresh-download-url', attempts };
    } catch (e) {
      attempts.push(`fresh-download-url: ${formatImageSyncError(e)}`);
    }
    try {
      const ref = storageRef(path);
      const bytes = await ref.getBytes(10 * 1024 * 1024);
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const raw = await blobToDataUrlForSync(blob);
      const data = await normalizeReportImage(raw);
      if (!data) throw new Error('Browser could not decode Storage bytes.');
      return { data, method: 'storage-sdk-bytes', attempts };
    } catch (e) {
      attempts.push(`storage-sdk-bytes: ${formatImageSyncError(e)}`);
    }
  }

  if (suppliedUrl) {
    try {
      const data = await fetchImageUrlForSync(suppliedUrl);
      return { data, method: 'manifest-download-url', attempts };
    } catch (e) {
      attempts.push(`manifest-download-url: ${formatImageSyncError(e)}`);
    }
  }

  const message = attempts.length ? attempts.join(' | ') : 'No usable Storage path or download URL.';
  const err = new Error(message);
  err.syncAttempts = attempts;
  throw err;
}

function formatImageSyncError(error) {
  if (!error) return 'Unknown error';
  const code = error.code ? String(error.code) : '';
  const message = error.message ? String(error.message) : String(error);
  return code ? `${code}: ${message}` : message;
}

async function syncOneCloudImage(kind, id, storagePath, sourceUrl, force) {
  const key = imageCacheKey(kind, id);

  if (!force && isKnownMissingCloudImage(kind, id)) {
    return { ok: false, skipped: true, key, kind, id, errorMessage: 'Cloud image is missing; using placeholder/local cache.' };
  }

  const descriptor = await cloudImageDescriptor(kind, id, storagePath, sourceUrl);
  if (!descriptor) return { ok: false, skipped: true, key, kind, id, errorMessage: 'No image descriptor.' };
  if (descriptor.missing) {
    return { ok: false, skipped: true, key, kind, id, errorMessage: 'Cloud image is missing; using placeholder/local cache.' };
  }

  const existing = await getCachedImageRecordAsync(key);
  const existingUrl = existing && existing.dataUrl ? existing.dataUrl : (getCachedLocalImage(key) || '');
  const samePath = existing && descriptor.storagePath && existing.storagePath === descriptor.storagePath;
  const sameVersion = samePath && descriptor.updatedAt && existing.updatedAt && descriptor.updatedAt === existing.updatedAt;
  if (!force && existingUrl && (sameVersion || (samePath && !descriptor.updatedAt))) {
    imageMemoryCache.set(key, existingUrl);
    return { ok: true, downloaded: false, key, kind, id };
  }

  try {
    const result = await downloadCloudImageDataUrl(descriptor);
    await cacheLocalImageWithMeta(key, result.data, descriptor);
    return { ok: true, downloaded: true, key, kind, id, method: result.method, attempts: result.attempts };
  } catch (e) {
    console.warn('Image sync failed:', kind, id, e);
    return {
      ok: false,
      skipped: false,
      key,
      kind,
      id,
      error: e,
      errorMessage: formatImageSyncError(e),
      attempts: e && e.syncAttempts ? e.syncAttempts : []
    };
  }
}

async function storageItemDescriptor(item) {
  if (!item) return null;
  try {
    const meta = await item.getMetadata();
    const sourceUrl = await item.getDownloadURL();
    return {
      storagePath: (meta && meta.fullPath) ? String(meta.fullPath) : String(item.fullPath || ''),
      sourceUrl: sourceUrl || '',
      updatedAt: meta && meta.updated ? String(meta.updated) : ''
    };
  } catch (e) {
    console.warn('Could not read Storage image metadata:', item && item.fullPath, e);
    return null;
  }
}

async function discoverStorageImageInventory() {
  const found = [];
  if (!FIREBASE_ENABLED || !currentSchoolId || !firebase.storage) return found;

  const schoolBase = `schools/${currentSchoolId}`;

  // Logo: deterministic v21+ location. Check Storage directly rather than
  // depending on Firestore logo metadata being present.
  try {
    const item = storageRef(`${schoolBase}/logos/school-logo`);
    const d = await storageItemDescriptor(item);
    if (d) found.push(Object.assign({ kind: 'logo', id: 'school', storageSource: 'storage' }, d));
  } catch (e) {}

  // Staff signatures: deterministic filename is the Staff ID.
  try {
    const knownStaffIds = new Set(DB.get(KEYS.staff, []).map(s => String(s.id || '').trim()).filter(Boolean));
    const result = await storageRef(`${schoolBase}/signatures`).listAll();
    for (const item of (result.items || [])) {
      const staffId = String(item.name || '').trim();
      if (!staffId || !knownStaffIds.has(staffId)) continue;
      const d = await storageItemDescriptor(item);
      if (d) found.push(Object.assign({ kind: 'staff', id: staffId, storageSource: 'storage' }, d));
    }
  } catch (e) {
    console.warn('Could not discover staff signatures in Storage:', e);
  }

  // Student photos: list only classes this account can read. The deterministic
  // filename is the Student ID, allowing Storage to repair missing Firestore
  // photo metadata.
  const classIds = Array.from(accessibleClassIds());
  const knownStudents = DB.get(KEYS.students, []);
  for (const classId of classIds) {
    const studentIds = new Set(knownStudents.filter(s => String(s.classId || '') === String(classId)).map(s => String(s.id || '').trim()).filter(Boolean));
    try {
      const result = await storageRef(`${schoolBase}/student-photos/${classId}`).listAll();
      for (const item of (result.items || [])) {
        const studentId = String(item.name || '').trim();
        // Ignore legacy/randomly named duplicate Storage objects. Only a
        // deterministic Student ID can be safely mapped back to a student.
        if (!studentId || !studentIds.has(studentId)) continue;
        const d = await storageItemDescriptor(item);
        if (d) found.push(Object.assign({ kind: 'student', id: studentId, classId: String(classId), storageSource: 'storage' }, d));
      }
    } catch (e) {
      console.warn('Could not discover student photos for class:', classId, e);
    }
  }

  return found;
}

function mergeImageInventoryItems(baseItems, storageItems) {
  const map = new Map();
  (baseItems || []).forEach(item => {
    if (!item || !item.kind || !item.id) return;
    map.set(`${item.kind}__${item.id}`, Object.assign({}, item));
  });

  // Storage is authoritative for the actual binary. If Storage discovery finds
  // an asset, prefer that exact path over stale or missing Firestore metadata.
  (storageItems || []).forEach(item => {
    if (!item || !item.kind || !item.id) return;
    const key = `${item.kind}__${item.id}`;
    const existing = map.get(key) || {};
    map.set(key, Object.assign({}, existing, item, { storageSource: 'storage' }));
  });
  return Array.from(map.values());
}

async function repairCloudImageMetadata(inventory) {
  if (!FIREBASE_ENABLED || !currentSchoolId || !isHeadTeacher()) return 0;
  let repaired = 0;

  for (const item of (inventory || [])) {
    if (!item || !item.storagePath || !item.sourceUrl) continue;
    try {
      if (item.kind === 'logo') {
        const snap = await schoolRef().get();
        const profile = snap.exists ? (snap.data().profile || {}) : {};
        if (profile.logoStoragePath !== item.storagePath || profile.logoUrl !== item.sourceUrl) {
          await schoolRef().set({
            profile: {
              logoStoragePath: item.storagePath,
              logoUrl: item.sourceUrl,
              updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }
          }, { merge: true });
          repaired++;
        }
      } else if (item.kind === 'staff') {
        const ref = staffRef(item.id);
        const snap = await ref.get();
        if (!snap.exists) continue;
        const current = snap.data() || {};
        if (current.signatureStoragePath !== item.storagePath || current.signatureUrl !== item.sourceUrl) {
          await ref.set({
            signatureStoragePath: item.storagePath,
            signatureUrl: item.sourceUrl,
            signatureUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          repaired++;
        }
      } else if (item.kind === 'student') {
        const ref = studentRef(item.id);
        const snap = await ref.get();
        if (!snap.exists) continue;
        const current = snap.data() || {};
        if (item.classId && current.classId && String(current.classId) !== String(item.classId)) continue;
        if (current.photoStoragePath !== item.storagePath || current.photoUrl !== item.sourceUrl) {
          await ref.set({
            photoStoragePath: item.storagePath,
            photoUrl: item.sourceUrl,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          repaired++;
        }
      }
    } catch (e) {
      console.warn('Could not repair cloud image metadata:', item.kind, item.id, e);
    }
  }
  return repaired;
}

async function getCloudImageInventory(options) {
  const opts = options || {};
  const firestoreItems = [];
  if (!FIREBASE_ENABLED || !currentSchoolId) return firestoreItems;

  // v32: Firestore imageAssets is the authoritative manifest. Every browser
  // can read the same manifest without needing permission to list Storage
  // folders. This is the cloud-to-browser synchronization contract.
  try {
    const snap = await pullImageAssetsForAccess();
    snap.forEach(doc => {
      const a = doc.data() || {};
      if (!a.kind || !a.recordId || !a.storagePath) return;
      firestoreItems.push({
        kind: String(a.kind),
        id: String(a.recordId),
        classId: a.classId || '',
        storagePath: String(a.storagePath || ''),
        sourceUrl: String(a.sourceUrl || ''),
        storageUpdatedAt: String(a.storageUpdatedAt || ''),
        storageSource: 'manifest'
      });
    });
  } catch (e) {
    console.warn('Could not read Firestore image manifest:', e);
  }

  // Compatibility/repair: seed the manifest from image metadata that already
  // exists on the normal school records. This is safe because the same access
  // rules already govern these records. It lets v32 migrate existing installs
  // without requiring Storage folder-list permission.
  const canRepairAll = isHeadTeacher();
  try {
    const schoolDoc = await schoolRef().get();
    const profile = schoolDoc.exists ? (schoolDoc.data().profile || {}) : {};
    if (profile.logoStoragePath || profile.logoUrl) {
      const item = { kind: 'logo', id: 'school', storagePath: profile.logoStoragePath || '', sourceUrl: profile.logoUrl || '', storageSource: 'firestore' };
      if (!firestoreItems.some(x => x.kind === item.kind && x.id === item.id) && item.storagePath) firestoreItems.push(item);
    }
  } catch (e) { console.warn('Could not read school image metadata:', e); }

  try {
    const all = canRepairAll;
    const classIds = all ? null : classIdsForCloudSync();
    const studentsSnap = await pullStudentsForAccess(all, classIds);
    studentsSnap.forEach(d => {
      const s = d.data() || {};
      if (!(s.photoStoragePath || s.photoUrl)) return;
      const item = { kind: 'student', id: d.id, storagePath: s.photoStoragePath || '', sourceUrl: s.photoUrl || '', classId: s.classId || '', storageSource: 'firestore' };
      if (!firestoreItems.some(x => x.kind === item.kind && x.id === item.id)) firestoreItems.push(item);
    });
  } catch (e) { console.warn('Could not read student image metadata:', e); }

  try {
    const staffSnap = await pullSubcollection('staff', null);
    staffSnap.forEach(d => {
      const s = d.data() || {};
      if (!(s.signatureStoragePath || s.signatureUrl)) return;
      const item = { kind: 'staff', id: d.id, storagePath: s.signatureStoragePath || '', sourceUrl: s.signatureUrl || '', storageSource: 'firestore' };
      if (!firestoreItems.some(x => x.kind === item.kind && x.id === item.id)) firestoreItems.push(item);
    });
  } catch (e) { console.warn('Could not read staff image metadata:', e); }

  // Head Teachers can repair manifest records from existing Firestore metadata.
  // Teachers only repair assets they are allowed to manage (student photos).
  const manifestKeys = new Set(firestoreItems.filter(x => x.storageSource === 'manifest').map(x => `${x.kind}__${x.id}`));
  for (const item of firestoreItems.slice()) {
    if (!item.storagePath || manifestKeys.has(`${item.kind}__${item.id}`)) continue;
    const allowed = item.kind === 'student' ? requireImageAssetWriteAccess(item) : canRepairAll;
    if (!allowed) continue;
    try {
      await upsertImageManifest(item.kind, item.id, {
        classId: item.classId || '',
        storagePath: item.storagePath,
        sourceUrl: item.sourceUrl || '',
        storageUpdatedAt: item.storageUpdatedAt || new Date().toISOString()
      });
    } catch (e) {
      console.warn('Could not seed image manifest:', item.kind, item.id, e);
    }
  }

  // Legacy deterministic-path probing is intentionally opt-in. Normal startup,
  // background sync, and Sync Center checks must never probe every student
  // photo one-by-one because stale/missing files can create a long 404 queue.
  // A future explicit repair action may call getCloudImageInventory({ probeLegacy: true }).
  if (opts.probeLegacy === true) {
    // v32 legacy recovery: when old versions uploaded an image using the
    // deterministic path but failed to create its manifest entry, probe the
    // exact known path for each authorized record. This does NOT list Storage
    // folders and therefore does not require broad Storage list permission.
    try {
      const all = isHeadTeacher();
      const classIds = all ? null : classIdsForCloudSync();
      const students = DB.get(KEYS.students, []);
      for (const st of students) {
        if (!st || !st.id || !st.classId) continue;
        if (!all && !classIds.has(st.classId)) continue;
        const path = `schools/${currentSchoolId}/student-photos/${st.classId}/${st.id}`;
        try {
          const ref = storageRef(path);
          const meta = await ref.getMetadata();
          const url = await ref.getDownloadURL();
          await upsertImageManifest('student', st.id, {
            classId: st.classId, storagePath: path, sourceUrl: url,
            storageUpdatedAt: meta && meta.updated ? String(meta.updated) : new Date().toISOString()
          });
        } catch (e) {}
      }
      const staff = DB.get(KEYS.staff, []);
      if (all) {
        for (const st of staff) {
          if (!st || !st.id) continue;
          const path = `schools/${currentSchoolId}/signatures/${st.id}`;
          try {
            const ref = storageRef(path);
            const meta = await ref.getMetadata();
            const url = await ref.getDownloadURL();
            await upsertImageManifest('staff', st.id, {
              storagePath: path, sourceUrl: url,
              storageUpdatedAt: meta && meta.updated ? String(meta.updated) : new Date().toISOString()
            });
          } catch (e) {}
        }
      }
      const logoPath = `schools/${currentSchoolId}/logos/school-logo`;
      try {
        const ref = storageRef(logoPath);
        const meta = await ref.getMetadata();
        const url = await ref.getDownloadURL();
        await upsertImageManifest('logo', 'school', {
          storagePath: logoPath, sourceUrl: url,
          storageUpdatedAt: meta && meta.updated ? String(meta.updated) : new Date().toISOString()
        });
      } catch (e) {}
    } catch (e) {
      console.warn('Could not probe deterministic legacy image paths:', e);
    }
  }

  // Re-read the manifest after seeding/probing so the returned inventory
  // represents exactly what every browser will use for synchronization.
  try {
    const snap = await pullImageAssetsForAccess();
    const manifest = [];
    snap.forEach(doc => {
      const a = doc.data() || {};
      if (!a.kind || !a.recordId || !a.storagePath) return;
      manifest.push({
        kind: String(a.kind), id: String(a.recordId), classId: a.classId || '',
        storagePath: String(a.storagePath), sourceUrl: String(a.sourceUrl || ''),
        storageUpdatedAt: String(a.storageUpdatedAt || ''), storageSource: 'manifest'
      });
    });
    return manifest;
  } catch (e) {
    // If manifest access fails, fall back to metadata-derived items rather than
    // making reports unusable.
    return firestoreItems.filter(x => x.storagePath);
  }
}

function requireImageAssetWriteAccess(item) {
  if (!item || item.kind !== 'student') return false;
  return isHeadTeacher() || (item.classId && canAccessClass(item.classId));
}


function dataUrlToBlob(dataUrl) {
  const value = String(dataUrl || '');
  const match = value.match(/^data:([^;,]+)(?:;[^,]*)?,(.*)$/i);
  if (!match) return null;
  const mime = match[1] || 'application/octet-stream';
  const body = match[2] || '';
  try {
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch (e) {
    return null;
  }
}

async function getKnownLocalImageCandidates() {
  const candidates = [];
  const add = async (kind, id, path, extra) => {
    if (!id) return;
    const key = imageCacheKey(kind, id);
    const rec = await getCachedImageRecordAsync(key);
    const dataUrl = rec && rec.dataUrl ? String(rec.dataUrl) : '';
    if (!isDataImage(dataUrl)) return;
    candidates.push(Object.assign({ kind, id: String(id), cacheKey: key, dataUrl }, extra || {}));
  };

  await add('logo', 'school', `schools/${currentSchoolId}/logos/school-logo`);

  const staff = DB.get(KEYS.staff, []);
  for (const st of staff) {
    if (!st || !st.id) continue;
    await add('staff', st.id, `schools/${currentSchoolId}/signatures/${st.id}`, {
      name: st.name || '', role: st.role || ''
    });
  }

  const students = DB.get(KEYS.students, []);
  for (const st of students) {
    if (!st || !st.id || !st.classId) continue;
    await add('student', st.id, `schools/${currentSchoolId}/student-photos/${st.classId}/${st.id}`, {
      classId: String(st.classId), name: st.name || ''
    });
  }
  return candidates;
}

async function publishLocalImagesToCloud() {
  if (!FIREBASE_ENABLED || !currentSchoolId) throw new Error('No active school cloud session.');
  if (!isHeadTeacher()) throw new Error('Only the Head Teacher can recover local images to the cloud.');

  const candidates = await getKnownLocalImageCandidates();
  if (!candidates.length) return { found: 0, published: 0, skipped: 0, failed: 0, details: [] };

  // Only use the Firestore manifest to decide whether an asset is already
  // registered. We deliberately do not list Storage folders. This preserves
  // the least-privilege Storage rules introduced in v32.
  let manifest = [];
  try {
    const snap = await pullImageAssetsForAccess();
    snap.forEach(doc => {
      const a = doc.data() || {};
      if (a.kind && a.recordId) manifest.push({ kind: String(a.kind), id: String(a.recordId), storagePath: String(a.storagePath || '') });
    });
  } catch (e) {
    throw new Error('Could not read the Firestore image manifest: ' + (e.message || e));
  }
  const registered = new Set(manifest.map(x => `${x.kind}__${x.id}`));

  let published = 0, skipped = 0, failed = 0;
  const details = [];
  for (const item of candidates) {
    const key = `${item.kind}__${item.id}`;
    if (registered.has(key)) {
      skipped++;
      details.push(`${item.kind}:${item.id} already registered`);
      continue;
    }

    const blob = dataUrlToBlob(item.dataUrl);
    if (!blob) {
      failed++;
      details.push(`${item.kind}:${item.id} invalid local image`);
      continue;
    }

    let storagePath = '';
    if (item.kind === 'logo') storagePath = `schools/${currentSchoolId}/logos/school-logo`;
    else if (item.kind === 'staff') storagePath = `schools/${currentSchoolId}/signatures/${item.id}`;
    else if (item.kind === 'student') storagePath = `schools/${currentSchoolId}/student-photos/${item.classId}/${item.id}`;
    if (!storagePath) {
      failed++;
      details.push(`${item.kind}:${item.id} no deterministic path`);
      continue;
    }

    try {
      const ref = storageRef(storagePath);
      await ref.put(blob, { contentType: blob.type || 'image/png' });
      const url = await ref.getDownloadURL();
      const meta = await ref.getMetadata();
      const updatedAt = meta && meta.updated ? String(meta.updated) : new Date().toISOString();

      const payload = {
        storagePath,
        sourceUrl: url,
        storageUpdatedAt: updatedAt,
        recoveredFromLocal: true,
        recoveredAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      if (item.kind === 'student') payload.classId = item.classId || '';
      await upsertImageManifest(item.kind, item.id, payload);

      if (item.kind === 'logo') {
        await schoolRef().set({ profile: {
          logoUrl: url,
          logoStoragePath: storagePath,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        } }, { merge: true });
      } else if (item.kind === 'staff') {
        await staffRef(item.id).set({
          signatureUrl: url,
          signatureStoragePath: storagePath,
          signatureUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } else if (item.kind === 'student') {
        await studentRef(item.id).set({
          photoUrl: url,
          photoStoragePath: storagePath,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }

      registered.add(key);
      published++;
      details.push(`${item.kind}:${item.id} registered`);
    } catch (e) {
      failed++;
      details.push(`${item.kind}:${item.id} failed: ${e.message || e}`);
    }
  }
  return { found: candidates.length, published, skipped, failed, details };
}

async function syncImagesFromCloud(options) {
  const opts = options || {};
  if (!FIREBASE_ENABLED || !currentSchoolId) return { total: 0, local: 0, downloaded: 0, failed: 0, skipped: 0, repaired: 0, details: [] };
  const inventory = await getCloudImageInventory({ probeLegacy: false });
  const repaired = await repairCloudImageMetadata(inventory);
  let downloaded = 0, failed = 0, skipped = 0, local = 0;
  const details = [];

  // Sequential downloads are deliberate. They reduce memory pressure on mobile
  // browsers and prevent several large images from being decoded simultaneously.
  for (const item of inventory) {
    const result = await syncOneCloudImage(item.kind, item.id, item.storagePath, item.sourceUrl, !!opts.force);
    const label = `${item.kind}:${item.id}`;
    if (result.ok) {
      local++;
      if (result.downloaded) {
        downloaded++;
        details.push({ kind: item.kind, id: item.id, status: 'downloaded', method: result.method || '' });
      } else {
        skipped++;
        details.push({ kind: item.kind, id: item.id, status: 'already-local', method: '' });
      }
    } else if (!result.skipped) {
      failed++;
      details.push({ kind: item.kind, id: item.id, status: 'failed', error: result.errorMessage || 'Unknown error', attempts: result.attempts || [] });
    } else {
      details.push({ kind: item.kind, id: item.id, status: 'skipped', error: result.errorMessage || '' });
    }
  }

  localStorage.setItem(LAST_IMAGE_SYNC_KEY, String(Date.now()));
  return { total: inventory.length, local, downloaded, failed, skipped, repaired, details };
}

function startBackgroundImageSync(token, uid, schoolId) {
  if (!FIREBASE_ENABLED || !schoolId) return;
  Promise.resolve().then(async () => {
    if (!isCurrentSession(token, uid, schoolId)) return;
    try {
      const result = await syncImagesFromCloud({ force: false });
      if (!isCurrentSession(token, uid, schoolId)) return;
      // Refresh lightweight status indicators without repainting the whole
      // dashboard or changing the active view.
      const countEl = document.getElementById('aboutImageCount');
      if (countEl) {
        const count = await getImageCacheCount();
        countEl.textContent = count == null ? 'Unavailable' : `${count} local images cached (IndexedDB)`;
      }
      const status = document.getElementById('aboutImageSyncStatus');
      if (status) {
        status.textContent = result.failed ? `Image sync: ${result.downloaded || 0} downloaded, ${result.failed} failed` : `Image sync complete: ${result.downloaded || 0} downloaded`;
      }
    } catch (e) {
      if (!isCurrentSession(token, uid, schoolId)) return;
      console.warn('Background image sync failed:', e);
      const status = document.getElementById('aboutImageSyncStatus');
      if (status) status.textContent = 'Image sync is pending; reports can retry when needed.';
    }
  });
}

function getLastImageSyncText() {
  const raw = localStorage.getItem(LAST_IMAGE_SYNC_KEY);
  return raw ? new Date(Number(raw)).toLocaleString() : 'never';
}

async function uploadSchoolAsset(file, kind, id) {
  if (!FIREBASE_ENABLED || !currentSchoolId || !file) return '';
  const path = schoolAssetPath(file, kind, id);
  if (!path) throw new Error('Could not determine the Firebase Storage path.');

  const ref = storageRef(path);
  let lastError = null;

  // v36: upload and download-URL generation are separate operations. A
  // successful Storage PUT must not be reported as a failed image upload just
  // because getDownloadURL briefly returns object-not-found on mobile.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await ref.put(file, { contentType: file.type || 'application/octet-stream' });
      break;
    } catch (e) {
      lastError = e;
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 500));
    }
  }
  if (lastError) throw lastError;

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await ref.getDownloadURL();
    } catch (e) {
      lastError = e;
      if (attempt < 4) await new Promise(r => setTimeout(r, attempt * 700));
    }
  }

  // The object is already in Storage. Return an empty URL and let Firestore
  // keep the deterministic storagePath. Future sync can request a fresh URL.
  console.warn('Storage upload succeeded but download URL is temporarily unavailable:', path, lastError);
  return '';
}

function persistStaffSignature(staffId, url, storagePath) {
  if (!FIREBASE_ENABLED || !currentSchoolId || !staffId) return Promise.resolve();
  if (!isHeadTeacher()) return Promise.resolve();
  const data = {
    signatureUrl: url || '',
    signatureUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  if (storagePath !== undefined) data.signatureStoragePath = storagePath || '';
  return staffRef(staffId).set(data, { merge: true });
}

function removeStorageFile(url) {
  if (!url || !FIREBASE_ENABLED) return Promise.resolve();
  try {
    return firebase.storage().refFromURL(url).delete().catch(() => {});
  } catch (e) {
    return Promise.resolve();
  }
}

function removeStoragePath(path) {
  if (!path || !FIREBASE_ENABLED) return Promise.resolve();
  try {
    return storageRef(path).delete().catch(() => {});
  } catch (e) {
    return Promise.resolve();
  }
}

function cloudChunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function deletionMarker(ref) {
  return schoolRef().collection('deletedRecords').doc(ref.parent.id + '__' + ref.id);
}
function deletionVersionsKey() { return 'arc_deletion_versions__' + currentSchoolId; }
function recordDeletionVersion(field, key) {
  return DB.get(deletionVersionsKey(), {})[field + '__' + cloudKey(key)] || null;
}
function rememberDeletions(items) {
  const versions = DB.get(deletionVersionsKey(), {});
  items.forEach(item => { versions[item.collection + '__' + item.id] = item.version || 'legacy-deletion'; });
  localStorage.setItem(deletionVersionsKey(), JSON.stringify(versions));
}
function markBatchDelete(batch, ref) {
  const marker = {collection:ref.parent.id, id:ref.id, version:crypto.randomUUID()};
  batch.set(deletionMarker(ref), {...marker, deletedAt:firebase.firestore.FieldValue.serverTimestamp()});
  batch.delete(ref);
  return marker;
}
async function deleteSchoolRecord(ref) {
  if (navigator.onLine === false || offlineAuthenticatedMode) throw new Error('Reconnect before deleting school records.');
  const batch = firebase.firestore().batch();
  const marker = markBatchDelete(batch, ref);
  await batch.commit();
  rememberDeletions([marker]);
}
function commitChunks(ops) {
  if (!ops.length) return Promise.resolve();
  const chunks = cloudChunk(ops, 220);
  return chunks.reduce((p, chunk) => p.then(() => {
    const batch = firebase.firestore().batch();
    const markers = [];
    const guarded = {set:(...args)=>batch.set(...args), create:(...args)=>batch.create(...args), delete:ref=>markers.push(markBatchDelete(batch,ref)), restore:(ref,data)=>{batch.delete(deletionMarker(ref));batch.set(ref,data,{merge:true});}};
    chunk.forEach(op => op(guarded));
    return batch.commit().then(() => { if(markers.length)rememberDeletions(markers); });
  }), Promise.resolve());
}

function stripImagesForCloud(field, value) {
  // Firebase Storage owns binary/image data. Firestore records must contain
  // only lightweight metadata/URLs. This sanitizer accepts either a whole
  // collection array or a single record because syncCollectionArray invokes
  // it one record at a time.
  const cleanStudent = student => {
    const c = Object.assign({}, student || {});
    delete c.photo;
    // Older builds could accidentally copy a data URL into photoUrl. Never
    // send that inline image back to Firestore.
    if (isDataImage(c.photoUrl)) c.photoUrl = '';
    return c;
  };
  const cleanStaff = staff => {
    const c = Object.assign({}, staff || {});
    delete c.signature;
    // Older builds could accidentally copy a data URL into signatureUrl.
    if (isDataImage(c.signatureUrl)) c.signatureUrl = '';
    return c;
  };

  if (field === 'students') {
    return Array.isArray(value) ? value.map(cleanStudent) : cleanStudent(value);
  }
  if (field === 'staff') {
    return Array.isArray(value) ? value.map(cleanStaff) : cleanStaff(value);
  }
  if (field === 'settings' && value && typeof value === 'object') {
    const c = Object.assign({}, value);
    delete c.logo;
    if (isDataImage(c.logoUrl)) c.logoUrl = '';
    return c;
  }
  return value;
}

function mergeLocalImage(field, cloudValue, id) {
  if (field === 'students') {
    const local = DB.get(KEYS.students, []).find(s => s.id === id);
    const cached = getCachedLocalImage(imageCacheKey('student', id));
    return Object.assign({}, cloudValue, { photo: (local && isDataImage(local.photo) ? local.photo : '') || cached || '' });
  }
  if (field === 'staff') {
    const local = DB.get(KEYS.staff, []).find(s => s.id === id);
    const cached = getCachedLocalImage(imageCacheKey('staff', id));
    return Object.assign({}, cloudValue, { id: String(id), signature: (local && isDataImage(local.signature) ? local.signature : '') || cached || '' });
  }
  return cloudValue;
}

function classIdsForCloudSync() {
  return new Set(accessibleClassIds());
}

function gradeEntriesForClass(classId, grades) {
  const out = {};
  Object.keys(grades || {}).forEach(key => {
    if (key.indexOf(classId + '__') === 0) out[key] = grades[key];
  });
  return out;
}

function remarkEntriesForClass(classId, remarks) {
  const out = {};
  Object.keys(remarks || {}).forEach(key => {
    if (key.indexOf(classId + '__') === 0) out[key] = remarks[key];
  });
  return out;
}

function migrateLegacySchoolDocument() {
  if (!isHeadTeacher() || !currentSchoolId) return Promise.resolve(false);
  return safetyCall('migrateSchoolLegacy', {}).then(result => result.migrated);
}

function pullSubcollection(name, allowedIds) {
  const ref = schoolRef().collection(name);
  if (allowedIds === null) return ref.get();
  const ids = Array.from(allowedIds);
  if (!ids.length) return Promise.resolve({ empty: true, forEach: function() {} });
  return Promise.all(ids.map(id => ref.doc(id).get())).then(docs => ({
    empty: docs.length === 0,
    forEach: fn => docs.forEach(d => { if (d.exists) fn(d); })
  }));
}


function pullStudentsForAccess(all, classIds) {
  if (all) return schoolRef().collection('students').get();
  const ids = Array.from(classIds || []);
  if (!ids.length) return Promise.resolve({ empty: true, forEach: function() {} });
  return Promise.all(ids.map(classId =>
    schoolRef().collection('students').where('classId', '==', classId).get()
  )).then(snaps => {
    const docs = [];
    snaps.forEach(snap => snap.forEach(d => docs.push(d)));
    return { empty: docs.length === 0, forEach: fn => docs.forEach(fn) };
  });
}

function pullGradesForAccess(all, classIds) {
  if (all) return schoolRef().collection('grades').get();
  const ids = Array.from(classIds || []);
  if (!ids.length) return Promise.resolve({ empty: true, forEach: function() {} });
  return Promise.all(ids.map(classId =>
    schoolRef().collection('grades').where('classId', '==', classId).get()
  )).then(snaps => {
    const docs = [];
    snaps.forEach(snap => snap.forEach(d => docs.push(d)));
    return { empty: docs.length === 0, forEach: fn => docs.forEach(fn) };
  });
}

function pullAttendanceForAccess(all, classIds) {
  if (all) return schoolRef().collection('attendance').get();
  const ids = Array.from(classIds || []);
  if (!ids.length) return Promise.resolve({ empty: true, forEach: function() {} });
  return Promise.all(ids.map(classId =>
    schoolRef().collection('attendance').where('classId', '==', classId).get()
  )).then(snaps => {
    const docs = [];
    snaps.forEach(snap => snap.forEach(d => docs.push(d)));
    return { empty: docs.length === 0, forEach: fn => docs.forEach(fn) };
  });
}

function safetyCall(name, data) {
  if (navigator.onLine === false || offlineAuthenticatedMode) return Promise.reject(new Error('Connect and reverify your account before this operation.'));
  return firebase.functions().httpsCallable(name)(data).then(result => result.data);
}
function redactCachedStaff() {
  const safe = DB.get(KEYS.staff, []).map(record => {
    const item = {id:record.id};
    ['name','role','signatureUrl','signatureStoragePath','isActive'].forEach(key => { if(record[key]!==undefined)item[key]=record[key]; });
    return item;
  });
  DB.set(KEYS.staff, safe, {skipCloudSync:true});
}
function pullStaffForAccess(all) {
  if (all) return pullSubcollection('staff', null);
  return safetyCall('getSchoolReportStaff', {}).then(result => ({forEach: fn => result.staff.forEach(item => fn({id:item.id,data:()=>item}))}));
}
function pullImageAssetsForAccess() {
  const ref=schoolRef().collection('imageAssets');
  if(isHeadTeacher())return ref.get();
  const queries=[ref.where('kind','in',['logo','staff']).get()];
  Array.from(classIdsForCloudSync()||[]).forEach(classId=>queries.push(ref.where('kind','==','student').where('classId','==',classId).get()));
  return Promise.all(queries).then(snaps=>({forEach:fn=>snaps.forEach(snap=>snap.forEach(fn))}));
}
function pullTeacherAttendanceForAccess(all) {
  if (!all) return Promise.resolve({ empty: true, forEach: function() {} });
  return schoolRef().collection('teacherAttendance').get();
}

function pullSchoolCalendarForAccess() {
  return schoolRef().collection('schoolCalendar').get();
}

function pullRemarksForAccess(all, classIds) {
  if (all) return schoolRef().collection('remarks').get();
  const ids = Array.from(classIds || []);
  if (!ids.length) return Promise.resolve({ empty: true, forEach: function() {} });
  return Promise.all(ids.map(classId =>
    schoolRef().collection('remarks').where('classId', '==', classId).get()
  )).then(snaps => {
    const docs = [];
    snaps.forEach(snap => snap.forEach(d => docs.push(d)));
    return { empty: docs.length === 0, forEach: fn => docs.forEach(fn) };
  });
}

/* ---------- v40 data-loss protection ---------- */
const V40_RECOVERY_PREFIX = 'arc_v40_recovery__';

function recoveryKey(schoolId) {
  return `${V40_RECOVERY_PREFIX}${String(schoolId || 'unknown')}`;
}

function backupLocalSchoolData(reason) {
  if (!currentSchoolId) return false;
  try {
    // Preserve the pre-repair snapshot before a smaller cache can replace it.
    const preservedKey = recoveryKey(currentSchoolId) + '__staff_repair_original';
    const previous = localStorage.getItem(recoveryKey(currentSchoolId));
    if (previous && localStorage.getItem(preservedKey) === null) localStorage.setItem(preservedKey, previous);
    const fields = ['settings','classes','subjects','students','grades','attendance','teacherAttendance','schoolCalendar','remarks','staff','activity','billing'];
    const snapshot = { version:'v40', schoolId:String(currentSchoolId), createdAt:new Date().toISOString(), reason:String(reason || 'cloud-pull'), data:{} };
    fields.forEach(field => {
      const key = KEYS[field];
      if (!key) return;
      const raw = localStorage.getItem(key);
      if (raw !== null) snapshot.data[field] = JSON.parse(raw);
    });
    localStorage.setItem(recoveryKey(currentSchoolId), JSON.stringify(snapshot));

    // Keep a rolling history of the last five pre-hydration snapshots. One
    // overwritten recovery slot is not enough when data loss is noticed days
    // later after several launches.
    const historyIndexKey = recoveryKey(currentSchoolId) + '__history_index';
    let history = [];
    try { history = JSON.parse(localStorage.getItem(historyIndexKey) || '[]'); } catch (e) {}
    const historyKey = recoveryKey(currentSchoolId) + '__history__' + Date.now();
    localStorage.setItem(historyKey, JSON.stringify(snapshot));
    history.push(historyKey);
    while (history.length > 5) {
      const oldKey = history.shift();
      try { localStorage.removeItem(oldKey); } catch (e) {}
    }
    localStorage.setItem(historyIndexKey, JSON.stringify(history));
    return true;
  } catch (e) {
    console.warn('v40 recovery backup could not be saved:', e);
    return false;
  }
}

function readLocalRecoveryBackup(schoolId) {
  try {
    const raw = localStorage.getItem(recoveryKey(schoolId || currentSchoolId));
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function mergeRecordsById(localItems, cloudItems) {
  const map = new Map();
  (Array.isArray(localItems) ? localItems : []).forEach(item => {
    if (item && item.id != null) map.set(String(item.id), item);
  });
  (Array.isArray(cloudItems) ? cloudItems : []).forEach(item => {
    if (item && item.id != null) map.set(String(item.id), item);
  });
  return Array.from(map.values());
}

function mergeKeyedData(localValue, cloudValue) {
  const local = localValue && typeof localValue === 'object' && !Array.isArray(localValue) ? localValue : {};
  const cloud = cloudValue && typeof cloudValue === 'object' && !Array.isArray(cloudValue) ? cloudValue : {};
  return Object.assign({}, local, cloud);
}

function mergeCloudCollection(field, cloudItems, authoritative) {
  // v40 systemic data-loss guard:
  // Firestore absence is NOT proof of intentional deletion. Every hydration is
  // therefore a merge. Pending local edits win for matching IDs/keys, while
  // local-only records remain available for recovery instead of disappearing.
  if (field === 'settings') {
    const local = DB.get(KEYS.settings, {});
    const merged = Object.assign({}, local, cloudItems || {});
    dirtyIdsFor(KEYS.settings).forEach(id => { if (Object.prototype.hasOwnProperty.call(local, id)) merged[id] = local[id]; });
    DB.set(KEYS.settings, merged, {skipCloudSync:true});
    return;
  }
  const arrayFields = ['classes','subjects','students','staff'];
  if (arrayFields.indexOf(field) !== -1) {
    const incoming = Array.isArray(cloudItems) ? cloudItems : [];
    const local = DB.get(KEYS[field], []);
    const dirty = new Set(dirtyIdsFor(KEYS[field]));
    const merged = mergeRecordsById(local, incoming);
    const pending = new Map(local.filter(item => item && dirty.has(String(item.id))).map(item => [String(item.id), item]));
    DB.set(KEYS[field], merged.map(item => pending.get(String(item.id)) || item), {skipCloudSync:true});
    return;
  }
  const incoming = cloudItems && typeof cloudItems === 'object' && !Array.isArray(cloudItems) ? cloudItems : {};
  const local = DB.get(KEYS[field], {});
  const merged = mergeKeyedData(local, incoming);
  dirtyIdsFor(KEYS[field]).forEach(id => { if (Object.prototype.hasOwnProperty.call(local, id)) merged[id] = local[id]; });
  DB.set(KEYS[field], merged, {skipCloudSync:true});
}

function pullCloudData(sessionToken) {
  if (!FIREBASE_ENABLED || !currentSchoolId) return Promise.resolve();
  const token = sessionToken == null ? sessionGeneration : sessionToken;
  const uid = currentUid;
  const schoolId = currentSchoolId;
  const valid = () => isCurrentSession(token, uid, schoolId);
  let duplicateRepair = null;
  if (!valid()) return Promise.resolve();
  cloudHydrationInProgress = true;
  sessionDataReady = false;
  // A timer from before hydration could otherwise delete cloud records using
  // the temporarily empty local cache. Cancel every pending delayed push.
  Object.keys(pushTimers).forEach(rawKey => {
    clearTimeout(pushTimers[rawKey]);
    delete pushTimers[rawKey];
  });

  // v40: save a rollback snapshot before cloud data touches local storage.
  backupLocalSchoolData('before-cloud-pull');

  return migrateLegacyImageLocalStorage()
    .then(() => migrateInlineImagesFromLocalRecords())
    .then(() => migrateLegacySchoolDocument())
    .then(() => {
    const all = isHeadTeacher();
    const classIds = all ? null : classIdsForCloudSync();
    const subjectIds = all ? null : new Set(currentAssignedSubjectIds || []);

    return Promise.all([
      schoolRef().get(),
      pullSubcollection('classes', classIds),
      pullSubcollection('subjects', subjectIds),
      pullStudentsForAccess(all, classIds),
      pullStaffForAccess(all),
      pullGradesForAccess(all, classIds),
      pullAttendanceForAccess(all, classIds),
      pullTeacherAttendanceForAccess(all),
      pullSchoolCalendarForAccess(),
      pullRemarksForAccess(all, classIds)
    ]).then(async results => {
      if (!valid()) return;
      const deleted = await schoolRef().collection('deletedRecords').get();
      if (!valid()) return;
      const tombstones = {};
      const deletionItems = [];
      deleted.forEach(doc => { const item=doc.data(); deletionItems.push(item); (tombstones[item.collection] ||= new Set()).add(localKeyFromCloudId(item.id)); });
      const schoolDoc = results[0];
      const classSnap = results[1];
      const subjectSnap = results[2];
      const studentSnap = results[3];
      const staffSnap = results[4];
      const gradeSnap = results[5];
      const attendanceSnap = results[6];
      const teacherAttendanceSnap = results[7];
      const schoolCalendarSnap = results[8];
      const remarkSnap = results[9];

      const schoolProfile = schoolDoc.exists ? (schoolDoc.data().profile || {}) : {};
      if (schoolDoc.exists) {
        const p = schoolProfile;
        const localSettings = DB.get(KEYS.settings, {});
        const mergedProfile = Object.assign({}, localSettings, p);
        // Keep an existing local image. Cloud URL/path are metadata only.
        const cachedLogo = getCachedLocalImage(imageCacheKey('logo', 'school'));
        if (cachedLogo) mergedProfile.logo = cachedLogo;
        mergeCloudCollection('settings', mergedProfile, true);
      }

      const classes = [];
      classSnap.forEach(d => classes.push(d.data()));
      mergeCloudCollection('classes', classes, all);

      // Firestore collection reads have no guaranteed display order. Use the
      // persisted order field, falling back to the existing local order for
      // older Phase 3 subject documents that predate this field.
      const localSubjects = DB.get(KEYS.subjects, []);
      const localOrder = new Map(localSubjects.map((s, i) => [s.id, subjectOrderValue(s, i)]));
      const subjects = [];
      subjectSnap.forEach(d => {
        const subject = Object.assign({}, d.data());
        if (!Number.isFinite(Number(subject.order))) subject.order = localOrder.has(d.id) ? localOrder.get(d.id) : subjects.length;
        subjects.push(subject);
      });
      ensureSubjectOrder(subjects);
      mergeCloudCollection('subjects', sortSubjectsByOrder(subjects), all);

      const students = [];
      studentSnap.forEach(d => {
        const s = d.data();
        if (all || classIds.has(s.classId)) students.push(mergeLocalImage('students', s, d.id));
      });
      if (all) {
        const localBeforeStudentPull = DB.get(KEYS.students, []);
        const localByClass = new Map();
        const cloudByClass = new Map();
        localBeforeStudentPull.forEach(s => localByClass.set(String(s.classId || ''), (localByClass.get(String(s.classId || '')) || 0) + 1));
        students.forEach(s => cloudByClass.set(String(s.classId || ''), (cloudByClass.get(String(s.classId || '')) || 0) + 1));
        const missingWholeClasses = Array.from(localByClass.entries()).filter(([classId, count]) => classId && count > 0 && !cloudByClass.has(classId));
        const suspiciousStudentPull = students.length < localBeforeStudentPull.length && missingWholeClasses.length > 0;
        // Fail closed on a suspiciously incomplete school-wide Students pull.
        // Keep the browser's pre-pull records visible, overlay the cloud copies,
        // and require explicit recovery before writing any missing records back.
        mergeCloudCollection('students', students, !suspiciousStudentPull);
        if (suspiciousStudentPull) {
          console.warn('Student cloud pull looked incomplete; preserved local student records for recovery.', {
            localCount: localBeforeStudentPull.length,
            cloudCount: students.length,
            missingClassIds: missingWholeClasses.map(([classId]) => classId)
          });
        }
      } else {
        mergeCloudCollection('students', students, false);
      }

      const staff = [];
      staffSnap.forEach(d => staff.push(mergeLocalImage('staff', d.data(), d.id)));
      if (all) mergeCloudCollection('staff', staff, true);
      else DB.set(KEYS.staff, staff, {skipCloudSync:true});

      // The Head Teacher is also teaching staff. Ensure the account has a
      // corresponding Staff record so teacher attendance includes the Head
      // Teacher and the average is not distorted.
      if (isHeadTeacher()) {
        try { await ensureHeadTeacherStaffRecord(); }
        catch (e) { console.warn('Could not ensure Head Teacher Staff record:', e); }
      }

      // v27: image synchronization is deliberately NOT part of the login
      // critical path. The account, role, and core school data must become
      // usable immediately. Image synchronization runs in the background
      // after the dashboard is ready. Reports can fetch a missing image
      // on-demand from IndexedDB/Storage without blocking authentication.

      const grades = {};
      gradeSnap.forEach(d => {
        const key = localKeyFromCloudId(d.id);
        const classId = key.split('__')[0];
        if (all || classIds.has(classId)) grades[key] = (d.data() || {}).entries || {};
      });
      mergeCloudCollection('grades', grades, all);
      // Only a Head Teacher receives the complete subject and grade set. Run
      // the repair after cloud records and the local recovery cache have been
      // merged, so stale empty records cannot remain visible to that account.
      const mergedSubjects = DB.get(KEYS.subjects, []);
      const mergedGrades = DB.get(KEYS.grades, {});
      const cloudSubjectIds = new Set(subjects.map(subject => subject.id));
      // Never remove a local subject merely because it is absent from a cloud
      // snapshot. Absence may be an incomplete/older sync, not an intentional
      // deletion. Explicit subject deletion handles genuine removals.
      const staleSubjectRepair = { subjects: mergedSubjects, changed: false, removed: 0 };
      const nameRepair = all
        ? repairDuplicateSubjects(staleSubjectRepair.subjects, mergedGrades)
        : { subjects: sortSubjectsByOrder(mergedSubjects), grades: mergedGrades, changed: false };
      duplicateRepair = Object.assign({}, nameRepair, {
        changed: staleSubjectRepair.changed || nameRepair.changed,
        removed: staleSubjectRepair.removed + (nameRepair.removed || 0)
      });
      DB.set(KEYS.subjects, duplicateRepair.subjects, {skipCloudSync:true});
      if (duplicateRepair.changed) {
        console.info(`Merged ${duplicateRepair.removed} duplicate subject(s) and preserved ${duplicateRepair.movedScores} score part(s).`);
      }
      DB.set(KEYS.grades, duplicateRepair.grades, {skipCloudSync:true});

      const attendance = {};
      attendanceSnap.forEach(d => {
        const key = localKeyFromCloudId(d.id);
        const data = d.data() || {};
        const classId = data.classId || key.split('__')[0];
        if (all || classIds.has(classId)) attendance[key] = Object.assign({}, data, { entries: data.entries || {} });
      });
      mergeCloudCollection('attendance', attendance, all);

      const teacherAttendance = {};
      teacherAttendanceSnap.forEach(d => {
        const key = localKeyFromCloudId(d.id);
        const data = d.data() || {};
        teacherAttendance[key] = Object.assign({}, data, { entries: data.entries || {} });
      });
      if (all) mergeCloudCollection('teacherAttendance', teacherAttendance, true);

      const schoolCalendar = {};
      schoolCalendarSnap.forEach(d => {
        const key = localKeyFromCloudId(d.id);
        schoolCalendar[key] = Object.assign({}, d.data(), { date: (d.data() || {}).date || key.split('__').slice(-1)[0] });
      });
      mergeCloudCollection('schoolCalendar', schoolCalendar, true);

      const remarks = {};
      remarkSnap.forEach(d => {
        const key = localKeyFromCloudId(d.id);
        const classId = key.split('__')[0];
        if (all || classIds.has(classId)) remarks[key] = (d.data() || {}).entries || {};
      });
      mergeCloudCollection('remarks', remarks, all);
      if (!valid()) return;
      Object.entries(tombstones).forEach(([field, ids]) => {
        if (!KEYS[field]) return;
        const collectionResults = {classes:classSnap,subjects:subjectSnap,students:studentSnap,staff:staffSnap,grades:gradeSnap,attendance:attendanceSnap,teacherAttendance:teacherAttendanceSnap,schoolCalendar:schoolCalendarSnap,remarks:remarkSnap};
        const existing = new Set();
        collectionResults[field]?.forEach(doc => existing.add(localKeyFromCloudId(doc.id)));
        existing.forEach(id => ids.delete(id));
        const value = DB.get(KEYS[field], fieldDefault(field));
        const clean = Array.isArray(value) ? value.filter(item => !ids.has(String(item.id))) : Object.fromEntries(Object.entries(value).filter(([id]) => !ids.has(id)));
        DB.set(KEYS[field], clean, {skipCloudSync:true});
        clearSyncDirty(KEYS[field], Array.from(ids));
      });
      rememberDeletions(deletionItems.filter(item => !dirtyIdsFor(KEYS[item.collection]).includes(localKeyFromCloudId(item.id))));
      setLastSyncedNow();
    });
  }).finally(() => {
    // Whether the read succeeded or failed, the user may make intentional
    // changes only after this hydration attempt has reached a safe endpoint.
    if (valid()) {
      cloudHydrationInProgress = false;
      sessionDataReady = true;
      syncableFields().forEach(field => {
        if (dirtyIdsFor(field.key).length) scheduleCloudPush(field.key);
      });
      // The repair made only safe score transfers, but it was intentionally
      // performed while cloud writes were paused. Queue the now-complete
      // collections after the hydration barrier opens.
      if (duplicateRepair && duplicateRepair.changed) {
        scheduleCloudPush(KEYS.grades);
        scheduleCloudPush(KEYS.subjects);
      }
    }
  });
}

const pushTimers = {};
const fieldPushes = new Map();
function scheduleCloudPush(rawKey) {
  if (!FIREBASE_ENABLED || !currentSchoolId || currentStatus !== 'active') return;
  if (cloudHydrationInProgress || !sessionDataReady) return;
  const match = syncableFields().find(f => f.key === rawKey);
  if (!match) return;
  clearTimeout(pushTimers[rawKey]);
  const token = sessionGeneration, uidAtSchedule = currentUid, schoolAtSchedule = currentSchoolId;
  pushTimers[rawKey] = setTimeout(() => {
    delete pushTimers[rawKey];
    if (!isCurrentSession(token, uidAtSchedule, schoolAtSchedule) || cloudHydrationInProgress || !sessionDataReady) return;
    pushFieldToCloud(match).catch(err => {
      console.error('Cloud sync failed for', match.field, err);
      updateOfflineModeBanner(err.message || 'Sync failed. Your local changes are preserved.');
    });
  }, 800);
}


function syncCollectionArray(ref, items, cleanFn, options) {
  // Legacy compatibility helper. It is intentionally UPSERT-ONLY.
  // Missing local IDs never delete Firestore documents.
  const safeItems = Array.isArray(items) ? items : [];
  return commitChunks(safeItems
    .filter(item => item && item.id)
    .map(item => batch => batch.set(ref.doc(String(item.id)), cleanFn(item), { merge: true })));
}

function syncKeyedCollection(ref, entries, makeData, allowedClassIds) {
  // Legacy compatibility helper. It is intentionally UPSERT-ONLY.
  // Explicit Delete/Clear handlers own all cloud deletions.
  const safe = entries && typeof entries === 'object' && !Array.isArray(entries) ? entries : {};
  return commitChunks(Object.keys(safe).map(key => {
    const docId = cloudKey(key);
    return batch => batch.set(ref.doc(docId), makeData(key, safe[key]), { merge: true });
  }));
}

function dirtyIdsFor(rawKey) {
  return Array.from(syncDirtyKeys.get(rawKey) || []);
}

function dirtyArrayRecords(rawKey, value, allowedIds) {
  const wanted = new Set(dirtyIdsFor(rawKey));
  return (Array.isArray(value) ? value : []).filter(item =>
    item && item.id != null &&
    wanted.has(String(item.id)) &&
    (!allowedIds || allowedIds.has(item.classId))
  );
}

function dirtyKeyedRecords(rawKey, value, allowedClassIds) {
  const wanted = new Set(dirtyIdsFor(rawKey));
  const out = {};
  Object.keys(value || {}).forEach(key => {
    if (!wanted.has(String(key))) return;
    if (allowedClassIds) {
      const classId = (value[key] && value[key].classId) || String(key).split('__')[0];
      if (!allowedClassIds.has(classId)) return;
    }
    out[key] = value[key];
  });
  return out;
}


function pushFieldToCloud(match) {
  // Serialize writes per school/field so an older response cannot overtake a newer edit.
  if (fieldPushes.has(match.key)) return fieldPushes.get(match.key);
  const pending = performFieldPush(match);
  fieldPushes.set(match.key, pending);
  const cleanup = () => { if (fieldPushes.get(match.key) === pending) fieldPushes.delete(match.key); };
  pending.then(cleanup, cleanup);
  return pending;
}

function performFieldPush(match) {
  // Direct calls are safe and non-destructive. Automatic synchronization only
  // upserts records that DB.set marked dirty. It never compares whole local
  // collections with Firestore and never infers deletes from missing cache data.
  if (!FIREBASE_ENABLED || !currentSchoolId || currentStatus !== 'active' || offlineAuthenticatedMode || cloudHydrationInProgress || !sessionDataReady) return Promise.resolve();

  const field = match.field;
  const value = DB.get(match.key, fieldDefault(field));
  const dirtyIds = dirtyIdsFor(match.key);
  if (!dirtyIds.length) return Promise.resolve();

  const token = sessionGeneration, uidAtPush = currentUid, schoolAtPush = currentSchoolId;
  let pushedIds = [];
  let promise = Promise.resolve();

  if (['grades','attendance','teacherAttendance','remarks'].includes(field)) {
    const entries = dirtyKeyedRecords(match.key, value, isHeadTeacher() ? null : classIdsForCloudSync());
    pushedIds = Object.keys(entries);
    const bases = syncBaseValues.get(match.key) || {};
    promise = Promise.all(pushedIds.map(key => safetyCall('saveSchoolRecord', {field,key,base:bases[key] || {},value:entries[key],deletionVersion:recordDeletionVersion(field,key)})));
  } else if (field === 'settings') {
    if (!isHeadTeacher()) return Promise.resolve();
    pushedIds = dirtyIds.slice();
    promise = schoolRef().set({
      profile: stripImagesForCloud('settings', value),
      schemaVersion: CLOUD_SCHEMA_VERSION,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } else if (field === 'classes') {
    if (!isHeadTeacher()) return Promise.resolve();
    const items = dirtyArrayRecords(match.key, value);
    pushedIds = items.map(item => String(item.id));
    promise = syncCollectionArray(schoolRef().collection('classes'), items,
      c => Object.assign({}, c, { updatedAt: firebase.firestore.FieldValue.serverTimestamp() }));
  } else if (field === 'subjects') {
    if (!isHeadTeacher()) return Promise.resolve();
    const items = dirtyArrayRecords(match.key, value);
    pushedIds = items.map(item => String(item.id));
    promise = syncCollectionArray(schoolRef().collection('subjects'), items,
      s => Object.assign({}, s, { updatedAt: firebase.firestore.FieldValue.serverTimestamp() }));
  } else if (field === 'staff') {
    if (!isHeadTeacher()) return Promise.resolve();
    const items = dirtyArrayRecords(match.key, value);
    pushedIds = items.map(item => String(item.id));
    promise = syncCollectionArray(schoolRef().collection('staff'), items,
      s => stripImagesForCloud('staff', s), { preserveMissing: true });
  } else if (field === 'students') {
    const allowed = classIdsForCloudSync();
    const items = dirtyArrayRecords(match.key, value, allowed);
    pushedIds = items.map(item => String(item.id));
    promise = syncCollectionArray(schoolRef().collection('students'), items,
      s => stripImagesForCloud('students', s));
  } else if (field === 'grades') {
    const allowed = classIdsForCloudSync();
    const entries = dirtyKeyedRecords(match.key, value, allowed);
    pushedIds = Object.keys(entries);
    promise = syncKeyedCollection(schoolRef().collection('grades'), entries,
      (key, record) => ({ classId: key.split('__')[0], entries: record || {}, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }),
      isHeadTeacher() ? null : allowed);
  } else if (field === 'attendance') {
    const allowed = classIdsForCloudSync();
    const entries = dirtyKeyedRecords(match.key, value, allowed);
    pushedIds = Object.keys(entries);
    promise = syncKeyedCollection(schoolRef().collection('attendance'), entries,
      (key, record) => Object.assign({}, record, {
        classId: (record && record.classId) || key.split('__')[0],
        entries: (record && record.entries) || {},
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }), isHeadTeacher() ? null : allowed);
  } else if (field === 'teacherAttendance') {
    if (!isHeadTeacher()) return Promise.resolve();
    const entries = dirtyKeyedRecords(match.key, value, null);
    pushedIds = Object.keys(entries);
    promise = syncKeyedCollection(schoolRef().collection('teacherAttendance'), entries,
      (key, record) => Object.assign({}, record, { entries: (record && record.entries) || {}, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }), null);
  } else if (field === 'schoolCalendar') {
    if (!isHeadTeacher()) return Promise.resolve();
    const entries = dirtyKeyedRecords(match.key, value, null);
    pushedIds = Object.keys(entries);
    promise = syncKeyedCollection(schoolRef().collection('schoolCalendar'), entries,
      (key, record) => Object.assign({}, record, { updatedAt: firebase.firestore.FieldValue.serverTimestamp() }), null);
  } else if (field === 'remarks') {
    const allowed = classIdsForCloudSync();
    const entries = dirtyKeyedRecords(match.key, value, allowed);
    pushedIds = Object.keys(entries);
    promise = syncKeyedCollection(schoolRef().collection('remarks'), entries,
      (key, record) => ({ classId: key.split('__')[0], entries: record || {}, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }),
      isHeadTeacher() ? null : allowed);
  }

  const recordValue = (data, id) => Array.isArray(data)
    ? data.find(item => item && String(item.id) === id) : data && data[id];
  const sent = new Map(pushedIds.map(id => [id, stableSyncJson(recordValue(value, id))]));
  return promise.then(() => {
    if (!isCurrentSession(token, uidAtPush, schoolAtPush)) return;
    const latest = DB.get(match.key, fieldDefault(field));
    const unchanged = pushedIds.filter(id => stableSyncJson(recordValue(latest, id)) === sent.get(id));
    const bases = syncBaseValues.get(match.key) || {};
    pushedIds.filter(id => !unchanged.includes(id)).forEach(id => { bases[id] = JSON.parse(sent.get(id)); });
    syncBaseValues.set(match.key, bases);
    clearSyncDirty(match.key, unchanged);
    if (pushedIds.length) setLastSyncedNow();
    // Only retry edits made during this write; inaccessible records remain queued.
    if (unchanged.length < pushedIds.length) scheduleCloudPush(match.key);
  });
}

function syncableFields() {
  return [
    { field: 'settings', cloudField: 'profile', key: KEYS.settings },
    { field: 'classes', cloudField: 'classes', key: KEYS.classes },
    { field: 'subjects', cloudField: 'subjects', key: KEYS.subjects },
    { field: 'students', cloudField: 'students', key: KEYS.students },
    { field: 'grades', cloudField: 'grades', key: KEYS.grades },
    { field: 'attendance', cloudField: 'attendance', key: KEYS.attendance },
    { field: 'teacherAttendance', cloudField: 'teacherAttendance', key: KEYS.teacherAttendance },
    { field: 'schoolCalendar', cloudField: 'schoolCalendar', key: KEYS.schoolCalendar },
    { field: 'remarks', cloudField: 'remarks', key: KEYS.remarks },
    { field: 'staff', cloudField: 'staff', key: KEYS.staff }
  ];
}

function fieldDefault(field) {
  return (field === 'settings' || field === 'grades' || field === 'attendance' || field === 'teacherAttendance' || field === 'schoolCalendar' || field === 'remarks') ? {} : [];
}

function pushAllFieldsNow() {
  return Promise.all(syncableFields().map(f => pushFieldToCloud(f))).then(() =>
    schoolRef().set({ schemaVersion: CLOUD_SCHEMA_VERSION, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true })
  ).then(() => setLastSyncedNow());
}

async function flushPendingCloudWrites() {
  if (!FIREBASE_ENABLED || !currentSchoolId || currentStatus !== 'active') return;
  for (const field of syncableFields()) {
    if (dirtyIdsFor(field.key).length) await pushFieldToCloud(field);
  }
  updateOfflineModeBanner();
}

async function revalidateAndSyncAfterReconnect() {
  if (offlineReconnectInProgress || !FIREBASE_ENABLED || !currentUid || !currentSchoolId || currentStatus !== 'active') {
    updateOfflineModeBanner();
    return;
  }
  const authUser = firebase.auth().currentUser;
  if (!authUser || authUser.uid !== currentUid) {
    updateOfflineModeBanner();
    return;
  }

  offlineReconnectInProgress = true;
  updateOfflineModeBanner('Internet is back. Rechecking your account before syncing local changes.');

  const token = sessionGeneration;
  const uidBefore = currentUid;
  const schoolBefore = currentSchoolId;
  try {
    const userDoc = await firebase.firestore().collection('users').doc(uidBefore).get({source:'server'});
    if (!isCurrentSession(token, uidBefore, schoolBefore)) return;
    const data = userDoc.exists ? userDoc.data() : null;
    if (!data || data.status !== 'active' || !data.schoolId || data.schoolId !== schoolBefore) {
      clearVerifiedLocalSession(uidBefore);
      offlineAuthenticatedMode = false;
      sessionReady = false;
      sessionDataReady = false;
      hideSessionRestoring(); hideSyncingMessage();
      if (data && data.status === 'pending') {
        currentSchoolId = null; currentRole = data.role || 'teacher'; currentStatus = 'pending';
        hideAuthGate(); hideDisabledGate(); showPendingGate();
      } else if (data && data.status && data.status !== 'active') {
        currentSchoolId = null; currentRole = data.role || null; currentStatus = data.status;
        hideAuthGate(); hidePendingGate(); showDisabledGate();
      } else {
        resetWorkspaceState();
        renderAuthForm(); showAuthGate();
        setAuthError('Your school account could not be reverified. Sign in again when online.');
      }
      return;
    }

    currentRole = data.role;
    currentStatus = 'active';
    currentAssignedClassIds = Array.isArray(data.assignedClassIds) ? data.assignedClassIds : [];
    currentAssignedSubjectIds = Array.isArray(data.assignedSubjectIds) ? data.assignedSubjectIds : [];
    currentUserData = data;
    saveVerifiedLocalSession(authUser, data);
    offlineAuthenticatedMode = false;
    sessionReady = true;
    sessionDataReady = true;
    cloudHydrationInProgress = false;

    // Local offline edits go first so a cloud pull cannot overwrite them.
    await flushPendingCloudWrites();
    if (!isCurrentSession(token, uidBefore, schoolBefore)) return;

    await pullCloudData(token);
    if (!isCurrentSession(token, uidBefore, schoolBefore)) return;

    loadSettingsForm();
    refreshProfileMenu();
    renderHome(); renderClasses(); renderStudents(); renderSubjects(); renderStaff(); renderQuickAccessList();
    const restored = getSavedNavigation();
    if (restored.view === 'attendance') { showView('attendance'); setAttendanceMode(restored.attendanceTab); }
    else showView(restored.view);
    startBackgroundImageSync(token, uidBefore, schoolBefore);
  } catch (error) {
    console.warn('Reconnect synchronization failed:', error);
    if (isLikelyOfflineError(error)) offlineAuthenticatedMode = true;
  } finally {
    offlineReconnectInProgress = false;
    updateOfflineModeBanner();
  }
}

function setLastSyncedNow() {
  localStorage.setItem(LAST_SYNCED_KEY, String(Date.now()));
  const setupVisible = !document.getElementById('view-setup').classList.contains('hidden');
  if (setupVisible) renderCloudSyncStatus();
}

function renderCloudSyncStatus() {
  const wrap = document.getElementById('cloudSyncStatus');
  const btn = document.getElementById('syncNowBtn');
  const joinCodeWrap = document.getElementById('joinCodeDisplay');
  if (!wrap) return;
  if (!FIREBASE_ENABLED) {
    wrap.innerHTML = '<p class="hint">Accounts are not set up, so cloud sync is off.</p>';
    btn.classList.add('hidden');
    if (joinCodeWrap) joinCodeWrap.classList.add('hidden');
    return;
  }
  if (!currentSchoolId) {
    wrap.innerHTML = '<p class="hint">You are using guest mode — data stays on this device only.</p>';
    btn.classList.add('hidden');
    if (joinCodeWrap) joinCodeWrap.classList.add('hidden');
    return;
  }
  const last = localStorage.getItem(LAST_SYNCED_KEY);
  const lastText = last ? new Date(Number(last)).toLocaleString() : 'never';
  const email = firebase.auth().currentUser ? (firebase.auth().currentUser.email || '') : (currentUserData && currentUserData.email || '');
  const modeText = (navigator.onLine === false || offlineAuthenticatedMode) ? 'Offline mode' : 'Cloud connected';
  wrap.innerHTML = `<p class="hint">Signed in as ${escapeHtml(email)} (${escapeHtml(currentRole)}). ${escapeHtml(modeText)}. Last synced: ${lastText}. Photos, signatures, and the school logo synchronize through Firebase Storage when online.</p>`;
  btn.classList.toggle('hidden', navigator.onLine === false || offlineAuthenticatedMode);
  if (joinCodeWrap) {
    if (currentRole === 'headteacher' && navigator.onLine !== false && !offlineAuthenticatedMode) {
      firebase.firestore().collection('schools').doc(currentSchoolId).get().then(doc => {
        const code = doc.exists ? doc.data().joinCode : '';
        joinCodeWrap.innerHTML = code
          ? `<p class="hint">Your school's join code: <strong>${escapeHtml(code)}</strong> — share this with your teachers so they can join.</p>`
          : '';
        joinCodeWrap.classList.remove('hidden');
      });
    } else {
      joinCodeWrap.classList.add('hidden');
    }
  }
}

document.getElementById('syncNowBtn').addEventListener('click', () => {
  if (!FIREBASE_ENABLED || !currentSchoolId) return;
  flushPendingCloudWrites().then(() => pullCloudData()).then(() => {
    renderCloudSyncStatus();
    renderClasses();
    renderStudents();
    renderSubjects();
    renderStaff();
    return syncImagesFromCloud({ force: false });
  }).then(result => {
    alert(`Sync complete.\n\nCloud images: ${result.total}\nLocal images ready: ${result.local}\nDownloaded: ${result.downloaded}\nMetadata repaired: ${result.repaired}\nFailed: ${result.failed}`);
  }).catch(err => alert('Sync failed: ' + err.message));
});

function showSessionRestoring() {
  document.documentElement.classList.add('sessionRestoring');
  document.documentElement.classList.remove('authing');
  const heading = document.getElementById('authHeading');
  if (heading) heading.textContent = 'Restoring your session…';
  const fields = document.getElementById('authFormFields');
  if (fields) fields.classList.add('hidden');
  const msg = document.getElementById('authSyncingMsg');
  if (msg) { msg.textContent = 'Please wait while SchoolHub restores your session.'; msg.classList.remove('hidden'); }
}
function hideSessionRestoring() { document.documentElement.classList.remove('sessionRestoring'); }
function showAuthGate() { document.documentElement.classList.add('authing'); document.documentElement.classList.remove('sessionRestoring'); document.getElementById('schoolHubFloatingPill')?.remove(); }
function hideAuthGate() { document.documentElement.classList.remove('authing'); }
function showSchoolChoiceGate() { document.documentElement.classList.add('schoolChoice'); }
function hideSchoolChoiceGate() { document.documentElement.classList.remove('schoolChoice'); }
function showPendingGate() { document.documentElement.classList.add('pendingApproval'); }
function hidePendingGate() { document.documentElement.classList.remove('pendingApproval'); }
function showDisabledGate() { document.documentElement.classList.add('disabledAccess'); }
function hideDisabledGate() { document.documentElement.classList.remove('disabledAccess'); }

function showSyncingMessage() {
  document.getElementById('authFormFields').classList.add('hidden');
  document.getElementById('authSyncingMsg').classList.remove('hidden');
  document.getElementById('authHeading').textContent = 'Syncing…';
}
function hideSyncingMessage() {
  document.getElementById('authFormFields').classList.remove('hidden');
  document.getElementById('authSyncingMsg').classList.add('hidden');
}

function renderAuthForm() {
  updateGuestTrialUI();
  const login = authMode === 'login';
  document.getElementById('authHeading').textContent = login ? 'Welcome back' : 'Create an account';
  document.getElementById('authSubtitle').textContent = login ? 'Sign in to your school account.' : 'Start your SchoolHub journey. Join or register your school next.';
  document.getElementById('authSubmitBtn').textContent = login ? 'Sign in' : 'Create account';
  document.getElementById('authSwitchPrompt').textContent = login ? 'Don’t have an account?' : 'Already have an account?';
  document.getElementById('authToggleModeBtn').textContent = login ? 'Sign up' : 'Sign in';
  document.getElementById('authConfirmField').classList.toggle('hidden', login);
  document.getElementById('authForgotBtn').classList.toggle('hidden', !login);
  document.getElementById('authPassword').autocomplete = login ? 'current-password' : 'new-password';
  ['authPassword', 'authConfirmPassword'].forEach(id => { document.getElementById(id).type = 'password'; });
  document.getElementById('authConfirmPassword').value = '';
  ['authPasswordToggle', 'authConfirmToggle'].forEach(id => {
    const button = document.getElementById(id);
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', id === 'authPasswordToggle' ? 'Show password' : 'Show confirm password');
    button.classList.remove('showing');
  });
  document.getElementById('authError').classList.add('hidden');
}

function setAuthError(message) {
  const el = document.getElementById('authError');
  el.textContent = message;
  el.classList.remove('hidden');
}

function setSchoolChoiceError(message) {
  const el = document.getElementById('schoolChoiceError');
  el.textContent = message;
  el.classList.remove('hidden');
}

/* ---------- School registration / joining ---------- */
function generateJoinCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous look-alike characters
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code.slice(0, 3) + '-' + code.slice(3);
}

function generateUniqueJoinCode(triesLeft) {
  if (triesLeft === undefined) triesLeft = 5;
  const code = generateJoinCode();
  return firebase.firestore().collection('joinCodes').doc(code).get().then(doc => {
    if (!doc.exists) return code;
    if (triesLeft <= 0) throw new Error('Could not generate a unique join code — try again.');
    return generateUniqueJoinCode(triesLeft - 1);
  });
}

function registerSchool(schoolName, address, email) {
  if (!firebase.auth().currentUser || !currentUid) {
    return Promise.reject(new Error('You must be signed in before creating a school.'));
  }

  const schoolRef = firebase.firestore().collection('schools').doc();
  const schoolId = schoolRef.id;
  const userRef = firebase.firestore().collection('users').doc(currentUid);
  const authUser = firebase.auth().currentUser;

  // IMPORTANT: the signed-in account may legitimately have no users/{uid}
  // document (for example, if that document was deleted from Firestore).
  // Create/restore the Head Teacher user profile before creating the public
  // join-code document. This also prevents the old joinCodes security rule
  // from rejecting school creation because isHeadTeacher() could not find
  // users/{uid} yet.
  return generateUniqueJoinCode().then(joinCode => {
    const schoolData = {
      profile: { schoolName, address, email },
      ownerUid: currentUid,
      subscription: { plan: 'free', status: 'inactive' },
      joinCode,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    const userData = {
      schoolId,
      role: 'headteacher',
      status: 'active',
      email: authUser.email || email || '',
      displayName: authUser.displayName || schoolName || '',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    return schoolRef.set(schoolData)
      .then(() => userRef.set(userData, { merge: true }))
      .then(() => firebase.firestore().collection('joinCodes').doc(joinCode).set({
        schoolId,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }))
      .then(() => {
        migrateDataIntoSchool(schoolId);
        currentSchoolId = schoolId;
        currentRole = 'headteacher';
        currentStatus = 'active';
        currentUserData = Object.assign({}, userData);
        saveVerifiedLocalSession(authUser, userData);
        offlineAuthenticatedMode = false;
        sessionReady = true;
        sessionDataReady = true;
        updateOfflineModeBanner();
        return joinCode;
      });
  });
}

function joinSchoolWithCode(code) {
  const cleanCode = code.trim().toUpperCase();
  return firebase.firestore().collection('joinCodes').doc(cleanCode).get().then(doc => {
    if (!doc.exists) throw new Error('That code was not found. Check it and try again.');
    const schoolId = doc.data().schoolId;
    return firebase.firestore().collection('users').doc(currentUid).set({
      schoolId, role: 'teacher', status: 'pending', assignedClassIds: [], assignedSubjectIds: [],
      email: firebase.auth().currentUser ? (firebase.auth().currentUser.email || '') : '',
      displayName: firebase.auth().currentUser ? (firebase.auth().currentUser.displayName || '') : '',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(() => {
      currentSchoolId = null; // stays null until a Head Teacher approves — no data namespace touched yet
      currentRole = 'teacher';
      currentStatus = 'pending';
    });
  });
}

/* ---------- Manage Teachers (Head Teacher only) ---------- */
// Teacher accounts and Staff records are intentionally separate collections,
// but every approved teacher must now have a linked Staff record.
//
// users/{uid}
//   = authentication, school membership, status and class/subject access
//
// schools/{schoolId}/staff/{staffId}
//   = personnel/report-card information, including rank, staff number and signature
//
// The relationship is stored in both directions:
//   users/{uid}.staffId -> staff/{staffId}
//   staff/{staffId}.userUid -> users/{uid}

function fetchSchoolMembers() {
  return firebase.firestore().collection('users').where('schoolId', '==', currentSchoolId).get()
    .then(snap => {
      const members = [];
      snap.forEach(doc => members.push(Object.assign({ uid: doc.id }, doc.data())));
      return members;
    });
}

function getStaffForUserUid(userUid) {
  if (!userUid) return null;
  const staff = DB.get(KEYS.staff, []);
  return staff.find(s => s.userUid === userUid) || null;
}

function getStaffById(staffId) {
  if (!staffId) return null;
  return DB.get(KEYS.staff, []).find(s => s.id === staffId) || null;
}

function staffNameFromMember(member) {
  const email = String(member && member.email || '').trim();
  if (!email) return '';
  const localPart = email.split('@')[0] || '';
  return localPart.replace(/[._-]+/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase()).trim();
}

function createLinkedStaffRecord(member, name) {
  if (!isHeadTeacher()) return Promise.reject(new Error('Only the Head Teacher can create staff records.'));
  if (!member || !member.uid) return Promise.reject(new Error('Teacher account could not be identified.'));

  const existing = getStaffForUserUid(member.uid);
  if (existing) return Promise.resolve(existing);

  const cleanName = String(name || '').trim();
  if (!cleanName) return Promise.reject(new Error('Enter the teacher\'s full name for the Staff record.'));

  const staffId = uid();
  const record = {
    id: staffId,
    userUid: member.uid,
    email: String(member.email || '').trim(),
    name: cleanName,
    role: 'Teacher',
    dob: '',
    staffId: '',
    registeredNo: '',
    licenseNo: '',
    ssnitNo: '',
    ghanaCardId: '',
    dateOfAppointment: '',
    rank: '',
    phone: '',
    signature: '',
    signatureUrl: '',
    createdAt: new Date().toISOString()
  };

  const staffList = DB.get(KEYS.staff, []);
  staffList.push(record);
  DB.set(KEYS.staff, staffList);

  // Keep the relationship in the teacher account as well. The Head Teacher
  // is allowed to update teacher membership records by Firestore rules.
  return staffRef(staffId).set(stripImagesForCloud('staff', record))
    .then(() => firebase.firestore().collection('users').doc(member.uid).update({
      staffId,
      staffLinkedAt: firebase.firestore.FieldValue.serverTimestamp()
    }))
    .then(() => record)
    .catch(err => {
      // Do not leave a misleading local record if the cloud relationship failed.
      DB.set(KEYS.staff, DB.get(KEYS.staff, []).filter(s => s.id !== staffId));
      throw err;
    });
}

function linkExistingStaffToTeacher(member, staffId) {
  if (!isHeadTeacher()) return Promise.reject(new Error('Only the Head Teacher can link staff records.'));
  if (!member || !member.uid) return Promise.reject(new Error('Teacher account could not be identified.'));
  const staff = getStaffById(staffId);
  if (!staff) return Promise.reject(new Error('Selected Staff record was not found.'));

  const otherTeacher = DB.get(KEYS.staff, []).find(s => s.id !== staff.id && s.userUid === member.uid);
  if (otherTeacher) return Promise.reject(new Error('This teacher is already linked to another Staff record.'));

  const previousUserUid = staff.userUid || '';
  staff.userUid = member.uid;
  staff.email = String(member.email || staff.email || '').trim();
  staff.role = 'Teacher';
  DB.set(KEYS.staff, DB.get(KEYS.staff, []));

  const userRef = firebase.firestore().collection('users').doc(member.uid);
  const staffWrite = staffRef(staff.id).set(stripImagesForCloud('staff', staff), { merge: true });
  const userWrite = userRef.update({
    staffId: staff.id,
    staffLinkedAt: firebase.firestore.FieldValue.serverTimestamp()
  });

  // If this Staff record used to belong to another account, clear that old
  // account's link so the relationship remains one-to-one.
  let oldUserWrite = Promise.resolve();
  if (previousUserUid && previousUserUid !== member.uid) {
    oldUserWrite = firebase.firestore().collection('users').doc(previousUserUid).update({
      staffId: firebase.firestore.FieldValue.delete(),
      staffLinkedAt: firebase.firestore.FieldValue.delete()
    }).catch(() => {});
  }

  return Promise.all([staffWrite, userWrite, oldUserWrite]).then(() => staff);
}

function unlinkTeacherStaff(member) {
  if (!isHeadTeacher()) return Promise.reject(new Error('Only the Head Teacher can unlink staff records.'));
  if (!member || !member.uid) return Promise.resolve();
  const staff = getStaffForUserUid(member.uid);
  const userRef = firebase.firestore().collection('users').doc(member.uid);

  if (!staff) {
    return userRef.update({
      staffId: firebase.firestore.FieldValue.delete(),
      staffLinkedAt: firebase.firestore.FieldValue.delete()
    });
  }

  staff.userUid = '';
  staff.email = staff.email || String(member.email || '').trim();
  DB.set(KEYS.staff, DB.get(KEYS.staff, []));

  return Promise.all([
    staffRef(staff.id).set(stripImagesForCloud('staff', staff), { merge: true }),
    userRef.update({
      staffId: firebase.firestore.FieldValue.delete(),
      staffLinkedAt: firebase.firestore.FieldValue.delete()
    })
  ]);
}

let editingManageTeacherUid = null;

function renderManageTeachers() {
  const list = document.getElementById('manageTeachersList');
  if (!isHeadTeacher()) {
    list.innerHTML = '<li class="empty">Only the Head Teacher can manage teachers.</li>';
    return;
  }
  list.innerHTML = '<li class="empty">Loading…</li>';
  const classes = DB.get(KEYS.classes, []);
  const subjects = DB.get(KEYS.subjects, []);
  const staff = DB.get(KEYS.staff, []);

  fetchSchoolMembers().then(members => {
    members.sort((a, b) => {
      if (a.role === 'headteacher' && b.role !== 'headteacher') return -1;
      if (a.role !== 'headteacher' && b.role === 'headteacher') return 1;
      return (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1);
    });

    list.innerHTML = '';
    const teachers = members.filter(m => m.role === 'teacher');
    if (!teachers.length) {
      list.innerHTML = '<li class="empty">No teachers have joined your school yet.</li>';
      return;
    }

    teachers.forEach(m => {
      const li = document.createElement('li');
      const assignedClasses = Array.isArray(m.assignedClassIds) ? m.assignedClassIds : [];
      const assignedSubjects = Array.isArray(m.assignedSubjectIds) ? m.assignedSubjectIds : [];
      const linkedStaff = m.staffId ? getStaffById(m.staffId) : getStaffForUserUid(m.uid);
      const statusText = m.status === 'pending' ? ' · Pending approval' : m.status === 'disabled' ? ' · Disabled' : ' · Active';
      const displayEmail = String(m.email || '').trim();
      const displayName = String(m.displayName || '').trim();
      const accountLabel = displayName && displayEmail
        ? `${displayName} · ${displayEmail}`
        : (displayEmail || displayName || m.uid);
      const suggestedName = linkedStaff ? linkedStaff.name : (displayName || staffNameFromMember(m));
      const isExpanded = m.status === 'pending' || editingManageTeacherUid === m.uid;

      const classChecks = classes.map(c =>
        `<label class="checkbox-row"><input type="checkbox" class="assign-class-cb" value="${escapeHtml(c.id)}" ${assignedClasses.indexOf(c.id) !== -1 ? 'checked' : ''}> ${escapeHtml(c.name)}</label>`
      ).join('') || '<p class="hint">Create classes first.</p>';

      const subjectChecks = subjects.map(sub =>
        `<label class="checkbox-row"><input type="checkbox" class="assign-subject-cb" value="${escapeHtml(sub.id)}" ${assignedSubjects.indexOf(sub.id) !== -1 ? 'checked' : ''}> ${escapeHtml(sub.name)}</label>`
      ).join('') || '<p class="hint">Create subjects first.</p>';

      const staffOptions = ['<option value="">— Create new Staff record —</option>']
        .concat(staff.map(s => `<option value="${escapeHtml(s.id)}" ${linkedStaff && linkedStaff.id === s.id ? 'selected' : ''}>${escapeHtml(s.name || 'Unnamed Staff')}${s.role ? ' (' + escapeHtml(s.role) + ')' : ''}${s.userUid && s.userUid !== m.uid ? ' · Linked' : ''}</option>`))
        .join('');

      const actionLabel = m.status === 'pending' ? 'Approve & Save' : 'Update Teacher';
      const disableButton = m.status === 'disabled'
        ? `<button class="edit-student reactivate-teacher-btn" data-uid="${m.uid}">Reactivate</button>`
        : `<button class="del-student disable-teacher-btn" data-uid="${m.uid}">Disable</button>`;

      if (isExpanded) {
        li.innerHTML = `<div class="edit-row teacher-edit-panel">
          <strong>${escapeHtml(accountLabel)}</strong>
          <div class="meta">Teacher${statusText}${linkedStaff ? ' · Staff: ' + escapeHtml(linkedStaff.name) : ' · No Staff record linked'}</div>
          <label>Staff name
            <input type="text" class="teacher-staff-name" value="${escapeHtml(suggestedName)}" placeholder="Full name for Staff record">
          </label>
          <label>Staff record
            <select class="teacher-staff-select">${staffOptions}</select>
          </label>
          <p class="hint">An approved teacher must have one linked Staff record. The Staff record stores the person's personnel details and report-card signature. The teacher account stores access and assignments.</p>
          <strong>Classes</strong>
          <div class="teacher-assignment-list">${classChecks}</div>
          <strong>Subjects</strong>
          <div class="teacher-assignment-list">${subjectChecks}</div>
          <div class="edit-actions">
            <button class="save-btn save-teacher-assignment" data-uid="${m.uid}">${actionLabel}</button>
            ${m.status !== 'pending' ? '<button class="cancel-btn cancel-teacher-edit" data-uid="' + m.uid + '">Cancel</button>' : ''}
            ${linkedStaff ? '<button class="cancel-btn unlink-teacher-staff" data-uid="' + m.uid + '">Unlink Staff</button>' : ''}
            ${m.status === 'pending' ? '<button class="cancel-btn reject-teacher-btn" data-uid="' + m.uid + '">Reject</button>' : disableButton}
          </div>
        </div>`;
      } else {
        const classCount = assignedClasses.length;
        const subjectCount = assignedSubjects.length;
        li.innerHTML = `<div class="teacher-collapsed-row">
          <div class="teacher-summary-main">
            <strong>${escapeHtml(accountLabel)}</strong>
            <div class="meta">Teacher${statusText}${linkedStaff ? ' · Staff: ' + escapeHtml(linkedStaff.name) : ' · No Staff record linked'}</div>
            <div class="teacher-assignment-summary">${classCount} class${classCount === 1 ? '' : 'es'} · ${subjectCount} subject${subjectCount === 1 ? '' : 's'}</div>
          </div>
          <div class="teacher-summary-actions">
            <button class="edit-teacher-btn" data-uid="${m.uid}">Edit</button>
            ${disableButton}
          </div>
        </div>`;
      }
      list.appendChild(li);
    });

    list.querySelectorAll('.edit-teacher-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        editingManageTeacherUid = btn.dataset.uid;
        renderManageTeachers();
      });
    });

    list.querySelectorAll('.cancel-teacher-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        editingManageTeacherUid = null;
        renderManageTeachers();
      });
    });

    list.querySelectorAll('.teacher-staff-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const li = sel.closest('li');
        const nameInput = li.querySelector('.teacher-staff-name');
        if (sel.value) {
          const selected = staff.find(s => s.id === sel.value);
          if (selected && selected.name) nameInput.value = selected.name;
        }
      });
    });

    list.querySelectorAll('.save-teacher-assignment').forEach(btn => {
      btn.addEventListener('click', () => {
        const li = btn.closest('li');
        const member = teachers.find(t => t.uid === btn.dataset.uid);
        if (!member) return;

        const assignedClassIds = Array.from(li.querySelectorAll('.assign-class-cb:checked')).map(cb => cb.value);
        const assignedSubjectIds = Array.from(li.querySelectorAll('.assign-subject-cb:checked')).map(cb => cb.value);
        const staffSelect = li.querySelector('.teacher-staff-select');
        const staffName = li.querySelector('.teacher-staff-name').value.trim();
        const selectedStaffId = staffSelect.value;

        if (!assignedClassIds.length) {
          alert('Assign at least one class before approving or activating a teacher.');
          return;
        }
        if (!selectedStaffId && !staffName) {
          alert('Enter the teacher\'s full name for the Staff record, or select an existing Staff record.');
          return;
        }

        const existingLinked = member.staffId ? getStaffById(member.staffId) : getStaffForUserUid(member.uid);
        let staffPromise;

        if (selectedStaffId) {
          const selectedStaff = getStaffById(selectedStaffId);
          if (!selectedStaff) {
            alert('The selected Staff record could not be found.');
            return;
          }
          if (selectedStaff.userUid && selectedStaff.userUid !== member.uid) {
            const ok = confirm('This Staff record is already linked to another teacher account. Reassign it to this teacher?');
            if (!ok) return;
          }
          staffPromise = linkExistingStaffToTeacher(member, selectedStaffId);
        } else if (existingLinked) {
          existingLinked.name = staffName;
          existingLinked.email = String(member.email || existingLinked.email || '').trim();
          existingLinked.role = 'Teacher';
          DB.set(KEYS.staff, DB.get(KEYS.staff, []));
          staffPromise = staffRef(existingLinked.id).set(stripImagesForCloud('staff', existingLinked), { merge: true }).then(() => existingLinked);
        } else {
          staffPromise = createLinkedStaffRecord(member, staffName);
        }

        staffPromise.then(staffRecord => {
          return firebase.firestore().collection('users').doc(member.uid).update({
            assignedClassIds,
            assignedSubjectIds,
            status: 'active',
            staffId: staffRecord.id,
            staffLinkedAt: firebase.firestore.FieldValue.serverTimestamp(),
            assignmentsUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        }).then(() => {
          editingManageTeacherUid = null;
          auditAction('update', 'teacher', member.uid, `Updated teacher access and assignments: ${member.email || member.uid}`);
          return pullCloudData();
        }).then(() => {
          renderManageTeachers();
          renderStaff();
          renderClasses();
        }).catch(err => alert('Could not save teacher and Staff relationship: ' + err.message));
      });
    });

    list.querySelectorAll('.unlink-teacher-staff').forEach(btn => {
      btn.addEventListener('click', () => {
        const member = teachers.find(t => t.uid === btn.dataset.uid);
        if (!member) return;
        if (!confirm('Unlink this teacher from the Staff record? The Staff record will remain in the school.')) return;
        unlinkTeacherStaff(member).then(() => pullCloudData()).then(() => {
          renderManageTeachers();
          renderStaff();
          renderClasses();
        }).catch(err => alert('Could not unlink Staff: ' + err.message));
      });
    });

    list.querySelectorAll('.reject-teacher-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!confirm('Reject this request? The teacher will need to join again with a school code.')) return;
        const member = teachers.find(t => t.uid === btn.dataset.uid);
        const linkedStaff = member ? getStaffForUserUid(member.uid) : null;
        const updates = {
          status: 'rejected',
          assignedClassIds: [],
          assignedSubjectIds: [],
          staffId: firebase.firestore.FieldValue.delete(),
          staffLinkedAt: firebase.firestore.FieldValue.delete()
        };
        firebase.firestore().collection('users').doc(btn.dataset.uid).update(updates)
          .then(() => {
            // A pending teacher should not have a Staff record, but clean up a
            // partial relationship if one was created before rejection.
            if (!linkedStaff) return null;
            linkedStaff.userUid = '';
            DB.set(KEYS.staff, DB.get(KEYS.staff, []));
            return staffRef(linkedStaff.id).set(stripImagesForCloud('staff', linkedStaff), { merge: true });
          })
          .then(() => renderManageTeachers())
          .catch(err => alert('Could not reject: ' + err.message));
      });
    });

    list.querySelectorAll('.disable-teacher-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!confirm('Disable this teacher? Their Staff record and school data will remain safe, but account access will be blocked.')) return;
        firebase.firestore().collection('users').doc(btn.dataset.uid).update({ status: 'disabled' })
          .then(() => { auditAction('disable', 'teacher', btn.dataset.uid, `Disabled teacher: ${btn.dataset.uid}`); return renderManageTeachers(); })
          .catch(err => alert('Could not disable teacher: ' + err.message));
      });
    });

    list.querySelectorAll('.reactivate-teacher-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const teacher = members.find(m => m.uid === btn.dataset.uid);
        const ids = Array.isArray(teacher && teacher.assignedClassIds) ? teacher.assignedClassIds : [];
        const linked = teacher && (teacher.staffId ? getStaffById(teacher.staffId) : getStaffForUserUid(teacher.uid));
        if (!ids.length) {
          alert('Assign at least one class before reactivating this teacher.');
          return;
        }
        if (!linked) {
          alert('Link or create a Staff record before reactivating this teacher.');
          return;
        }
        firebase.firestore().collection('users').doc(btn.dataset.uid).update({
          status: 'active',
          staffId: linked.id,
          staffLinkedAt: firebase.firestore.FieldValue.serverTimestamp()
        })
          .then(() => renderManageTeachers())
          .catch(err => alert('Could not reactivate: ' + err.message));
      });
    });
  }).catch(err => {
    list.innerHTML = `<li class="empty">Could not load teachers: ${escapeHtml(err.message)}</li>`;
  });
}

function initAuth() {
  if (!FIREBASE_ENABLED) {
    // Accounts not configured — app behaves exactly as it always has.
    initLockScreen();
    proceedToApp();
    return;
  }

  firebase.initializeApp(window.FIREBASE_CONFIG);

  // v38.9: explicitly persist Firebase authentication locally. This makes
  // reopening or refreshing the PWA a session restoration event, not a new
  // login event. The login form is kept hidden until Firebase has definitively
  // reported the authentication state.
  const authPersistenceReady = firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL)
    .catch(err => {
      console.warn('Could not set LOCAL auth persistence; Firebase will use its current persistence mode.', err);
    });

  const pwInput = document.getElementById('authPassword');
  const pwToggle = document.getElementById('authPasswordToggle');
  pwToggle.addEventListener('click', () => {
    const showing = pwInput.type === 'text';
    pwInput.type = showing ? 'password' : 'text';
    pwToggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    pwToggle.setAttribute('aria-pressed', String(!showing));
    pwToggle.classList.toggle('showing', !showing);
  });
  document.getElementById('authConfirmToggle').addEventListener('click', () => {
    const input = document.getElementById('authConfirmPassword');
    const button = document.getElementById('authConfirmToggle');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    button.setAttribute('aria-label', showing ? 'Show confirm password' : 'Hide confirm password');
    button.setAttribute('aria-pressed', String(!showing));
    button.classList.toggle('showing', !showing);
  });
  ['authEmail', 'authPassword', 'authConfirmPassword'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); document.getElementById('authSubmitBtn').click(); }
    });
  });

  document.getElementById('authToggleModeBtn').addEventListener('click', () => {
    authMode = authMode === 'login' ? 'signup' : 'login';
    renderAuthForm();
  });

  document.getElementById('authSubmitBtn').addEventListener('click', () => {
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    if (!email || !password) { setAuthError('Enter an email and password.'); return; }
    if (!document.getElementById('authEmail').checkValidity()) { setAuthError('Enter a valid email address.'); return; }
    if (authMode === 'signup' && password.length < 6) { setAuthError('Use a password with at least 6 characters.'); return; }
    if (authMode === 'signup' && password !== document.getElementById('authConfirmPassword').value) { setAuthError('Your passwords do not match. Please try again.'); return; }
    const action = authMode === 'login'
      ? firebase.auth().signInWithEmailAndPassword(email, password)
      : firebase.auth().createUserWithEmailAndPassword(email, password);
    action.catch(err => setAuthError(err.message));
  });

  document.getElementById('authGoogleBtn').addEventListener('click', () => {
    const button = document.getElementById('authGoogleBtn');
    const label = document.getElementById('authGoogleBtnLabel');
    button.disabled = true;
    const originalLabel = label.textContent;
    label.textContent = 'Opening Google…';
    const provider = new firebase.auth.GoogleAuthProvider();
    // Always let the person choose an account instead of silently using a
    // different Google account that may already be signed in on the device.
    provider.setCustomParameters({ prompt: 'select_account' });

    authPersistenceReady
      .then(() => firebase.auth().signInWithPopup(provider))
      .catch(err => {
        if (err && err.code === 'auth/account-exists-with-different-credential') {
          setAuthError('An account already exists with this email. Sign in with your email and password first, then contact the Head Teacher if you need help linking Google.');
        } else if (err && err.code !== 'auth/popup-closed-by-user') {
          setAuthError(err && err.message ? err.message : 'Google sign-in could not be completed.');
        }
      })
      .finally(() => {
        button.disabled = false;
        label.textContent = originalLabel;
      });
  });

  document.getElementById('authForgotBtn').addEventListener('click', () => {
    const email = document.getElementById('authEmail').value.trim();
    if (!email) { setAuthError('Enter your email above first, then tap this again.'); return; }
    firebase.auth().sendPasswordResetEmail(email)
      .then(() => alert('Password reset email sent to ' + email))
      .catch(err => setAuthError(err.message));
  });

  document.getElementById('authGuestBtn').addEventListener('click', () => {
    if (guestTrialRemaining() <= 0) { updateGuestTrialUI(); return; }
    if (localStorage.getItem(GUEST_TRIAL_KEY) === null) localStorage.setItem(GUEST_TRIAL_KEY, String(Date.now()));
    sessionGeneration += 1;
    localStorage.setItem(GUEST_MODE_KEY, '1');
    currentUid = null;
    currentSchoolId = null;
    currentRole = null;
    currentStatus = null;
    currentUserData = null;
    currentAssignedClassIds = [];
    currentAssignedSubjectIds = [];
    sessionReady = true;
    sessionDataReady = true;
    hideAuthGate();
    initLockScreen();
    proceedToApp();
  });

  document.getElementById('logoutBtn').addEventListener('click', signOutAndReset);
  document.getElementById('schoolChoiceLogoutBtn').addEventListener('click', signOutAndReset);
  document.getElementById('pendingLogoutBtn').addEventListener('click', signOutAndReset);
  document.getElementById('disabledLogoutBtn').addEventListener('click', signOutAndReset);

  let appStarted = false;

  document.getElementById('registerSchoolBtn').addEventListener('click', () => {
    const name = document.getElementById('regSchoolName').value.trim();
    const address = document.getElementById('regSchoolAddress').value.trim();
    const email = document.getElementById('regSchoolEmail').value.trim();
    if (!name) { setSchoolChoiceError('Enter a school name.'); return; }
    registerSchool(name, address, email).then(joinCode => {
      const token = sessionGeneration;
      const uid = currentUid;
      const schoolId = currentSchoolId;
      hideSchoolChoiceGate();
      hideSyncingMessage(); hideAuthGate();
      initLockScreen();
      sessionReady = true;
      sessionDataReady = true;
      appStarted = true;
      // The new school's local workspace is ready. Upload in the background:
      // a slow/offline mobile connection must not hold navigation behind a gate.
      proceedToApp();
      renderQuickAccessList();
      refreshProfileMenu();
      alert(`School registered! Your join code is ${joinCode} — share this with your teachers. You can view it again anytime in Setup.`);
      return pushAllFieldsNow().catch(err => {
        if (!isCurrentSession(token, uid, schoolId)) return;
        console.warn('Initial school upload failed:', err);
        alert('Your school is registered and your data is saved on this device. Cloud upload could not finish. Retry from Sync Center when your connection is ready.');
      });
    }).catch(err => setSchoolChoiceError(err.message));
  });

  document.getElementById('joinSchoolBtn').addEventListener('click', () => {
    const code = document.getElementById('joinCodeInput').value.trim();
    if (!code) { setSchoolChoiceError('Enter a join code.'); return; }
    if (hasExistingLocalData()) {
      const ok = confirm("You have existing data on this device that won't transfer if you join a school. Export a Backup first from Setup if you want to keep it. Continue joining anyway?");
      if (!ok) return;
    }
    joinSchoolWithCode(code).then(() => {
      hideSchoolChoiceGate();
      showPendingGate();
    }).catch(err => setSchoolChoiceError(err.message));
  });

  authPersistenceReady.finally(() => {
    firebase.auth().onAuthStateChanged(user => {
    // During an explicit logout, never let the transient persisted Firebase
    // user state re-enter the authentication loading path. The sign-out
    // handler has already shown a clean login form immediately.
    if (manualSignOutInProgress && user) return;

    const token = ++sessionGeneration;

    if (user) {
      currentUid = user.uid;
      currentSchoolId = null;
      currentRole = null;
      currentStatus = null;
      currentAssignedClassIds = [];
      currentAssignedSubjectIds = [];
      currentUserData = null;
      sessionReady = false;
      localStorage.removeItem(GUEST_MODE_KEY);
      // v38.9: auth state is still unknown to the UI until the account profile
      // has been resolved. Keep the sign-in form completely hidden during this
      // short restoration window.
      showSessionRestoring();

      firebase.firestore().collection('users').doc(currentUid).get({source:'server'}).then(userDoc => {
        if (!isCurrentSession(token, user.uid, null)) return;
        const data = userDoc.exists ? userDoc.data() : null;
        currentUserData = data || null;
        const authProfileUpdates = {};
        if (data && data.schoolId && firebase.auth().currentUser) {
          const authUser = firebase.auth().currentUser;
          if (!data.email && authUser.email) authProfileUpdates.email = authUser.email;
          if (!data.displayName && authUser.displayName) authProfileUpdates.displayName = authUser.displayName;
        }
        const repairAccountProfile = Object.keys(authProfileUpdates).length
          ? firebase.firestore().collection('users').doc(currentUid).set(authProfileUpdates, { merge: true })
          : Promise.resolve();
        currentAssignedClassIds = data && Array.isArray(data.assignedClassIds) ? data.assignedClassIds : [];
        currentAssignedSubjectIds = data && Array.isArray(data.assignedSubjectIds) ? data.assignedSubjectIds : [];

        if (!data || !data.schoolId || data.status === 'rejected') {
          currentSchoolId = null; currentRole = null; currentStatus = null;
          hideSessionRestoring(); hideSyncingMessage(); hideAuthGate(); hideDisabledGate();
          showSchoolChoiceGate();
          return;
        }
        if (data.status === 'pending') {
          currentSchoolId = null; currentRole = data.role; currentStatus = 'pending';
          hideSessionRestoring(); hideSyncingMessage(); hideAuthGate(); hideDisabledGate();
          showPendingGate();
          return;
        }
        if (data.status !== 'active') {
          currentSchoolId = null; currentRole = data.role; currentStatus = data.status || 'disabled';
          hideSessionRestoring(); hideSyncingMessage(); hideAuthGate(); hidePendingGate();
          showDisabledGate();
          return;
        }

        currentSchoolId = data.schoolId;
        currentRole = data.role;
        if (currentRole === 'teacher') redactCachedStaff();
        currentStatus = 'active';
        saveVerifiedLocalSession(user, data);
        offlineAuthenticatedMode = false;
        updateOfflineModeBanner();

        return repairAccountProfile.then(() => {
          if (!isCurrentSession(token, user.uid, data.schoolId)) return;

          // Revision 3: data-changing cloud synchronization stays blocked
          // until Firestore hydration has finished for this school session.
          sessionReady = true;
          sessionDataReady = false;
          cloudHydrationInProgress = true;

          // The local cache is namespaced by currentSchoolId, so this does not
          // expose another school's records. On a new device/school the page
          // simply renders its empty/loading state until cloud data arrives.
          hideSyncingMessage(); hideSessionRestoring(); hideAuthGate(); hidePendingGate(); hideDisabledGate();
          initLockScreen();
          if (!appStarted) appStarted = true;
          proceedToApp();

          // Restore the exact page immediately, then synchronize the school in
          // the background. The sync completion refreshes the current view but
          // never routes the user through Home.
          const restoredBeforeSync = getSavedNavigation();
          if (restoredBeforeSync.view === 'attendance') {
            showView('attendance');
            setAttendanceMode(restoredBeforeSync.attendanceTab);
          } else {
            showView(restoredBeforeSync.view);
          }

          pullCloudData(token).then(() => {
            if (!isCurrentSession(token, user.uid, data.schoolId)) return;
            loadSettingsForm();
            refreshProfileMenu();
            renderHome();
            renderClasses(); renderStudents(); renderSubjects(); renderStaff(); renderQuickAccessList();
            // Re-render the page the user is actually on. Do not call
            // showView('home') and do not change the saved navigation.
            const restored = getSavedNavigation();
            if (restored.view === 'attendance') {
              showView('attendance');
              setAttendanceMode(restored.attendanceTab);
            } else {
              showView(restored.view);
            }
            startBackgroundImageSync(token, user.uid, data.schoolId);
          }).catch(err => {
            if (!isCurrentSession(token, user.uid, data.schoolId)) return;
            console.warn('Background cloud synchronization failed:', err);
            const sub = document.getElementById('welcomeSubtext');
            if (sub) sub.textContent = 'Cloud sync is taking longer than expected. You can retry from the profile menu.';
          });
        });
      }).catch(err => {
        if (token !== sessionGeneration || currentUid !== user.uid) return;
        const cached = loadVerifiedLocalSession(user);
        if (cached && isLikelyOfflineError(err)) {
          console.warn('Account profile unavailable; opening verified offline session.', err);
          startCachedAuthenticatedSession(user, cached);
          appStarted = true;
          return;
        }
        sessionReady = false;
        offlineAuthenticatedMode = false;
        hideSessionRestoring();
        hideSyncingMessage();
        renderAuthForm();
        showAuthGate();
        setAuthError('Could not load your account: ' + err.message);
      });
    } else {
      offlineAuthenticatedMode = false;
      updateOfflineModeBanner();
      hideSessionRestoring();
      // The Firebase callback is the final authority that no account is signed
      // in. Invalidate every pending operation from the previous account.
      resetWorkspaceState();
      if (localStorage.getItem(GUEST_MODE_KEY)) {
        if (!enforceGuestTrial()) { renderAuthForm(); return; }
        sessionReady = true;
        sessionDataReady = true;
        hideAuthGate(); hideSchoolChoiceGate(); hidePendingGate(); hideDisabledGate();
        initLockScreen();
        if (!appStarted) { appStarted = true; proceedToApp(); }
        else {
          renderQuickAccessList(); renderHome();
          const restored = getSavedNavigation();
          if (restored.view === 'attendance') { showView('attendance'); setAttendanceMode(restored.attendanceTab); }
          else showView(restored.view);
        }
      } else {
        hideSchoolChoiceGate(); hidePendingGate(); hideDisabledGate();
        renderAuthForm();
        showAuthGate();
      }
    }
  });
  });
}

/* ---------- theme (Light / Dark / System) ---------- */
const THEME_KEY = 'arc_theme';
const THEME_CYCLE = ['system', 'light', 'dark'];

const THEME_ICONS = {
  system: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.2" y1="4.2" x2="5.6" y2="5.6"/><line x1="18.4" y1="18.4" x2="19.8" y2="19.8"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.2" y1="19.8" x2="5.6" y2="18.4"/><line x1="18.4" y1="5.6" x2="19.8" y2="4.2"/></svg>',
  dark: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>'
};

function applyTheme(value) {
  if (value === 'light' || value === 'dark') {
    document.documentElement.setAttribute('data-theme', value);
  } else {
    document.documentElement.removeAttribute('data-theme'); // system: follow OS via CSS media query
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const isLight = value === 'light' || (value === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
    meta.setAttribute('content', isLight ? '#F1EFE6' : '#16241C');
  }
  const btn = document.getElementById('themeToggle');
  btn.innerHTML = THEME_ICONS[value];
  btn.setAttribute('aria-label', `Theme: ${value}. Tap to change.`);
}

function initTheme() {
  let current = localStorage.getItem(THEME_KEY) || 'system';
  applyTheme(current);
  document.getElementById('themeToggle').addEventListener('click', () => {
    const idx = THEME_CYCLE.indexOf(current);
    current = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
    localStorage.setItem(THEME_KEY, current);
    applyTheme(current);
  });
}

/* ---------- PIN lock (local only — a privacy screen for a shared phone) ---------- */
const PIN_KEY = 'arc_pin_hash';

async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function isPinSet() { return !!localStorage.getItem(PIN_KEY); }

function renderPinSection() {
  const wrap = document.getElementById('pinStatusWrap');
  if (!isPinSet()) {
    wrap.innerHTML = `
      <input type="password" inputmode="numeric" pattern="[0-9]*" id="newPinInput" placeholder="New PIN (4-8 digits)" maxlength="8">
      <input type="password" inputmode="numeric" pattern="[0-9]*" id="confirmPinInput" placeholder="Confirm PIN" maxlength="8">
      <button id="setPinBtn" class="btn-primary">Set PIN</button>
      <p class="hint">Once set, this PIN is required every time the app is opened. There is no recovery if it's forgotten — the only way back in is clearing this site's data in the browser, which also erases everything saved (classes, students, grades).</p>
    `;
    document.getElementById('setPinBtn').addEventListener('click', async () => {
      const pin = document.getElementById('newPinInput').value.trim();
      const confirmVal = document.getElementById('confirmPinInput').value.trim();
      if (!/^\d{4,8}$/.test(pin)) { alert('PIN must be 4-8 digits.'); return; }
      if (pin !== confirmVal) { alert('PINs do not match.'); return; }
      localStorage.setItem(PIN_KEY, await sha256Hex(pin));
      alert('PIN set. The app will now ask for this PIN each time it opens.');
      renderPinSection();
    });
  } else {
    wrap.innerHTML = `
      <p class="hint">PIN lock is enabled — the app asks for this PIN every time it opens.</p>
      <input type="password" inputmode="numeric" pattern="[0-9]*" id="currentPinInput" placeholder="Current PIN" maxlength="8">
      <input type="password" inputmode="numeric" pattern="[0-9]*" id="newPinInput2" placeholder="New PIN (leave blank to just remove)" maxlength="8">
      <button id="changePinBtn" class="btn-primary">Update</button>
      <button id="removePinBtn" class="btn-text">Remove PIN</button>
    `;
    document.getElementById('changePinBtn').addEventListener('click', async () => {
      const current = document.getElementById('currentPinInput').value.trim();
      const newPin = document.getElementById('newPinInput2').value.trim();
      if (await sha256Hex(current) !== localStorage.getItem(PIN_KEY)) { alert('Current PIN is incorrect.'); return; }
      if (!newPin) { alert('Enter a new PIN, or use Remove PIN instead.'); return; }
      if (!/^\d{4,8}$/.test(newPin)) { alert('PIN must be 4-8 digits.'); return; }
      localStorage.setItem(PIN_KEY, await sha256Hex(newPin));
      alert('PIN updated.');
      renderPinSection();
    });
    document.getElementById('removePinBtn').addEventListener('click', async () => {
      const current = document.getElementById('currentPinInput').value.trim();
      if (await sha256Hex(current) !== localStorage.getItem(PIN_KEY)) { alert('Current PIN is incorrect.'); return; }
      if (!confirm('Remove PIN lock? The app will open without asking for a PIN from now on.')) return;
      localStorage.removeItem(PIN_KEY);
      alert('PIN lock removed.');
      renderPinSection();
    });
  }
}

let lockScreenBound = false;
function initLockScreen() {
  if (!document.documentElement.classList.contains('locked')) return;
  if (lockScreenBound) { document.getElementById('lockPinInput').focus(); return; }
  lockScreenBound = true;
  const input = document.getElementById('lockPinInput');
  const error = document.getElementById('lockError');
  const unlock = async () => {
    const val = input.value.trim();
    if (!val) return;
    const hash = await sha256Hex(val);
    if (hash === localStorage.getItem(PIN_KEY)) {
      document.documentElement.classList.remove('locked');
      input.value = '';
      error.classList.add('hidden');
    } else {
      error.classList.remove('hidden');
      input.value = '';
      input.focus();
    }
  };
  document.getElementById('lockUnlockBtn').addEventListener('click', unlock);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') unlock(); });
  input.focus();
}

function proceedToApp() {
  if (!enforceGuestTrial()) return;
  if (FIREBASE_ENABLED && !sessionReady) return;
  ensureDefaults();
  renderPinSection();
  if (!FIREBASE_ENABLED || sessionDataReady) loadSettingsForm();

  // On first startup of a session, show a temporary Home while cloud data is
  // still loading. Once sessionDataReady is true, restore the saved location.
  // This avoids saving/remembering the temporary Home screen itself.
  if (sessionDataReady) {
    const restored = getSavedNavigation();
    if (restored.view === 'attendance') {
      showView('attendance');
      setAttendanceMode(restored.attendanceTab);
    } else {
      showView(restored.view);
    }
  } else {
    // Firebase session is authenticated, but school data is still loading.
    // Keep the session-restoration gate on screen instead of showing Home.
    // The saved page is restored by the pullCloudData() completion handler.
    return;
  }
}

/* ---------- v40 true offline-first authenticated mode ---------- */
window.addEventListener('offline', () => {
  if (FIREBASE_ENABLED && currentUid && currentSchoolId && currentStatus === 'active') {
    offlineAuthenticatedMode = true;
  }
  updateOfflineModeBanner();
  try { renderCloudSyncStatus(); } catch (e) {}
});

window.addEventListener('online', () => {
  updateOfflineModeBanner('Internet connection detected. Revalidating your school account…');
  revalidateAndSyncAfterReconnect();
});

setTimeout(() => updateOfflineModeBanner(), 0);

/* ---------- init ---------- */
initTheme();
initAuth();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

setTimeout(() => { try { renderFloatingPill(); } catch (e) { console.warn('Floating pill navigation:', e); } }, 0);

/* ---------- v40 Bulk Selection & Safe Delete ---------- */
const bulkSelectionsV40={students:new Set(),staff:new Set(),classes:new Set(),subjects:new Set()};
function bulkVisibleRecordsV40(kind){
  if(kind==='students'){
    const q=(document.getElementById('studentSearchInput')?.value||'').trim().toLowerCase();
    let rows=getAccessibleStudents();
    if(q) return rows.filter(s=>[s.name,s.admissionId,s.guardianName,s.parentPhone,s.houseGps,s.disability].join(' ').toLowerCase().includes(q));
    const cid=document.getElementById('studentClassSelect')?.value||''; return rows.filter(s=>s.classId===cid);
  }
  if(kind==='classes') return isTeacher()?[]:getAccessibleClasses();
  if(kind==='subjects') return subjectArrangeMode?[]:sortSubjectsByOrder(DB.get(KEYS.subjects,[]));
  if(kind==='staff') return canManageStaffWorkspace()?DB.get(KEYS.staff,[]):[];
  return [];
}
function bulkRefreshToolbarV40(kind){
  const host=document.querySelector(`.bulk-selection-toolbar[data-kind="${kind}"]`); if(!host)return;
  const set=bulkSelectionsV40[kind], ids=bulkVisibleRecordsV40(kind).map(x=>String(x.id));
  host.querySelector('.bulk-count').textContent=`${set.size} selected`;
  const del=host.querySelector('.bulk-delete-btn');del.textContent=`Delete Selected (${set.size})`;del.disabled=!set.size;
  host.querySelector('.bulk-select-all').checked=!!ids.length&&ids.every(id=>set.has(id));
  host.querySelector('.bulk-unselect-all').checked=!!ids.length&&ids.every(id=>!set.has(id));
}
function syncBulkRowChecksV40(kind,list,rowSelector,rows,set){
  const candidates=Array.from(list.querySelectorAll(rowSelector)).filter(el=>!el.querySelector('.edit-row'));
  rows.forEach((record,i)=>{
    const row=candidates[i];if(!row)return;
    const id=String(record.id);
    const existing=Array.from(row.children).filter(el=>el.classList&&el.classList.contains('bulk-record-select'));
    let wrap=existing.shift();existing.forEach(el=>el.remove());
    if(!wrap){wrap=document.createElement('span');wrap.className='bulk-record-select';row.insertBefore(wrap,row.firstChild);}
    wrap.dataset.bulkKind=kind;wrap.dataset.bulkId=id;
    let cb=wrap.querySelector('.bulk-record-check');
    if(!cb){cb=document.createElement('input');cb.type='checkbox';cb.className='bulk-record-check';wrap.replaceChildren(cb);}
    cb.setAttribute('aria-label',`Select ${record.name||'record'}`);
    cb.checked=set.has(id);
    cb.onchange=()=>{cb.checked?set.add(id):set.delete(id);bulkRefreshToolbarV40(kind);};
  });
}
function installBulkUiV40(kind,listId,rowSelector){
  const list=document.getElementById(listId);if(!list)return;
  document.querySelectorAll(`.bulk-selection-toolbar[data-kind="${kind}"]`).forEach(x=>x.remove());
  const rows=bulkVisibleRecordsV40(kind);if(!rows.length){list.querySelectorAll('.bulk-record-select').forEach(x=>x.remove());return;}
  const ids=rows.map(x=>String(x.id)), set=bulkSelectionsV40[kind];
  Array.from(set).forEach(id=>{if(!ids.includes(id))set.delete(id);});
  const bar=document.createElement('div');bar.className='bulk-selection-toolbar';bar.dataset.kind=kind;
  bar.innerHTML=`<label><input type="checkbox" class="bulk-select-all"> Select All</label><label><input type="checkbox" class="bulk-unselect-all"> Unselect All</label><span class="bulk-count"></span><button type="button" class="bulk-delete-btn">Delete Selected</button>`;
  list.parentNode.insertBefore(bar,list);
  const syncChecks=()=>syncBulkRowChecksV40(kind,list,rowSelector,rows,set);
  bar.querySelector('.bulk-select-all').addEventListener('change',e=>{if(e.target.checked)ids.forEach(id=>set.add(id));else ids.forEach(id=>set.delete(id));syncChecks();bulkRefreshToolbarV40(kind);});
  bar.querySelector('.bulk-unselect-all').addEventListener('change',e=>{if(e.target.checked)ids.forEach(id=>set.delete(id));syncChecks();bulkRefreshToolbarV40(kind);});
  bar.querySelector('.bulk-delete-btn').addEventListener('click',()=>bulkDeleteV40(kind));
  syncChecks();
  bulkRefreshToolbarV40(kind);
}
function classDepsV40(id){const st=DB.get(KEYS.students,[]).filter(x=>x.classId===id).length,g=Object.keys(DB.get(KEYS.grades,{})).filter(k=>k.startsWith(id+'__')).length,a=Object.keys(DB.get(KEYS.attendance,{})).filter(k=>k.startsWith(id+'__')).length,r=Object.keys(DB.get(KEYS.remarks,{})).filter(k=>k.startsWith(id+'__')).length;return{st,g,a,r,total:st+g+a+r};}
function subjectDepsV40(id){let g=0;Object.values(DB.get(KEYS.grades,{})).forEach(v=>{try{if(v&&JSON.stringify(v).includes('"'+id+'"'))g++;}catch(e){}});return{g,total:g};}
async function bulkDeleteV40(kind){
  const ids=Array.from(bulkSelectionsV40[kind]);if(!ids.length)return;
  if(kind!=='students'&&!isHeadTeacher()){alert('Only the Headteacher can bulk delete these records.');return;}
  if(kind==='students'){const chosen=DB.get(KEYS.students,[]).filter(x=>ids.includes(String(x.id)));if(chosen.some(x=>!requireClassAccess(x.classId)))return;}
  if(kind==='classes'){const blocked=ids.map(id=>({id,d:classDepsV40(id),x:DB.get(KEYS.classes,[]).find(c=>String(c.id)===id)})).filter(x=>x.d.total);if(blocked.length){alert('Safe Delete blocked because selected classes still contain academic records.\n\n'+blocked.slice(0,8).map(x=>`${x.x?.name||x.id}: ${x.d.st} student(s), ${x.d.g} grade record(s), ${x.d.a} attendance record(s), ${x.d.r} remark record(s)`).join('\n'));return;}}
  if(kind==='subjects'){const blocked=ids.map(id=>({id,d:subjectDepsV40(id),x:DB.get(KEYS.subjects,[]).find(c=>String(c.id)===id)})).filter(x=>x.d.total);if(blocked.length){alert('Safe Delete blocked because selected subjects still have grade references.\n\n'+blocked.slice(0,8).map(x=>`${x.x?.name||x.id}: ${x.d.g} grade reference(s)`).join('\n'));return;}}
  if(!confirm(`Delete ${ids.length} selected ${kind}?\n\nThis action cannot be undone.`))return;
  const token=sessionGeneration,userId=currentUid,schoolId=currentSchoolId;
  try{
    if(FIREBASE_ENABLED&&currentSchoolId){if(cloudHydrationInProgress||!sessionDataReady)throw new Error('School data is still synchronizing.');await commitChunks(ids.map(id=>batch=>batch.delete(schoolRef().collection(kind).doc(String(id)))));if(!isCurrentSession(token,userId,schoolId))return;setLastSyncedNow();}
    if(kind==='students')DB.set(KEYS.students,DB.get(KEYS.students,[]).filter(x=>!ids.includes(String(x.id))),{skipCloudSync:true});
    if(kind==='staff'){DB.set(KEYS.staff,DB.get(KEYS.staff,[]).filter(x=>!ids.includes(String(x.id))),{skipCloudSync:true});const cs=DB.get(KEYS.classes,[]);cs.forEach(c=>{if(ids.includes(String(c.classTeacherId)))c.classTeacherId='';});DB.set(KEYS.classes,cs);const st=DB.get(KEYS.settings,{});if(ids.includes(String(st.headTeacherId))){st.headTeacherId='';DB.set(KEYS.settings,st);}}
    if(kind==='classes')DB.set(KEYS.classes,DB.get(KEYS.classes,[]).filter(x=>!ids.includes(String(x.id))),{skipCloudSync:true});
    if(kind==='subjects'){const a=DB.get(KEYS.subjects,[]).filter(x=>!ids.includes(String(x.id)));a.forEach((x,i)=>x.order=i);DB.set(KEYS.subjects,a,{skipCloudSync:true});}
    auditAction('delete',kind,'bulk',`Bulk deleted ${ids.length} ${kind} record(s)`);bulkSelectionsV40[kind].clear();
    if(kind==='students'){renderStudents();renderClasses();}else if(kind==='staff'){renderStaff();renderClasses();}else if(kind==='classes'){renderClasses();renderStudentClassSelect();}else renderSubjects();
  }catch(error){alert(`Could not delete the selected ${kind}. Nothing was removed locally.\n\n${error.message||error}`);}
}
const _renderClassesBulkV40=renderClasses;renderClasses=function(){_renderClassesBulkV40();setTimeout(()=>installBulkUiV40('classes','classList','li'),0);};
const _renderStudentsBulkV40=renderStudents;renderStudents=function(){_renderStudentsBulkV40();setTimeout(()=>installBulkUiV40('students','studentList','li'),0);};
const _renderSubjectsBulkV40=renderSubjects;renderSubjects=function(){_renderSubjectsBulkV40();setTimeout(()=>installBulkUiV40('subjects','subjectList','li.subject-sort-item'),0);};
const _renderStaffBulkV40=renderStaff;renderStaff=function(){_renderStaffBulkV40();setTimeout(()=>installBulkUiV40('staff','staffList','.staff-editor-list > li'),0);};
setTimeout(()=>{try{renderClasses();renderStudents();renderSubjects();renderStaff();}catch(e){console.warn('Bulk selection initial render:',e);}},0);
