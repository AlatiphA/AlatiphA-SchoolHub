'use strict';
const {createHash}=require('node:crypto');
const valid=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
function register({onCall,onDocumentWritten,HttpsError,db,admin}){
 const fail=(c,m)=>{throw new HttpsError(c,m);},stamp=()=>admin.firestore.FieldValue.serverTimestamp(),call=f=>onCall({region:'africa-south1',maxInstances:3,timeoutSeconds:120},f);
 async function owner(r){if(!r.auth)fail('unauthenticated','Sign in first.');const a=await admin.auth().getUser(r.auth.uid);if(a.disabled||!a.emailVerified||a.customClaims?.schoolhubOwner!==true)fail('permission-denied','Verified owner access required.');return r.auth.uid;}
 function input(d,actions){if(!valid(d.schoolId)||!valid(d.requestId)||d.requestId.length<16||d.confirmSchoolId!==d.schoolId||!actions.includes(d.action)||!Number.isSafeInteger(d.revision)||d.revision<0||typeof d.reason!=='string'||!d.reason.trim()||d.reason.trim().length>300)fail('invalid-argument','Choose an action, enter a reason (up to 300 characters), and confirm the exact School ID.');}
 const ref=p=>db.doc(p),audit=(actor,d)=>ref('schoolAdministrationAudit/'+createHash('sha256').update(actor+'|'+d.requestId).digest('hex'));
 function fingerprint(d){return JSON.stringify([d.schoolId,d.uid||'',d.action,d.revision,d.reason.trim()]);}
 async function school(tx,d){const s=await tx.get(ref('schools/'+d.schoolId)),m=await tx.get(ref('schoolAdministration/'+d.schoolId));if(!s.exists||['deleting','deleted'].includes(m.data()?.state))fail('failed-precondition','School is unavailable or deletion has started.');return {s,m};}
 async function projectSchool(schoolId){
  let cursor='';
  for(;;){let q=db.collection('users').where('schoolId','==',schoolId).orderBy('__name__').limit(100);if(cursor)q=q.startAfter(cursor);const page=await q.get();if(!page.docs.length)return;
   await db.runTransaction(async tx=>{const meta=await tx.get(ref('schoolAdministration/'+schoolId)),members=await Promise.all(page.docs.map(d=>tx.get(ref('users/'+d.id))));
    const status=['deleting','deleted'].includes(meta.data()?.state)?'disabled':['suspended','disabled'].includes(meta.data()?.accessStatus)?meta.data().accessStatus:'active';
    members.forEach((snap,i)=>{if(snap.data()?.schoolId===schoolId)tx.set(ref('users/'+page.docs[i].id),{ownerSchoolAccess:{schoolId,status}},{merge:true});});
   });cursor=page.docs.at(-1).id;
  }
 }
 const api={
  setSchoolHubOwnerAccess:call(async r=>{
   const actor=await owner(r),d=r.data||{};input(d,['suspend','disable','reactivate','free','paid']);const log=audit(actor,d),fp=fingerprint(d);
   const result=await db.runTransaction(async tx=>{
    const previous=await tx.get(log);if(previous.exists){if(previous.data().fingerprint!==fp)fail('already-exists','Request ID already used.');return previous.data().result;}
    const {s,m}=await school(tx,d),state=m.data()||{};
    if((state.revision||0)!==d.revision)fail('aborted','School changed. Refresh before reviewing again.');
    if(s.data().ownerUid===actor&&['suspend','disable'].includes(d.action))fail('failed-precondition','You cannot restrict your own school.');
    const revision=d.revision+1,result={ok:true,revision},change={revision,updatedBy:actor,updatedAtMs:Date.now()};
    if(['free','paid'].includes(d.action)){change.complimentary=d.action==='free';tx.set(ref('schools/'+d.schoolId+'/billing/account'),{complimentaryAccess:{active:d.action==='free',schoolId:d.schoolId,grantedBy:actor,reason:d.reason.trim(),updatedAt:stamp()}},{merge:true});}
    else change.accessStatus={suspend:'suspended',disable:'disabled',reactivate:'active'}[d.action];
    tx.set(ref('schoolAdministration/'+d.schoolId),change,{merge:true});
    tx.set(log,{action:'school.'+d.action,schoolId:d.schoolId,schoolName:s.data().profile?.schoolName||'',actorUid:actor,reason:d.reason.trim(),fingerprint:fp,result,at:stamp()});return result;
   });
   if(['suspend','disable','reactivate'].includes(d.action))await projectSchool(d.schoolId);
   return result;
  }),
  listSchoolHubOwnerUsers:call(async r=>{
   await owner(r);const d=r.data||{};if(!valid(d.schoolId)||(d.cursor&&!valid(d.cursor)))fail('invalid-argument','Choose a school.');
   if(!(await ref('schools/'+d.schoolId).get()).exists)fail('not-found','School not found.');
   let q=db.collection('users').where('schoolId','==',d.schoolId).orderBy('__name__').limit(26);if(d.cursor)q=q.startAfter(d.cursor);const p=await q.get();
   const users=await Promise.all(p.docs.slice(0,25).map(async doc=>{const u=doc.data();let a;try{a=await admin.auth().getUser(doc.id);}catch(e){if(e.code!=='auth/user-not-found')throw e;}
    return {uid:doc.id,name:String(u.displayName||'').slice(0,200),email:String(a?.email||u.email||'').slice(0,254),role:u.role||'',membershipStatus:u.status||'',accessStatus:u.ownerAccess?.status||'active',revision:u.ownerAccess?.revision||0,authPending:u.ownerAccess?.authPending===true,pending:u.ownerAccess?.authPending?{requestId:u.ownerAccess.requestId,action:u.ownerAccess.action,reason:u.ownerAccess.reason,revision:(u.ownerAccess.revision||1)-1}:null,authDisabled:a?.disabled===true,missingAuth:!a,protected:a?.customClaims?.schoolhubOwner===true};}));
   return {users,nextCursor:p.docs.length>25?p.docs[24].id:''};
  }),
  manageSchoolHubOwnerUser:call(async r=>{
   const actor=await owner(r),d=r.data||{};input(d,['suspend','disable','reactivate']);if(!valid(d.uid)||d.confirmUid!==d.uid)fail('invalid-argument','Confirm the exact user ID.');if(d.uid===actor)fail('failed-precondition','You cannot restrict your own account.');
   const a=await admin.auth().getUser(d.uid);if(a.customClaims?.schoolhubOwner===true)fail('permission-denied','Owner accounts are protected.');
   const log=audit(actor,d),fp=fingerprint(d),uRef=ref('users/'+d.uid);
   const result=await db.runTransaction(async tx=>{
    const old=await tx.get(log);if(old.exists){if(old.data().fingerprint!==fp)fail('already-exists','Request ID already used.');return old.data().result;}
    const {s}=await school(tx,d),snap=await tx.get(uRef),u=snap.data();if(!u||u.schoolId!==d.schoolId)fail('failed-precondition','User no longer belongs to this school. Refresh.');
    if((u.ownerAccess?.revision||0)!==d.revision||u.ownerAccess?.authPending)fail('aborted','Account changed or a previous sign-in change needs retry.');
    if(d.action==='reactivate'&&a.disabled&&u.ownerAccess?.status!=='disabled')fail('failed-precondition','Sign-in was disabled outside these owner controls. Review it with the service administrator.');
    const result={ok:true,uid:d.uid,schoolId:d.schoolId,action:d.action,revision:d.revision+1,authPending:true};
    tx.set(uRef,{ownerAccess:{status:d.action==='reactivate'?'suspended':d.action==='disable'?'disabled':'suspended',revision:result.revision,authPending:true,requestId:d.requestId,action:d.action,reason:d.reason.trim(),updatedBy:actor}},{merge:true});
    tx.set(log,{action:'user.'+d.action,schoolId:d.schoolId,schoolName:s.data().profile?.schoolName||'',targetUid:d.uid,actorUid:actor,reason:d.reason.trim(),fingerprint:fp,result,at:stamp()});return result;
   });
   if(!result.authPending)return result;
   if((await uRef.get()).data()?.schoolId!==d.schoolId)fail('failed-precondition','User changed schools during the sign-in update. Contact the service administrator.');
   // The Firestore deny remains effective if Auth fails. Retrying the SAME request completes it.
   await owner(r);if((await admin.auth().getUser(d.uid)).customClaims?.schoolhubOwner===true)fail('permission-denied','Owner accounts are protected.');
   if(d.action==='disable')await admin.auth().updateUser(d.uid,{disabled:true});
   if(d.action==='reactivate')await admin.auth().updateUser(d.uid,{disabled:false});
   if(d.action!=='reactivate')await admin.auth().revokeRefreshTokens(d.uid);
   return db.runTransaction(async tx=>{const snap=await tx.get(uRef),prior=await tx.get(log);if(snap.data()?.ownerAccess?.requestId!==d.requestId)fail('aborted','Account changed. Refresh.');const final={...result,authPending:false};tx.set(uRef,{ownerAccess:{...snap.data().ownerAccess,status:{suspend:'suspended',disable:'disabled',reactivate:'active'}[d.action],authPending:false}},{merge:true});tx.set(log,{...prior.data(),result:final});return final;});
  })
 };
 if(onDocumentWritten)api.projectSchoolHubOwnerAccess=onDocumentWritten({document:'schoolAdministration/{schoolId}',region:'africa-south1',retry:true,timeoutSeconds:120},async e=>{if(e.data?.before.data()?.accessStatus===e.data?.after.data()?.accessStatus&&e.data?.before.data()?.state===e.data?.after.data()?.state)return;await projectSchool(e.params.schoolId);});
 return api;
}
module.exports={register};
