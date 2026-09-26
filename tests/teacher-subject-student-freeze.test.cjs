const fs=require('fs');
const assert=require('assert');

const app=fs.readFileSync('app-4.js','utf8');
const index=fs.readFileSync('index.html','utf8');
const ui=fs.readFileSync('ui-polish.css','utf8');
const sw=fs.readFileSync('sw.js','utf8');

assert(app.includes('function currentWelcomeName()'));
assert(app.includes('const initialSubjects = isActiveGuest()'));
assert(app.includes('function subjectGradeRefHasScoreV40(entry)'));
assert(app.includes('function pruneEmptySubjectGradeRefsV40(ids)'));
assert(app.includes('if (!subjectEntryHasScore(classGrades[studentId][subjectId])) delete classGrades[studentId][subjectId];'));
assert(index.includes('Head Teacher welcome name (optional)'));
assert(ui.includes('#app #view-students .student-details-table :is(th,td):first-child'));
assert(ui.includes('position:sticky;'));
assert(ui.includes('left:0;'));
assert(sw.includes('schoolhub-cache-v40-subject-report-image-fix-3'));

console.log('teacher identity, subject cleanup, and student freeze regression: PASS');
