const {test}=require('node:test');const assert=require('node:assert/strict');
const {register}=require('./teacher-lifecycle');
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
function fixture(){
 const records=new Map([
 ['users/head',{schoolId:'s',role:'headteacher',status:'active'}],
 ['users/teacher',{schoolId:'s',role:'teacher',status:'active',assignedClassIds:['c1'],assignedSubjectIds:['math']}],
 ['users/disabled',{schoolId:'s',role:'teacher',status:'disabled'}],
 ['schools/s',{profile:{schoolName:'Test',currentYear:'2026/2027',currentTerm:'Term 3'}}],
 ['schools/s/classes/c1',{name:'Class 1'}],['schools/s/classes/c2',{name:'Class 2'}],
 ['schools/s/students/p1',{id:'p1',name:'Pupil',classId:'c1',isActive:true}],
 ['schools/s/subjects/math',{name:'Math'}],
 ['schools/s/staff/h',{name:'Head',role:'headteacher',bankAccount:'SECRET',ghanaCard:'SECRET'}]
 ]);let failCommit=false;
 const ref=path=>({path,collection:name=>ref(path+'/'+name),doc:id=>ref(path+'/'+id),where:(field,op,value)=>({...ref(path),filter:[field,value]})});
 const get=async r=>{
  if(r.path.split('/').length%2===1){const docs=[...records].filter(([k])=>k.startsWith(r.path+'/')&&k.split('/').length===r.path.split('/').length+1).filter(([,v])=>!r.filter||v[r.filter[0]]===r.filter[1]).map(([k,v])=>({id:k.split('/').at(-1),data:()=>structuredClone(v)}));return {docs};}
  return {exists:records.has(r.path),data:()=>structuredClone(records.get(r.path))};
 };
 const db={collection:ref,runTransaction:async fn=>{const writes=[];const tx={get,set:(r,v)=>writes.push(['set',r.path,v]),create:(r,v)=>{if(records.has(r.path))throw Error('already exists');writes.push(['set',r.path,v]);},update:(r,v)=>writes.push(['set',r.path,{...records.get(r.path),...v}]),delete:r=>writes.push(['delete',r.path])};const result=await fn(tx);if(failCommit)throw Error('injected commit failure');writes.forEach(([op,k,v])=>{if(op==='delete')records.delete(k);else records.set(k,v);});return result;}};
 const firestore={FieldValue:{serverTimestamp:()=>123}};
 const authVerified=new Map();
 const handlers=register({db,onCall:(_,fn)=>fn,HttpsError,admin:{firestore,auth:()=>({getUser:async uid=>({uid,email:records.get('users/'+uid)?.email||'',emailVerified:authVerified.get(uid)!==false,disabled:false})})}});
 return {records,handlers,setVerified:(uid,v)=>authVerified.set(uid,v),setFail:()=>failCommit=true,req:(data,uid='head')=>({auth:{uid},data})};
}
const save={action:'save',teacherUid:'teacher',name:'Ibrahim',assignedClassIds:['c1'],assignedSubjectIds:['math']};
const staffRecords=f=>[...f.records].filter(([k])=>k.startsWith('schools/s/staff/')&&k!=='schools/s/staff/h');
test('pending approval, unlink, relink, disable and reactivation retain exactly one Staff record',async()=>{
 const f=fixture();f.records.set('users/teacher',{schoolId:'s',role:'teacher',status:'pending',email:'ibrahim@example.test'});
 assert.equal(staffRecords(f).length,0);const call=d=>f.handlers.manageTeacherLifecycle(f.req(d));
 const first=await call(save);await call({action:'unlink',teacherUid:'teacher'});
 assert.equal(f.records.get('schools/s/staff/'+first.staffId).userUid,'');
 // Changing the contact email does not lose the retained recovery link.
 f.records.get('schools/s/staff/'+first.staffId).email='other@example.test';
 const relink=await call(save);assert.equal(relink.staffId,first.staffId);
 await call({action:'disable',teacherUid:'teacher'});await call(save);assert.equal(f.records.get('users/teacher').status,'disabled');
 await call({action:'reactivate',teacherUid:'teacher'});
 f.records.get('schools/s/staff/'+first.staffId).phone='012345';await call(save);
 assert.equal(staffRecords(f).length,1);assert.equal(staffRecords(f)[0][1].phone,'012345');assert.equal(f.records.get('users/teacher').staffId,first.staffId);
});
test('email matching prefers existing staff; similar names require explicit review and cannot steal a link',async()=>{
 const f=fixture();f.records.get('users/teacher').email=' EXACT@example.test ';
 f.records.set('schools/s/staff/existing',{name:'Ibrahim',email:'exact@example.test',phone:'kept'});
 const result=await f.handlers.manageTeacherLifecycle(f.req(save));assert.equal(result.staffId,'existing');
 f.records.set('users/other',{schoolId:'s',role:'teacher',status:'pending',email:'other@example.test'});
 await assert.rejects(f.handlers.manageTeacherLifecycle(f.req({...save,teacherUid:'other'})),/similar Staff name/);
 await assert.rejects(f.handlers.manageTeacherLifecycle(f.req({...save,teacherUid:'other',staffId:'existing'})),/another account/);
});
test('removal clears membership atomically and preserves school history; rejoin relinks',async()=>{
 const f=fixture(),call=d=>f.handlers.manageTeacherLifecycle(f.req(d));const first=await call(save);
 f.records.set('schools/s/grades/history',{teacher:'teacher',score:80});f.records.set('schools/s/teacherAttendance/history',{entries:{[first.staffId]:'P'}});
 const before=structuredClone([...f.records]);const failed=fixture();failed.setFail();await assert.rejects(failed.handlers.manageTeacherLifecycle(failed.req(save)),/injected/);assert.equal(staffRecords(failed).length,0);
 await call({action:'remove',teacherUid:'teacher'});const u=f.records.get('users/teacher');assert.equal(u.status,'removed');assert.equal(u.schoolId,undefined);assert.equal(u.staffId,undefined);assert.equal(u.role,undefined);assert.deepEqual(u.assignedClassIds,[]);
 assert.equal(f.records.get('schools/s/grades/history').score,80);assert.equal(f.records.get('schools/s/teacherAttendance/history').entries[first.staffId],'P');assert.equal(staffRecords(f).length,1);
 await assert.rejects(f.handlers.getTeacherHomeSummary(f.req({},'teacher')),e=>e.code==='permission-denied');
 f.records.set('users/teacher',{schoolId:'s',role:'teacher',status:'pending'});assert.equal((await call(save)).staffId,first.staffId);assert.equal(staffRecords(f).length,1);
});
test('teacher Home counts unique active peer accounts sharing an assigned class',async()=>{
 const f=fixture();f.records.set('users/peer',{schoolId:'s',role:'teacher',status:'active',assignedClassIds:['c1','c2']});f.records.set('users/pending',{schoolId:'s',role:'teacher',status:'pending',assignedClassIds:['c1']});f.records.set('users/elsewhere',{schoolId:'other',role:'teacher',status:'active',assignedClassIds:['c1']});
 assert.deepEqual(await f.handlers.getTeacherHomeSummary(f.req({},'teacher')),{teachers:2});
 await assert.rejects(f.handlers.manageTeacherLifecycle(f.req(save,'teacher')),e=>e.code==='permission-denied');
});

test('removing a teacher retires owned verification reservations without touching other accounts',async()=>{const f=fixture();f.records.get('users/teacher').email='teacher@example.test';f.records.set('schools/s/identityEmails/current',{uid:'teacher',email:'teacher@example.test'});f.records.set('schools/s/identityEmails/pending',{uid:'teacher',email:'future@example.test',status:'email-change-reserved'});f.records.set('schools/s/identityEmails/other',{uid:'other',email:'other@example.test'});await f.handlers.manageTeacherLifecycle(f.req({action:'remove',teacherUid:'teacher'}));assert(!f.records.has('schools/s/identityEmails/current'));assert(!f.records.has('schools/s/identityEmails/pending'));assert(f.records.has('schools/s/identityEmails/other'));});
test('unverified signup identities cannot join even when client claims verification',async()=>{const f=fixture();f.records.set('joinCodes/VERIFY1',{schoolId:'s'});const before=structuredClone([...f.records]);for(const token of [{email:'fake@example.test'},{email:'fake@example.test',email_verified:false}])await assert.rejects(f.handlers.joinSchoolWithCodeSafe({auth:{uid:'new',token},data:{code:'VERIFY1',emailVerified:true}}),e=>e.code==='failed-precondition');assert.deepEqual([...f.records],before);const result=await f.handlers.joinSchoolWithCodeSafe({auth:{uid:'new',token:{email:'real@example.test',email_verified:true}},data:{code:'VERIFY1'}});assert.equal(result.status,'pending');});
test('pending approval uses Auth email verification while existing active members retain update access',async()=>{const f=fixture();f.records.set('users/teacher',{schoolId:'s',role:'teacher',status:'pending',email:'teacher@example.test'});f.setVerified('teacher',false);const before=structuredClone([...f.records]);await assert.rejects(f.handlers.manageTeacherLifecycle(f.req(save)),e=>e.code==='failed-precondition');assert.deepEqual([...f.records],before);f.setVerified('teacher',true);await f.handlers.manageTeacherLifecycle(f.req(save));f.setVerified('teacher',false);await f.handlers.manageTeacherLifecycle(f.req({...save,name:'Legacy active member'}));assert.equal(f.records.get('users/teacher').status,'active');});
