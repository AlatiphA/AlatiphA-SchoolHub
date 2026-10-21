'use strict';
const {createHash,ECDH}=require('node:crypto');
const hash=s=>createHash('sha256').update(s).digest('hex');
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
function validKey(v){try{if(typeof v!=='string'||!/^[A-Za-z0-9_-]{87}$/.test(v))return false;ECDH.convertKey(Buffer.from(v,'base64url'),'prime256v1');return true;}catch{return false;}}
module.exports.register=({onCall,onDocumentWritten,HttpsError,db,admin})=>{
 const options={region:'africa-south1',maxInstances:3},stamp=()=>admin.firestore.FieldValue.serverTimestamp();
 const fail=(code,message)=>{throw new HttpsError(code,message);};
 async function messageSchool(schoolId,tx){if(!id(schoolId))return false;const read=r=>tx?tx.get(r):r.get(),[school,state]=await Promise.all([read(db.doc('schools/'+schoolId)),read(db.doc('schoolAdministration/'+schoolId))]);return school.exists&&state.data()?.archived!==true&&!['deleting','deleted'].includes(state.data()?.state);}
 const call=fn=>onCall(options,fn),config=db.doc('configuration/schoolHubPush');
 async function actor(req){
  if(!req.auth)fail('unauthenticated','Sign in first.');
  const a=await admin.auth().getUser(req.auth.uid);
  if(a.disabled||!a.emailVerified)fail('permission-denied','Use a verified, enabled account.');
  const u=(await db.doc('users/'+a.uid).get()).data()||{};
  const owner=a.customClaims?.schoolhubOwner===true;
  let head=false;
  if(u.role==='headteacher'&&u.status==='active'&&id(u.schoolId))head=(await db.doc('schools/'+u.schoolId).get()).data()?.ownerUid===a.uid;
  return {uid:a.uid,owner,head,schoolId:u.schoolId||'',user:u};
 }
 async function member(req){const a=await actor(req);if(!a.owner&&!(a.user.status==='active'&&id(a.schoolId)&&['teacher','headteacher'].includes(a.user.role)))fail('permission-denied','Active school membership required.');return a;}
 async function sender(req){const a=await actor(req);if(!a.owner&&!a.head)fail('permission-denied','Only the project owner or active Head Teacher can send messages.');return a;}
 async function settings(){const p=(await config.get()).data()||{};return {enabled:p.enabled===true&&validKey(p.publicKey)&&id(p.messagingSenderId)&&typeof p.appId==='string',publicKey:validKey(p.publicKey)?p.publicKey:'',appId:String(p.appId||''),messagingSenderId:String(p.messagingSenderId||'')};}
 async function scope(a,schoolId){if(!a.owner&&schoolId!==a.schoolId)fail('permission-denied','Choose your own school.');if(!id(schoolId))fail('invalid-argument','Choose a school.');const s=await db.doc('schools/'+schoolId).get();if(!s.exists)fail('not-found','School not found.');if(!(await messageSchool(schoolId)))fail('failed-precondition','Restore this archived school before sending service messages.');return s.data();}
 const category=n=>['school_message','school_announcement','owner_message'].includes(n.type)?'messages':'activity';
 const prefs=v=>({messages:v?.messages===true,activity:v?.activity===true});
 async function eligible(uid,schoolId){
  try{if(schoolId&&!(await messageSchool(schoolId)))return false;const [u,a]=await Promise.all([db.doc('users/'+uid).get(),admin.auth().getUser(uid)]),p=u.data();return !a.disabled&&a.emailVerified&&(p?.status==='active'&&id(p.schoolId)&&(!schoolId||p.schoolId===schoolId)&&['teacher','headteacher'].includes(p.role)||!schoolId&&a.customClaims?.schoolhubOwner===true);}
  catch(e){if(e.code==='auth/user-not-found')return false;throw e;}
 }
 const api={
 getSchoolHubMessagingAccess:call(async req=>{const a=await actor(req);return {owner:a.owner,head:a.head,schoolId:a.schoolId,canSend:a.owner||a.head};}),
 getSchoolHubPushSettings:call(async req=>{await member(req);return settings();}),
 setSchoolHubPushSettings:call(async req=>{
  const a=await sender(req);if(!a.owner)fail('permission-denied','Only the project owner can configure push.');const d=req.data||{};
  if(typeof d.enabled!=='boolean'||!validKey(d.publicKey)||typeof d.messagingSenderId!=='string'||!/^\d{6,20}$/.test(d.messagingSenderId)||typeof d.appId!=='string'||!new RegExp('^1:'+d.messagingSenderId+':web:[a-f0-9]+$').test(d.appId))fail('invalid-argument','Use this Firebase project’s public Web Push key, sender ID and Web app ID.');
  await config.set({enabled:d.enabled,publicKey:d.publicKey,messagingSenderId:d.messagingSenderId,appId:d.appId,updatedAt:stamp(),updatedBy:a.uid});
  await db.collection('messagingAudit').add({actorUid:a.uid,action:'push.configured',enabled:d.enabled,at:stamp()});return settings();
 }),
 getSchoolHubMessageDirectory:call(async req=>{
  const a=await sender(req),d=req.data||{};
  if(a.owner&&!d.schoolId){const list=await db.collection('schools').orderBy('__name__').limit(101).get();return {schools:(await Promise.all(list.docs.slice(0,100).map(async s=>(await messageSchool(s.id))?{id:s.id,name:String(s.data().profile?.schoolName||s.data().name||s.id)}:null))).filter(Boolean),more:list.docs.length>100};}
  const schoolId=d.schoolId||a.schoolId;await scope(a,schoolId);
  const list=await db.collection('users').where('schoolId','==',schoolId).get();
  return {members:list.docs.filter(s=>s.data().status==='active'&&(a.owner?['teacher','headteacher'].includes(s.data().role):s.data().role==='teacher')).map(s=>({uid:s.id,name:String(s.data().displayName||s.data().email||s.id),role:s.data().role}))};
 }),
 sendSchoolHubMessage:call(async req=>{
  const a=await sender(req),d=req.data||{};
  if(typeof d.title!=='string'||!d.title.trim()||d.title.length>160||typeof d.body!=='string'||!d.body.trim()||d.body.length>1000||!id(d.requestId))fail('invalid-argument','Enter a title (up to 160 characters), message (up to 1,000) and valid request ID.');
  const schoolId=d.schoolId||'';if(!schoolId&&!a.owner)fail('permission-denied','Choose your own school.');if(schoolId)await scope(a,schoolId);
  if(d.recipientUid&&!id(d.recipientUid))fail('invalid-argument','Choose a recipient.');
  if(d.recipientUid){const p=(await db.doc('users/'+d.recipientUid).get()).data();if(!p||p.status!=='active'||p.schoolId!==schoolId||!(a.owner?['teacher','headteacher']:['teacher']).includes(p.role))fail('permission-denied','Recipient is not active in this school.');}
  const payload={title:d.title.trim(),body:d.body.trim(),schoolId,recipientUid:d.recipientUid||'',actorUid:a.uid,owner:a.owner},fingerprint=hash(JSON.stringify(payload)),ref=db.doc('messageJobs/'+hash(a.uid+'|'+d.requestId));
  await db.runTransaction(async tx=>{const [old,rate]=await Promise.all([tx.get(ref),tx.get(db.doc('messageRate/'+a.uid))]);if(old.exists){if(old.data().fingerprint!==fingerprint)fail('already-exists','This request ID was already used for another message.');return;}if(Date.now()-Number(rate.data()?.atMs||0)<10000)fail('resource-exhausted','Wait ten seconds before sending another message.');tx.create(ref,{...payload,fingerprint,state:'queued',cursor:'',sent:0,createdAt:stamp()});tx.set(db.doc('messageRate/'+a.uid),{atMs:Date.now()});});
  return {jobId:ref.id,state:(await ref.get()).data().state};
 }),
 getSchoolHubMessageStatus:call(async req=>{const a=await sender(req),jobId=req.data?.jobId;if(!/^[a-f0-9]{64}$/.test(jobId||''))fail('invalid-argument','Choose a message.');const p=(await db.doc('messageJobs/'+jobId).get()).data();if(!p||p.actorUid!==a.uid)fail('permission-denied','Message unavailable.');return {state:p.state,sent:Number(p.sent)||0};}),
 registerSchoolHubPushDevice:call(async req=>{
  const a=await member(req),d=req.data||{};if(d.ownerUid!==a.uid)fail('permission-denied','Account changed.');if(typeof d.token!=='string'||d.token.length<20||d.token.length>4096||/[\s\x00-\x1f]/.test(d.token))fail('invalid-argument','Invalid push registration.');if(!(await settings()).enabled)fail('failed-precondition','The project owner has not enabled push yet.');
  const key=hash(d.token),ref=db.doc(`users/${a.uid}/pushDevices/${key}`),now=Date.now();
  await db.runTransaction(async tx=>{
   const state=db.doc(`users/${a.uid}/pushState/registration`),tokenOwner=db.doc('pushTokenOwners/'+key),[old,s,prior]=await Promise.all([tx.get(ref),tx.get(state),tx.get(tokenOwner)]),ids=s.data()?.ids||[],records=await Promise.all(ids.map(v=>tx.get(db.doc(`users/${a.uid}/pushDevices/${v}`))));
   const live=ids.filter((v,i)=>v!==d.previousId&&records[i].data()?.enabled===true&&now-records[i].data().lastSeenMs<30*86400000);if(!live.includes(key)&&live.length>=5)fail('resource-exhausted','Disable push on an older browser first (maximum five).');
   if(prior.data()?.uid&&prior.data().uid!==a.uid)tx.delete(db.doc(`users/${prior.data().uid}/pushDevices/${key}`));
   for(const v of ids)if(v!==key&&!live.includes(v))tx.delete(db.doc(`users/${a.uid}/pushDevices/${v}`));
   tx.set(ref,{enabled:true,token:d.token,preferences:prefs(d.preferences),enabledAtMs:old.data()?.enabled===true&&now-old.data().lastSeenMs<30*86400000?old.data().enabledAtMs:now,lastSeenMs:now});tx.set(state,{ids:[...new Set([...live,key])]});tx.set(tokenOwner,{uid:a.uid});
  });return {id:key};
 }),
 unregisterSchoolHubPushDevice:call(async req=>{
  const a=await actor(req),d=req.data||{};if(d.ownerUid!==a.uid||!/^[a-f0-9]{64}$/.test(d.id||''))fail('invalid-argument','Invalid device.');
  await db.runTransaction(async tx=>{const s=db.doc(`users/${a.uid}/pushState/registration`),r=await tx.get(s);tx.delete(db.doc(`users/${a.uid}/pushDevices/${d.id}`));tx.set(s,{ids:(r.data()?.ids||[]).filter(v=>v!==d.id)});});return {ok:true};
 }),
 getSchoolHubPushDiagnostics:call(async req=>{
  const a=await member(req),uid=req.data?.uid||a.uid;if(!id(uid))fail('invalid-argument','Choose a user.');
  if(uid!==a.uid){if(!a.owner&&!a.head)fail('permission-denied','Only your own device status is available.');const p=(await db.doc('users/'+uid).get()).data();if(!a.owner&&(!p||p.schoolId!==a.schoolId||p.role!=='teacher'||p.status!=='active'))fail('permission-denied','Choose an active teacher in your school.');}
  const [devices,last]=await Promise.all([db.collection(`users/${uid}/pushDevices`).limit(5).get(),db.doc(`users/${uid}/pushStatus/latest`).get()]);const p=last.data();return {devices:devices.docs.map((s,i)=>({browser:i+1,enabled:s.data().enabled===true,lastSeenMs:Number(s.data().lastSeenMs)||0})),latest:p?{state:p.state,accepted:Number(p.accepted)||0,failed:Number(p.failed)||0,attemptedAtMs:Number(p.attemptedAtMs)||0}:null};
 })};
 api.deliverSchoolHubMessage=onDocumentWritten({...options,document:'messageJobs/{jobId}',retry:true,timeoutSeconds:540,maxInstances:1},async event=>{
  if(event.data?.before?.exists||!event.data?.after?.exists)return;const ref=db.doc('messageJobs/'+event.params.jobId);let job=(await ref.get()).data();if(job.state==='complete'||job.state==='cancelled')return;
  const began=Date.now(),lease=hash(String(event.id||event.params.jobId)+'|'+String(Math.random()));
  await db.runTransaction(async tx=>{const current=(await tx.get(ref)).data();if(current.state==='complete'||current.state==='cancelled'){job=current;return;}if(current.leaseUntilMs>Date.now())throw Error('Message delivery already running');job=current;tx.update(ref,{lease,leaseUntilMs:Date.now()+540000});});
  if(job.state==='complete'||job.state==='cancelled')return;
  try{do{
   // Recheck the sender on every page. Demotion/removal cancels unsent recipients.
   let a;try{a=await sender({auth:{uid:job.actorUid}});if(job.owner&&!a.owner||!job.owner&&(!a.head||a.schoolId!==job.schoolId))throw Error('Sender permission changed');}catch(e){if(e.code&& !['permission-denied','auth/user-not-found'].includes(e.code))throw e;await ref.update({state:'cancelled'});return;}
   let query=db.collection('users').orderBy('__name__').limit(75);if(job.cursor)query=query.startAfter(job.cursor);const page=job.recipientUid?{docs:[await db.doc('users/'+job.recipientUid).get()]}:await query.get();
   for(const recipient of page.docs){
    const n=db.doc(`users/${recipient.id}/notifications/message_${event.params.jobId}`);
    await db.runTransaction(async tx=>{const [u,old]=await Promise.all([tx.get(db.doc('users/'+recipient.id)),tx.get(n)]),p=u.data();if(old.exists||!p||p.status!=='active'||!id(p.schoolId)||job.schoolId&&p.schoolId!==job.schoolId||!(job.owner?['headteacher','teacher']:['teacher']).includes(p.role))return;if(!(await messageSchool(p.schoolId,tx)))return;
     tx.create(n,{title:job.title,body:job.body,type:job.owner?'owner_message':'school_message',action:'home',schoolId:p.schoolId,actorUid:job.actorUid,actorName:job.owner?'SchoolHub support':'Head Teacher',read:false,createdAt:stamp()});
    });
   }
   // Count confirmed notification documents, including idempotent retries.
   let count=0;for(const r of page.docs)if((await db.doc(`users/${r.id}/notifications/message_${event.params.jobId}`).get()).exists)count++;
   const complete=!!job.recipientUid||page.docs.length<75;job={...job,cursor:page.docs.at(-1)?.id||job.cursor,sent:job.sent+count,state:complete?'complete':'sending'};
   await ref.update({cursor:job.cursor,sent:job.sent,state:job.state,updatedAt:stamp()});if(complete)return;
   if(Date.now()-began>420000)throw Error('Continue message delivery on retry');
  }while(true);}finally{await db.runTransaction(async tx=>{const current=(await tx.get(ref)).data();if(current.lease===lease)tx.update(ref,{leaseUntilMs:0});});}
 });
 api.sendSchoolHubPush=onDocumentWritten({...options,document:'users/{uid}/notifications/{noticeId}',retry:true,timeoutSeconds:120},async event=>{
  if(event.data?.before?.exists||!event.data?.after?.exists)return;const n=event.data.after.data(),uid=event.params.uid,now=Date.now(),created=n.createdAt?.toMillis?.()||now,status=db.doc(`users/${uid}/pushStatus/latest`);let accepted=0,failed=0;
  const finish=state=>status.set({state,accepted,failed,attemptedAtMs:now});
  if(!(await settings()).enabled)return finish('configuration_off');if(now-created>86400000)return finish('notice_expired');if(!(await eligible(uid,n.schoolId)))return finish('account_ineligible');
  const list=await db.collection(`users/${uid}/pushDevices`).where('enabled','==',true).limit(5).get();
  for(const device of list.docs){const d=device.data();if(!d.preferences?.[category(n)]||d.enabledAtMs>created||now-d.lastSeenMs>30*86400000)continue;
   const delivery=db.doc(`users/${uid}/pushDeliveries/`+hash(event.params.noticeId+'|'+device.id));let claimed=false;
   await db.runTransaction(async tx=>{const p=(await tx.get(delivery)).data();if(p?.state==='sent')return;if(p?.leaseUntilMs>now)throw Error('Delivery in progress');tx.set(delivery,{state:'sending',leaseUntilMs:now+120000});claimed=true;});if(!claimed)continue;
   try{
    // Generic lock-screen text; the signed-in app reads the private notice.
    await (typeof admin.messaging==='function'?admin.messaging():require('firebase-admin/messaging').getMessaging()).send({token:d.token,data:{schoolHub:'1',uid,noticeId:event.params.noticeId,title:'SchoolHub notification',body:'Open SchoolHub to read your notification.'},webpush:{headers:{TTL:'86400',Urgency:'normal'}}});accepted++;await delivery.set({state:'sent',sentAt:stamp()});
   }catch(e){failed++;await delivery.set({state:'failed',leaseUntilMs:0});if(['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(e.code))await device.ref.set({enabled:false},{merge:true});else {await finish('failed');throw e;}}
  }
  await finish(accepted?'accepted_by_fcm':failed?'failed':'no_new_matching_devices');
 });
 return api;
};
module.exports.validKey=validKey;
