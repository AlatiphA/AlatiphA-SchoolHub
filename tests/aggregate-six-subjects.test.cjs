const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync('app-4.js','utf8');
const computation=app.slice(app.indexOf('function computeAggregate(entries)'),app.indexOf('// Per-subject class-wide position:'));
function fixture(simple=false){
 const subjects=Array.from({length:8},(_,i)=>({id:'s'+i}));
 const grades={};const students=[{id:'five',name:'Five subjects'},{id:'six',name:'Six subjects'},{id:'seven',name:'Seven subjects'}];
 for(const [id,count,score]of [['five',5,100],['six',6,80],['seven',7,70]]){grades[id]={};for(let i=0;i<count;i++)grades[id]['s'+i]={c:score,e:score};}
 const c={studentsForClassYear:()=>students,getAccessibleSubjects:()=>subjects,gradeKey:()=> 'class',KEYS:{grades:'grades',settings:'settings'},DB:{get:k=>k==='grades'?{class:grades}:{reportLayout:simple?'simple':'standard'}},getGradeFor:n=>n>=90?1:n>=80?2:3,getRemarkFor:()=> 'remark',scaleClass:n=>n*.3,scaleExam:n=>n*.7};
 vm.createContext(c);vm.runInContext(computation,c);return {c,grades,subjects};
}
test('zero through five completed subjects have no aggregate',()=>{
 const {c}=fixture();for(let n=0;n<6;n++)assert.equal(c.computeAggregate(Array.from({length:n},()=>({grade:1}))),null);
});
test('six subjects calculate normally and additional electives retain the best two rule',()=>{
 const {c}=fixture();assert.equal(c.computeAggregate([1,2,3,4,5,6].map(grade=>({grade}))),21);
 assert.equal(c.computeAggregate([1,2,3,4,9,3,2,8].map(grade=>({grade}))),15);
 assert.equal(c.computeAggregate(Array.from({length:6},()=>({grade:1}))),6);
});
for(const simple of [false,true])test((simple?'simple':'standard')+' report leaves five-subject pupil unranked while retaining scores',()=>{
 const {c}=fixture(simple),results=c.computeClassResults('class','term','year');const five=results.find(x=>x.student.id==='five'),six=results.find(x=>x.student.id==='six');
 assert.equal(five.entries.length,5);assert.equal(five.aggregate,null);assert.equal(five.position,null);assert.equal(five.totalSum,500);assert.equal(five.avg,100);
 assert.equal(six.aggregate,12);assert.equal(six.position,1);assert.equal(six.outOf,2);
});
test('missing score components do not count toward the six-subject minimum',()=>{
 const {c,grades}=fixture();delete grades.six.s5.c;const six=c.computeClassResults('class','term','year').find(x=>x.student.id==='six');assert.equal(six.entries.length,5);assert.equal(six.aggregate,null);assert.equal(six.position,null);
});
for(const button of ['exportCsvBtn','historyExportCsvBtn'])test(button+' exports a dash for incomplete aggregate',async()=>{
 const {c,subjects}=fixture(true);let click,blob;
 const get=c.DB.get;c.DB.get=k=>k==='subjects'?subjects:k==='classes'?[{id:'class',name:'Class'}]:get(k);
 c.KEYS.subjects='subjects';c.KEYS.classes='classes';c.computeSubjectPositions=()=>({});c.ordinal=n=>String(n);
 c.currentHistorySelection=()=>({classId:'class',term:'Term 1',year:'2026'});c.historicalSettings=()=>({reportLayout:'simple'});
 c.document={getElementById:id=>id===button?{addEventListener:(_,fn)=>click=fn}:{value:'class'},createElement:()=>({click(){}}),body:{appendChild(){},removeChild(){}}};
 c.URL={createObjectURL:b=>{blob=b;return 'blob:test';},revokeObjectURL(){}};c.Blob=Blob;
 const start=app.indexOf("document.getElementById('"+button+"').addEventListener('click'");const end=app.indexOf('\n});',start)+4;
 const csvStart=app.indexOf('function csvValue('),csvEnd=app.indexOf('\n}',csvStart)+2;
 vm.runInContext(app.slice(csvStart,csvEnd)+app.slice(start,end),c);click();
 const csv=await blob.text(),rows=csv.replace(/^\uFEFF/,'').split('\r\n').map(x=>x.split(','));
 const col=rows[0].indexOf('Aggregate');assert.equal(rows[1][col],'-');assert.equal(rows[2][col],'12');assert.equal(rows[1].at(-1),'');
});
