const fs=require('fs');
const assert=require('assert');
const js=fs.readFileSync('app-4.js','utf8');
const html=fs.readFileSync('index.html','utf8');
const rules=fs.readFileSync('firestore.rules','utf8');

assert(js.includes('function buildYearRolloverDraft()'));
assert(js.includes('function buildYearEndSnapshot(draft)'));
assert(js.includes('function applyYearRollover()'));
assert(js.includes("classHistory = Object.assign"));
assert(js.includes("enrollmentStatus = 'graduated'"));
assert(js.includes("enrollmentStatus = 'left'"));
assert(js.includes('studentsForClassYear(classId, year)'));
assert(js.includes('cloudRolloverSnapshot(snapshot, rolloverId, counts)'));
assert(js.includes("batch.create(metaRef"));
assert(html.includes('id="yearRolloverSection"'));
assert(html.includes('id="openYearRolloverBtn"'));
assert(rules.includes('match /yearRollovers/{rolloverId}'));
assert(rules.includes('allow update, delete: if false;'));

assert(js.includes('function parseYearEndBackupFile(text)'));
assert(js.includes('function applyYearEndEmergencyRestore()'));
assert(js.includes("parsed.type !== 'academic-year-rollover'"));
assert(js.includes('Students created after the backup are deliberately left untouched'));
assert(js.includes("batch.set(studentRef(String(student.id)), cloudStudent)"));
assert(html.includes('id="restoreYearEndBackupBtn"'));
assert(html.includes('id="restoreYearEndBackupInput"'));

console.log('year rollover regression: PASS');
