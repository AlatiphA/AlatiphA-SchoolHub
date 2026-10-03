const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const app=fs.readFileSync('app-4.js','utf8');
const hostedApp=fs.readFileSync('public/app-4.js','utf8');
const rules=fs.readFileSync('firestore.rules','utf8');
const lifecycle=fs.readFileSync('functions/teacher-lifecycle.js','utf8');
const sw=fs.readFileSync('sw.js','utf8');
const hostedSw=fs.readFileSync('public/sw.js','utf8');

function identityFixture(){
  const source=fs.readFileSync('functions/teacher-lifecycle.test.js','utf8');
  const fixtureSource=source.slice(source.indexOf('function fixture(){'),source.indexOf('\nconst save='));
  class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
  return new Function('register','HttpsError',fixtureSource+'\nreturn fixture();')(require('../functions/teacher-lifecycle').register,HttpsError);
}

test('server join uses authenticated email and enforces membership and identity locks',async()=>{
  const f=identityFixture();f.records.set('joinCodes/GUARD1',{schoolId:'s'});
  const req=(uid,email)=>({auth:{uid,token:{email}},data:{code:'GUARD1',email:'spoof@example.test'}});
  assert.equal((await f.handlers.joinSchoolWithCodeSafe(req('new',' Same@Example.Test '))).status,'pending');
  assert.equal(f.records.get('users/new').email,'same@example.test');
  assert.equal((await f.handlers.joinSchoolWithCodeSafe(req('new','same@example.test'))).alreadyPending,true);
  await assert.rejects(f.handlers.joinSchoolWithCodeSafe(req('second','same@example.test')),e=>e.code==='already-exists');
  await assert.rejects(f.handlers.joinSchoolWithCodeSafe(req('teacher','new@example.test')),e=>e.code==='failed-precondition');
});

test('legacy duplicate memberships block server approval and reactivation',async()=>{
  for(const action of ['save','reactivate']){
    const f=identityFixture();
    f.records.set('users/candidate',{schoolId:'s',role:'teacher',status:action==='save'?'pending':'disabled',email:'SAME@example.test',assignedClassIds:['c1']});
    f.records.set('users/existing',{schoolId:'s',role:'teacher',status:'active',email:'same@example.test'});
    await assert.rejects(f.handlers.manageTeacherLifecycle(f.req({action,teacherUid:'candidate',name:'Candidate',assignedClassIds:['c1'],assignedSubjectIds:[]})),e=>e.code==='already-exists');
    assert.equal(f.records.get('users/candidate').status,action==='save'?'pending':'disabled');
  }
});

test('rejecting a pending identity releases its lock for another UID',async()=>{
  const f=identityFixture();f.records.set('joinCodes/GUARD1',{schoolId:'s'});
  const req=uid=>({auth:{uid,token:{email:'same@example.test'}},data:{code:'GUARD1'}});
  await f.handlers.joinSchoolWithCodeSafe(req('first'));
  await f.handlers.manageTeacherLifecycle(f.req({action:'reject',teacherUid:'first'}));
  assert.equal((await f.handlers.joinSchoolWithCodeSafe(req('second'))).status,'pending');
});

test('actual approval handler blocks normalized duplicate pending accounts before saving',()=>{
  const start=app.indexOf("list.querySelectorAll('.save-teacher-assignment')");
  const block=app.slice(start,app.indexOf('const assignedClassIds =',start));
  const guard=block.slice(block.indexOf('const member ='));
  const run=new Function('teachers','members','btn','alert',guard+'\nreturn "allowed";');
  const teacher={uid:'candidate',role:'teacher',status:'pending',email:' Same@Example.Test '};
  for(const status of ['pending','active','disabled']){
    const messages=[];
    assert.equal(run([teacher],[teacher,{uid:'other',role:'teacher',status,email:'same@example.test'}],{dataset:{uid:'candidate'}},m=>messages.push(m)),undefined);
    assert.equal(messages.length,1);
  }
  for(const other of [
    {...teacher},
    {uid:'other',role:'teacher',status:'removed',email:'same@example.test'},
    {uid:'other',role:'teacher',status:'active',email:'different@example.test'}
  ])assert.equal(run([teacher],[teacher,other],{dataset:{uid:'candidate'}},()=>{throw Error('unexpected warning');}),'allowed');
});

test('teacher join uses the server identity guard instead of direct membership writes',()=>{
  const start=app.indexOf('function joinSchoolWithCode(code)');
  const end=app.indexOf('/* ---------- Manage Teachers',start);
  assert.ok(start>=0&&end>start);
  const block=app.slice(start,end);
  assert.ok(block.includes("safetyCall('joinSchoolWithCodeSafe'"));
  assert.ok(!block.includes("collection('users').doc(currentUid).set"));
  assert.equal(hostedApp,app);
});

test('server join guard normalizes authenticated email and rejects duplicate school identities',()=>{
  assert.ok(lifecycle.includes('joinSchoolWithCodeSafe'));
  assert.ok(lifecycle.includes("const email=norm(r.auth.token&&r.auth.token.email)"));
  assert.ok(lifecycle.includes("['pending','active','disabled'].includes(m.status)"));
  assert.ok(lifecycle.includes("norm(m.email)===email"));
  assert.ok(lifecycle.includes("fail('already-exists','This email is already linked to another SchoolHub account in this school."));
});

test('email identity lock serializes concurrent join attempts',()=>{
  assert.ok(lifecycle.includes("collection('identityEmails').doc(emailLockId(email))"));
  assert.ok(lifecycle.includes("crypto.createHash('sha256')"));
  assert.ok(lifecycle.includes("tx.set(identityRef,{uid:r.auth.uid,email,status:'pending'"));
});

test('approval and reactivation cannot create another active membership for the same email',()=>{
  assert.ok(lifecycle.includes("const needsIdentityGuard=d.action==='save'||d.action==='reactivate';"));
  assert.ok(lifecycle.includes("Another school membership already uses this email."));
  assert.ok(lifecycle.includes("tx.set(identityRef,{uid:id,email:identityEmail,status:next.status"));
});

test('old clients cannot create or rejoin teacher membership directly',()=>{
  const usersStart=rules.indexOf('match /users/{uid}');
  const notificationsStart=rules.indexOf('match /users/{uid}/notifications',usersStart);
  assert.ok(usersStart>=0&&notificationsStart>usersStart);
  const usersRule=rules.slice(usersStart,notificationsStart);
  assert.ok(!usersRule.includes("request.resource.data.role == 'teacher'"));
  assert.ok(!usersRule.includes("resource.data.status in ['rejected', 'removed']"));
  assert.ok(usersRule.includes("hasOnly(['displayName'])"));
  assert.ok(!usersRule.includes("hasOnly(['displayName', 'email'])"));
});

test('Head Teacher can see duplicate-email warnings and full account UIDs',()=>{
  assert.ok(app.includes('Duplicate email warning'));
  assert.ok(app.includes('Account UID: ${escapeHtml(m.uid)}'));
  assert.ok(app.includes('Another account in this school already uses ${escapeHtml(displayEmail)}.'));
});

test('identity lock collection is server-only',()=>{
  assert.ok(rules.includes('match /identityEmails/{emailHash}'));
  assert.ok(rules.includes('allow read, write: if false;'));
});

test('service worker release is bumped for the identity guard delivery',()=>{
  assert.ok(sw.includes("schoolhub-cache-v40-aggregate-six-1"));
  assert.equal(hostedSw,sw);
});
