const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app-4.js', 'utf8');
function fn(name) {
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  const lineEnd = source.indexOf('\n', start);
  const first = source.slice(start, lineEnd);
  return first.trimEnd().endsWith('}') ? first : source.slice(start, source.indexOf('\n}', start) + 2);
}
const data = new Map();
const elements = new Map();
const ctx = vm.createContext({
  localStorage: {getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,String(v))},
  document: {getElementById: id => {
    if (!elements.has(id)) elements.set(id, {});
    return elements.get(id);
  }},
  Date: {now: () => 2000000000000},
  alert: () => {}, hideSyncingMessage: () => {}, showAuthGate: () => {},
  DB: {get: (k,fallback) => k === 'classes' ? [{id:'guest-class'}] : fallback,
       set: (k,v) => data.set(k,JSON.stringify(v))},
  KEYS: {classes:'classes',settings:'settings'},
  REPORT_THEMES: {bw:{title:'Black & White'},premium:{title:'Premium'}},
  auditAction: () => {}, renderReportThemePicker: () => {},
  reportBillingIsFree: () => true
});
vm.runInContext(`const GUEST_MODE_KEY='arc_guest_mode', GUEST_TRIAL_KEY='arc_guest_trial_started';
const GUEST_TRIAL_DURATION=604800000;
let currentUid=null, currentSchoolId=null, currentRole=null, currentStatus=null;
let sessionReady=true, sessionDataReady=true;
const FIREBASE_ENABLED=true;
${['guestTrialRemaining','isActiveGuest','updateGuestTrialUI','enforceGuestTrial','isHeadTeacher','isTeacher','accessibleClassIds','requireHeadTeacher','requireSchoolAccountForPaidFeature','ensureCreditsAvailable','applyReportTheme','migrateDataIntoSchool'].map(fn).join('\n')}`, ctx);
const run = code => vm.runInContext(code, ctx);
(async () => {
  assert.equal(run('guestTrialRemaining()'),604800000);
  data.set('arc_guest_mode','1');
  assert.equal(run('enforceGuestTrial()'),true);
  const start=data.get('arc_guest_trial_started');
  assert.equal(run('isActiveGuest()'),true);
  assert.equal(run('isHeadTeacher()'),false);
  assert.equal(run('accessibleClassIds()[0]'),'guest-class');
  assert.equal(run("requireHeadTeacher('manage classes')"),true);
  await run("applyReportTheme('bw')");
  assert.equal(JSON.parse(data.get('settings')).reportTheme,'bw');
  await run("applyReportTheme('premium')");
  assert.equal(JSON.parse(data.get('settings')).reportTheme,'bw');
  assert.equal(await run("ensureCreditsAvailable(1,'premium report')"),false);
  assert.equal(await run("ensureCreditsAvailable(5,'batch report')"),false);
  run('enforceGuestTrial()');
  assert.equal(data.get('arc_guest_trial_started'),start,'reopening cannot restart trial');
  assert.equal(run('guestTrialRemaining(2000000000000+604800000-1)'),1);
  assert.equal(run('guestTrialRemaining(2000000000000+604800000)'),0);
  data.set('arc_guest_trial_started',String(2000000000000-604800000));
  data.set('arc_students','[{"id":"pupil"}]');
  assert.equal(run('enforceGuestTrial()'),false);
  assert.equal(run('sessionReady'),false);
  assert.equal(elements.get('authGuestBtn').disabled,true);
  assert.equal(data.get('arc_students'),'[{"id":"pupil"}]','expiry preserves data');
  run("currentUid='new-user'; currentSchoolId='school'; currentRole='headteacher'; currentStatus='active'");
  assert.equal(run('enforceGuestTrial()'),true,'registered school bypasses guest expiry');
  data.set('arc_school_calendar','{"holiday":true}');
  run("migrateDataIntoSchool('school')");
  assert.equal(data.get('arc_students__school'),data.get('arc_students'));
  assert.equal(data.get('arc_school_calendar__school'),data.get('arc_school_calendar'));
  data.set('arc_guest_trial_started','invalid');
  assert.equal(run('guestTrialRemaining()'),0);
  data.set('arc_guest_trial_started','2000000000001');
  assert.equal(run('guestTrialRemaining()'),0);
  console.log('Guest trial checks passed: expiry boundary, resume, permissions, themes, billing restrictions, data preservation and migration.');
})().catch(error=>{console.error(error);process.exitCode=1;});

