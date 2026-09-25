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
