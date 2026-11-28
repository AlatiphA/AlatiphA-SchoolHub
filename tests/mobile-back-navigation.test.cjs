const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('app-4.js', 'utf8');
const start = source.indexOf('const views = [');
const end = source.indexOf('function refreshHeadTeacherSelect(', start);

function fixture() {
  const listeners = {};
  const nodes = new Map();
  const history = {
    entries: [null], index: 0,
    get state() { return this.entries[this.index]; },
    replaceState(state) { this.entries[this.index] = state; },
    pushState(state) { this.entries.splice(this.index + 1); this.entries.push(state); this.index++; },
    go(delta) {
      const next = this.index + delta;
      if (next < 0 || next >= this.entries.length) return;
      this.index = next;
      listeners.popstate?.({ state: this.state });
    }
  };
  const node = id => {
    if (!nodes.has(id)) {
      const classes = new Set(['hidden']);
      nodes.set(id, { classList: {
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
        add(name) { classes.add(name); },
        contains(name) { return classes.has(name); }
      }, textContent: '' });
    }
    return nodes.get(id);
  };
  const ctx = {
    document: { getElementById: node },
    window: { history, addEventListener: (name, fn) => { listeners[name] = fn; }, scrollTo() {} },
    FIREBASE_ENABLED: true, sessionReady: true, sessionDataReady: true,
    sessionGeneration: 1, currentUid: 'teacher', currentSchoolId: 'school', currentRole: 'teacher',
    enforceGuestTrial: () => true, isTeacher: () => true, isHeadTeacher: () => false,
    saveNavigationState() {}, sectionTitle: name => name,
    renderHome() {}, renderClasses() {}, renderStudents() {}, renderSubjects() {}, renderStaff() {},
    renderFloatingPill() {}, showFloatingPill() {}, renderStudentClassSelect() {}, renderAttendanceView() {},
    renderGradesClassSelect() {}, renderRemarksClassSelect() {}, renderReportsClassSelect() {}
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(start, end), ctx);
  return { ctx, history, nodes };
}

test('edge Back moves through SchoolHub sections to Home without adding a new entry', () => {
  const f = fixture();
  f.ctx.showView('home');
  f.ctx.showView('students');
  f.ctx.showView('grades');
  assert.equal(f.history.entries.length, 3);
  f.history.go(-1);
  assert.equal(f.nodes.get('view-students').classList.contains('hidden'), false);
  assert.equal(f.history.entries.length, 3);
  f.ctx.goHomeFromSubView();
  assert.equal(f.nodes.get('view-home').classList.contains('hidden'), false);
  assert.equal(f.history.index, 0);
});

test('a restored section has Home behind it, and signed-out history cannot reopen records', () => {
  const f = fixture();
  f.ctx.showView('reports');
  assert.equal(f.history.entries.length, 2);
  assert.equal(f.history.entries[0].schoolHubView, 'home');
  f.history.go(-1);
  assert.equal(f.nodes.get('view-home').classList.contains('hidden'), false);
  f.ctx.sessionReady = false;
  f.history.go(1);
  assert.equal(f.nodes.get('view-home').classList.contains('hidden'), false);
  assert.equal(f.nodes.get('view-reports').classList.contains('hidden'), true);
});
