const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync('app-4.js','utf8'),source=app.slice(app.indexOf('function reportCompletenessNotes('),app.indexOf('function drawReportPage('));
function notes(completed,listed){const c={};vm.createContext(c);vm.runInContext(source,c);return Array.from(c.reportCompletenessNotes({entries:Array.from({length:completed},()=>({})),subjectCount:listed,aggregate:completed<6?null:12}));}
test('five of nine results explain both missing subjects and aggregate dash',()=>{
 const lines=notes(5,9);assert.equal(lines.length,3);assert.match(lines[0],/5 of 9/);assert.match(lines[0],/incomplete or unavailable/);assert.match(lines[1],/fewer than six/);assert.match(lines[1],/class position/);assert.match(lines[2],/contact the school/);
});
test('six or eight of nine subjects explain omissions without denying a valid aggregate',()=>{
 for(const n of [6,8]){const lines=notes(n,9);assert.equal(lines.length,2);assert.match(lines[0],new RegExp(n+' of 9'));assert(!lines.some(x=>x.includes('Aggregate:')));}
});
test('complete report has no incomplete-results note',()=>assert.deepEqual(notes(9,9),[]));
test('zero completed results and fewer than six listed subjects remain clear',()=>{
 assert.match(notes(0,9)[0],/0 of 9/);assert.match(notes(5,5)[0],/Aggregate: -/);
});
test('result snapshots count the school subject list even with restricted accessible subjects',()=>{
 const c={studentsForClassYear:()=>[{id:'p'}],getAccessibleSubjects:()=>[{id:'a'}],gradeKey:()=> 'key',KEYS:{subjects:'subjects',grades:'grades',settings:'settings'},DB:{get:k=>k==='subjects'?Array.from({length:9},(_,i)=>({id:String(i)})):k==='grades'?{key:{p:{a:{e:90}}}}:{reportLayout:'simple'}},getGradeFor:()=>1,getRemarkFor:()=> 'Remark'};
 vm.createContext(c);vm.runInContext(app.slice(app.indexOf('function computeAggregate('),app.indexOf('// Per-subject class-wide position:')),c);const result=c.computeClassResults('c','t','y')[0];assert.equal(result.subjectCount,9);assert.equal(result.entries.length,1);
});
