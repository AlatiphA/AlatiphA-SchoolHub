'use strict';
const {createHash,randomUUID}=require('node:crypto');
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const digest=v=>createHash('sha256').update(v).digest('hex');
const unavailable=s=>['deleting','deleted'].includes(s?.state);
const name=s=>String(s?.profile?.schoolName||s?.name||'Unnamed school').slice(0,200);

// All ordinary server writes pass through this guard. Buffered transaction writes
// allow the deletion lock to be read before any SDK write is queued, atomically.
function guardDatabase(raw,HttpsError){
 const originals=new WeakMap(),wrapped=new WeakMap();
 const unwrap=r=>originals.get(r)||r;
 const schoolIds=(ref,data)=>{const p=String(unwrap(ref)?.path||'').split('/'),ids=[];if(p[0]==='schools'&&id(p[1]))ids.push(p[1]);if(id(data?.schoolId))ids.push(data.schoolId);return ids;};
 async function check(tx,ids){for(const school of new Set(ids))if(unavailable((await tx.get(raw.doc('schoolAdministration/'+school))).data()))throw new HttpsError('failed-precondition','This school is being permanently deleted or has been deleted.');}
 async function transaction(fn,options){return raw.runTransaction(async tx=>{
  const writes=[],scope=[];
  const proxy=new Proxy(tx,{get(t,k){if(['set','create','update','delete'].includes(k))return (ref,...args)=>{writes.push([k,unwrap(ref),args]);scope.push(...schoolIds(ref,args[0]));return proxy;};if(k==='get')return r=>t.get(unwrap(r));if(k==='getAll')return (...refs)=>t.getAll(...refs.map(unwrap));const v=t[k];return typeof v==='function'?v.bind(t):v;}});
  const result=await fn(proxy);await check(tx,scope);for(const [method,ref,args]of writes)tx[method](ref,...args);return result;
 },options);}
 function wrap(ref){if(!ref||typeof ref!=='object')return ref;if(wrapped.has(ref))return wrapped.get(ref);
  const proxy=new Proxy(ref,{get(t,k){if(['doc','collection','where','orderBy','limit','startAfter','select'].includes(k)&&typeof t[k]==='function')return (...args)=>wrap(t[k](...args));
   if(['set','create','update','delete'].includes(k)&&typeof t[k]==='function')return (...args)=>transaction(tx=>tx[k](t,...args));
   if(k==='add')return async data=>{const doc=t.doc();await transaction(tx=>tx.create(doc,data));return wrap(doc);};
   const v=t[k];return typeof v==='function'?v.bind(t):v;}});originals.set(proxy,ref);wrapped.set(ref,proxy);return proxy;
 }
 return new Proxy(raw,{get(t,k){if(k==='runTransaction')return transaction;if(k==='doc'||k==='collection')return (...args)=>wrap(t[k](...args));if(k==='batch'||k==='bulkWriter')return ()=>{throw Error('Use guarded transactions for school writes.');};const v=t[k];return typeof v==='function'?v.bind(t):v;}});
}

function register({onCall,onDocumentWritten,HttpsError,db,admin}){
 const options={region:'africa-south1',maxInstances:3},fail=(code,message)=>{throw new HttpsError(code,message);};
 async function owner(req,recent=false){if(!req.auth)fail('unauthenticated','Sign in with your owner account.');const u=await admin.auth().getUser(req.auth.uid);if(u.disabled||!u.emailVerified||u.customClaims?.schoolhubOwner!==true)fail('permission-denied','Verified project-owner access required.');if(recent&&(!Number.isFinite(req.auth.token?.auth_time)||Date.now()/1000-req.auth.token.auth_time>600||req.auth.token.auth_time>Date.now()/1000+60))fail('failed-precondition','Sign out and sign in again, then review the deletion within ten minutes.');return u;}
 const call=fn=>onCall(options,fn),meta=id=>db.doc('schoolAdministration/'+id),audit=id=>db.doc('schoolAdministrationAudit/'+id);
 const valid=d=>{if(!id(d.schoolId)||!Number.isSafeInteger(d.revision)||d.revision<0)fail('invalid-argument','Choose a school and refresh its status.');};
 async function live(d){valid(d);const [school,state]=await Promise.all([db.doc('schools/'+d.schoolId).get(),meta(d.schoolId).get()]);if(!school.exists)fail('not-found','School no longer exists.');const s=state.data()||{};if((s.revision||0)!==d.revision)fail('aborted','School status changed. Refresh and review again.');if(unavailable(s))fail('failed-precondition','Deletion has already started.');return {school:school.data(),state:s};}
 const api={
  setSchoolHubOwnerSchoolArchive:call(async req=>{
   const u=await owner(req),d=req.data||{};valid(d);if(typeof d.archived!=='boolean'||!id(d.requestId)||d.confirmSchoolId!==d.schoolId)fail('invalid-argument','Type the exact school ID to confirm.');
   const key=digest(u.uid+'|'+d.requestId),fingerprint=JSON.stringify([d.schoolId,d.archived,d.revision]);
   return db.runTransaction(async tx=>{const [school,snap,prior]=await Promise.all([tx.get(db.doc('schools/'+d.schoolId)),tx.get(meta(d.schoolId)),tx.get(audit(key))]);if(prior.exists){if(prior.data().fingerprint!==fingerprint)fail('already-exists','Request already used.');return prior.data().result;}
    if(!school.exists)fail('not-found','School no longer exists.');const s=snap.data()||{};if(unavailable(s))fail('failed-precondition','Deletion has started; restore is unavailable.');if((s.revision||0)!==d.revision)fail('aborted','School status changed. Refresh and review again.');await owner(req);
    const result={schoolId:d.schoolId,archived:d.archived,revision:d.revision+1};tx.set(meta(d.schoolId),{...s,...result,state:d.archived?'archived':'active',updatedAtMs:Date.now(),updatedBy:u.uid});tx.create(audit(key),{action:d.archived?'school.archived':'school.restored',schoolId:d.schoolId,schoolName:name(school.data()),actorUid:u.uid,at:admin.firestore.FieldValue.serverTimestamp(),fingerprint,result});return result;
   });
  }),
  reviewSchoolHubOwnerSchoolDeletion:call(async req=>{
   const u=await owner(req),d=req.data||{},s=await live(d);if(s.state.archived!==true)fail('failed-precondition','Archive the school before reviewing permanent deletion.');
   const school=db.doc('schools/'+d.schoolId),collections=await school.listCollections(),counts=[];
   for(const col of collections)counts.push({collection:col.id,count:(await col.count().get()).data().count});
   const [members,codes,files]=await Promise.all([db.collection('users').where('schoolId','==',d.schoolId).count().get(),db.collection('joinCodes').where('schoolId','==',d.schoolId).count().get(),admin.storage().bucket().getFiles({prefix:'schools/'+d.schoolId+'/',versions:true,autoPaginate:false,maxResults:1000})]);
   await owner(req);const token=randomUUID(),summary={schoolId:d.schoolId,schoolName:name(s.school),revision:d.revision,collections:counts,members:members.data().count,joinCodes:codes.data().count,imageVersions:files[0].length,moreImages:!!files[1]?.pageToken};
   await db.doc('schoolDeletionReviews/'+token).set({ownerUid:u.uid,schoolId:d.schoolId,revision:d.revision,expiresAtMs:Date.now()+600000,summary});return {...summary,token};
  }),
  deleteSchoolHubOwnerSchool:call(async req=>{
   const u=await owner(req,true),d=req.data||{};valid(d);if(!id(d.token)||d.confirmSchoolId!==d.schoolId||d.confirmPhrase!=='DELETE SCHOOL'||d.backupConfirmed!==true)fail('invalid-argument','Confirm the school ID, DELETE SCHOOL and your backup.');
   return db.runTransaction(async tx=>{const job=db.doc('schoolDeletionJobs/'+d.schoolId),[review,school,state,old]=await Promise.all([tx.get(db.doc('schoolDeletionReviews/'+d.token)),tx.get(db.doc('schools/'+d.schoolId)),tx.get(meta(d.schoolId)),tx.get(job)]),r=review.data(),s=state.data()||{};
    if(!r||r.ownerUid!==u.uid||r.schoolId!==d.schoolId||r.revision!==d.revision)fail('permission-denied','Review this school with your current owner account.');
    if(old.exists&&old.data().reviewToken===d.token)return {schoolId:d.schoolId,state:old.data().state};
    if(r.expiresAtMs<Date.now())fail('failed-precondition','Deletion review expired. Review the school again.');if(!school.exists||name(school.data())!==r.summary.schoolName||s.archived!==true||unavailable(s)||(s.revision||0)!==d.revision)fail('aborted','School changed. Refresh and review again.');await owner(req,true);
    tx.set(meta(d.schoolId),{...s,state:'deleting',revision:d.revision+1,updatedAtMs:Date.now(),updatedBy:u.uid});tx.create(job,{schoolId:d.schoolId,schoolName:r.summary.schoolName,actorUid:u.uid,reviewToken:d.token,state:'queued',phase:'members',cursor:'',createdAtMs:Date.now(),leaseUntilMs:0});tx.create(audit(digest('delete|'+d.token)),{action:'school.deletion-started',schoolId:d.schoolId,schoolName:r.summary.schoolName,actorUid:u.uid,at:admin.firestore.FieldValue.serverTimestamp()});return {schoolId:d.schoolId,state:'queued'};
   });
  }),
  getSchoolHubOwnerSchoolDeletionStatus:call(async req=>{await owner(req);if(!id(req.data?.schoolId))fail('invalid-argument','Choose a school.');const s=(await db.doc('schoolDeletionJobs/'+req.data.schoolId).get()).data();await owner(req);return s?{state:s.state,phase:s.phase,canResume:s.state!=='complete'&&Number(s.leaseUntilMs||0)<=Date.now(),updatedAtMs:s.updatedAtMs||s.createdAtMs}:null;}),
  resumeSchoolHubOwnerSchoolDeletion:call(async req=>{
   await owner(req,true);const schoolId=req.data?.schoolId;if(!id(schoolId)||req.data.confirmSchoolId!==schoolId)fail('invalid-argument','Confirm the deletion job school ID.');
   return db.runTransaction(async tx=>{const ref=db.doc('schoolDeletionJobs/'+schoolId),[job,state]=await Promise.all([tx.get(ref),tx.get(meta(schoolId))]),j=job.data();if(!j)fail('not-found','No confirmed deletion exists for this school.');if(j.state==='complete')return {state:'complete'};if(state.data()?.state!=='deleting')fail('failed-precondition','The deletion lock is missing.');if(j.leaseUntilMs>Date.now())return {state:'running'};await owner(req,true);tx.update(ref,{state:'queued',retryNonce:randomUUID(),leaseUntilMs:0,updatedAtMs:Date.now()});return {state:'queued'};});
  })
 };
 // A durable queue advances one bounded page or one school subcollection at a
 // time. Errors retry; the tombstone outlives the root record to block old edits.
 api.processSchoolHubSchoolDeletion=onDocumentWritten({...options,document:'schoolDeletionJobs/{schoolId}',retry:true,timeoutSeconds:540,maxInstances:1},async event=>{
  if(!event.data?.after?.exists||event.data.after.data().state!=='queued')return;const schoolId=event.params.schoolId;if(!id(schoolId))throw Error('Invalid deletion school');const ref=db.doc('schoolDeletionJobs/'+schoolId),lease=randomUUID();let j;
  await db.runTransaction(async tx=>{j=(await tx.get(ref)).data();if(j?.state==='complete')return;if(j?.leaseUntilMs>Date.now())throw Error('Deletion already running');if((await tx.get(meta(schoolId))).data()?.state!=='deleting')throw Error('School deletion lock missing');tx.update(ref,{state:'running',lease,leaseUntilMs:Date.now()+600000});});if(j.state==='complete')return;
  const next=async (phase,cursor='')=>ref.update({state:'queued',phase,cursor,leaseUntilMs:0,updatedAtMs:Date.now(),lastError:''});
  try{
   if(j.phase==='members'){
    const page=await db.collection('users').where('schoolId','==',schoolId).limit(50).get();
    for(const member of page.docs)await db.runTransaction(async tx=>{const r=db.doc('users/'+member.id),s=await tx.get(r);if(s.data()?.schoolId===schoolId)tx.update(r,{schoolId:'',status:'removed',staffId:'',assignedClassIds:[],assignedSubjectIds:[]});});await next(page.docs.length?'members':'joinCodes');
   }else if(['joinCodes','messageJobs'].includes(j.phase)){
    const page=await db.collection(j.phase).where('schoolId','==',schoolId).limit(50).get();for(const d of page.docs)await db.recursiveDelete(db.doc(j.phase+'/'+d.id));await next(page.docs.length?j.phase:j.phase==='joinCodes'?'messageJobs':'user-data');
   }else if(j.phase==='user-data'){
    const all=await db.collection('users').listDocuments(),page={docs:all.filter(r=>!j.cursor||r.id>j.cursor).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).slice(0,25)};
    for(const user of page.docs)for(const [col,field]of [['notifications','schoolId'],['schoolRegistrations','result.schoolId']]){let docs;do{docs=await db.collection(`users/${user.id}/${col}`).where(field,'==',schoolId).limit(50).get();for(const d of docs.docs)await db.recursiveDelete(db.doc(`users/${user.id}/${col}/${d.id}`));}while(docs.docs.length===50);}
    await next(page.docs.length===25?'user-data':'images',page.docs.length===25?page.docs.at(-1).id:'');
   }else if(j.phase==='images'){
    const [files]=await admin.storage().bucket().getFiles({prefix:'schools/'+schoolId+'/',versions:true,autoPaginate:false,maxResults:25});for(const f of files)await f.delete({ignoreNotFound:true});await next(files.length?'images':'records');
   }else if(j.phase==='records'){
    const cols=await db.doc('schools/'+schoolId).listCollections();if(cols.length){await db.recursiveDelete(cols[0]);await next('records');}else await next('verify');
   }else if(j.phase==='verify'){
    const school=db.doc('schools/'+schoolId),cols=await school.listCollections(),[files]=await admin.storage().bucket().getFiles({prefix:'schools/'+schoolId+'/',versions:true,autoPaginate:false,maxResults:1});if(cols.length){await next('records');return;}if(files.length){await next('images');return;}
    await db.runTransaction(async tx=>{const [s,current]=await Promise.all([tx.get(meta(schoolId)),tx.get(ref)]);if(s.data()?.state!=='deleting'||current.data()?.lease!==lease)throw Error('Deletion ownership changed');tx.delete(school);tx.set(meta(schoolId),{archived:true,state:'deleted',revision:s.data().revision+1,updatedAtMs:Date.now(),updatedBy:j.actorUid});tx.update(ref,{state:'complete',phase:'complete',leaseUntilMs:0,updatedAtMs:Date.now()});tx.set(audit(digest('complete|'+j.reviewToken)),{action:'school.deleted',schoolId,schoolName:j.schoolName,actorUid:j.actorUid,at:admin.firestore.FieldValue.serverTimestamp()});});
   }else throw Error('Unknown deletion phase');
  }catch(error){await db.runTransaction(async tx=>{const s=await tx.get(ref);if(s.data()?.lease===lease&&s.data()?.state!=='complete')tx.update(ref,{state:'queued',leaseUntilMs:0,updatedAtMs:Date.now(),lastError:'Cleanup interrupted; retry pending.'});});throw error;}
 });
 return api;
}
module.exports={guardDatabase,register,unavailable};
