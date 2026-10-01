const { test, before, after } = require('node:test');
const { readFileSync } = require('node:fs');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, writeBatch, collection, getDocs, query, where, deleteDoc } = require('firebase/firestore');
const { ref, uploadBytes, getBytes } = require('firebase/storage');
let env;
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-schoolhub-audit', firestore: {rules: readFileSync('firestore.rules','utf8')}, storage: {rules: readFileSync('storage.rules','utf8')} });
  await env.withSecurityRulesDisabled(async ctx => {
    const db=ctx.firestore();
    for(const [path,value] of Object.entries({
      'users/head': {schoolId:'s',role:'headteacher',status:'active'},
      'users/teacher': {schoolId:'s',role:'teacher',status:'active',assignedClassIds:['c1'],assignedSubjectIds:['math']},
      'users/disabled': {schoolId:'s',role:'teacher',status:'disabled',assignedClassIds:['c1']},
      'users/outsider': {schoolId:'other',role:'headteacher',status:'active'},
      'schools/s': {ownerUid:'head',profile:{schoolName:'School'}},
      'schools/s/students/p1': {id:'p1',classId:'c1'},
      'schools/s/students/p2': {id:'p2',classId:'c2'},
      'schools/s/staff/h': {name:'Head',bankAccount:'private'},
      'schools/s/teacherAttendance/day': {entries:{}},
      'schools/s/grades/g': {classId:'c1',entries:{}},
      'schools/s/attendance/a': {classId:'c1',entries:{}},
      'schools/s/remarks/r': {classId:'c1',entries:{}},
      'schools/s/imageAssets/p2': {kind:'student',classId:'c2',sourceUrl:'private'},
      'schools/s/imageAssets/p1': {kind:'student',classId:'c1'},
      'joinCodes/owned': {schoolId:'s'}
    })) await setDoc(doc(db,path),value);
  });
});
after(async()=>{if(env)await env.cleanup();});
test('teachers can query assigned pupils but not other classes or personnel',async()=>{
  const db=env.authenticatedContext('teacher').firestore();
  await assertSucceeds(getDocs(query(collection(db,'schools/s/students'),where('classId','==','c1'))));
  for(const path of ['schools/s/students/p2','schools/s/staff/h','schools/s/teacherAttendance/day'])await assertFails(getDoc(doc(db,path)));
  await assertSucceeds(getDoc(doc(env.authenticatedContext('head').firestore(),'schools/s/staff/h')));
});
test('disabled users and other schools cannot access school records',async()=>{
  for(const uid of ['disabled','outsider'])await assertFails(getDoc(doc(env.authenticatedContext(uid).firestore(),'schools/s/students/p1')));
});
test('record writes and year archives require the server even for heads',async()=>{
  for(const uid of ['head','teacher']){
    const db=env.authenticatedContext(uid).firestore();
    for(const path of ['grades/g','attendance/a','remarks/r','teacherAttendance/day','yearRollovers/year'])await assertFails(setDoc(doc(db,'schools/s/'+path),{classId:'c1',entries:{}}));
  }
});
test('deletion marker and student delete are atomic and block stale recreation',async()=>{
  const db=env.authenticatedContext('teacher').firestore(), batch=writeBatch(db);
  batch.set(doc(db,'schools/s/deletedRecords/students__p1'),{collection:'students',id:'p1'});
  batch.delete(doc(db,'schools/s/students/p1'));
  await assertSucceeds(batch.commit());
  await assertFails(setDoc(doc(db,'schools/s/students/p1'),{classId:'c1'}));
  await assertFails(deleteDoc(doc(db,'schools/s/deletedRecords/students__p1')));
});
test('join codes cannot be reassigned to another school',async()=>{
  await assertFails(setDoc(doc(env.authenticatedContext('head').firestore(),'joinCodes/owned'),{schoolId:'other'}));
});
test('explicit head recovery removes a marker and restores a pupil atomically',async()=>{
  const db=env.authenticatedContext('head').firestore(),batch=writeBatch(db);
  batch.delete(doc(db,'schools/s/deletedRecords/students__p1'));
  batch.set(doc(db,'schools/s/students/p1'),{id:'p1',classId:'c1'});
  await assertSucceeds(batch.commit());
});
test('pupil photo manifests follow the same class permissions as photos',async()=>{
  const db=env.authenticatedContext('teacher').firestore();
  await assertFails(getDoc(doc(db,'schools/s/imageAssets/p2')));
  await assertSucceeds(getDocs(query(collection(db,'schools/s/imageAssets'),where('kind','==','student'),where('classId','==','c1'))));
});
test('storage enforces pupil class and head-only school assets',async()=>{
  const storage=env.authenticatedContext('teacher').storage(), bytes=new Uint8Array([1,2,3]);
  await assertSucceeds(uploadBytes(ref(storage,'schools/s/student-photos/c1/p.jpg'),bytes));
  await assertFails(uploadBytes(ref(storage,'schools/s/student-photos/c2/p.jpg'),bytes));
  await assertFails(uploadBytes(ref(storage,'schools/s/signatures/head.png'),bytes));
  await assertSucceeds(uploadBytes(ref(env.authenticatedContext('head').storage(),'schools/s/signatures/head.png'),bytes));
  await assertFails(getBytes(ref(env.authenticatedContext('outsider').storage(),'schools/s/signatures/head.png')));
});
test('callables save and restore atomically against real Firestore transactions',async()=>{
  const admin=require('../functions/node_modules/firebase-admin');
  const app=admin.initializeApp({projectId:'demo-schoolhub-audit'},'audit-server');
  const db=app.firestore();
  const serverRequire=require('node:module').createRequire(require('node:path').resolve('functions/index.js'));
  const {HttpsError}=serverRequire('firebase-functions/v2/https');
  const handlers=require('../functions/safety').register({db,admin,HttpsError,onCall:(_,fn)=>fn});
  const req=data=>({auth:{uid:'head'},data});
  try{
    await handlers.migrateSchoolLegacy(req({}));
    await db.doc('schools/s').update({profile:{schoolName:'School',currentYear:'2026/2027',currentTerm:'Term 3'}});
    await db.doc('schools/s/classes/c1').set({id:'c1',name:'Class 1'});
    await db.doc('schools/s/classes/c2').set({id:'c2',name:'Class 2'});
    const key='c1__Term 3__2026/2027';
    await handlers.saveSchoolRecord({auth:{uid:'teacher'},data:{field:'grades',key,base:{},value:{p1:{math:{e:80}}}}});
    const before=(await db.doc('schools/s/students/p1').get()).data();
    await handlers.applySchoolYearChange(req({mode:'rollover',fromYear:'2026/2027',toYear:'2027/2028',decisions:{p1:{decision:'promote',destinationClassId:'c2'},p2:{decision:'repeat'}}}));
    const assert=require('node:assert/strict');
    assert.equal((await db.doc('schools/s/students/p1').get()).data().classId,'c2');
    await handlers.applySchoolYearChange(req({mode:'restore',expectedYear:'2027/2028',snapshot:{schoolId:'s',type:'academic-year-rollover',data:{students:[before],settings:{schoolName:'School',currentYear:'2026/2027'}}}}));
    assert.equal((await db.doc('schools/s/students/p1').get()).data().classId,'c1');
    assert.equal((await db.collection('schools/s/yearRollovers').get()).size,2);
  }finally{await app.delete();}
});

test('school teachers can read entitlements but cannot alter billing or read purchases',async()=>{
  const db=env.authenticatedContext('teacher').firestore();
  await assertSucceeds(getDoc(doc(db,'schools/s/billing/account')));
  await assertFails(setDoc(doc(db,'schools/s/billing/account'),{testLifetimeLicence:{active:true}}));
  await assertFails(getDoc(doc(db,'schools/s/billingTransactions/ref')));
  for(const uid of ['disabled','outsider']) await assertFails(getDoc(doc(env.authenticatedContext(uid).firestore(),'schools/s/billing/account')));
});

test('teachers cannot bypass My Details protections by rewriting their link or Staff record',async()=>{
  const db=env.authenticatedContext('teacher').firestore();
  await assertFails(setDoc(doc(db,'users/teacher'),{staffId:'h'},{merge:true}));
  await assertFails(setDoc(doc(db,'users/teacher'),{role:'headteacher'},{merge:true}));
  await assertFails(setDoc(doc(db,'schools/s/staff/h'),{phone:'new',userUid:'teacher'},{merge:true}));
});

test('old clients cannot blank existing Setup and recovery copies are head-only',async()=>{
 const db=env.authenticatedContext('head').firestore();
 await assertFails(setDoc(doc(db,'schools/s'),{profile:{schoolName:''}},{merge:true}));
 await assertSucceeds(getDoc(doc(db,'schools/s/profileRecovery/previous')));
 for(const uid of ['teacher','outsider'])await assertFails(getDoc(doc(env.authenticatedContext(uid).firestore(),'schools/s/profileRecovery/previous')));
 await assertFails(setDoc(doc(db,'schools/s/profileRecovery/previous'),{profile:{schoolName:'fake'}}));
});

test('fee records cannot be read or rewritten directly by any school account',async()=>{
 for(const uid of ['head','teacher','outsider'])for(const name of ['feeCategories','feeItems','pupilCharges','feeAccounts','feePayments','feeEvents','feeMeta']){
  const db=env.authenticatedContext(uid).firestore();
  await assertFails(getDoc(doc(db,'schools/s/'+name+'/test')));
  await assertFails(setDoc(doc(db,'schools/s/'+name+'/test'),{paid:999,amount:999}));
 }
});

test('fee transactions serialize concurrent payments and receipt retries',async()=>{
 const admin=require('../functions/node_modules/firebase-admin');const app=admin.initializeApp({projectId:'demo-schoolhub-audit'},'fees-server');const db=app.firestore();
 const serverRequire=require('node:module').createRequire(require('node:path').resolve('functions/index.js'));
 const {HttpsError}=serverRequire('firebase-functions/v2/https');const {register,key}=require('../functions/fees');const h=register({db,HttpsError,onCall:(_,fn)=>fn}),assert=require('node:assert/strict');
 const req=data=>({auth:{uid:'head'},data});
 try{
  await db.doc('schools/s/classes/fees-test').set({name:'Fees test'});await db.doc('schools/s/students/fees-pupil').set({name:'Synthetic pupil',classId:'fees-test'});
  await h.updateSchoolFees(req({action:'classFee',requestId:'fees-emulator-class',classId:'fees-test',term:'Term 1',year:'2026/2027',amount:30000}));
  const accountId=key('Term 1','2026/2027','fees-pupil'),payment={action:'payment',accountId,amount:20000,method:'Cash',payer:'Synthetic parent'};
  const results=await Promise.allSettled([h.updateSchoolFees(req({...payment,requestId:'fees-emulator-pay-1'})),h.updateSchoolFees(req({...payment,requestId:'fees-emulator-pay-2'}))]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  const winner=results[0].status==='fulfilled'?'fees-emulator-pay-1':'fees-emulator-pay-2';await h.updateSchoolFees(req({...payment,requestId:winner}));
  assert.equal((await db.doc('schools/s/feeAccounts/'+accountId).get()).data().paid,20000);
  assert.equal((await db.collection('schools/s/feePayments').get()).size,1);
  await h.updateSchoolFees(req({action:'classFee',requestId:'fees-emulator-next-year',classId:'fees-test',term:'Term 1',year:'2027/2028',amount:20000}));
  const next=key('Term 1','2027/2028','fees-pupil');
  const carried=await h.updateSchoolFees(req({...payment,accountId:next,requestId:'fees-emulator-carried',amount:15000}));
  assert.equal(carried.payment.balanceAfter,15000);assert.equal(carried.payment.allocations.length,2);
  await h.updateSchoolFees(req({action:'void',accountId:next,requestId:'fees-emulator-void',paymentId:'fees-emulator-carried',reason:'Synthetic reversal'}));
  assert.equal((await db.doc('schools/s/feeAccounts/'+accountId).get()).data().paid,20000);
  assert.equal((await db.doc('schools/s/feeAccounts/'+next).get()).data().paid,0);

 }finally{await app.delete();}
});

test('teacher membership creation and rejoin require the server guard',async()=>{
 const fresh=env.authenticatedContext('direct-new').firestore(),pending={schoolId:'s',role:'teacher',status:'pending',assignedClassIds:[],assignedSubjectIds:[],email:'direct@example.test',displayName:'Direct'};
 await assertFails(setDoc(doc(fresh,'users/direct-new'),pending));
 await env.withSecurityRulesDisabled(async ctx=>setDoc(doc(ctx.firestore(),'users/direct-rejoin'),{status:'rejected',email:'direct-rejoin@example.test'}));
 const rejoin=env.authenticatedContext('direct-rejoin').firestore();
 await assertFails(setDoc(doc(rejoin,'users/direct-rejoin'),{...pending,email:'direct-rejoin@example.test'}));
});
test('server join blocks a second membership with the same normalized email',async()=>{
 const admin=require('../functions/node_modules/firebase-admin'),app=admin.initializeApp({projectId:'demo-schoolhub-audit'},'identity-guard'),db=app.firestore();
 const {register}=require('../functions/teacher-lifecycle');class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 const h=register({db,admin,HttpsError,onCall:(_,fn)=>fn}),assert=require('node:assert/strict');
 try{
  await db.doc('joinCodes/GUARD1').set({schoolId:'s'});
  const req=(uid,email)=>({auth:{uid,token:{email,name:uid}},data:{code:'GUARD1'}});
  const first=await h.joinSchoolWithCodeSafe(req('identity-a','Same.Email@Example.Test'));
  assert.equal(first.status,'pending');
  assert.equal((await db.doc('users/identity-a').get()).data().email,'same.email@example.test');
  await assert.rejects(()=>h.joinSchoolWithCodeSafe(req('identity-b','same.email@example.test')),e=>e&&e.code==='already-exists');
 }finally{await app.delete();}
});
test('atomic teacher lifecycle, concurrent approval, removal and rejoining preserve one staff record',async()=>{
 const admin=require('../functions/node_modules/firebase-admin'),app=admin.initializeApp({projectId:'demo-schoolhub-audit'},'teacher-lifecycle'),db=app.firestore();
 const {register}=require('../functions/teacher-lifecycle');class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 const h=register({db,admin,HttpsError,onCall:(_,fn)=>fn}),assert=require('node:assert/strict'),req=data=>({auth:{uid:'head'},data});
 const teacherDb=env.authenticatedContext('lifecycle-teacher').firestore();
 const pending={schoolId:'s',role:'teacher',status:'pending',assignedClassIds:[],assignedSubjectIds:[],email:'life@example.test',displayName:'Lifecycle Teacher'};
 try{
  await db.doc('users/lifecycle-teacher').set(pending);
  await db.doc('schools/s/classes/life-class').set({name:'Lifecycle class'});
  const save={action:'save',teacherUid:'lifecycle-teacher',name:'Lifecycle Teacher',assignedClassIds:['life-class'],assignedSubjectIds:[]};
  const results=await Promise.all([h.manageTeacherLifecycle(req(save)),h.manageTeacherLifecycle(req(save))]);assert.equal(results[0].staffId,results[1].staffId);
  const staffId=results[0].staffId,staffRef=db.doc('schools/s/staff/'+staffId);
  await assertFails(setDoc(doc(env.authenticatedContext('head').firestore(),'schools/s/staff/duplicate-link'),{name:'Duplicate',userUid:'lifecycle-teacher'}));
  await h.manageTeacherLifecycle(req({action:'unlink',teacherUid:'lifecycle-teacher'}));assert.equal((await staffRef.get()).data().userUid,'');
  assert.equal((await h.manageTeacherLifecycle(req(save))).staffId,staffId);
  await h.manageTeacherLifecycle(req({action:'disable',teacherUid:'lifecycle-teacher'}));await h.manageTeacherLifecycle(req({action:'reactivate',teacherUid:'lifecycle-teacher'}));
  await assertSucceeds(setDoc(doc(env.authenticatedContext('head').firestore(),'schools/s/staff/'+staffId),{phone:'12345'},{merge:true}));
  await db.doc('schools/s/teacherAttendance/lifecycle-history').set({entries:{[staffId]:'P'}});
  await h.manageTeacherLifecycle(req({action:'remove',teacherUid:'lifecycle-teacher'}));
  await assertFails(getDoc(doc(teacherDb,'schools/s/classes/life-class')));
  assert.equal((await db.doc('schools/s/teacherAttendance/lifecycle-history').get()).data().entries[staffId],'P');
  assert.equal((await staffRef.get()).data().phone,'12345');
  await db.doc('users/lifecycle-teacher').set(pending);assert.equal((await h.manageTeacherLifecycle(req(save))).staffId,staffId);
  assert.equal((await db.collection('schools/s/staff').where('userUid','==','lifecycle-teacher').get()).size,1);
 }finally{await app.delete();}
});
