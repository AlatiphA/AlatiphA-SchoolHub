'use strict';
const {createHash}=require('node:crypto');
const PAYMENT_PROVIDER='manual',BILLING_MODE='live';
const RECIPIENT=Object.freeze({network:'MTN MoMo',number:'0243443688',name:'Abdul-Latif Ahmed'});
function register({onCall,HttpsError,db,admin,packages,schoolLicenceEnd}){
 const fail=(code,message)=>{throw new HttpsError(code,message);},hash=s=>createHash('sha256').update(s).digest('hex'),call=fn=>onCall({region:'us-central1',invoker:'public'},fn),stamp=()=>admin.firestore.FieldValue.serverTimestamp();
 const validId=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{16,100}$/.test(s);
 async function schoolMember(tx,req,head=false){if(!req.auth)fail('unauthenticated','Sign in first.');const u=(await tx.get(db.collection('users').doc(req.auth.uid))).data();if(!u||u.status!=='active'||!u.schoolId||!['teacher','headteacher'].includes(u.role)||(head&&u.role!=='headteacher'))fail('permission-denied','Active school access required.');if(req.data?.expectedSchoolId!==u.schoolId)fail('failed-precondition','Your school changed. Reopen Billing & Credits.');return u;}
 async function owner(req){if(!req.auth)fail('unauthenticated','Sign in first.');const u=await admin.auth().getUser(req.auth.uid);if(u.disabled||!u.emailVerified||u.customClaims?.schoolhubOwner!==true)fail('permission-denied','Verified SchoolHub owner access required.');}
 const plans=Object.entries(packages).filter(([id])=>id!=='lifetime').map(([id,p])=>({id,...p,currency:'GHS'}));
 const safe=r=>({id:r.id,schoolId:r.schoolId,schoolName:r.schoolName,requesterUid:r.requesterUid,packageId:r.packageId,amountPesewas:r.amountPesewas,credits:r.credits,type:r.type,reference:r.reference,status:r.status,requestedAtMs:r.requestedAtMs,reviewedAtMs:r.reviewedAtMs||null,rejectionReason:r.rejectionReason||'',attendanceTermKey:r.attendanceTermKey||null,term:r.term||'',year:r.year||'',expiresAt:r.expiresAt||null});
 return {
 getSchoolManualBilling:call(async req=>{const u=await db.runTransaction(tx=>schoolMember(tx,req));const school=db.collection('schools').doc(u.schoolId);const [bill,history]=await Promise.all([school.collection('billing').doc('account').get(),school.collection('billingTransactions').orderBy('createdAt','desc').limit(25).get()]);return {provider:PAYMENT_PROVIDER,mode:BILLING_MODE,recipient:RECIPIENT,plans,account:bill.data()||{},requests:u.role==='headteacher'?history.docs.map(d=>d.data()).filter(r=>r.provider==='manual').map(safe):[],legacyPayments:u.role==='headteacher'?history.docs.filter(d=>d.data().provider!=='manual').map(d=>({reference:d.id,status:d.data().status,mode:d.data().mode,amountPesewas:d.data().expectedAmountPesewas||0})):[],canSubmit:u.role==='headteacher'};}),
 submitSchoolManualPayment:call(async req=>{
  const d=req.data||{},requestId=d.requestId,packageId=String(d.packageId||''),pack=packages[packageId],reference=typeof d.reference==='string'?d.reference.trim().toUpperCase():'';
  if(!validId(requestId)||!Object.hasOwn(packages,packageId)||packageId==='lifetime'||!/^[A-Z0-9-]{6,80}$/.test(reference))fail('invalid-argument','Choose a current package and enter the unique MoMo transaction ID from your receipt (6–80 letters, digits or hyphens).');
  return db.runTransaction(async tx=>{
   const u=await schoolMember(tx,req,true),school=db.collection('schools').doc(u.schoolId),id='MP_'+hash(u.schoolId+'|'+requestId),ref=db.collection('manualSchoolPayments').doc(id),lock=db.collection('manualPaymentReferences').doc(hash(reference));
   const [existing,used,schoolSnap,bill]=await Promise.all([tx.get(ref),tx.get(lock),tx.get(school),tx.get(school.collection('billing').doc('account'))]);
   if(!schoolSnap.exists)fail('not-found','School not found.');
   if(existing.exists){const r=existing.data();if(r.reference!==reference||r.packageId!==packageId||r.requesterUid!==req.auth.uid)fail('failed-precondition','This submission ID was already used for different payment details.');return safe(r);}
   if(used.exists)fail('already-exists','This transaction ID is already submitted or approved. Check payment history or contact the owner.');
   const profile=schoolSnap.data().profile||{},account=bill.data()||{};let term='',year='',attendanceTermKey=null;
   if(pack.type==='attendance_term'){term=profile.currentTerm;year=profile.currentYear;if(!['Term 1','Term 2','Term 3'].includes(term)||typeof year!=='string'||!year.trim())fail('failed-precondition','Save and sync the school term and academic year first.');attendanceTermKey=encodeURIComponent(JSON.stringify([year,term]));if(account.attendanceTerms?.[attendanceTermKey]?.active)fail('already-exists','Attendance is already active for this term.');}
   const record={id,schoolId:u.schoolId,schoolName:profile.schoolName||'School',requesterUid:req.auth.uid,provider:'manual',mode:'live',packageId,type:pack.type||'credit_purchase',credits:pack.credits,amountPesewas:pack.amountPesewas,currency:'GHS',reference,status:'pending',requestedAtMs:Date.now(),createdAt:stamp(),attendanceTermKey,term,year};
   tx.set(ref,record);tx.set(school.collection('billingTransactions').doc(id),record);tx.set(lock,{id,schoolId:u.schoolId,status:'pending'});return safe(record);
  });
 }),
 listSchoolManualPayments:call(async req=>{await owner(req);const status=req.data?.status||'pending';if(!['pending','credited','rejected'].includes(status))fail('invalid-argument','Choose a payment status.');const snap=await db.collection('manualSchoolPayments').where('status','==',status).limit(50).get();return {requests:snap.docs.map(d=>safe(d.data())).sort((a,b)=>a.requestedAtMs-b.requestedAtMs),limit:50};}),
 reviewSchoolManualPayment:call(async req=>{
  await owner(req);const d=req.data||{},decision=d.decision,reason=typeof d.reason==='string'?d.reason.trim():'';
  if(typeof d.id!=='string'||!/^MP_[a-f0-9]{64}$/.test(d.id)||!['approve','reject'].includes(decision)||(decision==='reject'&&(!reason||reason.length>300)))fail('invalid-argument','Choose a payment and include a reason when rejecting (maximum 300 characters).');
  return db.runTransaction(async tx=>{
   const ref=db.collection('manualSchoolPayments').doc(d.id),snap=await tx.get(ref);if(!snap.exists)fail('not-found','Payment request not found.');const r=snap.data();
   if(r.status==='credited'&&decision==='approve')return safe(r);if(r.status==='rejected'&&decision==='reject')return safe(r);if(r.status!=='pending')fail('failed-precondition','This request was already reviewed.');
   const school=db.collection('schools').doc(r.schoolId),billRef=school.collection('billing').doc('account'),lockRef=db.collection('manualPaymentReferences').doc(hash(r.reference));
   const [schoolSnap,billSnap,lock]=await Promise.all([tx.get(school),tx.get(billRef),tx.get(lockRef)]);if(!schoolSnap.exists&&decision==='approve')fail('not-found','School no longer exists. Reject this payment and contact the payer.');if(!lock.exists||lock.data().id!==r.id||lock.data().status!=='pending')fail('failed-precondition','The transaction ID is no longer reserved for this request.');
   const pack=packages[r.packageId];if(!pack||r.packageId==='lifetime'||pack.amountPesewas!==r.amountPesewas||pack.credits!==r.credits)fail('failed-precondition','Package details changed. Reject this request with an explanation before resubmission.');
   const next={...r,status:decision==='approve'?'credited':'rejected',reviewedBy:req.auth.uid,reviewedAtMs:Date.now(),rejectionReason:decision==='reject'?reason:''};
   if(decision==='approve'){
    if(d.verifiedPayment!==true||!Number.isSafeInteger(d.receivedAmountPesewas)||d.receivedAmountPesewas!==r.amountPesewas)fail('failed-precondition','Check the recipient, transaction ID and exact amount in your MoMo history before approving.');
    const b=billSnap.data()||{},balance=Number(b.balance||0);if(!Number.isSafeInteger(balance)||balance<0)fail('failed-precondition','School balance needs review.');const update={currency:'GHS',updatedAt:stamp()};
    if(pack.type==='school_licence_3_year'){const old=b.schoolLicence,start=Math.max(Date.now(),old?.active&&old.schoolId===r.schoolId?Date.parse(old.expiresAt)||0:0);next.expiresAt=schoolLicenceEnd(start);update.schoolLicence={active:true,schoolId:r.schoolId,durationYears:3,includesUpdates:true,reference:r.id,startsAt:new Date(start).toISOString(),expiresAt:next.expiresAt,purchasedAt:stamp()};}
    else if(pack.type==='attendance_term'){if(b.attendanceTerms?.[r.attendanceTermKey]?.active)fail('already-exists','This term is already active. Reject this duplicate request or contact the school.');update.attendanceTerms={...(b.attendanceTerms||{}),[r.attendanceTermKey]:{active:true,reference:r.id}};}
    else {if(!Number.isSafeInteger(balance+pack.credits))fail('failed-precondition','Credit balance limit reached.');update.balance=balance+pack.credits;}
    tx.set(billRef,update,{merge:true});tx.set(lockRef,{id:r.id,schoolId:r.schoolId,status:'credited',approvedBy:req.auth.uid,approvedAtMs:Date.now()});
   }else tx.delete(lockRef);
   tx.set(ref,next);if(schoolSnap.exists)tx.set(school.collection('billingTransactions').doc(r.id),next);tx.set(db.collection('manualPaymentAudit').doc(),{paymentId:r.id,schoolId:r.schoolId,decision,reason:next.rejectionReason,actorUid:req.auth.uid,at:stamp()});return safe(next);
  });
 })
 };
}
module.exports={register,PAYMENT_PROVIDER,BILLING_MODE,RECIPIENT};
