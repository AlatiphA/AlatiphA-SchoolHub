const { test, before, after } = require('node:test');
const { readFileSync } = require('node:fs');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, writeBatch, collection, getDocs, query, where, deleteDoc, onSnapshot } = require('firebase/firestore');
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
      'schools/s/imageAssets/p2': {kind:'student',recordId:'p2',classId:'c2',sourceUrl:'private'},
      'schools/s/imageAssets/p1': {kind:'student',recordId:'p1',classId:'c1'},
      'joinCodes/owned': {schoolId:'s'}
    })) await setDoc(doc(db,path),value);
  });
});
after(async()=>{if(env)await env.cleanup();});
test('operations documents are server-owned even for heads; teachers cannot read financial registers',async()=>{
 for(const collectionName of ['opItems','opAssets','opLiabilities','opRequests','opHistory','opSettlements','opCodes','opReceipts','opCounters','weeklySupervision','supervisionReceipts','supervisionHistory']){
  const path='schools/s/'+collectionName+'/security-test';await env.withSecurityRulesDisabled(ctx=>setDoc(doc(ctx.firestore(),path),{cost:100,createdBy:'teacher'}));
  for(const uid of ['head','teacher','disabled','outsider']){const db=env.authenticatedContext(uid).firestore();await assertFails(getDoc(doc(db,path)));await assertFails(setDoc(doc(db,path),{cost:0}));await assertFails(deleteDoc(doc(db,path)));}
 }
});
test('native operations transactions prevent concurrent overspending, duplicate payments and teacher financial access',async()=>{
 const assert=require('node:assert/strict'),admin=require('../functions/node_modules/firebase-admin'),app=admin.initializeApp({projectId:'demo-schoolhub-audit'},'operations-server'),db=app.firestore();
 const serverRequire=require('node:module').createRequire(require('node:path').resolve('functions/index.js')),{HttpsError}=serverRequire('firebase-functions/v2/https'),h=require('../functions/school-operations').register({db,admin,HttpsError,onCall:(_,fn)=>fn});
 const req=(data,uid='head')=>({auth:{uid},data:{expectedUid:uid,expectedSchoolId:'s',...data}});
 try{
  await h.updateSchoolOperations(req({requestId:'native-item-01',id:'native-stock-01',action:'createItem',code:'NATIVE-BOOK',name:'Synthetic books',unit:'pieces',quantityMilli:5000,minimumMilli:1000,unitCost:100}));
  const autoRequests=[1,2,3].map(i=>req({requestId:'native-auto-stock-0'+i,action:'createItem',name:'Synthetic auto '+i,unit:'pieces',quantityMilli:0,minimumMilli:0,unitCost:0}));
  const autoResults=await Promise.all(autoRequests.map(r=>h.updateSchoolOperations(r)));
  assert.deepEqual(autoResults.map(x=>x.code).sort(),['SC-001','SC-002','SC-003']);
  assert.deepEqual(await h.updateSchoolOperations(autoRequests[0]),autoResults[0]);
  assert.equal((await db.doc('schools/s/opCounters/stockCodes').get()).data().nextNumber,4);
  const outcomes=await Promise.allSettled([1,2].map(i=>h.updateSchoolOperations(req({requestId:'native-issue-0'+i,action:'issue',id:'native-stock-01',revision:0,quantityMilli:3000,reason:'Synthetic issue'}))));assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  await h.updateSchoolOperations(req({requestId:'native-request-01',action:'requestStock',id:'native-stock-request',itemId:'native-stock-01',quantityMilli:1000,purpose:'Synthetic lesson'},'teacher'));
  const approval=req({requestId:'native-approve-01',action:'approveRequest',id:'native-stock-request',revision:0,reason:'Approved'});await h.updateSchoolOperations(approval);await h.updateSchoolOperations(approval);assert.equal((await db.doc('schools/s/opItems/native-stock-01').get()).data().quantityMilli,1000);
  await h.updateSchoolOperations(req({requestId:'native-liability-01',id:'native-liability-01',action:'createLiability',creditor:'Synthetic supplier',description:'Books',amount:10000,dueOn:'2026-10-31'}));
  const payment=req({requestId:'native-payment-01',action:'settle',id:'native-liability-01',revision:0,amount:6000,reason:'Synthetic cash'}),paid=await h.updateSchoolOperations(payment);await h.updateSchoolOperations(payment);assert.equal((await db.doc('schools/s/opLiabilities/native-liability-01').get()).data().paid,6000);
  await h.updateSchoolOperations(req({requestId:'native-reverse-01',action:'reverseSettlement',paymentId:paid.paymentId,revision:1,reason:'Synthetic reversal'}));assert.equal((await db.doc('schools/s/opLiabilities/native-liability-01').get()).data().paid,0);
  const teacher=await h.getSchoolOperations(req({},'teacher'));assert.deepEqual(teacher.assets,[]);assert.deepEqual(teacher.liabilities,[]);assert(teacher.items.every(x=>!Object.hasOwn(x,'unitCost')));assert(teacher.requests.every(x=>x.createdBy==='teacher'));
  await assert.rejects(h.updateSchoolOperations(req({requestId:'native-denied-01',action:'settle'},'teacher')),e=>e.code==='permission-denied');
 }finally{await app.delete();}
});
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
  // The app reads manifests by the current accessible pupil IDs, not stale manifest classes.
  await assertSucceeds(getDoc(doc(db,'schools/s/imageAssets/p1')));
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
  const req=(uid,email)=>({auth:{uid,token:{email,name:uid,email_verified:true}},data:{code:'GUARD1'}});
  const first=await h.joinSchoolWithCodeSafe(req('identity-a','Same.Email@Example.Test'));
  assert.equal(first.status,'pending');
  assert.equal((await db.doc('users/identity-a').get()).data().email,'same.email@example.test');
  await assert.rejects(()=>h.joinSchoolWithCodeSafe(req('identity-b','same.email@example.test')),e=>e&&e.code==='already-exists');
 }finally{await app.delete();}
});
test('atomic teacher lifecycle, concurrent approval, removal and rejoining preserve one staff record',async()=>{
 const admin=require('../functions/node_modules/firebase-admin'),app=admin.initializeApp({projectId:'demo-schoolhub-audit'},'teacher-lifecycle'),db=app.firestore();
 const {register}=require('../functions/teacher-lifecycle');class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 const h=register({db,admin:{firestore:admin.firestore,auth:()=>({getUser:async()=>({emailVerified:true,email:'life@example.test',disabled:false})})},HttpsError,onCall:(_,fn)=>fn}),assert=require('node:assert/strict'),req=data=>({auth:{uid:'head'},data});
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

test('verified user cannot bypass server-owned email reconciliation but can edit display name',async()=>{const db=env.authenticatedContext('head',{email:'new@example.test',email_verified:true}).firestore();await assertFails(setDoc(doc(db,'users/head'),{email:'new@example.test'},{merge:true}));await assertSucceeds(setDoc(doc(db,'users/head'),{displayName:'Head Teacher'},{merge:true}));});


test('native live class listeners deliver rename and confirmed deletion within existing permissions',async()=>{
 const assert=require('node:assert/strict'),head=env.authenticatedContext('head').firestore(),teacher=env.authenticatedContext('teacher').firestore();
 function watch(reference){
  let latest,error;const waiting=[];
  const unsubscribe=onSnapshot(reference,{includeMetadataChanges:true},snapshot=>{if(snapshot.metadata.fromCache||snapshot.metadata.hasPendingWrites)return;latest=snapshot;for(const w of [...waiting])if(w.predicate(snapshot)){waiting.splice(waiting.indexOf(w),1);clearTimeout(w.timer);w.resolve();}},e=>{error=e;waiting.splice(0).forEach(w=>{clearTimeout(w.timer);w.reject(e)});});
  return {wait(predicate){if(error)return Promise.reject(error);if(latest&&predicate(latest))return Promise.resolve();return new Promise((resolve,reject)=>{const w={predicate,resolve,reject,timer:null};w.timer=setTimeout(()=>{const i=waiting.indexOf(w);if(i>=0)waiting.splice(i,1);reject(Error('Live snapshot timed out'));},15000);waiting.push(w);});},stop:unsubscribe};
 }
 const list=watch(collection(head,'schools/s/classes')),assigned=watch(doc(teacher,'schools/s/classes/c1')),markers=watch(query(collection(teacher,'schools/s/deletedRecords'),where('collection','==','classes')));
 const hasName=name=>snapshot=>snapshot.docs.some(d=>d.id==='c1'&&d.data().name===name);
 try{
  await setDoc(doc(head,'schools/s/classes/c1'),{id:'c1',name:'Live class test'});
  await Promise.all([list.wait(hasName('Live class test')),assigned.wait(d=>d.exists()&&d.data().name==='Live class test')]);
  await setDoc(doc(head,'schools/s/classes/c1'),{id:'c1',name:'Remote live rename'});
  await Promise.all([list.wait(hasName('Remote live rename')),assigned.wait(d=>d.exists()&&d.data().name==='Remote live rename')]);
  const batch=writeBatch(head);batch.set(doc(head,'schools/s/deletedRecords/classes__c1'),{collection:'classes',id:'c1',version:'native-live-delete'});batch.delete(doc(head,'schools/s/classes/c1'));await batch.commit();
  await Promise.all([list.wait(s=>!s.docs.some(d=>d.id==='c1')),assigned.wait(d=>!d.exists()),markers.wait(s=>s.docs.some(d=>d.data().id==='c1'&&d.data().version==='native-live-delete'))]);
  await assertFails(getDocs(collection(teacher,'schools/s/classes')));
  assert.equal((await getDoc(doc(head,'schools/s/classes/c1'))).exists(),false);
 }finally{list.stop();assigned.stop();markers.stop();}
});
test('native weekly supervision restricts feedback to linked staff and protects revisions and retries',async()=>{
 const assert=require('node:assert/strict'),admin=require('../functions/node_modules/firebase-admin'),app=admin.initializeApp({projectId:'demo-schoolhub-audit'},'supervision-server'),db=app.firestore();
 const serverRequire=require('node:module').createRequire(require('node:path').resolve('functions/index.js')),{HttpsError}=serverRequire('firebase-functions/v2/https'),h=require('../functions/weekly-supervision').register({db,HttpsError,onCall:(_,fn)=>fn});
 const req=(data,uid='head')=>({auth:{uid},data:{expectedUid:uid,expectedSchoolId:'s',...data}});
 try{
  await db.doc('schools/s/staff/weekly-native-staff').set({name:'Synthetic Teacher'});await db.doc('schools/s/subjects/weekly-math').set({name:'Mathematics'});await db.doc('schools/s/classes/weekly-native-class').set({name:'Synthetic Class'});await db.doc('users/weeklyTeacher').set({status:'active',role:'teacher',schoolId:'s',staffId:'weekly-native-staff'});
  const value={requestId:'native-weekly-check',staffId:'weekly-native-staff',classId:'weekly-native-class',week:'2026-10-05',year:'2026/2027',term:'1',checkedOn:'2026-10-05',lessonReviewed:true,lessonStatus:'submitted',registerReviewed:true,registerStatus:'up_to_date',followUpStatus:'none',assessments:[{subjectId:'weekly-math',exercises:3,assessments:1,booksChecked:4,booksMarked:4}]};
  const saved=await h.saveWeeklySupervision(req(value));assert.deepEqual(await h.saveWeeklySupervision(req(value)),saved);
  assert.equal((await h.getWeeklySupervision(req({week:value.week},'weeklyTeacher'))).records[0].staffId,'weekly-native-staff');assert.deepEqual((await h.getWeeklySupervision(req({week:value.week},'teacher'))).records,[]);
  await assert.rejects(h.saveWeeklySupervision(req({...value,requestId:'teacher-cannot-write'},'weeklyTeacher')),e=>e.code==='permission-denied');
  const concurrent=await Promise.allSettled(['A','B'].map(feedback=>h.saveWeeklySupervision(req({...value,...saved,requestId:'native-weekly-edit-'+feedback,feedback}))));assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);assert.equal(concurrent.find(r=>r.status==='rejected').reason.code,'aborted');
 }finally{await app.delete();}
});
test('new school and head membership require a verified Auth email, not client verification fields',async()=>{
 const uid='verification-new-head',unverified=env.authenticatedContext(uid,{email:'head@example.test',email_verified:false}).firestore(),verified=env.authenticatedContext(uid,{email:'head@example.test',email_verified:true}).firestore();
 const school={ownerUid:uid,profile:{schoolName:'Synthetic verification school'}};
 await assertFails(setDoc(doc(unverified,'schools/verification-school'),{...school,emailVerified:true}));
 await assertSucceeds(setDoc(doc(verified,'schools/verification-school'),school));
 await assertFails(setDoc(doc(unverified,'joinCodes/VERIFY-SCHOOL'),{schoolId:'verification-school'}));
 await assertSucceeds(setDoc(doc(verified,'joinCodes/VERIFY-SCHOOL'),{schoolId:'verification-school'}));
 const member={schoolId:'verification-school',role:'headteacher',status:'active'};
 await assertFails(setDoc(doc(unverified,'users/'+uid),{...member,emailVerified:true}));await assertSucceeds(setDoc(doc(verified,'users/'+uid),member));
});

test('promoted pupil photo access follows current class; stale paths cannot grant former teachers access',async()=>{
 const path='schools/s/imageAssets/student__moved-photo',blob='schools/s/student-photos/c1/moved-photo',bytes=new Uint8Array([1,2,3]);
 await env.withSecurityRulesDisabled(async ctx=>{
  const db=ctx.firestore();await setDoc(doc(db,'users/current-photo-teacher'),{schoolId:'s',role:'teacher',status:'active',assignedClassIds:['c2'],assignedSubjectIds:['math']});
  await setDoc(doc(db,'schools/s/students/moved-photo'),{id:'moved-photo',classId:'c2'});
  await setDoc(doc(db,path),{kind:'student',recordId:'moved-photo',classId:'c1',storagePath:blob});
  await uploadBytes(ref(ctx.storage(),blob),bytes);
 });
 const former=env.authenticatedContext('teacher'),current=env.authenticatedContext('current-photo-teacher');
 await assertFails(getDoc(doc(former.firestore(),path)));
 await assertFails(getBytes(ref(former.storage(),blob)));
 await assertFails(uploadBytes(ref(former.storage(),blob),bytes));
 await assertFails(deleteDoc(doc(former.firestore(),path)));
 await assertSucceeds(getDoc(doc(current.firestore(),path)));
 await assertSucceeds(getBytes(ref(current.storage(),blob)));
 for(const uid of ['outsider','disabled']){const ctx=env.authenticatedContext(uid);await assertFails(getDoc(doc(ctx.firestore(),path)));await assertFails(getBytes(ref(ctx.storage(),blob)));}
});

test('two-school record boundary blocks cross-school reads writes and deletes',async()=>{
 const own=env.authenticatedContext('outsider').firestore(),foreign=env.authenticatedContext('head').firestore();
 const records=['students/private-pupil','staff/private-staff','grades/private-grade','attendance/private-day','remarks/private-remark','imageAssets/private-photo','billing/account','billingTransactions/private-payment','feeCharges/private-charge','weeklySupervision/private-check','opItems/private-stock'];
 await env.withSecurityRulesDisabled(async ctx=>{await setDoc(doc(ctx.firestore(),'schools/other'),{ownerUid:'outsider',profile:{schoolName:'Synthetic other school'}});for(const p of records)await setDoc(doc(ctx.firestore(),'schools/other/'+p),{classId:'other-class',kind:'student',recordId:'private-pupil',name:'Other school private fixture'});});
 await assertSucceeds(getDoc(doc(own,'schools/other/students/private-pupil')));
 for(const p of records){const target=doc(foreign,'schools/other/'+p);await assertFails(getDoc(target));await assertFails(setDoc(target,{classId:'c1',name:'tamper'}));await assertFails(deleteDoc(target));}
 await assertFails(getDoc(doc(foreign,'users/outsider')));
});
test('protected callables reject changed school identity and foreign restore snapshots without writes',async()=>{
 const assert=require('node:assert/strict'),admin=require('../functions/node_modules/firebase-admin'),app=admin.initializeApp({projectId:'demo-schoolhub-audit'},'pilot-boundaries'),db=app.firestore(),{HttpsError}=require('node:module').createRequire(require('node:path').resolve('functions/index.js'))('firebase-functions/v2/https'),deps={db,admin,HttpsError,onCall:(_,fn)=>fn};
 const r=data=>({auth:{uid:'head'},data:{expectedUid:'head',expectedSchoolId:'other',...data}});
 try{
  const op=require('../functions/school-operations').register(deps),weekly=require('../functions/weekly-supervision').register(deps),fees=require('../functions/fees').register(deps),safety=require('../functions/safety').register(deps);
  for(const [fn,data] of [[op.getSchoolOperations,{}],[weekly.getWeeklySupervision,{week:'2026-10-05'}],[fees.getSchoolFees,{}],[safety.saveSchoolRecord,{field:'grades',key:'c1__Term 3__2026/2027',base:{},value:{}}]])await assert.rejects(fn(r(data)),e=>e.code==='failed-precondition');
  const before=(await db.doc('schools/s').get()).data(),archives=(await db.collection('schools/s/yearRollovers').get()).size;
  await assert.rejects(safety.applySchoolYearChange({auth:{uid:'head'},data:{mode:'restore',expectedYear:before.profile.currentYear,snapshot:{schoolId:'other',type:'academic-year-rollover',data:{students:[],settings:{schoolName:'Foreign'}}}}}),e=>e.code==='invalid-argument');
  assert.deepEqual((await db.doc('schools/s').get()).data(),before);assert.equal((await db.collection('schools/s/yearRollovers').get()).size,archives);
 }finally{await app.delete();}
});

test('assigned pupils without photo manifests return missing without breaking teacher synchronization',async()=>{
 await env.withSecurityRulesDisabled(ctx=>setDoc(doc(ctx.firestore(),'schools/s/students/no-photo'),{id:'no-photo',classId:'c1'}));
 const teacher=env.authenticatedContext('teacher').firestore(),target='schools/s/imageAssets/student__no-photo';
 const snapshot=await assertSucceeds(getDoc(doc(teacher,target)));require('node:assert/strict').equal(snapshot.exists(),false);
 for(const uid of ['outsider','disabled','current-photo-teacher'])await assertFails(getDoc(doc(env.authenticatedContext(uid).firestore(),target)));
});
