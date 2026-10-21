'use strict';
const {validKey}=require('./push-messaging');
const clean=(v,max=200)=>typeof v==='string'?v.slice(0,max):'';
const docId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
function millis(v){const n=typeof v?.toMillis==='function'?v.toMillis():typeof v==='string'?Date.parse(v):typeof v==='number'?v:0;return Number.isFinite(n)&&n>0?n:0;}
function licence(account,schoolId,mode,now=Date.now()){
 const lifetime=account[mode==='test'?'testLifetimeLicence':'lifetimeLicence'];
 if(lifetime?.active===true&&lifetime.schoolId===schoolId)return {plan:'lifetime',state:'active',expiresAt:''};
 const p=account[mode==='test'?'testSchoolLicence':'schoolLicence'];
 if(!p)return {plan:'pay-as-you-go',state:'none',expiresAt:''};
 if(p.schoolId!==schoolId)return {plan:'three-year',state:'needs-review',expiresAt:''};
 const end=millis(p.expiresAt);
 return {plan:'three-year',state:p.active!==true?'inactive':!end?'needs-review':end>now?'active':'expired',expiresAt:end?new Date(end).toISOString():''};
}
module.exports={millis,licence,register({onCall,HttpsError,db,admin,checkoutTestOnly=true}){
 const fail=(code,message)=>{throw new HttpsError(code,message);};
 async function owner(req){
  if(!req.auth)fail('unauthenticated','Sign in to Owner Administration.');
  const u=await admin.auth().getUser(req.auth.uid);
  if(u.disabled||!u.emailVerified||u.customClaims?.schoolhubOwner!==true)fail('permission-denied','A verified project-owner account is required.');
  return u;
 }
 const secure=fn=>onCall({region:'africa-south1',maxInstances:3},async req=>{await owner(req);const result=await fn(req.data||{});await owner(req);return result;});
 const count=async query=>(await query.count().get()).data().count;
 async function schoolRow(doc){
  const s=doc.data()||{},profile=s.profile||{};
  const [head,billing]=await Promise.all([docId(s.ownerUid)?db.doc('users/'+s.ownerUid).get():Promise.resolve(null),db.doc(`schools/${doc.id}/billing/account`).get()]);
  const h=head?.data()||{},a=billing.data()||{},linked=h.role==='headteacher'&&h.status==='active'&&h.schoolId===doc.id;
  return {id:doc.id,name:clean(profile.schoolName||s.name)||'Unnamed school',contactEmail:clean(profile.email),address:clean(profile.address,500),createdAtMs:millis(s.createdAt),registration:linked?'linked':'needs-review',ownerUid:clean(s.ownerUid,128),headName:linked?clean(h.displayName):'',headEmail:linked?clean(h.email):'',licences:{live:licence(a,doc.id,'live'),test:licence(a,doc.id,'test')},credits:{live:Number.isFinite(a.balance)&&a.balance>=0?a.balance:0,test:Number.isFinite(a.testBalance)&&a.testBalance>=0?a.testBalance:0}};
 }
 return {
  getSchoolHubOwnerOverview:secure(async()=>{
   const users=db.collection('users');
   const [schools,heads,teachers,pending,push]=await Promise.all([count(db.collection('schools')),count(users.where('role','==','headteacher').where('status','==','active')),count(users.where('role','==','teacher').where('status','==','active')),count(users.where('role','==','teacher').where('status','==','pending')),db.doc('configuration/schoolHubPush').get()]);
   const p=push.data()||{};
   return {schoolRecords:schools,activeHeads:heads,activeTeachers:teachers,pendingTeachers:pending,pushEnabled:p.enabled===true&&validKey(p.publicKey)&&!!p.appId&&!!p.messagingSenderId,checkoutTestOnly:checkoutTestOnly===true,asOfMs:Date.now()};
  }),
  listSchoolHubOwnerSchools:secure(async d=>{
   if(d.cursor!=null&&d.cursor!==''&&!docId(d.cursor))fail('invalid-argument','Invalid school page.');
   let query=db.collection('schools').orderBy('__name__').limit(26);if(d.cursor)query=query.startAfter(d.cursor);
   const page=await query.get(),docs=page.docs.slice(0,25),schools=await Promise.all(docs.map(schoolRow));
   return {schools,nextCursor:page.docs.length>25?docs.at(-1).id:'',asOfMs:Date.now()};
  }),
  listSchoolHubOwnerActivity:secure(async d=>{
   const kind=d.kind||'messages';if(!['messages','push'].includes(kind))fail('invalid-argument','Choose messages or push setup activity.');
   if(d.cursor!=null&&d.cursor!==''&&!docId(d.cursor))fail('invalid-argument','Invalid activity page.');
   const collection=kind==='messages'?'messageJobs':'messagingAudit',field=kind==='messages'?'createdAt':'at';
   let query=db.collection(collection).orderBy(field,'desc').orderBy('__name__','desc').limit(26);
   if(d.cursor){const cursor=await db.doc(collection+'/'+d.cursor).get();if(!cursor.exists||!cursor.data()?.[field])fail('invalid-argument','Activity page is no longer available. Refresh the list.');query=query.startAfter(cursor);}
   const page=await query.get(),docs=page.docs.slice(0,25);
   return {kind,items:docs.map(doc=>{const p=doc.data()||{};return kind==='messages'?{id:doc.id,atMs:millis(p.createdAt),title:clean(p.title,160),actorUid:clean(p.actorUid,128),scope:p.owner===true&&!p.schoolId?'all-schools':p.recipientUid?'one-recipient':'one-school',schoolId:clean(p.schoolId,128),state:['queued','sending','complete','cancelled'].includes(p.state)?p.state:'unknown',sent:Number.isSafeInteger(p.sent)&&p.sent>=0?p.sent:0}:{id:doc.id,atMs:millis(p.at),actorUid:clean(p.actorUid,128),action:clean(p.action,80),enabled:p.enabled===true};}),nextCursor:page.docs.length>25?docs.at(-1).id:''};
  })
 };
}};
