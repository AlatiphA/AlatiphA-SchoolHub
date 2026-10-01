const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 const records=new Map([
  ['schools/s',{ownerUid:'head',profile:{schoolName:'School'}}],
  ['users/head',{role:'headteacher',status:'active',schoolId:'s',email:'head@example.test'}],
  ['users/teacher',{role:'teacher',status:'active',schoolId:'s',email:'teacher@example.test'}],
  ['users/pending',{role:'teacher',status:'pending',schoolId:'s'}],
  ['users/other',{role:'teacher',status:'active',schoolId:'other'}]
 ]);
 const ref=(path,filter)=>({path,collection:name=>ref(path+'/'+name),doc:id=>ref(path+'/'+id),where:(field,op,value)=>ref(path,[field,value]),get:()=>get({path,filter})});
 async function get(r){if(r.path.split('/').length%2){return {docs:[...records].filter(([k,v])=>k.startsWith(r.path+'/')&&k.split('/').length===r.path.split('/').length+1&&(!r.filter||v[r.filter[0]]===r.filter[1])).map(([k,v])=>({id:k.split('/').at(-1),data:()=>v}))};}return {exists:records.has(r.path),data:()=>records.get(r.path)};}
 const db={collection:ref,runTransaction:async fn=>{const writes=[];const result=await fn({get,set:(r,data)=>writes.push([r.path,data])});for(const [k,v]of writes)records.set(k,v);return result;}};
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 const module={exports:{}},ctx={module,exports:module.exports,require:name=>name==='firebase-functions/v2/firestore'?{onDocumentWritten:(opts,fn)=>fn}:require(name)};
 vm.runInNewContext(fs.readFileSync('functions/notifications.js','utf8'),ctx);
 const admin={firestore:{FieldValue:{serverTimestamp:()=>123},Timestamp:{fromMillis:n=>({toMillis:()=>n})}}};
 const handlers=module.exports.register({db,admin,HttpsError,onCall:(opts,fn)=>fn});
 const notices=uid=>[...records].filter(([k])=>k.startsWith('users/'+uid+'/notifications/')).map(([,v])=>v);
 const event=(id,before,after)=>({id,params:{uid:'teacher'},data:{before:{exists:!!before,data:()=>before},after:{exists:!!after,data:()=>after}}});
 return {records,handlers,notices,event,req:(uid,data)=>({auth:{uid,token:{}},data})};
}
test('teacher join events and retries create one notification for the owning Head Teacher',async()=>{
 const f=fixture(),e=f.event('join-1',null,{role:'teacher',status:'pending',schoolId:'s',email:'teacher@example.test'});
 await f.handlers.onUserMembershipNotification(e);await f.handlers.onUserMembershipNotification(e);
 assert.equal(f.notices('head').length,1);assert.equal(f.notices('head')[0].type,'teacher_join_request');
});
test('approval, removal and assignment events retain the right recipient and school',async()=>{
 const f=fixture(),before={role:'teacher',status:'pending',schoolId:'s'};
 await f.handlers.onUserMembershipNotification(f.event('approved',before,{...before,status:'active'}));
 await f.handlers.onUserMembershipNotification(f.event('removed',{...before,status:'active'},{status:'removed'}));
 await f.handlers.onUserMembershipNotification(f.event('assignments',{...before,status:'active',assignedClassIds:['a']},{...before,status:'active',assignedClassIds:['b']}));
 assert.deepEqual(f.notices('teacher').map(n=>n.type),['teacher_approved','teacher_removed','teacher_assignments_updated']);
 assert(f.notices('teacher').every(n=>n.schoolId==='s'));
});
test('explicit sign-in notices are throttled and announcements reach only active school teachers',async()=>{
 const f=fixture();assert.equal((await f.handlers.recordSchoolSignIn(f.req('teacher',{method:'google'}))).notified,true);
 assert.equal((await f.handlers.recordSchoolSignIn(f.req('teacher',{method:'google'}))).notified,false);assert.equal(f.notices('head').length,1);
 const r=await f.handlers.sendSchoolAnnouncement(f.req('head',{body:'School meeting tomorrow'}));assert.equal(r.sent,1);assert.equal(f.notices('teacher').length,1);assert.equal(f.notices('pending').length,0);assert.equal(f.notices('other').length,0);
 await assert.rejects(f.handlers.sendSchoolAnnouncement(f.req('teacher',{body:'Not authorized'})),e=>e.code==='permission-denied');
});
