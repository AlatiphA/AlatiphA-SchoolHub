// AlatiphA SchoolHub — app-4.js
const APP_VERSION = 'v5';

/* ---------- storage helpers ---------- */
const DB = {
  get(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v === null || v === undefined ? fallback : v;
    } catch (e) { return fallback; }
  },
  set(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
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
function ns(base) { return currentSchoolId ? `${base}__${currentSchoolId}` : base; }
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

function getAccessibleSubjects() {
  const all = DB.get(KEYS.subjects, []);
  if (isHeadTeacher()) return all;
  const ids = new Set(Array.isArray(currentAssignedSubjectIds) ? currentAssignedSubjectIds : []);
  return all.filter(s => ids.has(s.id));
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
  get remarks() { return ns('arc_remarks'); },
  get staff() { return ns('arc_staff'); }
};

const DEFAULT_SUBJECTS = [
  'English Language','Mathematics','Science','History',
  'Rel. & Moral Edu. (RME)','Creative Arts','Computing','Ghanaian Language'
];

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function ensureDefaults() {
  if (DB.get(KEYS.subjects, null) === null) {
    DB.set(KEYS.subjects, DEFAULT_SUBJECTS.map(name => ({ id: uid(), name })));
  }
  if (DB.get(KEYS.settings, null) === null) {
    DB.set(KEYS.settings, {
      teacherName: '', schoolName: '', address: '', email: '', logo: '',
      currentTerm: 'Term 1', currentYear: '', attendanceOutOf: '', nextTermBegins: '',
      reportLayout: 'standard', headTeacherId: ''
    });
  }
  if (DB.get(KEYS.classes, null) === null) DB.set(KEYS.classes, []);
  if (DB.get(KEYS.students, null) === null) DB.set(KEYS.students, []);
  if (DB.get(KEYS.grades, null) === null) DB.set(KEYS.grades, {});
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

/* ---------- view switching ---------- */
const views = ['home', 'setup', 'staff', 'classes', 'students', 'subjects', 'grades', 'remarks', 'reports', 'history', 'manage-teachers'];
function showView(name) {
  if (isTeacher() && ['setup', 'staff', 'classes', 'subjects', 'manage-teachers'].indexOf(name) !== -1) {
    name = 'home';
  }
  views.forEach(v => {
    document.getElementById('view-' + v).classList.toggle('hidden', v !== name);
  });
  document.getElementById('backBtn').classList.toggle('hidden', name === 'home');
  document.getElementById('brandText').textContent = name === 'home' ? 'AlatiphA SchoolHub' : sectionTitle(name);
  if (name === 'home') renderHome();
  if (name === 'setup') { refreshHeadTeacherSelect(); renderCloudSyncStatus(); }
  if (name === 'students') renderStudentClassSelect();
  if (name === 'grades') renderGradesClassSelect();
  if (name === 'remarks') renderRemarksClassSelect();
  if (name === 'reports') renderReportsClassSelect();
  if (name === 'history') renderHistoryTermYearSelect();
  if (name === 'manage-teachers') renderManageTeachers();
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
    grades: 'Grades', remarks: 'Remarks', reports: 'Reports', history: 'Term History',
    'manage-teachers': 'Manage Teachers'
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
  { view: 'grades', title: 'Grades', description: 'Enter class and exam scores',
    icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>' },
  { view: 'remarks', title: 'Remarks', description: 'Attendance, conduct, and comments',
    icon: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' },
  { view: 'reports', title: 'Reports', description: 'Generate PDFs, CSV, and view statistics',
    icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="9" y2="17"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="15" y1="15" x2="15" y2="17"/>' },
  { view: 'history', title: 'Term History', description: 'Browse and export past terms',
    icon: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/>' }
];

function renderQuickAccessList() {
  const wrap = document.getElementById('quickAccessList');
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
  document.getElementById('attendanceOutOf').value = s.attendanceOutOf || '';
  document.getElementById('nextTermBegins').value = s.nextTermBegins || '';
  document.getElementById('reportLayout').value = s.reportLayout || 'standard';
  const wrap = document.getElementById('logoPreviewWrap');
  const img = document.getElementById('logoPreview');
  if (s.logo) { img.src = s.logo; wrap.classList.remove('hidden'); }
  else { wrap.classList.add('hidden'); }
}

document.getElementById('schoolLogo').addEventListener('change', e => {
  if (!requireHeadTeacher('upload the school logo')) return;
  const file = e.target.files[0];
  if (!file) return;
  uploadSchoolAsset(file, 'logos', 'school-logo').then(url => {
    const s = DB.get(KEYS.settings, {});
    s.logo = url;
    s.logoUrl = url;
    DB.set(KEYS.settings, s);
    loadSettingsForm();
  }).catch(err => alert('Could not upload the school logo: ' + err.message));
});;

document.getElementById('removeLogo').addEventListener('click', () => {
  if (!requireHeadTeacher('change school settings')) return;
  const s = DB.get(KEYS.settings, {});
  s.logo = '';
  DB.set(KEYS.settings, s);
  loadSettingsForm();
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
  s.attendanceOutOf = document.getElementById('attendanceOutOf').value.trim();
  s.nextTermBegins = document.getElementById('nextTermBegins').value;
  s.reportLayout = document.getElementById('reportLayout').value;
  s.headTeacherId = document.getElementById('headTeacherSelect').value;
  DB.set(KEYS.settings, s);
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
    if (d.remarks) DB.set(KEYS.remarks, d.remarks);
    if (d.staff) DB.set(KEYS.staff, d.staff);
    alert('Backup restored. The app will now reload.');
    location.reload();
  };
  reader.readAsText(file);
});

/* ---------- Classes ---------- */
let editingClassId = null;

function renderClasses() {
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
      editingClassId = null;
      renderClasses();
    });
  });
  list.querySelectorAll('.del-class').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Delete this class and its students/grades?')) return;
      const id = btn.dataset.id;
      DB.set(KEYS.classes, DB.get(KEYS.classes, []).filter(c => c.id !== id));
      DB.set(KEYS.students, DB.get(KEYS.students, []).filter(s => s.classId !== id));
      const grades = DB.get(KEYS.grades, {});
      Object.keys(grades).forEach(k => { if (k.startsWith(id + '__')) delete grades[k]; });
      DB.set(KEYS.grades, grades);
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
    input.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const students = DB.get(KEYS.students, []);
      const st = students.find(x => x.id === input.dataset.student);
      if (!st || !requireClassAccess(st.classId)) return;
      uploadSchoolAsset(file, 'student-photos', st.classId + '/' + st.id).then(url => {
        const currentStudents = DB.get(KEYS.students, []);
        const current = currentStudents.find(x => x.id === input.dataset.student);
        if (current) { current.photo = url; current.photoUrl = url; }
        DB.set(KEYS.students, currentStudents);
        renderStudents(); // stays in edit mode — editingStudentId is untouched
      }).catch(err => alert('Could not upload the student photo: ' + err.message));
    });
  });
  list.querySelectorAll('.remove-student-photo').forEach(btn => {
    btn.addEventListener('click', () => {
      const students = DB.get(KEYS.students, []);
      const st = students.find(x => x.id === btn.dataset.id);
      if (st) st.photo = '';
      DB.set(KEYS.students, students);
      renderStudents();
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
      const grades = DB.get(KEYS.grades, {});
      Object.keys(grades).forEach(k => { if (grades[k][id]) delete grades[k][id]; });
      DB.set(KEYS.grades, grades);
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

function renderSubjects() {
  const list = document.getElementById('subjectList');
  const subjects = DB.get(KEYS.subjects, []);
  list.innerHTML = '';
  if (!subjects.length) { list.innerHTML = '<li class="empty">No subjects yet — add one below.</li>'; return; }
  subjects.forEach(sub => {
    const li = document.createElement('li');
    if (editingSubjectId === sub.id) {
      li.innerHTML = `<div class="edit-row">
        <input type="text" class="edit-subject-name" value="${escapeHtml(sub.name)}">
        <div class="edit-actions">
          <button class="save-btn save-subject" data-id="${sub.id}">Save</button>
          <button class="cancel-btn cancel-subject">Cancel</button>
        </div>
      </div>`;
    } else {
      li.innerHTML = `<div>${escapeHtml(sub.name)}</div>
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
      editingSubjectId = null;
      renderSubjects();
    });
  });
  list.querySelectorAll('.del-subject').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Delete this subject from all classes?')) return;
      const id = btn.dataset.id;
      DB.set(KEYS.subjects, DB.get(KEYS.subjects, []).filter(s => s.id !== id));
      renderSubjects();
    });
  });
}

document.getElementById('addSubjectBtn').addEventListener('click', () => {
  if (!requireHeadTeacher('manage subjects')) return;
  const input = document.getElementById('newSubjectName');
  const name = input.value.trim();
  if (!name) return;
  const subjects = DB.get(KEYS.subjects, []);
  subjects.push({ id: uid(), name });
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
      li.innerHTML = `<div><strong>${escapeHtml(st.name)}</strong>
          <div class="meta">${escapeHtml(st.role || 'Staff')}${st.rank ? ' · ' + escapeHtml(st.rank) : ''}${st.staffId ? ' · ID ' + escapeHtml(st.staffId) : ''}</div>
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
    input.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      uploadSchoolAsset(file, 'signatures', input.dataset.staff).then(url => {
        const staffList = DB.get(KEYS.staff, []);
        const st = staffList.find(x => x.id === input.dataset.staff);
        if (st) { st.signature = url; st.signatureUrl = url; }
        DB.set(KEYS.staff, staffList);
        renderStaff(); // stays in edit mode — editingStaffId is untouched
      }).catch(err => alert('Could not upload the signature: ' + err.message));
    });
  });
  list.querySelectorAll('.remove-staff-signature').forEach(btn => {
    btn.addEventListener('click', () => {
      const staffList = DB.get(KEYS.staff, []);
      const st = staffList.find(x => x.id === btn.dataset.id);
      if (st) st.signature = '';
      DB.set(KEYS.staff, staffList);
      renderStaff();
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

document.getElementById('addStaffBtn').addEventListener('click', () => {
  if (!requireHeadTeacher('manage staff')) return;
  const nameInput = document.getElementById('newStaffName');
  const name = nameInput.value.trim();
  if (!name) return;
  const role = document.getElementById('newStaffRole').value;
  const values = {};
  STAFF_FIELDS.forEach(f => { values[f.key] = document.getElementById('newStaff_' + f.key).value.trim(); });
  const file = document.getElementById('newStaffSignature').files[0];

  const commit = signatureDataUrl => {
    const staffList = DB.get(KEYS.staff, []);
    staffList.push(Object.assign({ id: uid(), name, role, signature: signatureDataUrl || '' }, values));
    DB.set(KEYS.staff, staffList);
    nameInput.value = '';
    STAFF_FIELDS.forEach(f => { document.getElementById('newStaff_' + f.key).value = ''; });
    document.getElementById('newStaffSignature').value = '';
    renderStaff();
  };

  if (file) {
    uploadSchoolAsset(file, 'signatures', uid()).then(url => commit(url))
      .catch(err => alert('Could not upload the signature: ' + err.message));
  } else {
    commit('');
  }
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
      comment: card.querySelector('.rm-comment').value.trim()
    };
  });
  allRemarks[key] = classRemarks;
  DB.set(KEYS.remarks, allRemarks);
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
function getStaffSignatures(classInfo, settings) {
  const staffList = DB.get(KEYS.staff, []);
  const classTeacher = classInfo && classInfo.classTeacherId ? staffList.find(s => s.id === classInfo.classTeacherId) : null;
  const headTeacher = settings.headTeacherId ? staffList.find(s => s.id === settings.headTeacherId) : null;
  return {
    classTeacherName: classTeacher ? classTeacher.name : '',
    classTeacherSignature: classTeacher ? classTeacher.signature : '',
    headTeacherName: headTeacher ? headTeacher.name : '',
    headTeacherSignature: headTeacher ? headTeacher.signature : ''
  };
}

function drawReportPage(doc, result, settings, positions, numOnRoll, classInfo, studentRemarks) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const left = 15, right = pageWidth - 15;
  let y = 18;

  doc.setTextColor(INK[0], INK[1], INK[2]);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  const schoolName = (settings.schoolName && settings.schoolName.trim()) ? settings.schoolName.trim() : 'School Name Not Set';
  doc.text(schoolName, pageWidth / 2, y, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  let subY = y + 6;
  if (settings.address) { doc.text(settings.address, pageWidth / 2, subY, { align: 'center' }); subY += 5; }
  if (settings.email) { doc.text(settings.email, pageWidth / 2, subY, { align: 'center' }); subY += 5; }
  y = subY + 2;

  doc.setDrawColor(GOLD[0], GOLD[1], GOLD[2]);
  doc.setLineWidth(0.8);
  doc.line(pageWidth / 2 - 30, y, pageWidth / 2 + 30, y);
  y += 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('REPORT CARD', pageWidth / 2, y, { align: 'center' });
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.2);
  doc.setTextColor(0, 0, 0);

  if (settings.logo) {
    try { doc.addImage(settings.logo, 'PNG', left, 12, 20, 20); }
    catch (e) { try { doc.addImage(settings.logo, 'JPEG', left, 12, 20, 20); } catch (e2) {} }
  }

  if (result.student.photo) {
    const pw = 20, ph = 24; // slightly taller than wide, passport-style
    try { doc.addImage(result.student.photo, 'PNG', right - pw, 12, pw, ph); }
    catch (e) { try { doc.addImage(result.student.photo, 'JPEG', right - pw, 12, pw, ph); } catch (e2) {} }
    doc.setDrawColor(200, 200, 200);
    doc.setLineWidth(0.2);
    doc.rect(right - pw, 12, pw, ph);
    doc.setDrawColor(0, 0, 0);
  }

  // Every "Label: value" pair on the report uses this one helper, so the
  // label is always bold, the value always normal weight, and the value
  // always starts right after the label's actual measured width — never
  // a guessed fixed offset that can overlap a long label.
  doc.setFontSize(9.5);
  const field = (label, value, x, yPos) => {
    doc.setFont('helvetica', 'bold');
    const labelText = label + ': ';
    doc.text(labelText, x, yPos);
    const w = doc.getTextWidth(labelText);
    doc.setFont('helvetica', 'normal');
    doc.text(String(value === undefined || value === null || value === '' ? '-' : value), x + w, yPos);
  };

  y += 10;
  doc.setFontSize(10);
  field('Name', result.student.name, left, y);
  field('ID', result.student.admissionId || '-', right - 35, y);
  y += 6;
  field('Class', classInfo ? classInfo.name : '', left, y);
  field('Term', settings.currentTerm || '', left + 70, y);
  field('Year', settings.currentYear || '', right - 35, y);
  y += 6;

  const simple = settings.reportLayout === 'simple';

  // Grade, subject position and aggregate are maintained in both layouts —
  // the only difference is that Simple never enters or uses a Class Score,
  // so Grade/Position/Aggregate are derived from Exam Score alone.
  field('Class Position', result.position ? ordinal(result.position) : '-', left, y);
  field('Total Score', result.totalSum, left + 70, y);
  field('Aggregate', result.aggregate !== null ? result.aggregate : '-', right - 35, y);
  doc.setFontSize(9.5);

  y += 8;
  // Results table. Standard: Subject | Class | Exam | Total | Grade | Position | Remark.
  // Simple: Subject | Score | Grade | Position | Remark — no Class column,
  // since Class Score is never entered or used in this layout. Column
  // widths always sum to the full printable width edge-to-edge.
  const colW = simple ? [48, 20, 18, 20, 74] : [46, 19, 19, 19, 15, 18, 44];
  const colX = [left];
  colW.forEach(w => colX.push(colX[colX.length - 1] + w));
  const headers = simple ? ['Subject', 'Score', 'Grade', 'Position', 'Remark'] : ['Subject', 'Class', 'Exam', 'Total', 'Grade', 'Position', 'Remark'];
  const rowH = 8;
  const lastCol = colW.length;
  const centerCols = simple ? [1, 2, 3] : [1, 2, 3, 4, 5]; // numeric columns center; Subject/Remark stay left-aligned

  const cellText = (text, i, yPos, bold, forceCenter) => {
    if (bold) doc.setFont('helvetica', 'bold'); else doc.setFont('helvetica', 'normal');
    if (forceCenter || centerCols.includes(i)) {
      doc.text(text, colX[i] + colW[i] / 2, yPos, { align: 'center' });
    } else {
      doc.text(text, colX[i] + 3, yPos);
    }
  };

  doc.setFillColor(INK[0], INK[1], INK[2]);
  doc.setTextColor(255, 255, 255);
  doc.rect(left, y, colX[lastCol] - left, rowH, 'F');
  doc.setFontSize(9);
  headers.forEach((h, i) => cellText(h, i, y + 5.5, true, true));
  y += rowH;
  doc.setTextColor(0, 0, 0);

  result.entries.forEach(en => {
    const weak = en.grade >= 7;
    const pos = positions[en.subject.id] && positions[en.subject.id][result.student.id];
    doc.rect(left, y, colX[lastCol] - left, rowH);
    for (let i = 1; i < lastCol; i++) doc.line(colX[i], y, colX[i], y + rowH);
    doc.setFontSize(8.5);
    if (simple) {
      cellText(String(en.subject.name), 0, y + 5.5, false);
      cellText(String(en.total), 1, y + 5.5, false);
      if (weak) doc.setTextColor(RED_INK[0], RED_INK[1], RED_INK[2]);
      cellText(String(en.grade), 2, y + 5.5, false);
      doc.setTextColor(0, 0, 0);
      cellText(pos ? ordinal(pos.position) : '-', 3, y + 5.5, false);
      cellText(en.remark, 4, y + 5.5, false);
    } else {
      cellText(String(en.subject.name), 0, y + 5.5, false);
      cellText(String(en.classScaled), 1, y + 5.5, false);
      cellText(String(en.examScaled), 2, y + 5.5, false);
      cellText(String(en.total), 3, y + 5.5, false);
      if (weak) doc.setTextColor(RED_INK[0], RED_INK[1], RED_INK[2]);
      cellText(String(en.grade), 4, y + 5.5, false);
      doc.setTextColor(0, 0, 0);
      cellText(pos ? ordinal(pos.position) : '-', 5, y + 5.5, false);
      cellText(en.remark, 6, y + 5.5, false);
    }
    y += rowH;
  });

  y += 8;

  // Attendance / roll / promotion / fees / next term
  doc.setFontSize(9.5);
  const attOutOf = settings.attendanceOutOf || '-';
  field('Attendance', `${studentRemarks.attendance || 0} out of ${attOutOf}`, left, y);
  field('Number on Roll', numOnRoll, right - 55, y);
  y += 6;
  field('Promoted/Repeated', studentRemarks.promoted || '-', left, y);
  field('Fees Due', `GH¢ ${studentRemarks.feesDue || '0.00'}`, right - 55, y);
  y += 6;
  field('Next Term Begins', settings.nextTermBegins || '-', left, y);
  y += 10;

  field('Conduct/Character', studentRemarks.conduct || '-', left, y);
  y += 7;
  field('Attitude', studentRemarks.attitude || '-', left, y);
  y += 7;
  field("Form Teacher's Comment", studentRemarks.comment || '-', left, y);
  y += 7;

  y += 10;
  // Signature lines: an actual drawn line above each label, evenly
  // distributed across the row width and centered under its own line.
  // If a staff member's uploaded signature image is available, it's
  // drawn just above the line; their name prints below the role label.
  const sig = getStaffSignatures(classInfo, settings);
  const sigLineWidth = 60;
  const halfWidth = (right - left) / 2;
  const leftSigCenter = left + halfWidth / 2;
  const rightSigCenter = left + halfWidth + halfWidth / 2;
  const sigImgW = 34, sigImgH = 12;

  if (sig.classTeacherSignature) {
    try { doc.addImage(sig.classTeacherSignature, 'PNG', leftSigCenter - sigImgW / 2, y - sigImgH - 2, sigImgW, sigImgH); }
    catch (e) { try { doc.addImage(sig.classTeacherSignature, 'JPEG', leftSigCenter - sigImgW / 2, y - sigImgH - 2, sigImgW, sigImgH); } catch (e2) {} }
  }
  if (sig.headTeacherSignature) {
    try { doc.addImage(sig.headTeacherSignature, 'PNG', rightSigCenter - sigImgW / 2, y - sigImgH - 2, sigImgW, sigImgH); }
    catch (e) { try { doc.addImage(sig.headTeacherSignature, 'JPEG', rightSigCenter - sigImgW / 2, y - sigImgH - 2, sigImgW, sigImgH); } catch (e2) {} }
  }

  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.3);
  doc.line(leftSigCenter - sigLineWidth / 2, y, leftSigCenter + sigLineWidth / 2, y);
  doc.line(rightSigCenter - sigLineWidth / 2, y, rightSigCenter + sigLineWidth / 2, y);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text('Class Teacher', leftSigCenter, y, { align: 'center' });
  doc.text('Head Teacher', rightSigCenter, y, { align: 'center' });

  if (sig.classTeacherName || sig.headTeacherName) {
    y += 5;
    doc.setFontSize(7.5);
    doc.setTextColor(90, 90, 90);
    if (sig.classTeacherName) doc.text(sig.classTeacherName, leftSigCenter, y, { align: 'center' });
    if (sig.headTeacherName) doc.text(sig.headTeacherName, rightSigCenter, y, { align: 'center' });
    doc.setTextColor(0, 0, 0);
  }

  y += 10;
  doc.setFontSize(8);
  doc.text(`Date: ${new Date().toLocaleDateString()}`, pageWidth / 2, y, { align: 'center' });

  // Compact grading/remarks legend footer — centered under the signature row
  y += 10;
  doc.setFontSize(7);
  doc.setTextColor(90, 90, 90);
  doc.text('Grading: 80-100=1  75-79=2  70-74=3  65-69=4  60-64=5  50-59=6  45-49=7  40-44=8  0-39=9', pageWidth / 2, y, { align: 'center' });
  y += 4;
  doc.text('Remarks: 80-100 Highly Proficient · 54-79 Proficient · 46-53 Approaching Proficiency · 40-45 Developing · 0-39 Emerging', pageWidth / 2, y, { align: 'center' });
  doc.setTextColor(GOLD[0], GOLD[1], GOLD[2]);
  doc.setFontSize(8);
  doc.text('Generated with AlatiphA SchoolHub', pageWidth / 2, doc.internal.pageSize.getHeight() - 8, { align: 'center' });
  doc.setTextColor(0, 0, 0);
}

function generateSinglePDF(result, positions, numOnRoll, classInfo, studentRemarks, settingsOverride) {
  if (!result.entries.length) { alert('No grades entered for this student yet.'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const settings = settingsOverride || DB.get(KEYS.settings, {});
  drawReportPage(doc, result, settings, positions, numOnRoll, classInfo, studentRemarks);
  doc.save(`${result.student.name.replace(/\s+/g, '_')}_report.pdf`);
}

function generateBatchPDF(results, positions, numOnRoll, classInfo, remarksAll, settingsOverride) {
  const usable = results.filter(r => r.entries.length > 0);
  if (!usable.length) { alert('No grades entered for this class yet.'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const settings = settingsOverride || DB.get(KEYS.settings, {});
  usable.forEach((r, i) => {
    if (i > 0) doc.addPage();
    drawReportPage(doc, r, settings, positions, numOnRoll, classInfo, remarksAll[r.student.id] || {});
  });
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
  const legacyKeys = ['arc_settings', 'arc_classes', 'arc_subjects', 'arc_students', 'arc_grades', 'arc_remarks', 'arc_staff'];
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
const CLOUD_SCHEMA_VERSION = 3;

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

function staffRef(id) {
  return schoolRef().collection('staff').doc(id);
}


/* ---------- Firebase Storage ---------- */
function storageRef(path) {
  return firebase.storage().ref().child(path);
}

function uploadSchoolAsset(file, kind, id) {
  if (!FIREBASE_ENABLED || !currentSchoolId || !file) return Promise.resolve('');
  const safeName = String(file.name || 'image').replace(/[^a-zA-Z0-9._-]/g, '_');
  let path;
  if (kind === 'student-photos' && id && String(id).indexOf('/') !== -1) {
    const parts = String(id).split('/');
    path = `schools/${currentSchoolId}/student-photos/${parts[0]}/${parts[1]}_${safeName}`;
  } else {
    path = `schools/${currentSchoolId}/${kind}/${id || uid()}_${safeName}`;
  }
  return storageRef(path).put(file, { contentType: file.type || 'application/octet-stream' })
    .then(snapshot => snapshot.ref.getDownloadURL());
}

function removeStorageFile(url) {
  if (!url || !FIREBASE_ENABLED) return Promise.resolve();
  try {
    return firebase.storage().refFromURL(url).delete().catch(() => {});
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
      delete c.photo;
      return c;
    });
  }
  if (field === 'staff' && Array.isArray(value)) {
    return value.map(s => {
      const c = Object.assign({}, s);
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
    return Object.assign({}, cloudValue, { photo: cloudValue.photoUrl || (local ? (local.photo || '') : '') });
  }
  if (field === 'staff') {
    const local = DB.get(KEYS.staff, []).find(s => s.id === id);
    return Object.assign({}, cloudValue, { signature: cloudValue.signatureUrl || (local ? (local.signature || '') : '') });
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

    const hasLegacy = ['classes', 'subjects', 'students', 'grades', 'remarks', 'staff']
      .some(k => data[k] !== undefined);
    if (!hasLegacy) {
      return schoolRef().set({ schemaVersion: CLOUD_SCHEMA_VERSION }, { merge: true }).then(() => false);
    }

    const classes = Array.isArray(data.classes) ? data.classes : [];
    const subjects = Array.isArray(data.subjects) ? data.subjects : [];
    const students = Array.isArray(data.students) ? data.students : [];
    const staff = Array.isArray(data.staff) ? data.staff : [];
    const grades = data.grades && typeof data.grades === 'object' ? data.grades : {};
    const remarks = data.remarks && typeof data.remarks === 'object' ? data.remarks : {};

    const ops = [];
    classes.forEach(c => ops.push(batch => batch.set(classRef(c.id), Object.assign({}, c, { updatedAt: firebase.firestore.FieldValue.serverTimestamp() }))));
    subjects.forEach(s => ops.push(batch => batch.set(subjectRef(s.id), stripImagesForCloud('subjects', s))));
    students.forEach(s => ops.push(batch => batch.set(studentRef(s.id), stripImagesForCloud('students', s))));
    staff.forEach(s => ops.push(batch => batch.set(staffRef(s.id), stripImagesForCloud('staff', s))));
    Object.keys(grades).forEach(key => ops.push(batch => batch.set(gradeRef(key), { classId: key.split('__')[0], entries: grades[key], updatedAt: firebase.firestore.FieldValue.serverTimestamp() })));
    Object.keys(remarks).forEach(key => ops.push(batch => batch.set(remarkRef(key), { classId: key.split('__')[0], entries: remarks[key], updatedAt: firebase.firestore.FieldValue.serverTimestamp() })));

    return commitChunks(ops).then(() => {
      const remove = {};
      ['classes', 'subjects', 'students', 'grades', 'remarks', 'staff'].forEach(k => { remove[k] = firebase.firestore.FieldValue.delete(); });
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

function pullCloudData() {
  if (!FIREBASE_ENABLED || !currentSchoolId) return Promise.resolve();

  return migrateLegacySchoolDocument().then(() => {
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
      pullRemarksForAccess(all, classIds)
    ]).then(results => {
      const schoolDoc = results[0];
      const classSnap = results[1];
      const subjectSnap = results[2];
      const studentSnap = results[3];
      const staffSnap = results[4];
      const gradeSnap = results[5];
      const remarkSnap = results[6];

      if (schoolDoc.exists) {
        const p = schoolDoc.data().profile || {};
        const localSettings = DB.get(KEYS.settings, {});
        const mergedProfile = Object.assign({}, localSettings, p);
        if (p.logoUrl) mergedProfile.logo = p.logoUrl;
        DB.set(KEYS.settings, mergedProfile);
      }

      const classes = [];
      classSnap.forEach(d => classes.push(d.data()));
      DB.set(KEYS.classes, classes);

      const subjects = [];
      subjectSnap.forEach(d => subjects.push(d.data()));
      DB.set(KEYS.subjects, subjects);

      const students = [];
      studentSnap.forEach(d => {
        const s = d.data();
        if (all || classIds.has(s.classId)) students.push(mergeLocalImage('students', s, d.id));
      });
      DB.set(KEYS.students, students);

      const staff = [];
      staffSnap.forEach(d => staff.push(mergeLocalImage('staff', d.data(), d.id)));
      DB.set(KEYS.staff, staff);

      const grades = {};
      gradeSnap.forEach(d => {
        const key = localKeyFromCloudId(d.id);
        const classId = key.split('__')[0];
        if (all || classIds.has(classId)) grades[key] = (d.data() || {}).entries || {};
      });
      DB.set(KEYS.grades, grades);

      const remarks = {};
      remarkSnap.forEach(d => {
        const key = localKeyFromCloudId(d.id);
        const classId = key.split('__')[0];
        if (all || classIds.has(classId)) remarks[key] = (d.data() || {}).entries || {};
      });
      DB.set(KEYS.remarks, remarks);
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
    Object.keys(entries).forEach(key => ops.push(batch => batch.set(ref.doc(key), makeData(key, entries[key]))));
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
    { field: 'remarks', cloudField: 'remarks', key: KEYS.remarks },
    { field: 'staff', cloudField: 'staff', key: KEYS.staff }
  ];
}

function fieldDefault(field) {
  return (field === 'settings' || field === 'grades' || field === 'remarks') ? {} : [];
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
    alert('Synced.');
  }).catch(err => alert('Sync failed: ' + err.message));
});

function showAuthGate() { document.documentElement.classList.add('authing'); }
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
  const schoolRef = firebase.firestore().collection('schools').doc();
  const schoolId = schoolRef.id;
  return generateUniqueJoinCode().then(joinCode => {
    return schoolRef.set({
      profile: { schoolName, address, email },
      ownerUid: currentUid,
      subscription: { plan: 'free', status: 'inactive' },
      joinCode,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    })
      .then(() => firebase.firestore().collection('joinCodes').doc(joinCode).set({ schoolId }))
      .then(() => firebase.firestore().collection('users').doc(currentUid).set({
        schoolId, role: 'headteacher', status: 'active',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }))
      .then(() => {
        migrateDataIntoSchool(schoolId);
        currentSchoolId = schoolId;
        currentRole = 'headteacher';
        currentStatus = 'active';
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
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(() => {
      currentSchoolId = null; // stays null until a Head Teacher approves — no data namespace touched yet
      currentRole = 'teacher';
      currentStatus = 'pending';
    });
  });
}

/* ---------- Manage Teachers (Head Teacher only) ---------- */
// Recording assignedClassIds here just captures which classes a
// teacher will get once approved — it does not yet restrict what an
// active teacher can see or edit day-to-day (that enforcement is a
// later phase).
function fetchSchoolMembers() {
  return firebase.firestore().collection('users').where('schoolId', '==', currentSchoolId).get()
    .then(snap => {
      const members = [];
      snap.forEach(doc => members.push(Object.assign({ uid: doc.id }, doc.data())));
      return members;
    });
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
      const statusText = m.status === 'pending' ? ' · Pending approval' : m.status === 'disabled' ? ' · Disabled' : ' · Active';

      const classChecks = classes.map(c =>
        `<label class="checkbox-row"><input type="checkbox" class="assign-class-cb" value="${escapeHtml(c.id)}" ${assignedClasses.indexOf(c.id) !== -1 ? 'checked' : ''}> ${escapeHtml(c.name)}</label>`
      ).join('') || '<p class="hint">Create classes first.</p>';

      const subjectChecks = subjects.map(sub =>
        `<label class="checkbox-row"><input type="checkbox" class="assign-subject-cb" value="${escapeHtml(sub.id)}" ${assignedSubjects.indexOf(sub.id) !== -1 ? 'checked' : ''}> ${escapeHtml(sub.name)}</label>`
      ).join('') || '<p class="hint">Create subjects first.</p>';

      const actionLabel = m.status === 'pending' ? 'Approve & Assign' : 'Save Assignments';
      const disableButton = m.status === 'disabled'
        ? `<button class="edit-student reactivate-teacher-btn" data-uid="${m.uid}">Reactivate</button>`
        : `<button class="del-student disable-teacher-btn" data-uid="${m.uid}">Disable</button>`;

      li.innerHTML = `<div class="edit-row">
        <strong>${escapeHtml(m.email || m.uid)}</strong>
        <div class="meta">Teacher${statusText}</div>
        <p class="hint">Assign the class(es) and subject(s) this teacher is allowed to work with.</p>
        <strong>Classes</strong>
        ${classChecks}
        <strong>Subjects</strong>
        ${subjectChecks}
        <div class="edit-actions">
          <button class="save-btn save-teacher-assignment" data-uid="${m.uid}">${actionLabel}</button>
          ${m.status === 'pending' ? '<button class="cancel-btn reject-teacher-btn" data-uid="' + m.uid + '">Reject</button>' : disableButton}
        </div>
      </div>`;
      list.appendChild(li);
    });

    list.querySelectorAll('.save-teacher-assignment').forEach(btn => {
      btn.addEventListener('click', () => {
        const li = btn.closest('li');
        const assignedClassIds = Array.from(li.querySelectorAll('.assign-class-cb:checked')).map(cb => cb.value);
        const assignedSubjectIds = Array.from(li.querySelectorAll('.assign-subject-cb:checked')).map(cb => cb.value);
        if (!assignedClassIds.length) {
          alert('Assign at least one class before approving or activating a teacher.');
          return;
        }
        const isPending = li.querySelector('.meta').textContent.indexOf('Pending') !== -1;
        const updates = {
          assignedClassIds,
          assignedSubjectIds,
          status: isPending ? 'active' : 'active',
          assignmentsUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        firebase.firestore().collection('users').doc(btn.dataset.uid).update(updates)
          .then(() => renderManageTeachers())
          .catch(err => alert('Could not save teacher assignment: ' + err.message));
      });
    });

    list.querySelectorAll('.reject-teacher-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!confirm('Reject this request? The teacher will need to join again with a school code.')) return;
        firebase.firestore().collection('users').doc(btn.dataset.uid).update({
          schoolId: firebase.firestore.FieldValue.delete(),
          role: firebase.firestore.FieldValue.delete(),
          status: 'rejected',
          assignedClassIds: firebase.firestore.FieldValue.delete(),
          assignedSubjectIds: firebase.firestore.FieldValue.delete()
        }).then(() => renderManageTeachers())
          .catch(err => alert('Could not reject: ' + err.message));
      });
    });

    list.querySelectorAll('.disable-teacher-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!confirm('Disable this teacher? Their school data will remain safe, but access will be blocked.')) return;
        firebase.firestore().collection('users').doc(btn.dataset.uid).update({ status: 'disabled' })
          .then(() => renderManageTeachers())
          .catch(err => alert('Could not disable: ' + err.message));
      });
    });

    list.querySelectorAll('.reactivate-teacher-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const teacher = members.find(m => m.uid === btn.dataset.uid);
        const ids = Array.isArray(teacher && teacher.assignedClassIds) ? teacher.assignedClassIds : [];
        if (!ids.length) {
          alert('Assign at least one class before reactivating this teacher.');
          return;
        }
        firebase.firestore().collection('users').doc(btn.dataset.uid).update({ status: 'active' })
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
    localStorage.setItem(GUEST_MODE_KEY, '1');
    hideAuthGate();
    initLockScreen();
    proceedToApp();
  });

  document.getElementById('logoutBtn').addEventListener('click', () => firebase.auth().signOut());
  document.getElementById('schoolChoiceLogoutBtn').addEventListener('click', () => firebase.auth().signOut());
  document.getElementById('pendingLogoutBtn').addEventListener('click', () => firebase.auth().signOut());
  document.getElementById('disabledLogoutBtn').addEventListener('click', () => firebase.auth().signOut());

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

  firebase.auth().onAuthStateChanged(user => {
    if (user) {
      currentUid = user.uid;
      localStorage.removeItem(GUEST_MODE_KEY);
      showSyncingMessage();
      showAuthGate();
      firebase.firestore().collection('users').doc(currentUid).get().then(userDoc => {
        const data = userDoc.exists ? userDoc.data() : null;
        currentUserData = data || null;
        currentAssignedClassIds = data && Array.isArray(data.assignedClassIds) ? data.assignedClassIds : [];
        currentAssignedSubjectIds = data && Array.isArray(data.assignedSubjectIds) ? data.assignedSubjectIds : [];

        if (!data || !data.schoolId) {
          currentSchoolId = null; currentRole = null; currentStatus = null;
          hideSyncingMessage(); hideAuthGate(); hideDisabledGate();
          showSchoolChoiceGate();
          return;
        }
        if (data.status === 'pending') {
          currentSchoolId = null; currentRole = data.role; currentStatus = 'pending';
          hideSyncingMessage(); hideAuthGate(); hideDisabledGate();
          showPendingGate();
          return;
        }
        if (data.status !== 'active') {
          // Disabled, or any other non-active status — never treat as
          // active by default. This is what a Head Teacher disabling a
          // teacher actually blocks.
          currentSchoolId = null; currentRole = data.role; currentStatus = data.status || 'disabled';
          hideSyncingMessage(); hideAuthGate(); hidePendingGate();
          showDisabledGate();
          return;
        }

        currentSchoolId = data.schoolId;
        currentRole = data.role;
        currentStatus = 'active';
        return pullCloudData().then(() => {
          hideSyncingMessage(); hideAuthGate(); hidePendingGate(); hideDisabledGate();
          initLockScreen();
          if (!appStarted) { appStarted = true; proceedToApp(); }
          else { refreshProfileMenu(); renderClasses(); renderStudents(); renderSubjects(); renderStaff(); }
        });
      }).catch(err => {
        hideSyncingMessage();
        setAuthError('Could not load your account: ' + err.message);
      });
    } else {
      currentUid = null; currentSchoolId = null; currentRole = null; currentStatus = null; currentUserData = null; currentAssignedClassIds = []; currentAssignedSubjectIds = [];
      if (localStorage.getItem(GUEST_MODE_KEY)) {
        hideAuthGate(); hideSchoolChoiceGate(); hidePendingGate(); hideDisabledGate();
        initLockScreen();
        if (!appStarted) { appStarted = true; proceedToApp(); }
      } else {
        hideSchoolChoiceGate(); hidePendingGate(); hideDisabledGate();
        renderAuthForm();
        showAuthGate();
      }
    }
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
  ensureDefaults();
  renderPinSection();
  loadSettingsForm();
  showView('home');
}

/* ---------- init ---------- */
initTheme();
initAuth();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
