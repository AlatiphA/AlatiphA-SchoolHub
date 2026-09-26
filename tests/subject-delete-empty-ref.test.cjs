const fs=require('fs');
const assert=require('assert');
const vm=require('vm');

const app=fs.readFileSync('app-4.js','utf8');
const start=app.indexOf('function subjectScorePartHasValue');
const end=app.indexOf('function subjectHasSavedScores',start);
assert(start>=0 && end>start);
const box={}; vm.createContext(box); vm.runInContext(app.slice(start,end),box);

assert.equal(box.subjectEntryHasScore({}),false);
assert.equal(box.subjectEntryHasScore({c:''}),false);
assert.equal(box.subjectEntryHasScore({e:'   '}),false);
assert.equal(box.subjectEntryHasScore({c:null}),false);
assert.equal(box.subjectEntryHasScore({e:null}),false);
assert.equal(box.subjectEntryHasScore({c:0}),true);
assert.equal(box.subjectEntryHasScore({e:'0'}),true);
assert.equal(box.subjectEntryHasScore({c:35}),true);
assert.equal(box.subjectEntryHasScore({e:'72'}),true);

const v40Start=app.indexOf('function subjectGradeRefHasScoreV40');
const v40End=app.indexOf('function subjectDepsV40',v40Start);
const box2={}; vm.createContext(box2); vm.runInContext(app.slice(v40Start,v40End),box2);
assert.equal(box2.subjectGradeRefHasScoreV40({}),false);
assert.equal(box2.subjectGradeRefHasScoreV40({c:''}),false);
assert.equal(box2.subjectGradeRefHasScoreV40({e:null}),false);
assert.equal(box2.subjectGradeRefHasScoreV40({c:0}),true);
assert.equal(box2.subjectGradeRefHasScoreV40({e:'80'}),true);

assert(app.includes('ids.some(id=>subjectGradeRefHasScoreV40(student[id]))'));
assert(app.includes('if(Object.hasOwn(student,id) && !subjectGradeRefHasScoreV40(student[id]))'));
console.log('subject delete empty-reference regression: PASS');
