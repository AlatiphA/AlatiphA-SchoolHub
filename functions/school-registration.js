'use strict';
const crypto=require('node:crypto');
function register({onCall,HttpsError,db,admin}){
 const fail=(code,message)=>{throw new HttpsError(code,message);};
 const text=(value,label,max,required=false)=>{if(value==null&&!required)return '';if(typeof value!=='string'||value.trim().length>max||(required&&!value.trim()))fail('invalid-argument',`Enter a valid ${label}.`);return value.trim();};
 return {registerSchoolSafe:onCall({region:'us-central1',invoker:'public'},async r=>{
  if(!r.auth)fail('unauthenticated','Sign in first.');
  if(r.auth.token?.email_verified!==true)fail('failed-precondition','Verify your login email before registering a school.');
  const authUser=await admin.auth().getUser(r.auth.uid);
  if(authUser.disabled||!authUser.emailVerified)fail('permission-denied','Verified active login required.');
  const d=r.data||{},name=text(d.schoolName,'school name',200,true),address=text(d.address,'address',500),email=text(d.email,'school email',200);
  const requestId=text(d.requestId,'registration request',80,true);
  if(!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId))fail('invalid-argument','Invalid registration request.');
  const fingerprint=JSON.stringify([name,address,email]),userRef=db.collection('users').doc(r.auth.uid),receiptRef=userRef.collection('schoolRegistrations').doc(requestId);
  const newSchoolId=crypto.randomUUID(),newCode=crypto.randomBytes(6).toString('hex').slice(0,3).toUpperCase()+'-'+crypto.randomBytes(6).toString('hex').slice(0,3).toUpperCase();
  return db.runTransaction(async tx=>{
   const userSnap=await tx.get(userRef),receipt=await tx.get(receiptRef),u=userSnap.data()||{};
   if(receipt.exists){const saved=receipt.data();if(saved.fingerprint!==fingerprint)fail('failed-precondition','This registration request was used with different details.');if(u.status!=='active'||u.role!=='headteacher'||u.schoolId!==saved.result.schoolId)fail('permission-denied','This registration is no longer your active school.');return saved.result;}
   // A current, pending or disabled member cannot promote themselves or leave
   // their school by registering another one. Only an absent/detached profile qualifies.
   if(userSnap.exists&&(u.schoolId||!['removed','rejected'].includes(u.status)))fail('permission-denied','Leave the existing school through its Head Teacher before registering a school.');
   const owned=await tx.get(db.collection('schools').where('ownerUid','==',r.auth.uid).limit(25));
   const candidates=owned.docs.filter(doc=>{const s=doc.data();return s.profile?.schoolName===name&&String(s.profile?.address||'')===address&&String(s.profile?.email||'')===email;});
   if(candidates.length>1)fail('failed-precondition','More than one unfinished school matches. Ask the project owner to review them before retrying.');
   // Recover the exact owner/name/details of the old partial registration,
   // rather than creating another orphan. No other owner's school is queried.
   const existing=candidates[0],schoolId=existing?existing.id:newSchoolId,schoolRef=db.collection('schools').doc(schoolId),old=existing?.data();
   if(old&&(!old.joinCode||old.subscription?.plan!=='free'||old.subscription?.status!=='inactive'))fail('failed-precondition','The existing school requires owner review before recovery.');
   const joinCode=old?old.joinCode:newCode,joinRef=db.collection('joinCodes').doc(joinCode),joinSnap=await tx.get(joinRef);
   if(joinSnap.exists&&joinSnap.data().schoolId!==schoolId)fail('already-exists','Join-code collision; retry registration.');
   const stamp=admin.firestore.FieldValue.serverTimestamp();
   const userData={schoolId,role:'headteacher',status:'active',assignedClassIds:[],assignedSubjectIds:[],email:authUser.email||'',displayName:authUser.displayName||name,createdAt:u.createdAt||stamp};
   const {createdAt,...profile}=userData;
   const result={schoolId,joinCode,userData:profile,recoveredPartial:!!existing};
   if(!existing)tx.create(schoolRef,{profile:{schoolName:name,address,email},ownerUid:r.auth.uid,subscription:{plan:'free',status:'inactive'},joinCode,createdAt:stamp});
   tx.set(userRef,userData,{merge:true});
   if(!joinSnap.exists)tx.create(joinRef,{schoolId,createdAt:stamp});
   tx.create(receiptRef,{fingerprint,result,createdAt:stamp});
   return result;
  });
 })};
}
module.exports={register};
