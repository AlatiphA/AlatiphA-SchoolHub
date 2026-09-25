const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('app-4.js','utf8');
function fixture(){
 const data={students:[{id:'p1',classId:'c1'},{id:'p2',classId:'c1'}],classes:[{id:'c1',classTeacherId:'staff1'},{id:'empty'}],subjects:[{id:'math'},{id:'unused'}],staff:[{id:'staff1'}],settings:{headTeacherId:'staff1'},grades:{term:{p1:{math:{e:70}},p2:{math:{e:50}}}},attendance:{day:{entries:{p1:'present',p2:'absent'}},legacy:{p1:false,p2:true}},remarks:{term:{p1:{conduct:'Good'},p2:{conduct:'Fair'}}},teacherAttendance:{day:{entries:{staff1:'present'}}}};
 const writes=[],alerts=[],confirmations=[],deleted=[];
 const ctx={DB:{get:(key,fallback)=>structuredClone(data[key]??fallback),set:(key,value)=>{data[key]=structuredClone(value);writes.push(key);}},KEYS:Object.fromEntries(Object.keys(data).map(k=>[k,k])),bulkSelectionsV40:{students:new Set(['p1','p2']),staff:new Set(),classes:new Set(),subjects:new Set()},isHeadTeacher:()=>true,requireClassAccess:()=>true,alert:m=>alerts.push(m),confirm:m=>{confirmations.push(m);return true;},FIREBASE_ENABLED:true,currentSchoolId:'school',currentUid:'head',sessionGeneration:1,cloudHydrationInProgress:false,sessionDataReady:true,offlineAuthenticatedMode:false,navigator:{onLine:true},isCurrentSession:()=>true,schoolRef:()=>({collection:kind=>({doc:id=>({kind,id}),get:async()=>({docs:[]}),where:()=>({limit:()=>({get:async()=>({empty:true})})})})}),commitChunks:async ops=>{ops.forEach(fn=>fn({delete:r=>deleted.push(r)}));},auditAction:()=>{},renderStudents:()=>{},renderClasses:()=>{},renderStaff:()=>{},renderSubjects:()=>{},renderStudentClassSelect:()=>{}};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function classDepsV40('),source.indexOf('const _renderClassesBulkV40')),ctx);
 return {ctx,data,writes,alerts,confirmations,deleted};
}
test('single and bulk student deletion clean grades, both attendance formats and remarks',async()=>{
 for(const bulk of [false,true]){
  const f=fixture();if(bulk)await f.ctx.bulkDeleteV40('students');else await f.ctx.deleteRecordsV40('students',['p1']);
  assert.deepEqual(f.data.students.map(x=>x.id),bulk?[]:['p2']);
  for(const entries of [f.data.grades.term,f.data.attendance.day.entries,f.data.attendance.legacy,f.data.remarks.term]){
   assert.equal(Object.hasOwn(entries,'p1'),false);assert.equal(Object.hasOwn(entries,'p2'),!bulk);
  }
  assert.match(f.confirmations[0],/grades, attendance entries and remarks/);
 }
});
test('individual and bulk class and subject deletion protect academic records',async()=>{
 for(const [kind,id] of [['classes','c1'],['subjects','math']])for(const bulk of [false,true]){
  const f=fixture();f.ctx.bulkSelectionsV40[kind].add(id);
  if(bulk)await f.ctx.bulkDeleteV40(kind);else await f.ctx.deleteRecordsV40(kind,[id]);
  assert.equal(f.deleted.length,0);assert.equal(f.writes.length,0);assert.match(f.alerts[0],/Safe Delete blocked/);
 }
});
test('cloud-only dependencies block deletion even when local data looks empty',async()=>{
 const f=fixture();f.ctx.schoolRef=()=>({collection:()=>({where:()=>({limit:()=>({get:async()=>({empty:false})})})})});
 await f.ctx.deleteRecordsV40('classes',['empty']);assert.equal(f.deleted.length,0);assert.match(f.alerts[0],/Safe Delete blocked/);
});
test('permission denial or cloud failure preserves all local records',async()=>{
 for(const denied of [false,true]){
  const f=fixture(),before=structuredClone(f.data);
  if(denied)f.ctx.requireClassAccess=()=>false;else f.ctx.commitChunks=async()=>{throw Error('permission denied');};
  await f.ctx.bulkDeleteV40('students');assert.deepEqual(f.data,before);assert.equal(f.writes.length,0);
 }
});
test('staff deletion clears assignments, retains history and explains account access',async()=>{
 const f=fixture();await f.ctx.deleteRecordsV40('staff',['staff1']);
 assert.equal(f.data.staff.length,0);assert.equal(f.data.classes[0].classTeacherId,'');assert.equal(f.data.settings.headTeacherId,'');
 assert.equal(f.data.teacherAttendance.day.entries.staff1,'present');assert.equal(f.data.grades.term.p1.math.e,70);
 assert.match(f.confirmations[0],/login access stays active/);
});
test('oversized and offline deletes perform no writes',async()=>{
 const f=fixture();await f.ctx.deleteRecordsV40('staff',Array.from({length:221},(_,i)=>String(i)));assert.equal(f.deleted.length,0);
 f.ctx.navigator.onLine=false;await f.ctx.deleteRecordsV40('students',['p1']);assert.equal(f.deleted.length,0);assert.equal(f.writes.length,0);
});
test('every individual delete button uses the shared deletion handler',()=>{
 for(const kind of ['classes','students','subjects','staff'])assert.match(source,new RegExp("deleteRecordsV40\\('"+kind+"', \\[String\\(btn.dataset.id\\)\\]\\)"));
});
