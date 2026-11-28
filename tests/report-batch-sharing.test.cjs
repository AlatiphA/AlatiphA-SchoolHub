const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('app-4.js', 'utf8');
const start = source.indexOf("let reportShareScope = '';");
const end = source.indexOf('function renderReportsStudentList()', start);

function fixture() {
  const actions = {};
  const entries = {
    innerHTML: '',
    querySelectorAll(selector) {
      if (selector === '.report-share-prepare') return [button('email', 'pupil')];
      if (selector === '.report-share-mark') return [button('', 'pupil')];
      return [];
    }
  };
  function button(channel, id) {
    const key = channel || 'mark';
    return { dataset: { id, channel }, addEventListener(_event, handler) { actions[key] = handler; } };
  }
  const count = { textContent: '' };
  const students = [
    { id: 'pupil', name: 'Learner One', parentEmail: 'parent@example.com', parentPhone: '0243443688', guardianName: 'Parent One' },
    { id: 'other', name: 'Learner Two', parentEmail: '', parentPhone: '' }
  ];
  const calls = [];
  const ctx = {
    DB: { get: () => students }, KEYS: { students: 'students' },
    document: { getElementById: id => id === 'reportShareQueueEntries' ? entries : id === 'reportShareCount' ? count : {} },
    guardianWhatsAppDigits: value => value ? '233' + String(value).slice(1) : '',
    escapeHtml: value => String(value),
    alert: message => { throw Error(message); },
    runReportAction: async (_button, action) => action(),
    generateCommunicationReport: async (studentId, options) => { calls.push({ studentId, options }); return 'ready'; }
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(start, end), ctx);
  vm.runInContext("reportShareScope = 'school|class|term'; reportShareSelection.add('pupil'); reportShareSelection.add('other');", ctx);
  const results = students.map(student => ({ student, entries: [{}] }));
  const settings = { currentTerm: 'Term 1', currentYear: '2026/2027', schoolName: 'Example School' };
  return { ctx, entries, count, actions, calls, results, settings };
}

test('batch sharing shows parent contacts, keeps missing contacts unavailable, and does not claim delivery', async () => {
  const f = fixture();
  f.ctx.renderReportShareQueue(f.results, f.settings);
  assert.match(f.entries.innerHTML, /parent@example\.com/);
  assert.match(f.entries.innerHTML, /data-id="other" data-channel="email" disabled/);
  assert.match(f.count.textContent, /2 selected · 0 marked sent/);
  await f.actions.email();
  assert.equal(f.calls[0].studentId, 'pupil');
  assert.equal(f.calls[0].options.recipient, 'parent@example.com');
  assert.match(f.entries.innerHTML, /PDF ready/);
  f.calls[0].options.onResult('shared');
  assert.match(f.entries.innerHTML, /Confirm it was sent/);
  assert.match(f.count.textContent, /0 marked sent/);
  f.actions.mark();
  assert.match(f.count.textContent, /1 marked sent/);
});
