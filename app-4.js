// AlatiphA SchoolHub — app-4.js
const APP_VERSION = 'v38.10.0';

/* ---------- storage helpers ---------- */
const DB = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      const v = JSON.parse(raw);
      if (v === null || v === undefined) return fallback;
      return restoreLocalImagesForDbKey(key, v);
    } catch (e) { return fallback; }
  },
  set(key, val) {
    const clean = stripImagesForLocalStorage(key, val);
    const payload = JSON.stringify(clean);
    try {
      localStorage.setItem(key, payload);
    } catch (e) {
      try {
        localStorage.removeItem(key);
        localStorage.setItem(key, payload);
      } catch (retryError) {
        console.error('Could not save local data:', key, retryError);
        throw retryError;
      }
    }
    if (typeof scheduleCloudPush === 'function') scheduleCloudPush(key);
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

// Session isolation: every authentication transition receives a new token.
// Any asynchronous work started by a previous user must stop using its data
// once the token changes. This prevents stale Firestore responses from
// repainting or overwriting the next user's workspace.
let sessionGeneration = 0;
let sessionReady = false;
let sessionDataReady = false; // Core school data has finished loading for this session.
let manualSignOutInProgress = false; // Prevent Firebase auth transitions from re-blocking the login form during logout.

function ns(base) { return currentSchoolId ? `${base}__${currentSchoolId}` : base; }

function isCurrentSession(token, uid, schoolId) {
  return token === sessionGeneration
    && currentUid === uid
    && (schoolId == null || currentSchoolId === schoolId);
}

function resetWorkspaceState() {
  currentUid = null;
  currentSchoolId = null;
  currentRole = null;
  currentStatus = null;
  currentAssignedClassIds = [];
  currentAssignedSubjectIds = [];
  currentUserData = null;
  sessionReady = false;
  sessionDataReady = false;

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
  if (isHeadTeacher()) return DB.get(KEYS.classes, []).map(c => c.id);
  if (isTeacher()) return Array.isArray(currentAssignedClassIds) ? currentAssignedClassIds : [];
  return [];
}

function getAccessibleClasses() {
  const ids = new Set(accessibleClassIds());
  return DB.get(KEYS.classes, []).filter(c => ids.has(c.id));
}

function getAccessibleStudents() {
  const ids = new Set(accessibleClassIds());
  return DB.get(KEYS.students, []).filter(s => ids.has(s.classId));
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

function getAccessibleSubjects() {
  const all = DB.get(KEYS.subjects, []);
  const ordered = sortSubjectsByOrder(all);
  if (isHeadTeacher()) return ordered;
  const ids = new Set(Array.isArray(currentAssignedSubjectIds) ? currentAssignedSubjectIds : []);
  return ordered.filter(s => ids.has(s.id));
}

function canAccessClass(classId) {
  return accessibleClassIds().indexOf(classId) !== -1;
}

function canAccessSubject(subjectId) {
  if (isHeadTeacher()) return true;
  return Array.isArray(currentAssignedSubjectIds) && currentAssignedSubjectIds.indexOf(subjectId) !== -1;
}

function requireHeadTeacher(action) {
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
  get activity() { return ns('arc_activity'); }
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
      reportLayout: 'standard', headTeacherId: '', termDates: {}
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
const views = ['home', 'setup', 'staff', 'classes', 'students', 'subjects', 'attendance', 'grades', 'remarks', 'reports', 'history', 'manage-teachers', 'activity'];
function showView(name) {
  // Never render role-sensitive views while an authenticated session is still
  // being resolved. Guest mode explicitly marks itself ready before calling
  // proceedToApp().
  if (FIREBASE_ENABLED && !sessionReady) return;
  if (isTeacher() && ['setup', 'staff', 'classes', 'subjects', 'manage-teachers'].indexOf(name) !== -1) {
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
  if (name === 'setup') { refreshHeadTeacherSelect(); renderCloudSyncStatus(); }
  if (name === 'students') renderStudentClassSelect();
  if (name === 'attendance') renderAttendanceView();
  if (name === 'grades') renderGradesClassSelect();
  if (name === 'remarks') renderRemarksClassSelect();
  if (name === 'reports') renderReportsClassSelect();
  if (name === 'history') renderHistoryTermYearSelect();
  if (name === 'manage-teachers') renderManageTeachers();
  if (name === 'activity') loadActivityLog();
  renderClasses();
  renderStudents();
  renderSubjects();
  renderStaff();
  window.scrollTo(0, 0);
}

function refreshHeadTeacherSelect() {
  const settings = DB.get(KEYS.settings, {});
  fillStaffSelect(document.getElementById('headTeacherSelect'), settings.headTeacherId || '');
}

function sectionTitle(name) {
  const titles = {
    setup: 'Setup', staff: 'Staff', classes: 'Classes', students: 'Students', subjects: 'Subjects',
    attendance: 'Attendance', grades: 'Grades', remarks: 'Remarks', reports: 'Reports', history: 'Term History',
    'manage-teachers': 'Manage Teachers', activity: 'Activity Log'
  };
  return titles[name] || 'AlatiphA SchoolHub';
}

document.getElementById('backBtn').addEventListener('click', () => showView('home'));

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
  const cards = QUICK_ACCESS_CARDS.filter(c => !c.headteacherOnly || currentRole === 'headteacher');
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
    { title: 'Welcome, Head Teacher', body: "Here's a quick walkthrough to get your school set up. Skip anytime — you can replay this from the profile menu." },
    { title: '1. Setup', body: 'Fill in Term, Academic Year, Attendance Out Of, Next Term Begins, and Report Layout, then tap Save Settings.' },
    { title: '2. Staff', body: 'Add your staff — teachers, yourself, and signatures that will appear on report cards.' },
    { title: '3. Classes', body: 'Create each class, and optionally assign a Class Teacher from your Staff list.' },
    { title: '4. Subjects', body: 'Check the Subjects list — a default set is there already; edit it to match what your school teaches.' },
    { title: '5. Students', body: 'Add students to each class — one at a time, or Bulk Add a whole list at once.' },
    { title: '6. Grades & Reports', body: 'Each term: enter scores in Grades, add Remarks, then generate PDF report cards or CSV exports from Reports.' },
    { title: '7. Add Teachers', body: "Share your school's join code (Setup → Cloud Sync) with teachers. When they join, approve them and assign their classes from Manage Teachers." },
    { title: "You're set", body: 'That covers the basics — replay this tour anytime from the profile menu (top right).' }
  ];
}

function tourSlidesForTeacher() {
  return [
    { title: 'Welcome, Teacher', body: "Here's a quick walkthrough of how this works. Skip anytime — you can replay this from the profile menu." },
    { title: 'Waiting for approval', body: 'Your Head Teacher needs to approve your request and assign your classes before you get full access.' },
    { title: 'Grades', body: 'Once approved: go to Grades, pick a class, enter scores, and tap Save Grades.' },
    { title: 'Reports', body: 'Generate a PDF report card for one student or the whole class, or export results as CSV, from Reports.' },
    { title: "You're set", body: 'Replay this tour anytime from the profile menu (top right).' }
  ];
}

function tourSlidesForGuest() {
  return [
    { title: 'Welcome', body: "You're using Guest mode — everything stays on this device only, with no account and no cloud sync. Skip anytime — replay this from the profile menu." },
    { title: '1. Setup', body: 'Start here: School Name, Term, Academic Year, and Report Layout.' },
    { title: '2. Classes & Subjects', body: 'Create your classes and check the Subjects list.' },
    { title: '3. Students', body: 'Add students to each class — one at a time, or Bulk Add a whole list at once.' },
    { title: '4. Grades & Reports', body: 'Enter scores in Grades each term, then generate PDF report cards or CSV exports from Reports.' },
    { title: "You're set", body: 'Replay this tour anytime from the profile menu (top right).' }
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
    accountLine.textContent = 'Guest data (separate from any account on this device)';
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
    const inventory = await getCloudImageInventory();
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
  s.headTeacherId = document.getElementById('headTeacherSelect').value;
  DB.set(KEYS.settings, s);
  auditAction('update', 'settings', 'school', 'Updated school and report settings');
  alert('Settings saved. School name on report: ' + (s.schoolName || '(not set)'));
});

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
          <button class="save-btn save-class" data-id="${c.id}">Save</button>
          <button class="cancel-btn cancel-class">Cancel</button>
        </div>
      </div>`;
    } else {
      const teacher = c.classTeacherId ? staffById[c.classTeacherId] : null;
      const teacherPart = teacher ? ` · Class Teacher: ${escapeHtml(teacher.name)}` : '';
      li.innerHTML = `<div><strong>${escapeHtml(c.name)}</strong><div class="meta">${students.length} student(s) on roll${teacherPart}</div></div>
        <div class="actions">
          <button data-id="${c.id}" class="edit-class">Edit</button>
          <button data-id="${c.id}" class="del-class">Delete</button>
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
    btn.addEventListener('click', () => {
      if (!confirm('Delete this class and its students/grades?')) return;
      const id = btn.dataset.id;
      DB.set(KEYS.classes, DB.get(KEYS.classes, []).filter(c => c.id !== id));
      auditAction('delete', 'class', id, 'Deleted class and its academic records');
      DB.set(KEYS.students, DB.get(KEYS.students, []).filter(s => s.classId !== id));
      const grades = DB.get(KEYS.grades, {});
      Object.keys(grades).forEach(k => { if (k.startsWith(id + '__')) delete grades[k]; });
      DB.set(KEYS.grades, grades);
      const attendance = DB.get(KEYS.attendance, {});
      Object.keys(attendance).forEach(k => { if (k.startsWith(id + '__')) delete attendance[k]; });
      DB.set(KEYS.attendance, attendance);
      const remarks = DB.get(KEYS.remarks, {});
      Object.keys(remarks).forEach(k => { if (k.startsWith(id + '__')) delete remarks[k]; });
      DB.set(KEYS.remarks, remarks);
      renderClasses();
    });
  });
}

document.getElementById('addClassBtn').addEventListener('click', () => {
  if (!requireHeadTeacher('manage classes')) return;
  const input = document.getElementById('newClassName');
  const name = input.value.trim();
  if (!name) return;
  const classTeacherId = document.getElementById('newClassTeacherSelect').value;
  const classes = DB.get(KEYS.classes, []);
  classes.push({ id: uid(), name, classTeacherId });
  DB.set(KEYS.classes, classes);
  auditAction('create', 'class', classes[classes.length - 1].id, `Created class: ${name}`);
  input.value = '';
  renderClasses();
});

/* ---------- Students ---------- */
function renderStudentClassSelect() {
  const sel = document.getElementById('studentClassSelect');
  fillClassSelect(sel);
  renderStudents();
}

function fillClassSelect(sel) {
  const classes = getAccessibleClasses();
  const prev = sel.value;
  sel.innerHTML = classes.length
    ? classes.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')
    : '<option value="">No assigned classes</option>';
  if (classes.some(c => c.id === prev)) sel.value = prev;
}

let editingStudentId = null;

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
      const inName = s.name.toLowerCase().includes(query);
      const inId = s.admissionId && s.admissionId.toLowerCase().includes(query);
      return inName || inId;
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
        <input type="text" class="edit-student-name" value="${escapeHtml(st.name)}" placeholder="Full name">
        <input type="text" class="edit-student-id" value="${st.admissionId ? escapeHtml(st.admissionId) : ''}" placeholder="Student ID (optional)">
        <input type="tel" class="edit-student-phone" value="${st.parentPhone ? escapeHtml(st.parentPhone) : ''}" placeholder="Parent phone (optional, for WhatsApp)">
        <select class="edit-student-gender">
          <option value="M" ${st.gender === 'M' ? 'selected' : ''}>Male</option>
          <option value="F" ${st.gender === 'F' ? 'selected' : ''}>Female</option>
        </select>
        ${photoPreview}
        <label>Passport Photo
          <input type="file" class="edit-student-photo-input" accept="image/*" data-student="${st.id}">
        </label>
        <div class="edit-actions">
          <button class="save-btn save-student" data-id="${st.id}">Save</button>
          <button class="cancel-btn cancel-student">Cancel</button>
        </div>
      </div>`;
    } else {
      const idPart = st.admissionId ? ` · ID ${escapeHtml(st.admissionId)}` : '';
      const classPart = searchMode ? ` · ${escapeHtml(classesById[st.classId] || 'Unknown class')}` : '';
      const thumb = st.photo ? `<img src="${st.photo}" alt="" class="student-thumb">` : '<span class="student-thumb student-thumb-empty"></span>';
      li.innerHTML = `<div class="student-row-main">
          ${thumb}
          <div><strong>${escapeHtml(st.name)}</strong><div class="meta">${st.gender}${idPart}${classPart}</div></div>
        </div>
        <div class="actions">
          <button data-id="${st.id}" class="edit-student">Edit</button>
          <button data-id="${st.id}" class="del-student">Delete</button>
        </div>`;
    }
    list.appendChild(li);
  });
  list.querySelectorAll('.edit-student').forEach(btn => {
    btn.addEventListener('click', () => { editingStudentId = btn.dataset.id; renderStudents(); });
  });
  list.querySelectorAll('.cancel-student').forEach(btn => {
    btn.addEventListener('click', () => { editingStudentId = null; renderStudents(); });
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
    btn.addEventListener('click', () => {
      const li = btn.closest('li');
      const name = li.querySelector('.edit-student-name').value.trim();
      if (!name) return;
      const admissionId = li.querySelector('.edit-student-id').value.trim();
      const parentPhone = li.querySelector('.edit-student-phone').value.trim();
      const gender = li.querySelector('.edit-student-gender').value;
      const students = DB.get(KEYS.students, []);
      const st = students.find(x => x.id === btn.dataset.id);
      if (st) { st.name = name; st.admissionId = admissionId; st.parentPhone = parentPhone; st.gender = gender; }
      DB.set(KEYS.students, students);
      auditAction('update', 'student', st ? st.id : btn.dataset.id, `Updated student: ${st ? st.name : ''}`);
      editingStudentId = null;
      renderStudents();
      renderClasses();
    });
  });
  list.querySelectorAll('.del-student').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Delete this student and their grades?')) return;
      const id = btn.dataset.id;
      DB.set(KEYS.students, DB.get(KEYS.students, []).filter(s => s.id !== id));
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

document.getElementById('studentClassSelect').addEventListener('change', renderStudents);
document.getElementById('studentSearchInput').addEventListener('input', renderStudents);

document.getElementById('addStudentBtn').addEventListener('click', () => {
  const classId = document.getElementById('studentClassSelect').value;
  if (!classId) { alert('Add a class first.'); return; }
  if (!requireClassAccess(classId)) return;
  const nameInput = document.getElementById('newStudentName');
  const name = nameInput.value.trim();
  if (!name) return;
  const gender = document.getElementById('newStudentGender').value;
  const admissionId = document.getElementById('newStudentId').value.trim();
  const parentPhone = document.getElementById('newStudentPhone').value.trim();
  const students = DB.get(KEYS.students, []);
  students.push({ id: uid(), classId, name, gender, admissionId, parentPhone });
  DB.set(KEYS.students, students);
  nameInput.value = '';
  document.getElementById('newStudentId').value = '';
  document.getElementById('newStudentPhone').value = '';
  renderStudents();
  renderClasses();
});

// Bulk add: one student per line, optionally "Name, ID". Gender and
// parent phone are left unset — use Edit on each student afterward.
document.getElementById('bulkAddStudentsBtn').addEventListener('click', () => {
  const classId = document.getElementById('studentClassSelect').value;
  if (!classId) { alert('Add a class first.'); return; }
  const textarea = document.getElementById('bulkStudentInput');
  const lines = textarea.value.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (!lines.length) return;
  const students = DB.get(KEYS.students, []);
  lines.forEach(line => {
    const parts = line.split(',');
    const name = parts[0].trim();
    if (!name) return;
    const admissionId = parts.length > 1 ? parts.slice(1).join(',').trim() : '';
    students.push({ id: uid(), classId, name, gender: '', admissionId, parentPhone: '' });
  });
  DB.set(KEYS.students, students);
  textarea.value = '';
  renderStudents();
  renderClasses();
  alert(`Added ${lines.length} student(s).`);
});

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
          <button class="save-btn save-subject" data-id="${sub.id}">Save</button>
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
      if (sub) sub.name = name;
      DB.set(KEYS.subjects, subjects);
      auditAction('update', 'subject', sub ? sub.id : btn.dataset.id, `Updated subject: ${sub ? sub.name : ''}`);
      editingSubjectId = null;
      renderSubjects();
    });
  });
  list.querySelectorAll('.del-subject').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Delete this subject from all classes?')) return;
      const id = btn.dataset.id;
      const subjects = DB.get(KEYS.subjects, []).filter(s => s.id !== id);
      subjects.forEach((sub, i) => { sub.order = i; });
      DB.set(KEYS.subjects, subjects);
      renderSubjects();
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
  subjects.forEach(sub => { sub.order = subjectOrderValue(sub, 0); });
  const maxOrder = subjects.reduce((max, sub) => Math.max(max, Number(sub.order) || 0), -1);
  subjects.push({ id: uid(), name, order: maxOrder + 1 });
  DB.set(KEYS.subjects, subjects);
  input.value = '';
  renderSubjects();
});

/* ---------- Staff ---------- */
let editingStaffId = null;

const STAFF_FIELDS = [
  { key: 'dob', label: 'Date of Birth', type: 'date' },
  { key: 'staffId', label: 'Staff ID', type: 'text' },
  { key: 'registeredNo', label: 'Registered No.', type: 'text' },
  { key: 'licenseNo', label: 'License No.', type: 'text' },
  { key: 'ssnitNo', label: 'SSNIT No.', type: 'text' },
  { key: 'ghanaCardId', label: 'Ghana Card ID', type: 'text' },
  { key: 'dateOfAppointment', label: 'Date of Appointment', type: 'date' },
  { key: 'rank', label: 'Rank', type: 'text' },
  { key: 'phone', label: 'Phone (optional)', type: 'tel' }
];

function renderStaff() {
  if (FIREBASE_ENABLED && !sessionDataReady) { const el = document.getElementById('staffList'); if (el) el.innerHTML = '<li class="empty">Loading your school workspace…</li>'; return; }
  const list = document.getElementById('staffList');
  const staff = DB.get(KEYS.staff, []);
  list.innerHTML = '';
  if (!staff.length) { list.innerHTML = '<li class="empty">No staff yet — add one below.</li>'; return; }
  staff.forEach(st => {
    const li = document.createElement('li');
    if (editingStaffId === st.id) {
      const fieldInputs = STAFF_FIELDS.map(f =>
        `<label>${f.label}<input type="${f.type}" class="edit-staff-${f.key}" value="${st[f.key] ? escapeHtml(st[f.key]) : ''}"></label>`
      ).join('');
      const sigPreview = st.signature
        ? `<img src="${st.signature}" alt="" class="staff-signature-preview">
           <button type="button" class="btn-text remove-staff-signature" data-id="${st.id}">Remove signature</button>`
        : '';
      li.innerHTML = `<div class="edit-row">
        <input type="text" class="edit-staff-name" value="${escapeHtml(st.name)}" placeholder="Full name">
        <label>Role
          <select class="edit-staff-role">
            <option value="Teacher" ${st.role === 'Teacher' ? 'selected' : ''}>Teacher</option>
            <option value="Head Teacher" ${st.role === 'Head Teacher' ? 'selected' : ''}>Head Teacher</option>
            <option value="Assistant Head Teacher" ${st.role === 'Assistant Head Teacher' ? 'selected' : ''}>Assistant Head Teacher</option>
            <option value="Other" ${st.role === 'Other' ? 'selected' : ''}>Other</option>
          </select>
        </label>
        ${fieldInputs}
        ${sigPreview}
        <label>Signature
          <input type="file" class="edit-staff-signature-input" accept="image/*" data-staff="${st.id}">
        </label>
        <div class="edit-actions">
          <button class="save-btn save-staff" data-id="${st.id}">Save</button>
          <button class="cancel-btn cancel-staff">Cancel</button>
        </div>
      </div>`;
    } else {
      const sigThumb = st.signature ? `<img src="${st.signature}" alt="" class="staff-signature-thumb">` : '';
      const linkedTeacher = st.userUid ? `<div class="meta">SchoolHub Teacher: ${escapeHtml(st.email || st.userUid)}</div>` : '';
      li.innerHTML = `<div><strong>${escapeHtml(st.name)}</strong>
          <div class="meta">${escapeHtml(st.role || 'Staff')}${st.rank ? ' · ' + escapeHtml(st.rank) : ''}${st.staffId ? ' · ID ' + escapeHtml(st.staffId) : ''}</div>
          ${linkedTeacher}
          ${sigThumb}
        </div>
        <div class="actions">
          <button data-id="${st.id}" class="edit-staff">Edit</button>
          <button data-id="${st.id}" class="del-staff">Delete</button>
        </div>`;
    }
    list.appendChild(li);
  });

  list.querySelectorAll('.edit-staff').forEach(btn => {
    btn.addEventListener('click', () => { editingStaffId = btn.dataset.id; renderStaff(); });
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

      // v36: save locally before any Firebase operation.
      try {
        const dataUrl = await fileToDataUrl(file);
        if (!isDataImage(dataUrl)) throw new Error('The selected file is not a readable image.');

        await cacheLocalImageWithMeta(cacheKey, dataUrl, {
          storagePath: assetPath,
          sourceUrl: '',
          updatedAt: new Date().toISOString()
        });

        const staffList = DB.get(KEYS.staff, []);
        const st = staffList.find(x => x.id === staffId);
        if (!st) throw new Error('Staff record not found.');
        st.signature = dataUrl;
        st.signatureUrl = '';
        st.signatureStoragePath = assetPath;
        DB.set(KEYS.staff, staffList);
        renderStaff();
        auditAction('update', 'staff-signature', staffId, `Updated staff signature: ${st.name || staffId}`);

        try {
          const url = await uploadSchoolAsset(file, 'signatures', staffId);
          const latestStaff = DB.get(KEYS.staff, []);
          const latest = latestStaff.find(x => x.id === staffId);
          if (latest) {
            latest.signature = dataUrl;
            latest.signatureUrl = url || '';
            latest.signatureStoragePath = assetPath;
          }
          DB.set(KEYS.staff, latestStaff);

          await persistStaffSignature(staffId, url || '', assetPath);
          await upsertImageManifest('staff', staffId, {
            storagePath: assetPath,
            sourceUrl: url || '',
            storageUpdatedAt: new Date().toISOString()
          });

          if (oldStoragePath && oldStoragePath !== assetPath) await removeStoragePath(oldStoragePath);
          renderStaff();
        } catch (cloudError) {
          console.warn('Staff signature cloud backup pending:', cloudError);
          alert(`Signature saved on this browser. Firebase backup is pending.\n\n${cloudError.message || cloudError}`);
        }
      } catch (err) {
        alert('Could not save the signature locally: ' + (err.message || err));
      } finally {
        input.value = '';
      }
    });
  });
  list.querySelectorAll('.remove-staff-signature').forEach(btn => {
    btn.addEventListener('click', () => {
      const staffList = DB.get(KEYS.staff, []);
      const st = staffList.find(x => x.id === btn.dataset.id);
      if (!st) return;
      const oldUrl = st.signatureUrl || st.signature || '';
      st.signature = '';
      st.signatureUrl = '';
      st.signatureStoragePath = '';
      removeCachedLocalImage(imageCacheKey('staff', st.id));
      DB.set(KEYS.staff, staffList);
      Promise.all([
        st.signatureStoragePath ? removeStoragePath(st.signatureStoragePath) : removeStorageFile(oldUrl),
        persistStaffSignature(st.id, ''),
        removeImageManifest('staff', st.id)
      ]).then(() => renderStaff())
        .catch(err => alert('Could not remove the signature: ' + err.message));
    });
  });
  list.querySelectorAll('.save-staff').forEach(btn => {
    btn.addEventListener('click', () => {
      const li = btn.closest('li');
      const name = li.querySelector('.edit-staff-name').value.trim();
      if (!name) return;
      const staffList = DB.get(KEYS.staff, []);
      const st = staffList.find(x => x.id === btn.dataset.id);
      if (st) {
        st.name = name;
        st.role = li.querySelector('.edit-staff-role').value;
        STAFF_FIELDS.forEach(f => { st[f.key] = li.querySelector(`.edit-staff-${f.key}`).value.trim(); });
      }
      DB.set(KEYS.staff, staffList);
      auditAction('update', 'staff', st ? st.id : btn.dataset.id, `Updated staff: ${st ? st.name : ''}`);
      editingStaffId = null;
      renderStaff();
      renderClasses(); // class list "Class Teacher:" meta may reference this name
    });
  });
  list.querySelectorAll('.del-staff').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Delete this staff member? Any class or Head Teacher signature assignment referencing them will be cleared.')) return;
      const id = btn.dataset.id;
      DB.set(KEYS.staff, DB.get(KEYS.staff, []).filter(s => s.id !== id));
      auditAction('delete', 'staff', id, 'Deleted staff record');
      const classes = DB.get(KEYS.classes, []);
      classes.forEach(c => { if (c.classTeacherId === id) c.classTeacherId = ''; });
      DB.set(KEYS.classes, classes);
      const s = DB.get(KEYS.settings, {});
      if (s.headTeacherId === id) { s.headTeacherId = ''; DB.set(KEYS.settings, s); }
      renderStaff();
      renderClasses();
    });
  });
}

document.getElementById('addStaffBtn').addEventListener('click', async () => {
  if (!requireHeadTeacher('manage staff')) return;
  const nameInput = document.getElementById('newStaffName');
  const name = nameInput.value.trim();
  if (!name) return;
  const role = document.getElementById('newStaffRole').value;
  const values = {};
  STAFF_FIELDS.forEach(f => { values[f.key] = document.getElementById('newStaff_' + f.key).value.trim(); });
  const file = document.getElementById('newStaffSignature').files[0];

  const staffId = uid();
  const signaturePath = file ? schoolAssetPath(file, 'signatures', staffId) : '';
  let signatureDataUrl = '';
  let signatureUrl = '';

  try {
    // v36: read/cache the signature before touching Firebase.
    if (file) {
      signatureDataUrl = await fileToDataUrl(file);
      if (!isDataImage(signatureDataUrl)) throw new Error('The selected signature file is not a readable image.');
      await cacheLocalImageWithMeta(imageCacheKey('staff', staffId), signatureDataUrl, {
        storagePath: signaturePath,
        sourceUrl: '',
        updatedAt: new Date().toISOString()
      });
    }

    const staffList = DB.get(KEYS.staff, []);
    const record = Object.assign({
      id: staffId,
      name,
      role,
      signature: signatureDataUrl,
      signatureUrl: '',
      signatureStoragePath: signaturePath
    }, values);
    staffList.push(record);
    DB.set(KEYS.staff, staffList);
    renderStaff();
    auditAction('create', 'staff', record.id, `Added staff: ${record.name}`);

    // Clear the form immediately after the local transaction succeeds.
    nameInput.value = '';
    STAFF_FIELDS.forEach(f => { document.getElementById('newStaff_' + f.key).value = ''; });
    document.getElementById('newStaffSignature').value = '';

    if (file) {
      try {
        signatureUrl = await uploadSchoolAsset(file, 'signatures', staffId);
        const latestStaff = DB.get(KEYS.staff, []);
        const latest = latestStaff.find(x => x.id === staffId);
        if (latest) latest.signatureUrl = signatureUrl || '';
        DB.set(KEYS.staff, latestStaff);
        await persistStaffSignature(staffId, signatureUrl || '', signaturePath);
        await upsertImageManifest('staff', staffId, {
          storagePath: signaturePath,
          sourceUrl: signatureUrl || '',
          storageUpdatedAt: new Date().toISOString()
        });
      } catch (cloudError) {
        console.warn('New staff signature cloud backup pending:', cloudError);
        alert(`Staff member saved locally. Signature Firebase backup is pending.\n\n${cloudError.message || cloudError}`);
      }
    }
    renderStaff();
  } catch (err) {
    alert('Could not save the staff member: ' + (err.message || err));
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

function downloadAttendanceReportPdf(){
  const btn=document.getElementById('downloadAttendanceReportBtn'); if(btn){btn.disabled=true;btn.textContent='Preparing Report…';}
  try{
    if(!window.jspdf||!window.jspdf.jsPDF)throw new Error('PDF library is not available. Please refresh SchoolHub and try again.');
    const sel=attendanceReportCurrentSelection(); const timesOpen=calculateTimesOpen(sel.term,sel.year); const doc=new window.jspdf.jsPDF({orientation:'portrait',unit:'mm',format:'a4'}); const W=doc.internal.pageSize.getWidth(),H=doc.internal.pageSize.getHeight(),m=10; let y=14;
    const txt=(v,x,yy,size=9,b=false)=>{doc.setFont('helvetica',b?'bold':'normal');doc.setFontSize(size);doc.text(String(v??''),x,yy);};
    const need=(h=8)=>{if(y+h>H-12){doc.addPage();y=14;}};
    const section=t=>{need(10);y+=3;txt(t,m,y,11,true);y+=5;};
    const table=(heads,rows,widths)=>{const row=(cells,b)=>{const lh=3.6,pad=1.1;const ls=cells.map((c,i)=>{doc.setFont('helvetica',b?'bold':'normal');doc.setFontSize(7);return doc.splitTextToSize(String(c??''),Math.max(5,widths[i]-pad*2));});const h=Math.max(6,Math.max(...ls.map(a=>a.length),1)*lh+2.4);need(h+1);let x=m;cells.forEach((c,i)=>{doc.rect(x,y,widths[i],h);doc.setFont('helvetica',b?'bold':'normal');doc.setFontSize(7);doc.text(ls[i],x+pad,y+3.5);x+=widths[i];});y+=h;};row(heads,true);rows.forEach(r=>row(r,false));y+=2;};
    const settings=sel.settings; txt(settings.schoolName||'School',m,y,16,true);y+=6;txt(attendanceReportTitle(sel),m,y,12,true);y+=5;txt(`${sel.term} ${sel.year} · Times Open: ${timesOpen} days`,m,y,9);y+=7;
    if(sel.type==='term'){
      const s=attendanceReportOverallStudent(sel.term,sel.year,timesOpen),t=attendanceReportOverallTeacher(sel.term,sel.year,timesOpen);section('Overall Summary');table(['Metric','Value'],[['Times Open',timesOpen+' days'],['Holidays',schoolCalendarRecordsForTerm(sel.term,sel.year).filter(x=>String(x.record.type||'').toLowerCase()==='holiday').length],['Midterm',schoolCalendarRecordsForTerm(sel.term,sel.year).filter(x=>String(x.record.type||'').toLowerCase()==='midterm').length],['Pupils',s.pupils],['Average Pupil Ratio',formatAttendanceRatio(s.averageRatio)],['Teachers',t.teachers],['Average Teacher Ratio',formatAttendanceRatio(t.averageRatio)]],[80,95]);section('Class Attendance');table(['Class','Pupils','Present','Late','Total','Absent','Avg Ratio'],getAccessibleClasses().map(c=>{const x=attendanceSummaryClassStats(c.id,sel.term,sel.year,timesOpen);return[c.name,x.pupils,x.present,x.late,x.total,x.absent,formatAttendanceRatio(x.averageRatio)];}),[40,20,20,18,18,20,39]);if(isHeadTeacher()){section('Teacher Attendance');table(['Teacher','Role','Present','Late','Total','Absent','Excused','Leave','Ratio'],attendanceReportTeacherRows(sel.term,sel.year,timesOpen).map(x=>[x.staff.name,x.staff.role||'Teacher',x.stats.present,x.stats.late,x.stats.total,x.stats.absent,x.stats.excused,x.stats.leave,formatAttendanceRatio(x.stats.ratio)]),[33,26,17,13,15,17,17,17,25]);}
    } else if(sel.type==='daily-students'||sel.type==='daily-teachers'){
      const data=attendanceReportDaily(sel.date,sel.term,sel.year,sel.classId,sel.type==='daily-teachers'?'teachers':'students');section(`Daily Attendance · ${sel.date}`);table(['Name',sel.type==='daily-students'?'Class':'Role','Status'],data.rows.map(r=>[r.name,sel.type==='daily-students'?r.className:r.role,r.status?attendanceStatusLabel(r.status):'Not recorded']),[65,55,60]);
    } else if(sel.type==='class'){
      const c=DB.get(KEYS.classes,[]).find(x=>x.id===sel.classId);if(!c)throw new Error('Select a class first.');section(c.name);const rows=attendanceReportClassRows(c.id,sel.term,sel.year,timesOpen);table(['Pupil','Present','Late','Total','Absent','Ratio','Current','Longest'],rows.map(x=>[x.student.name,x.stats.present,x.stats.late,x.stats.total,x.stats.absent,formatAttendanceRatio(x.stats.ratio),x.stats.currentAbsenceStreak,x.stats.longestAbsenceStreak]),[42,17,14,15,16,23,22,22]);
    } else if(sel.type==='pupil'){
      const st=DB.get(KEYS.students,[]).find(x=>x.id===sel.personId);if(!st||!canAccessClass(st.classId))throw new Error('Select a pupil first.');const x=attendanceReportPupilStats(st,sel.term,sel.year,timesOpen);section(st.name);table(['Metric','Value'],[['Class',(DB.get(KEYS.classes,[]).find(c=>c.id===st.classId)||{}).name||''],['Times Open',timesOpen],['Present',x.present],['Late',x.late],['Total',x.total],['Absent',x.absent],['Attendance Ratio',formatAttendanceRatio(x.ratio)],['Current Absence Streak',x.currentAbsenceStreak],['Longest Absence Streak',x.longestAbsenceStreak]],[85,90]);section('Attendance History');table(['Date','Day','Status'],x.history.map(r=>{const d=parseDateOnly(r.date);return[r.date,d?d.toLocaleDateString(undefined,{weekday:'short'}):'',r.label];}),[40,25,110]);
    } else if(sel.type==='teacher'){
      const st=DB.get(KEYS.staff,[]).find(x=>x.id===sel.personId&&isTeacherStaffRecord(x));if(!st)throw new Error('Select a teacher first.');const x=attendanceReportTeacherStats(st,sel.term,sel.year,timesOpen);section(st.name);table(['Metric','Value'],[['Role',st.role||'Teacher'],['Times Open',timesOpen],['Present',x.present],['Late',x.late],['Total',x.total],['Absent',x.absent],['Excused',x.excused],['On Leave',x.leave],['Attendance Ratio',formatAttendanceRatio(x.ratio)],['Current Absence Streak',x.currentAbsenceStreak],['Longest Absence Streak',x.longestAbsenceStreak]],[85,90]);section('Attendance History');table(['Date','Day','Status'],x.history.map(r=>{const d=parseDateOnly(r.date);return[r.date,d?d.toLocaleDateString(undefined,{weekday:'short'}):'',r.label];}),[40,25,110]);
    }
    need(10);y+=4;txt('Attendance ratios use Times Open. Present and Late count as attendance. Holidays, Midterm and weekends are excluded from Times Open.',m,y,8,false);
    const safe=attendanceReportTitle(sel).replace(/[^a-z0-9]+/gi,'_').replace(/^_+|_+$/g,'');doc.save(`${safe}_${sel.term}_${sel.year}`.replace(/[^a-z0-9_]+/gi,'_')+'.pdf');
  }catch(e){console.error(e);alert(e.message||'Unable to create the attendance report PDF.');}finally{if(btn){btn.disabled=false;btn.textContent='Download Report';}}
}


function renderAttendanceView() {
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
  html += `<div class="attendance-toolbar"><button type="button" id="attendanceAllPresent" class="btn-text">Mark All Present</button><button type="button" id="attendanceAllAbsent" class="btn-text">Mark All Absent</button></div>`;
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
    html += `<tr><td>${escapeHtml(x.date)}</td><td>${escapeHtml(day)}</td><td>${escapeHtml(calendarLabel(String(x.record.type || '').toLowerCase()))}</td><td>${escapeHtml(x.record.note || '')}</td><td><button type="button" class="btn-text calendar-edit" data-date="${escapeHtml(x.date)}">Edit</button><button type="button" class="btn-text calendar-delete" data-date="${escapeHtml(x.date)}">Remove</button></td></tr>`;
  });
  html += '</tbody></table></div>';
  html += '<p class="hint">Only weekdays inside the term count toward Times Open. Holiday and Midterm days are excluded. Weekends are automatically excluded.</p>';
  wrap.innerHTML = html;
  const canEdit = isHeadTeacher();
  ['calendarDate','calendarType','calendarNote','saveCalendarDay','clearCalendarDay'].forEach(id => { const el=document.getElementById(id); if(el) el.disabled=!canEdit; });
  document.querySelectorAll('.calendar-edit').forEach(btn => btn.addEventListener('click', () => {
    const rec = calendarRecord(term, year, btn.dataset.date) || {};
    document.getElementById('calendarDate').value = btn.dataset.date;
    document.getElementById('calendarType').value = rec.type || 'holiday';
    document.getElementById('calendarNote').value = rec.note || '';
  }));
  document.querySelectorAll('.calendar-delete').forEach(btn => btn.addEventListener('click', () => {
    if (!requireHeadTeacher('change the school calendar')) return;
    const all = DB.get(KEYS.schoolCalendar, {});
    const key = calendarKey(term, year, btn.dataset.date);
    delete all[key]; DB.set(KEYS.schoolCalendar, all);
    auditAction('delete', 'schoolCalendar', key, `Removed calendar exception for ${btn.dataset.date}`);
    refreshAttendanceAfterCalendarChange();
  }));
  document.getElementById('saveCalendarDay').addEventListener('click', () => {
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
    if (type === 'open') delete all[key];
    else all[key] = { term, year, date, type, note, updatedAt: new Date().toISOString() };
    DB.set(KEYS.schoolCalendar, all);
    auditAction('update', 'schoolCalendar', key, `Set ${date} as ${calendarLabel(type)}${note ? ` · ${note}` : ''}`);
    refreshAttendanceAfterCalendarChange();
    alert(`School calendar updated: ${date} · ${calendarLabel(type)}.`);
  });
  document.getElementById('clearCalendarDay').addEventListener('click', () => {
    if (!requireHeadTeacher('change the school calendar')) return;
    const date = document.getElementById('calendarDate').value;
    if (!date) { alert('Select a calendar date.'); return; }
    const all = DB.get(KEYS.schoolCalendar, {}); delete all[calendarKey(term, year, date)]; DB.set(KEYS.schoolCalendar, all);
    auditAction('delete', 'schoolCalendar', calendarKey(term, year, date), `Set ${date} as School Open`);
    refreshAttendanceAfterCalendarChange();
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
  const pdfBtn = document.getElementById('pdfAttendanceSummaryBtn');
  if (pdfBtn) { pdfBtn.disabled = true; pdfBtn.textContent = 'Preparing Report…'; }

  try {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      throw new Error('PDF library is not available. Please refresh SchoolHub and try again.');
    }

    const settings = DB.get(KEYS.settings, {});
    const term = String(settings.currentTerm || 'Term 1');
    const year = String(settings.currentYear || '');
    const timesOpen = calculateTimesOpen(term, year);
    const calendar = schoolCalendarRecordsForTerm(term, year);
    const holidays = calendar.filter(x => String(x.record.type || '').toLowerCase() === 'holiday').length;
    const midterms = calendar.filter(x => String(x.record.type || '').toLowerCase() === 'midterm').length;
    const school = String(settings.schoolName || 'School');
    const students = attendanceReportOverallStudent(term, year, timesOpen);
    const teachers = attendanceReportOverallTeacher(term, year, timesOpen);
    const classes = getAccessibleClasses();
    const staff = DB.get(KEYS.staff, []).filter(isTeacherStaffRecord);
    const teacherMap = teacherAttendanceSummary(term, year).summary;

    const JsPDF = window.jspdf.jsPDF;
    const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 10;
    const usableW = pageW - margin * 2;
    let y = 14;

    const addPageIfNeeded = (height = 8) => {
      if (y + height > pageH - 12) { doc.addPage(); y = 14; }
    };
    const text = (value, x, yy, size = 9, bold = false) => {
      doc.setFont('helvetica', bold ? 'bold' : 'normal');
      doc.setFontSize(size);
      doc.text(String(value ?? ''), x, yy);
    };
    const wrapped = (value, x, yy, width, size = 8.5, lineGap = 4.2) => {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(size);
      const lines = doc.splitTextToSize(String(value ?? ''), width);
      doc.text(lines, x, yy);
      return lines.length * lineGap;
    };
    const section = (title) => {
      addPageIfNeeded(10);
      y += 3;
      text(title, margin, y, 11, true);
      y += 5;
    };
    const row = (cells, widths, opts = {}) => {
      const fontSize = opts.fontSize || 7.4;
      const lineHeight = opts.lineHeight || 3.6;
      const cellPad = 1.2;
      const lineSets = cells.map((cell, i) => {
        doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
        doc.setFontSize(fontSize);
        return doc.splitTextToSize(String(cell ?? ''), Math.max(5, widths[i] - cellPad * 2));
      });
      const maxLines = Math.max(...lineSets.map(a => a.length), 1);
      const h = Math.max(6, maxLines * lineHeight + 2.5);
      addPageIfNeeded(h + 1);
      let x = margin;
      for (let i = 0; i < cells.length; i++) {
        doc.rect(x, y, widths[i], h);
        doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
        doc.setFontSize(fontSize);
        doc.text(lineSets[i], x + cellPad, y + 3.5);
        x += widths[i];
      }
      y += h;
    };
    const table = (headers, rows, widths) => {
      row(headers, widths, { bold: true, fontSize: 7.2 });
      rows.forEach(r => row(r, widths, { fontSize: 7.1 }));
      y += 2;
    };

    text(school, margin, y, 16, true); y += 6;
    text('Attendance Summary Report', margin, y, 12, true); y += 5;
    text(`${term} ${year} · Times Open: ${timesOpen} days`, margin, y, 9); y += 7;

    const cards = [
      ['Times Open', `${timesOpen} days`],
      ['Holidays', holidays],
      ['Midterm', midterms],
      ['Pupils', students.pupils],
      ['Average Pupil Ratio', formatAttendanceRatio(students.averageRatio)],
      ['Teachers', teachers.teachers],
      ['Average Teacher Ratio', formatAttendanceRatio(teachers.averageRatio)]
    ];
    const cardW = usableW / 2;
    for (let i = 0; i < cards.length; i += 2) {
      addPageIfNeeded(13);
      const pair = cards.slice(i, i + 2);
      pair.forEach((c, j) => {
        const x = margin + j * cardW;
        doc.rect(x, y, cardW - 2, 11);
        text(c[0], x + 2, y + 4, 7.2, false);
        text(c[1], x + 2, y + 8.5, 9, true);
      });
      y += 13;
    }

    section('Class Attendance');
    const classWidths = [38, 20, 20, 17, 18, 20, 41];
    table(['Class','Pupils','Present','Late','Total','Absent','Average Ratio'],
      classes.map(c => { const x = attendanceSummaryClassStats(c.id, term, year, timesOpen); return [c.name,x.pupils,x.present,x.late,x.total,x.absent,formatAttendanceRatio(x.averageRatio)]; }), classWidths);

    if (isHeadTeacher()) {
      section('Teacher Attendance');
      const teacherWidths = [35, 27, 18, 14, 16, 18, 18, 18, 30];
      table(['Teacher','Role','Present','Late','Total','Absent','Excused','Leave','Ratio'],
        staff.map(st => { const sm=teacherMap[st.id]||{present:0,late:0,total:0,absent:0,excused:0,leave:0}; return [st.name,st.role||'Teacher',sm.present,sm.late,sm.total,sm.absent,sm.excused,sm.leave,formatAttendanceRatio(attendanceRatio(sm,timesOpen,true))]; }), teacherWidths);
    }

    section('School Calendar Exceptions');
    const exceptions = calendar.filter(x => String(x.record.type || '').toLowerCase() !== 'open');
    table(['Date','Day','Type','Note'],
      exceptions.map(x => { const d=parseDateOnly(x.date); const day=d?d.toLocaleDateString(undefined,{weekday:'short'}):''; return [x.date,day,calendarLabel(String(x.record.type||'').toLowerCase()),x.record.note||'']; }), [30,18,30,104]);

    addPageIfNeeded(15);
    y += 3;
    wrapped('Attendance ratios use Times Open. Present and Late count as attendance. Approved teacher Excused and On Leave days are excluded from the individual teacher denominator. Holidays, midterm days and weekends are excluded from Times Open.', margin, y, usableW, 8, 4);

    const safe = `${term}-${year}`.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
    doc.save(`Attendance_Summary_${safe || 'Report'}.pdf`);
  } catch (e) {
    console.error('Attendance PDF generation failed:', e);
    alert(e && e.message ? e.message : 'Unable to create the PDF. Please try again.');
  } finally {
    if (pdfBtn) { pdfBtn.disabled = false; pdfBtn.textContent = 'Download Report'; }
  }
}

function refreshAttendanceAfterCalendarChange() {
  const settings = DB.get(KEYS.settings, {});
  settings.attendanceOutOf = String(calculateTimesOpen(settings.currentTerm, settings.currentYear) || '');
  DB.set(KEYS.settings, settings);
  const active = document.querySelector('#attendanceModeBar .attendance-mode.active');
  setAttendanceMode((active && active.dataset.mode) || 'students');
  loadSettingsForm();
}

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

/* ---------- Remarks (attendance, conduct, fees, comments) ---------- */
function renderRemarksClassSelect() {
  const sel = document.getElementById('remarksClassSelect');
  fillClassSelect(sel);
  renderRemarksForm();
}

function renderRemarksForm() {
  const classId = document.getElementById('remarksClassSelect').value;
  if (classId && !canAccessClass(classId)) { document.getElementById('remarksFormWrap').innerHTML = '<p class="empty">You do not have access to this class.</p>'; return; }
  const wrap = document.getElementById('remarksFormWrap');
  if (!classId) { wrap.innerHTML = '<p class="empty">Add a class first.</p>'; return; }
  const students = getAccessibleStudents().filter(s => s.classId === classId);
  if (!students.length) { wrap.innerHTML = '<p class="empty">No students in this class.</p>'; return; }
  const settings = DB.get(KEYS.settings, {});
  const key = gradeKey(classId, settings.currentTerm, settings.currentYear);
  const allRemarks = DB.get(KEYS.remarks, {});
  const classRemarks = allRemarks[key] || {};

  let html = '';
  students.forEach(st => {
    const r = classRemarks[st.id] || {};
    html += `<div class="remarks-card" data-student="${st.id}">
      <h3>${escapeHtml(st.name)}</h3>
      <label>Attendance (days present)
        <input type="number" min="0" class="rm-attendance" value="${r.attendance !== undefined ? r.attendance : ''}">
      </label>
      <label>Promoted / Repeated to
        <input type="text" class="rm-promoted" placeholder="e.g. Basic Two (2)" value="${r.promoted ? escapeHtml(r.promoted) : ''}">
      </label>
      <label>Fees Due (GH¢)
        <input type="number" min="0" step="0.01" class="rm-fees" value="${r.feesDue !== undefined ? r.feesDue : ''}">
      </label>
      <label>Conduct / Character
        <input type="text" class="rm-conduct" placeholder="e.g. Faithfully performs classroom tasks" value="${r.conduct ? escapeHtml(r.conduct) : ''}">
      </label>
      <label>Attitude
        <input type="text" class="rm-attitude" placeholder="e.g. Shows enthusiasm for classroom activities" value="${r.attitude ? escapeHtml(r.attitude) : ''}">
      </label>
      <label>Interest
        <input type="text" class="rm-interest" placeholder="e.g. Reading, Football, Drawing" value="${r.interest ? escapeHtml(r.interest) : ''}">
      </label>
      <label>Form Teacher's Comment
        <input type="text" class="rm-comment" placeholder="e.g. Keep it up" value="${r.comment ? escapeHtml(r.comment) : ''}">
      </label>
    </div>`;
  });
  wrap.innerHTML = html;
}

document.getElementById('remarksClassSelect').addEventListener('change', renderRemarksForm);

document.getElementById('saveRemarksBtn').addEventListener('click', () => {
  const classId = document.getElementById('remarksClassSelect').value;
  if (!classId) return;
  if (!requireClassAccess(classId)) return;
  const settings = DB.get(KEYS.settings, {});
  if (!settings.currentTerm || !settings.currentYear) {
    alert('Set the current Term and Academic Year in Setup first.');
    return;
  }
  const key = gradeKey(classId, settings.currentTerm, settings.currentYear);
  const allRemarks = DB.get(KEYS.remarks, {});
  const classRemarks = allRemarks[key] || {};
  document.querySelectorAll('.remarks-card').forEach(card => {
    const studentId = card.dataset.student;
    classRemarks[studentId] = {
      attendance: card.querySelector('.rm-attendance').value.trim(),
      promoted: card.querySelector('.rm-promoted').value.trim(),
      feesDue: card.querySelector('.rm-fees').value.trim(),
      conduct: card.querySelector('.rm-conduct').value.trim(),
      attitude: card.querySelector('.rm-attitude').value.trim(),
      interest: card.querySelector('.rm-interest').value.trim(),
      comment: card.querySelector('.rm-comment').value.trim()
    };
  });
  allRemarks[key] = classRemarks;
  DB.set(KEYS.remarks, allRemarks);
  auditAction('update', 'remarks', key, `Saved remarks for ${settings.currentTerm}, ${settings.currentYear}`);
  alert('Remarks saved.');
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
  const students = getAccessibleStudents().filter(s => s.classId === classId);
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
  const students = getAccessibleStudents().filter(s => s.classId === classId);
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

/* ---------- Reports ---------- */
function renderReportsClassSelect() {
  const sel = document.getElementById('reportsClassSelect');
  fillClassSelect(sel);
  renderReportsStudentList();
  renderClassStatistics();
}

function renderReportsStudentList() {
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
    li.innerHTML = `<div><strong>${escapeHtml(r.student.name)}</strong>
        <div class="meta">${r.entries.length} subject(s) · Avg ${r.avg.toFixed(1)}</div></div>
      <div class="actions">
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
      const numOnRoll = DB.get(KEYS.students, []).filter(s => s.classId === classId).length;
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
  const numOnRoll = DB.get(KEYS.students, []).filter(s => s.classId === classId).length;
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
      const numOnRoll = DB.get(KEYS.students, []).filter(s => s.classId === classId).length;
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
  const numOnRoll = DB.get(KEYS.students, []).filter(s => s.classId === classId).length;
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
  const PRIMARY = [24, 112, 99];
  const PRIMARY_DARK = [22, 80, 69];
  const TEXT = [22, 36, 28];
  const GOLD = [201, 162, 39];
  const PAPER = [241, 239, 230];
  const LIGHT = [248, 249, 246];
  const PALE_GREEN = [231, 242, 238];
  const MUTED = [92, 111, 99];
  const RED = [156, 58, 40];
  const WHITE = [255, 255, 255];
  const RULE = [205, 220, 214];

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
  doc.roundedRect(left, 8, contentW, 39, 4, 4, 'F');
  setFill(GOLD);
  doc.roundedRect(left, 44, contentW, 3, 1.5, 1.5, 'F');

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
    setDraw(GOLD); doc.setLineWidth(0.75);
    doc.roundedRect(right - pw - 5, 11, pw, ph, 2, 2, 'S');
  }

  const schoolName = (settings.schoolName && settings.schoolName.trim()) ? settings.schoolName.trim() : 'School Name Not Set';
  const headerCenter = pageWidth / 2;
  setText(WHITE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(schoolName, headerCenter, 19, { align: 'center' });
  doc.setFontSize(10);
  doc.text('TERMINAL REPORT CARD', headerCenter, 27, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.4);
  const contact = [settings.address, settings.email].filter(Boolean).join('  •  ');
  if (contact) doc.text(contact, headerCenter, 34, { align: 'center' });
  setText([230, 245, 240]);
  doc.setFontSize(6.4);
  doc.text('AlatiphA SchoolHub  •  Efficient School Management', headerCenter, 42, { align: 'center' });

  // Reusable compact two-column card. Values are constrained to the card so
  // long IDs, class names and totals can never spill outside the container.
  const cardY = 52, cardH = 31, gap = 4, cardW = (contentW - gap) / 2;
  function card(x, title, rows, width = cardW) {
    setFill(WHITE); doc.roundedRect(x, cardY, width, cardH, 2.5, 2.5, 'F');
    setDraw(RULE); doc.setLineWidth(0.25); doc.roundedRect(x, cardY, width, cardH, 2.5, 2.5, 'S');
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
    ['Class:', classInfo ? classInfo.name : ''],
    ['Position:', result.position ? ordinal(result.position) : '-'],
    ['Roll / ID:', result.student.admissionId || result.student.id || '-']
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
  const colW = simple ? [58, 22, 20, 23, 57] : [48, 20, 20, 21, 16, 19, 36];
  const colX = [left];
  colW.forEach(w => colX.push(colX[colX.length - 1] + w));
  const tableW = colX[colX.length - 1] - left;
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
    setDraw(RULE); doc.setLineWidth(0.22); doc.rect(left, y, tableW, rowH);
    for (let i = 1; i < colX.length - 1; i++) doc.line(colX[i], y, colX[i], y + rowH);
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
  const infoY = y, infoH = 36, infoGap = 4, infoW = (contentW - infoGap) / 2;
  function infoPanel(x, title, rows) {
    setFill(WHITE); doc.roundedRect(x, infoY, infoW, infoH, 2.5, 2.5, 'F');
    setDraw(RULE); doc.setLineWidth(0.25); doc.roundedRect(x, infoY, infoW, infoH, 2.5, 2.5, 'S');
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

  // Signature panels are deliberately WHITE because uploaded signature images
  // are normally saved with white backgrounds. This makes the signature blend
  // naturally into the signature area instead of showing a coloured rectangle.
  const sig = getStaffSignatures(classInfo, settings, resolvedAssets);
  const sigGap = 5, sigW = (contentW - sigGap - 31) / 2;
  const sigY = y, sigH = 28;
  function signatureBox(x, title, name, image) {
    setFill(WHITE); doc.roundedRect(x, sigY, sigW, sigH, 2.5, 2.5, 'F');
    setDraw(RULE); doc.setLineWidth(0.25); doc.roundedRect(x, sigY, sigW, sigH, 2.5, 2.5, 'S');
    if (image) {
      try { doc.addImage(image, 'PNG', x + sigW/2 - 18, sigY + 2, 36, 11); }
      catch (e) { try { doc.addImage(image, 'JPEG', x + sigW/2 - 18, sigY + 2, 36, 11); } catch (e2) {} }
    }
    setDraw(PRIMARY); doc.setLineWidth(0.35); doc.line(x + 12, sigY + 15, x + sigW - 12, sigY + 15);
    setText(PRIMARY_DARK); doc.setFont('helvetica','bold'); doc.setFontSize(7.2); doc.text(title, x + sigW/2, sigY + 20, {align:'center'});
    doc.setFont('helvetica','normal'); doc.setFontSize(6.5); doc.text(safe(name), x + sigW/2, sigY + 25, {align:'center'});
  }
  signatureBox(left, 'CLASS TEACHER', sig.classTeacherName, sig.classTeacherSignature);
  signatureBox(left + sigW + sigGap, 'HEAD TEACHER', sig.headTeacherName, sig.headTeacherSignature);

  const dateX = right - 31;
  setFill(WHITE); doc.roundedRect(dateX, sigY, 31, sigH, 2.5, 2.5, 'F');
  setDraw(GOLD); doc.setLineWidth(0.5); doc.roundedRect(dateX, sigY, 31, sigH, 2.5, 2.5, 'S');
  setText(PRIMARY_DARK); doc.setFont('helvetica','bold'); doc.setFontSize(6.8); doc.text('DATE OF ISSUE', dateX + 15.5, sigY + 9, {align:'center'});
  doc.setFont('helvetica','normal'); doc.setFontSize(7.2); doc.text(new Date().toLocaleDateString(), dateX + 15.5, sigY + 17, {align:'center'});
  setText(GOLD); doc.setFont('helvetica','bold'); doc.setFontSize(6); doc.text('SchoolHub', dateX + 15.5, sigY + 24, {align:'center'});

  // Two-line grading and remarks guides, deliberately compact so each fits
  // completely inside its container.
  y = sigY + sigH + 5;
  const legendGap = 4, legendW = (contentW - legendGap) / 2, legendH = 24;
  function legendBox(x, title, lines) {
    setFill(WHITE); doc.roundedRect(x, y, legendW, legendH, 2.5, 2.5, 'F');
    setDraw(RULE); doc.setLineWidth(0.25); doc.roundedRect(x, y, legendW, legendH, 2.5, 2.5, 'S');
    setFill(PRIMARY); doc.roundedRect(x, y, legendW, 6.5, 2.5, 2.5, 'F'); doc.rect(x, y + 4, legendW, 2.5, 'F');
    setText(WHITE); doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.text(title, x + 4, y + 4.5);
    let yy = y + 12;
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

  // Footer branding.
  const footerY = pageHeight - 14;
  setFill(PRIMARY_DARK); doc.rect(0, footerY, pageWidth, 14, 'F');
  setFill(GOLD); doc.rect(0, footerY, pageWidth, 1.5, 'F');
  setText(PAPER); doc.setFont('helvetica','normal'); doc.setFontSize(6.8);
  doc.text('Generated with ', left, footerY + 8);
  doc.setFont('helvetica','bold'); doc.text('AlatiphA SchoolHub', left + 20, footerY + 8);
  doc.setFont('helvetica','normal'); doc.text('Efficient School Management  •  Brighter Learners  •  Stronger Communities', right, footerY + 8, {align:'right'});
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

async function generateSinglePDF(result, positions, numOnRoll, classInfo, studentRemarks, settingsOverride) {
  if (!result.entries.length) { alert('No grades entered for this student yet.'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const settings = settingsOverride || DB.get(KEYS.settings, {});
  let assets;
  try {
    assets = await prepareReportAssets(result, settings, classInfo);
  } catch (assetError) {
    console.warn('Report image preparation failed:', assetError);
    assets = { logo: '', photo: '', classTeacherSignature: '', headTeacherSignature: '', classTeacherName: '', headTeacherName: '' };
  }
  drawReportPage(doc, result, settings, positions, numOnRoll, classInfo, studentRemarks, assets);
  doc.save(`${result.student.name.replace(/\s+/g, '_')}_report.pdf`);
}

async function generateBatchPDF(results, positions, numOnRoll, classInfo, remarksAll, settingsOverride) {
  const usable = results.filter(r => r.entries.length > 0);
  if (!usable.length) { alert('No grades entered for this class yet.'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const settings = settingsOverride || DB.get(KEYS.settings, {});
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
  doc.save('class_report_cards.pdf');
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
  const legacyKeys = ['arc_settings', 'arc_classes', 'arc_subjects', 'arc_students', 'arc_grades', 'arc_attendance', 'arc_teacher_attendance', 'arc_remarks', 'arc_staff'];
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
    return { storagePath: storagePath || (meta && meta.fullPath ? meta.fullPath : ''), sourceUrl: sourceUrl || '', updatedAt };
  } catch (e) {
    return { storagePath: storagePath || '', sourceUrl: sourceUrl || '', updatedAt: '' };
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
  const descriptor = await cloudImageDescriptor(kind, id, storagePath, sourceUrl);
  if (!descriptor) return { ok: false, skipped: true, key, kind, id, errorMessage: 'No image descriptor.' };

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

async function getCloudImageInventory() {
  const firestoreItems = [];
  if (!FIREBASE_ENABLED || !currentSchoolId) return firestoreItems;

  // v32: Firestore imageAssets is the authoritative manifest. Every browser
  // can read the same manifest without needing permission to list Storage
  // folders. This is the cloud-to-browser synchronization contract.
  try {
    const snap = await schoolRef().collection('imageAssets').get();
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

  // Re-read the manifest after seeding/probing so the returned inventory
  // represents exactly what every browser will use for synchronization.
  try {
    const snap = await schoolRef().collection('imageAssets').get();
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
    const snap = await schoolRef().collection('imageAssets').get();
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
  const inventory = await getCloudImageInventory();
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

function commitChunks(ops) {
  if (!ops.length) return Promise.resolve();
  const chunks = cloudChunk(ops, 450);
  return chunks.reduce((p, chunk) => p.then(() => {
    const batch = firebase.firestore().batch();
    chunk.forEach(op => op(batch));
    return batch.commit();
  }), Promise.resolve());
}

function stripImagesForCloud(field, value) {
  if (field === 'students' && Array.isArray(value)) {
    return value.map(s => {
      const c = Object.assign({}, s);
      if (!c.photoUrl && c.photo) c.photoUrl = c.photo;
      delete c.photo;
      return c;
    });
  }
  if (field === 'staff' && Array.isArray(value)) {
    return value.map(s => {
      const c = Object.assign({}, s);
      if (!c.signatureUrl && c.signature) c.signatureUrl = c.signature;
      delete c.signature;
      return c;
    });
  }
  if (field === 'settings' && value && typeof value === 'object') {
    const c = Object.assign({}, value);
    delete c.logo;
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
    return Object.assign({}, cloudValue, { signature: (local && isDataImage(local.signature) ? local.signature : '') || cached || '' });
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
  return schoolRef().get().then(doc => {
    if (!doc.exists) return false;
    const data = doc.data() || {};
    if (Number(data.schemaVersion || 0) >= CLOUD_SCHEMA_VERSION) return false;

    const hasLegacy = ['classes', 'subjects', 'students', 'grades', 'attendance', 'teacherAttendance', 'schoolCalendar', 'remarks', 'staff']
      .some(k => data[k] !== undefined);
    if (!hasLegacy) {
      return schoolRef().set({ schemaVersion: CLOUD_SCHEMA_VERSION }, { merge: true }).then(() => false);
    }

    const classes = Array.isArray(data.classes) ? data.classes : [];
    const subjects = Array.isArray(data.subjects) ? data.subjects : [];
    const students = Array.isArray(data.students) ? data.students : [];
    const staff = Array.isArray(data.staff) ? data.staff : [];
    const grades = data.grades && typeof data.grades === 'object' ? data.grades : {};
    const attendance = data.attendance && typeof data.attendance === 'object' ? data.attendance : {};
    const teacherAttendance = data.teacherAttendance && typeof data.teacherAttendance === 'object' ? data.teacherAttendance : {};
    const schoolCalendar = data.schoolCalendar && typeof data.schoolCalendar === 'object' ? data.schoolCalendar : {};
    const remarks = data.remarks && typeof data.remarks === 'object' ? data.remarks : {};

    const ops = [];
    classes.forEach(c => ops.push(batch => batch.set(classRef(c.id), Object.assign({}, c, { updatedAt: firebase.firestore.FieldValue.serverTimestamp() }))));
    subjects.forEach(s => ops.push(batch => batch.set(subjectRef(s.id), stripImagesForCloud('subjects', s))));
    students.forEach(s => ops.push(batch => batch.set(studentRef(s.id), stripImagesForCloud('students', s))));
    staff.forEach(s => ops.push(batch => batch.set(staffRef(s.id), stripImagesForCloud('staff', s))));
    Object.keys(grades).forEach(key => ops.push(batch => batch.set(gradeRef(key), { classId: key.split('__')[0], entries: grades[key], updatedAt: firebase.firestore.FieldValue.serverTimestamp() })));
    Object.keys(attendance).forEach(key => ops.push(batch => batch.set(attendanceRef(key), Object.assign({}, attendance[key], { classId: (attendance[key] && attendance[key].classId) || key.split('__')[0], entries: (attendance[key] && attendance[key].entries) || attendance[key], updatedAt: firebase.firestore.FieldValue.serverTimestamp() }))));
    Object.keys(teacherAttendance).forEach(key => ops.push(batch => batch.set(teacherAttendanceRef(key), Object.assign({}, teacherAttendance[key], { entries: (teacherAttendance[key] && teacherAttendance[key].entries) || teacherAttendance[key], updatedAt: firebase.firestore.FieldValue.serverTimestamp() }))));
    Object.keys(schoolCalendar).forEach(key => ops.push(batch => batch.set(schoolCalendarRef(key), Object.assign({}, schoolCalendar[key], { updatedAt: firebase.firestore.FieldValue.serverTimestamp() }))));
    Object.keys(remarks).forEach(key => ops.push(batch => batch.set(remarkRef(key), { classId: key.split('__')[0], entries: remarks[key], updatedAt: firebase.firestore.FieldValue.serverTimestamp() })));

    return commitChunks(ops).then(() => {
      const remove = {};
      ['classes', 'subjects', 'students', 'grades', 'attendance', 'teacherAttendance', 'schoolCalendar', 'remarks', 'staff'].forEach(k => { remove[k] = firebase.firestore.FieldValue.delete(); });
      return schoolRef().set(Object.assign(remove, { schemaVersion: CLOUD_SCHEMA_VERSION, migratedAt: firebase.firestore.FieldValue.serverTimestamp() }), { merge: true });
    }).then(() => true);
  });
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

function pullCloudData(sessionToken) {
  if (!FIREBASE_ENABLED || !currentSchoolId) return Promise.resolve();
  const token = sessionToken == null ? sessionGeneration : sessionToken;
  const uid = currentUid;
  const schoolId = currentSchoolId;
  const valid = () => isCurrentSession(token, uid, schoolId);
  if (!valid()) return Promise.resolve();

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
      pullSubcollection('staff', null),
      pullGradesForAccess(all, classIds),
      pullAttendanceForAccess(all, classIds),
      pullTeacherAttendanceForAccess(all),
      pullSchoolCalendarForAccess(),
      pullRemarksForAccess(all, classIds)
    ]).then(async results => {
      if (!valid()) return;
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
        DB.set(KEYS.settings, mergedProfile);
      }

      const classes = [];
      classSnap.forEach(d => classes.push(d.data()));
      DB.set(KEYS.classes, classes);

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
      DB.set(KEYS.subjects, sortSubjectsByOrder(subjects));

      const students = [];
      studentSnap.forEach(d => {
        const s = d.data();
        if (all || classIds.has(s.classId)) students.push(mergeLocalImage('students', s, d.id));
      });
      DB.set(KEYS.students, students);

      const staff = [];
      staffSnap.forEach(d => staff.push(mergeLocalImage('staff', d.data(), d.id)));
      DB.set(KEYS.staff, staff);

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
      DB.set(KEYS.grades, grades);

      const attendance = {};
      attendanceSnap.forEach(d => {
        const key = localKeyFromCloudId(d.id);
        const data = d.data() || {};
        const classId = data.classId || key.split('__')[0];
        if (all || classIds.has(classId)) attendance[key] = Object.assign({}, data, { entries: data.entries || {} });
      });
      DB.set(KEYS.attendance, attendance);

      const teacherAttendance = {};
      teacherAttendanceSnap.forEach(d => {
        const key = localKeyFromCloudId(d.id);
        const data = d.data() || {};
        teacherAttendance[key] = Object.assign({}, data, { entries: data.entries || {} });
      });
      if (all) DB.set(KEYS.teacherAttendance, teacherAttendance);

      const schoolCalendar = {};
      schoolCalendarSnap.forEach(d => {
        const key = localKeyFromCloudId(d.id);
        schoolCalendar[key] = Object.assign({}, d.data(), { date: (d.data() || {}).date || key.split('__').slice(-1)[0] });
      });
      DB.set(KEYS.schoolCalendar, schoolCalendar);

      const remarks = {};
      remarkSnap.forEach(d => {
        const key = localKeyFromCloudId(d.id);
        const classId = key.split('__')[0];
        if (all || classIds.has(classId)) remarks[key] = (d.data() || {}).entries || {};
      });
      DB.set(KEYS.remarks, remarks);
      if (!valid()) return;
      setLastSyncedNow();
    });
  });
}

const pushTimers = {};
function scheduleCloudPush(rawKey) {
  if (!FIREBASE_ENABLED || !currentSchoolId || currentStatus !== 'active') return;
  const match = syncableFields().find(f => f.key === rawKey);
  if (!match) return;
  clearTimeout(pushTimers[rawKey]);
  pushTimers[rawKey] = setTimeout(() => {
    pushFieldToCloud(match).catch(err => console.error('Cloud sync failed for', match.field, err));
  }, 800);
}


function syncCollectionArray(ref, items, cleanFn) {
  const currentIds = new Set(items.map(item => item.id));
  return ref.get().then(snapshot => {
    const ops = [];
    items.forEach(item => ops.push(batch => batch.set(ref.doc(item.id), cleanFn(item))));
    snapshot.forEach(doc => {
      if (!currentIds.has(doc.id)) ops.push(batch => batch.delete(ref.doc(doc.id)));
    });
    return commitChunks(ops);
  });
}

function syncKeyedCollection(ref, entries, makeData, allowedClassIds) {
  // Compare encoded Firestore IDs, not the raw local keys.
  // This prevents valid documents such as 2025/2026 from being deleted
  // during synchronization after their keys are encoded for Firestore.
  const currentIds = new Set(Object.keys(entries).map(cloudKey));
  let existingPromise;
  if (allowedClassIds === null) {
    existingPromise = ref.get();
  } else {
    const ids = Array.from(allowedClassIds || []);
    existingPromise = Promise.all(ids.map(classId => ref.where('classId', '==', classId).get()))
      .then(snaps => {
        const docs = [];
        snaps.forEach(snap => snap.forEach(d => docs.push(d)));
        return { forEach: fn => docs.forEach(fn) };
      });
  }
  return existingPromise.then(snapshot => {
    const ops = [];
    Object.keys(entries).forEach(key => {
      // Local grade/remark keys can contain '/', e.g. 2025/2026.
      // Encode the same ID used for comparison and reads before writing.
      const docId = cloudKey(key);
      ops.push(batch => batch.set(ref.doc(docId), makeData(key, entries[key])));
    });
    snapshot.forEach(doc => {
      if (!currentIds.has(doc.id)) ops.push(batch => batch.delete(ref.doc(doc.id)));
    });
    return commitChunks(ops);
  });
}

function pushFieldToCloud(match) {
  if (!FIREBASE_ENABLED || !currentSchoolId || currentStatus !== 'active') return Promise.resolve();
  const field = match.field;
  const value = DB.get(match.key, fieldDefault(field));

  if (field === 'settings') {
    if (!isHeadTeacher()) return Promise.resolve();
    return schoolRef().set({ profile: stripImagesForCloud('settings', value), schemaVersion: CLOUD_SCHEMA_VERSION, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true })
      .then(() => setLastSyncedNow());
  }

  if (field === 'classes') {
    if (!isHeadTeacher()) return Promise.resolve();
    return syncCollectionArray(schoolRef().collection('classes'), value,
      c => Object.assign({}, c, { updatedAt: firebase.firestore.FieldValue.serverTimestamp() }))
      .then(() => setLastSyncedNow());
  }

  if (field === 'subjects') {
    if (!isHeadTeacher()) return Promise.resolve();
    return syncCollectionArray(schoolRef().collection('subjects'), value,
      s => Object.assign({}, s, { updatedAt: firebase.firestore.FieldValue.serverTimestamp() }))
      .then(() => setLastSyncedNow());
  }

  if (field === 'staff') {
    if (!isHeadTeacher()) return Promise.resolve();
    return syncCollectionArray(schoolRef().collection('staff'), value,
      s => stripImagesForCloud('staff', s))
      .then(() => setLastSyncedNow());
  }

  if (field === 'students') {
    const allowed = classIdsForCloudSync();
    const filtered = value.filter(s => allowed.has(s.classId));
    const ref = schoolRef().collection('students');
    const existingPromise = isHeadTeacher()
      ? ref.get()
      : Promise.all(Array.from(allowed).map(classId => ref.where('classId', '==', classId).get()))
          .then(snaps => {
            const docs = [];
            snaps.forEach(snap => snap.forEach(d => docs.push(d)));
            return { forEach: fn => docs.forEach(fn) };
          });
    return existingPromise.then(snapshot => {
      const currentIds = new Set(filtered.map(s => s.id));
      const ops = [];
      filtered.forEach(s => ops.push(batch => batch.set(ref.doc(s.id), stripImagesForCloud('students', s))));
      snapshot.forEach(doc => { if (!currentIds.has(doc.id)) ops.push(batch => batch.delete(ref.doc(doc.id))); });
      return commitChunks(ops);
    }).then(() => setLastSyncedNow());
  }

  if (field === 'grades') {
    const allowed = classIdsForCloudSync();
    const filtered = {};
    Object.keys(value).forEach(key => {
      const classId = key.split('__')[0];
      if (allowed.has(classId)) filtered[key] = value[key];
    });
    return syncKeyedCollection(schoolRef().collection('grades'), filtered,
      (key, entries) => ({ classId: key.split('__')[0], entries, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }),
      isHeadTeacher() ? null : allowed)
      .then(() => setLastSyncedNow());
  }

  if (field === 'attendance') {
    const allowed = classIdsForCloudSync();
    const filtered = {};
    Object.keys(value).forEach(key => {
      const classId = (value[key] && value[key].classId) || key.split('__')[0];
      if (allowed.has(classId)) filtered[key] = value[key];
    });
    return syncKeyedCollection(schoolRef().collection('attendance'), filtered,
      (key, record) => Object.assign({}, record, { classId: record.classId || key.split('__')[0], entries: record.entries || {}, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }),
      isHeadTeacher() ? null : allowed)
      .then(() => setLastSyncedNow());
  }

  if (field === 'teacherAttendance') {
    if (!isHeadTeacher()) return Promise.resolve();
    return syncKeyedCollection(schoolRef().collection('teacherAttendance'), value,
      (key, record) => Object.assign({}, record, { entries: record.entries || {}, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }),
      null).then(() => setLastSyncedNow());
  }

  if (field === 'schoolCalendar') {
    if (!isHeadTeacher()) return Promise.resolve();
    return syncKeyedCollection(schoolRef().collection('schoolCalendar'), value,
      (key, record) => Object.assign({}, record, { updatedAt: firebase.firestore.FieldValue.serverTimestamp() }),
      null).then(() => setLastSyncedNow());
  }

  if (field === 'remarks') {
    const allowed = classIdsForCloudSync();
    const filtered = {};
    Object.keys(value).forEach(key => {
      const classId = key.split('__')[0];
      if (allowed.has(classId)) filtered[key] = value[key];
    });
    return syncKeyedCollection(schoolRef().collection('remarks'), filtered,
      (key, entries) => ({ classId: key.split('__')[0], entries, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }),
      isHeadTeacher() ? null : allowed)
      .then(() => setLastSyncedNow());
  }
  return Promise.resolve();
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
  wrap.innerHTML = `<p class="hint">Signed in as ${escapeHtml(firebase.auth().currentUser.email)} (${escapeHtml(currentRole)}). Last synced: ${lastText}. Photos, signatures, and the school logo are synchronized through Firebase Storage.</p>`;
  btn.classList.remove('hidden');
  if (joinCodeWrap) {
    if (currentRole === 'headteacher') {
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
  pullCloudData().then(() => {
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
function showAuthGate() { document.documentElement.classList.add('authing'); document.documentElement.classList.remove('sessionRestoring'); }
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
  document.getElementById('authHeading').textContent = authMode === 'login' ? 'Sign In' : 'Create Account';
  document.getElementById('authSubmitBtn').textContent = authMode === 'login' ? 'Log In' : 'Sign Up';
  document.getElementById('authToggleModeBtn').textContent = authMode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Log in';
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

      const classChecks = classes.map(c =>
        `<label class="checkbox-row"><input type="checkbox" class="assign-class-cb" value="${escapeHtml(c.id)}" ${assignedClasses.indexOf(c.id) !== -1 ? 'checked' : ''}> ${escapeHtml(c.name)}</label>`
      ).join('') || '<p class="hint">Create classes first.</p>';

      const subjectChecks = subjects.map(sub =>
        `<label class="checkbox-row"><input type="checkbox" class="assign-subject-cb" value="${escapeHtml(sub.id)}" ${assignedSubjects.indexOf(sub.id) !== -1 ? 'checked' : ''}> ${escapeHtml(sub.name)}</label>`
      ).join('') || '<p class="hint">Create subjects first.</p>';

      const staffOptions = ['<option value="">— Create new Staff record —</option>']
        .concat(staff.map(s => `<option value="${escapeHtml(s.id)}" ${linkedStaff && linkedStaff.id === s.id ? 'selected' : ''}>${escapeHtml(s.name || 'Unnamed Staff')}${s.role ? ' (' + escapeHtml(s.role) + ')' : ''}${s.userUid && s.userUid !== m.uid ? ' · Linked' : ''}</option>`))
        .join('');

      const actionLabel = m.status === 'pending' ? 'Approve & Save' : 'Save Teacher';
      const disableButton = m.status === 'disabled'
        ? `<button class="edit-student reactivate-teacher-btn" data-uid="${m.uid}">Reactivate</button>`
        : `<button class="del-student disable-teacher-btn" data-uid="${m.uid}">Disable</button>`;

      li.innerHTML = `<div class="edit-row">
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
        ${classChecks}
        <strong>Subjects</strong>
        ${subjectChecks}
        <div class="edit-actions">
          <button class="save-btn save-teacher-assignment" data-uid="${m.uid}">${actionLabel}</button>
          ${linkedStaff ? '<button class="cancel-btn unlink-teacher-staff" data-uid="' + m.uid + '">Unlink Staff</button>' : ''}
          ${m.status === 'pending' ? '<button class="cancel-btn reject-teacher-btn" data-uid="' + m.uid + '">Reject</button>' : disableButton}
        </div>
      </div>`;
      list.appendChild(li);
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
          schoolId: firebase.firestore.FieldValue.delete(),
          role: firebase.firestore.FieldValue.delete(),
          status: 'rejected',
          assignedClassIds: firebase.firestore.FieldValue.delete(),
          assignedSubjectIds: firebase.firestore.FieldValue.delete(),
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
    pwToggle.classList.toggle('showing', !showing);
  });

  document.getElementById('authToggleModeBtn').addEventListener('click', () => {
    authMode = authMode === 'login' ? 'signup' : 'login';
    renderAuthForm();
  });

  document.getElementById('authSubmitBtn').addEventListener('click', () => {
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    if (!email || !password) { setAuthError('Enter an email and password.'); return; }
    const action = authMode === 'login'
      ? firebase.auth().signInWithEmailAndPassword(email, password)
      : firebase.auth().createUserWithEmailAndPassword(email, password);
    action.catch(err => setAuthError(err.message));
  });

  document.getElementById('authForgotBtn').addEventListener('click', () => {
    const email = document.getElementById('authEmail').value.trim();
    if (!email) { setAuthError('Enter your email above first, then tap this again.'); return; }
    firebase.auth().sendPasswordResetEmail(email)
      .then(() => alert('Password reset email sent to ' + email))
      .catch(err => setAuthError(err.message));
  });

  document.getElementById('authGuestBtn').addEventListener('click', () => {
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
      hideSchoolChoiceGate();
      showSyncingMessage(); showAuthGate();
      return pushAllFieldsNow().then(() => {
        hideSyncingMessage(); hideAuthGate();
        initLockScreen();
        if (!appStarted) { appStarted = true; proceedToApp(); }
        alert(`School registered! Your join code is ${joinCode} — share this with your teachers. You can view it again anytime in Setup.`);
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

      firebase.firestore().collection('users').doc(currentUid).get().then(userDoc => {
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

        if (!data || !data.schoolId) {
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
        currentStatus = 'active';

        return repairAccountProfile.then(() => {
          if (!isCurrentSession(token, user.uid, data.schoolId)) return;

          // v38.9.3: authentication/profile resolution is the only startup
          // gate. The user's school data is local-first, so once the account
          // and school namespace are known we can immediately restore the last
          // page from this school's local cache. Firestore synchronization then
          // runs in the background. This prevents a slow/hung Firestore read
          // from leaving the user permanently on "Restoring your session…".
          sessionReady = true;
          sessionDataReady = true;

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
        if (!isCurrentSession(token, user.uid, currentSchoolId)) return;
        sessionReady = false;
        hideSessionRestoring();
        hideSyncingMessage();
        renderAuthForm();
        showAuthGate();
        setAuthError('Could not load your account: ' + err.message);
      });
    } else {
      hideSessionRestoring();
      // The Firebase callback is the final authority that no account is signed
      // in. Invalidate every pending operation from the previous account.
      resetWorkspaceState();
      if (localStorage.getItem(GUEST_MODE_KEY)) {
        sessionReady = true;
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

/* ---------- init ---------- */
initTheme();
initAuth();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
