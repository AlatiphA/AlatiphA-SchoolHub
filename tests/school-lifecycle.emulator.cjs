// Run only against disposable local emulators, never a live project.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {initializeTestEnvironment,assertSucceeds,assertFails}=require('@firebase/rules-unit-testing');
const {doc,setDoc,getDoc}=require('firebase/firestore'),{ref,uploadBytes}=require('firebase/storage');
const admin=require('firebase-admin'),{HttpsError}=require('firebase-functions/v2/https');
const {register,guardDatabase}=require('../functions/school-lifecycle');
const projectId='demo-schoolhub-lifecycle';let env,app,db,guard,h;
const req=data=>({auth:{uid:'owner',token:{auth_time:Math.floor(Date.now()/1000)}},data});
before(async()=>{
 assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8085');assert.equal(process.env.FIREBASE_STORAGE_EMULATOR_HOST,'127.0.0.1:9195');
 env=await initializeTestEnvironment({projectId,firestore:{rules:fs.readFileSync('firestore.rules','utf8')},storage:{rules:fs.readFileSync('storage.rules','utf8')}});
 await env.clearFirestore();await env.clearStorage();
 app=admin.initializeApp({projectId,storageBucket:projectId},'lifecycle-integration');db=app.firestore();guard=guardDatabase(db,HttpsError);
 for(const [path,data]of Object.entries({'users/head':{schoolId:'s',role:'headteacher',status:'active'},'users/teacher':{schoolId:'s',role:'teacher',status:'active',assignedClassIds:['c']},'users/other':{schoolId:'other',role:'headteacher',status:'active'},'schools/s':{ownerUid:'head',profile:{schoolName:'Synthetic Test School'}},'schools/other':{ownerUid:'other',profile:{schoolName:'Other Synthetic School'}},'schools/s/students/p':{id:'p',classId:'c'},'schools/s/archive/y/nested/n':{nested:'synthetic'},'schools/other/students/p':{id:'p',classId:'c'},'joinCodes/TEST':{schoolId:'s'},'users/teacher/notifications/test':{schoolId:'s'},'users/orphan/notifications/test':{schoolId:'s'}}))await db.doc(path).set(data);
 h=register({db,admin:{auth:()=>({getUser:async uid=>({uid,emailVerified:true,disabled:false,customClaims:{schoolhubOwner:uid==='owner'}})}),firestore:admin.firestore,storage:()=>app.storage()},HttpsError,onCall:(_,fn)=>fn,onDocumentWritten:(_,fn)=>fn});
});
after(async()=>{if(env)await env.cleanup();if(app)await app.delete();});
test('real rules permit class-scoped uploads within Storage document limits and retain access after archive',async()=>{
 const teacher=env.authenticatedContext('teacher',{email_verified:true});await assertSucceeds(uploadBytes(ref(teacher.storage(),'schools/s/student-photos/c/p'),Buffer.from('synthetic image'),{contentType:'image/png'}));
 await h.setSchoolHubOwnerSchoolArchive(req({schoolId:'s',revision:0,archived:true,confirmSchoolId:'s',requestId:'archive-native'}));
 await assertSucceeds(setDoc(doc(teacher.firestore(),'schools/s/students/p'),{id:'p',classId:'c'}));await assertFails(setDoc(doc(teacher.firestore(),'schoolAdministration/s'),{state:'active'}));
});
test('native deletion locks reject browser and Admin mutations, remove nested data and images, and retain Auth-independent profiles',async()=>{
 const review=await h.reviewSchoolHubOwnerSchoolDeletion(req({schoolId:'s',revision:1}));assert.equal(review.imageVersions,1);
 await h.deleteSchoolHubOwnerSchool(req({schoolId:'s',revision:1,token:review.token,confirmSchoolId:'s',confirmPhrase:'DELETE SCHOOL',backupConfirmed:true}));
 await assertFails(setDoc(doc(env.authenticatedContext('head',{email_verified:true}).firestore(),'schools/s/students/late'),{id:'late',classId:'c'}));
 await assert.rejects(guard.doc('schools/s/grades/late').set({entries:{}}),e=>e.code==='failed-precondition');
 await assert.rejects(guard.runTransaction(async tx=>{await tx.get(guard.doc('schools/s'));tx.set(guard.doc('schools/s/attendance/late'),{entries:{}});}),e=>e.code==='failed-precondition');
 const step=()=>h.processSchoolHubSchoolDeletion({params:{schoolId:'s'},data:{after:{exists:true,data:()=>({state:'queued'})}}});await step();
 await assertFails(uploadBytes(ref(env.authenticatedContext('teacher').storage(),'schools/s/student-photos/c/new'),Buffer.from('late image')));
 for(let i=0;i<30&&(await db.doc('schoolDeletionJobs/s').get()).data().state!=='complete';i++)await step();
 assert.equal((await db.doc('schoolDeletionJobs/s').get()).data().state,'complete');assert.equal((await db.doc('schools/s').get()).exists,false);assert.equal((await db.doc('schools/s/archive/y/nested/n').get()).exists,false);assert.equal((await db.doc('users/orphan/notifications/test').get()).exists,false);assert.equal((await db.doc('users/teacher').get()).data().schoolId,'');assert.equal((await db.doc('schools/other/students/p').get()).exists,true);
 await assert.rejects(guard.doc('schools/s').set({ownerUid:'head'}),e=>e.code==='failed-precondition');
});
