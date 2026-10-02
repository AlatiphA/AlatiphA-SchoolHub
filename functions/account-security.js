'use strict';
const crypto=require('node:crypto');
const normalize=value=>String(value||'').trim().toLowerCase();
const emailLockId=value=>crypto.createHash('sha256').update(normalize(value)).digest('hex');
function register({onCall,HttpsError,db,admin}){
 const fail=(code,message)=>{throw new HttpsError(code,message);};
 const callable=fn=>onCall({region:'us-central1',invoker:'public'},fn);
 async function identity(request,recent=false){
  if(!request.auth)fail('unauthenticated','Sign in before managing your account.');
  if(recent){const age=Date.now()/1000-Number(request.auth.token?.auth_time||0);if(!Number.isFinite(age)||age<0||age>300)fail('failed-precondition','Confirm your current password again before changing your login email.');}
  const user=await admin.auth().getUser(request.auth.uid),email=normalize(user.email);
  if(user.disabled||!email||normalize(request.auth.token?.email)!==email)fail('failed-precondition','Your sign-in details changed. Sign in again and retry.');
  return {user,email,uid:request.auth.uid};
 }
 async function membership(tx,uid){
  const ref=db.collection('users').doc(uid),snap=await tx.get(ref),member=snap.data();
  if(!member||!member.schoolId||member.status!=='active'||!['teacher','headteacher'].includes(member.role))fail('permission-denied','An active school account is required.');
  return {ref,member,school:db.collection('schools').doc(member.schoolId)};
 }
 async function available(tx,school,schoolId,email,uid){
  const ref=school.collection('identityEmails').doc(emailLockId(email)),snap=await tx.get(ref);
  if(snap.exists&&snap.data().uid&&snap.data().uid!==uid)fail('already-exists','This email is reserved for another SchoolHub account. Use a different address or ask your Head Teacher to check the accounts.');
  const members=await tx.get(db.collection('users').where('schoolId','==',schoolId));
  if(members.docs.some(doc=>doc.id!==uid&&['teacher','headteacher'].includes(doc.data().role)&&['pending','active','disabled'].includes(doc.data().status)&&normalize(doc.data().email)===email))fail('already-exists','Another account in this school already uses that email.');
  return ref;
 }
 return {
  prepareLoginEmailChange:callable(async request=>{
   const auth=await identity(request,true),newEmail=normalize(request.data?.newEmail);
   if(!auth.user.providerData?.some(provider=>provider.providerId==='password'))fail('failed-precondition','Manage Google-only login credentials in your Google account.');
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)||newEmail.length>254)fail('invalid-argument','Enter a valid new login email.');
   if(newEmail===auth.email)fail('invalid-argument','Enter an email different from your current login email.');
   // Check Firebase Auth as well as school membership; never create another UID.
   try{const existing=await admin.auth().getUserByEmail(newEmail);if(existing.uid!==auth.uid)fail('already-exists','This email already belongs to another sign-in account.');}catch(error){if(error.code!=='auth/user-not-found')throw error;}
   return db.runTransaction(async tx=>{
    const {ref,member,school}=await membership(tx,auth.uid);
    if(normalize(member.email)!==auth.email)fail('failed-precondition','Refresh your verified login email in Account Security first.');
    const target=await available(tx,school,member.schoolId,newEmail,auth.uid);
    const previous=await available(tx,school,member.schoolId,auth.email,auth.uid);
    const reservations=await tx.get(school.collection('identityEmails').where('uid','==',auth.uid));
    const waiting=reservations.docs.filter(doc=>doc.data().status==='email-change-reserved');
    if(waiting.length>=3&&!waiting.some(doc=>normalize(doc.data().email)===newEmail))fail('resource-exhausted','Three email changes are already awaiting verification. Verify one of those addresses before requesting another, or contact school support.');
    const now=admin.firestore.FieldValue.serverTimestamp();
    // Reservations remain owned by this UID: verification/recovery links may be
    // opened later. Releasing one prematurely could let another membership take it.
    tx.set(target,{uid:auth.uid,email:newEmail,status:'email-change-reserved',updatedAt:now});
    tx.set(previous,{uid:auth.uid,email:auth.email,status:member.status,updatedAt:now});
    tx.update(ref,{pendingLoginEmail:newEmail});
    return {newEmail,schoolId:member.schoolId};
   });
  }),
  synchronizeLoginEmail:callable(async request=>{
   const auth=await identity(request);
   return db.runTransaction(async tx=>{
    const {ref,member,school}=await membership(tx,auth.uid),oldEmail=normalize(member.email);
    const target=await available(tx,school,member.schoolId,auth.email,auth.uid);
    const oldRef=oldEmail&&oldEmail!==auth.email?await available(tx,school,member.schoolId,oldEmail,auth.uid):null;
    if(oldEmail&&oldEmail!==auth.email&&!auth.user.emailVerified)fail('failed-precondition','Verify your new login email before using it in SchoolHub.');
    const now=admin.firestore.FieldValue.serverTimestamp();
    tx.set(target,{uid:auth.uid,email:auth.email,status:member.status,updatedAt:now});
    if(oldRef)tx.set(oldRef,{uid:auth.uid,email:oldEmail,status:'email-recovery-reserved',updatedAt:now});
    const updates={email:auth.email};
    const completed=normalize(member.pendingLoginEmail)===auth.email;
    if(completed)updates.pendingLoginEmail=admin.firestore.FieldValue.delete();
    tx.update(ref,updates);
    return {email:auth.email,schoolId:member.schoolId,pendingEmail:completed?'':member.pendingLoginEmail||''};
   });
  })
 };
}
module.exports={register,normalize,emailLockId};
