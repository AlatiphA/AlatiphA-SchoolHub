'use strict';
const crypto=require('node:crypto');
const key=(...parts)=>crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
function register({onCall,HttpsError,db}){
 const fail=(code,message)=>{throw new HttpsError(code,message);};
 const call=fn=>onCall({region:'us-central1',invoker:'public',timeoutSeconds:120},fn);
 async function schoolFor(tx,r){
  if(!r.auth)fail('unauthenticated','Sign in first.');
  const u=(await tx.get(db.collection('users').doc(r.auth.uid))).data();
  if(!u||u.status!=='active'||u.role!=='headteacher'||!u.schoolId)fail('permission-denied','Only the active Head Teacher can manage fees.');
  return db.collection('schools').doc(u.schoolId);
 }
 const str=(s,label)=>{if(typeof s!=='string'||!s.trim()||s.length>200)fail('invalid-argument',label+' is required (maximum 200 characters).');return s.trim();};
 const money=(n,signed=false)=>{if(!Number.isSafeInteger(n)||Math.abs(n)>100000000||(!signed&&n<0))fail('invalid-argument','Enter a valid amount with at most two decimal places.');return n;};
 return {
 getReportFeeBalances:call(async r=>db.runTransaction(async tx=>{
  if(!r.auth)fail('unauthenticated','Sign in first.');
  const u=(await tx.get(db.collection('users').doc(r.auth.uid))).data(),d=r.data||{};
  const classId=str(d.classId,'Class'),term=str(d.term,'Term'),year=str(d.year,'Academic year');
  if(!u||u.status!=='active'||!u.schoolId||!['headteacher','teacher'].includes(u.role)||(u.role==='teacher'&&!(u.assignedClassIds||[]).includes(classId)))fail('permission-denied','Class access required.');
  const school=db.collection('schools').doc(u.schoolId);
  const pupils=(await tx.get(school.collection('students'))).docs.filter(x=>x.data().classId===classId);
  const ids=new Set(pupils.map(x=>x.id)),balances={};
  const accounts=(await tx.get(school.collection('feeAccounts'))).docs;
  for(const doc of accounts){const a=doc.data();if(ids.has(a.studentId)&&(a.year+'__'+a.term)<=(year+'__'+term))balances[a.studentId]=(balances[a.studentId]||0)+a.base+a.adjustment-a.paid;}
  return {balances};
 })),
 getSchoolFees:call(async r=>db.runTransaction(async tx=>{
  const school=await schoolFor(tx,r);
  const [a,p,e]=await Promise.all(['feeAccounts','feePayments','feeEvents'].map(c=>tx.get(school.collection(c))));
  return {accounts:a.docs.map(d=>({id:d.id,...d.data()})),payments:p.docs.map(d=>({id:d.id,...d.data()})),events:e.docs.map(d=>({id:d.id,...d.data()}))};
 })),
 updateSchoolFees:call(async r=>db.runTransaction(async tx=>{
  const school=await schoolFor(tx,r),d=r.data||{},action=d.action;
  const requestId=str(d.requestId,'Request identifier');if(!/^[a-zA-Z0-9-]{16,80}$/.test(requestId))fail('invalid-argument','Invalid request identifier.');
  const eventRef=school.collection('feeEvents').doc(requestId),old=await tx.get(eventRef),fingerprint=key(d);
  if(old.exists){if(old.data().fingerprint!==fingerprint)fail('already-exists','This request was already used. Refresh before continuing.');return old.data().result;}
  const period=a=>String(a.year)+'__'+String(a.term);
  const stamp=new Date().toISOString(),actor=r.auth.uid;let result={saved:true},details={};
  if(action==='classFee'){
   const term=str(d.term,'Term'),year=str(d.year,'Academic year'),classId=str(d.classId,'Class'),amount=money(d.amount);
   if(classId.includes('/'))fail('invalid-argument','Invalid class.');
   const cls=await tx.get(school.collection('classes').doc(classId));if(!cls.exists)fail('not-found','Class not found.');
   const pupils=(await tx.get(school.collection('students'))).docs.filter(x=>x.data().classId===classId&&x.data().isActive!==false);
   if(!pupils.length||pupils.length>400)fail('failed-precondition','Select a class with 1–400 active pupils.');
   const refs=pupils.map(p=>school.collection('feeAccounts').doc(key(term,year,p.id)));
   const existing=await Promise.all(refs.map(ref=>tx.get(ref)));
   existing.forEach((snap,i)=>{
    // A class fee creates each term charge once. Later individual corrections are audited adjustments.
    if(!snap.exists)tx.set(refs[i],{studentId:pupils[i].id,studentName:pupils[i].data().name||'',classId,className:cls.data().name||'',term,year,base:amount,adjustment:0,paid:0,revision:0,createdAt:stamp});
   });
   result={saved:true,created:existing.filter(x=>!x.exists).length,skipped:existing.filter(x=>x.exists).length};details={classId,term,year,amount};
  }else if(['reviseClass','cancelClass'].includes(action)){
   const term=str(d.term,'Term'),year=str(d.year,'Academic year'),classId=str(d.classId,'Class'),reason=str(d.reason,'Reason');
   const accounts=(await tx.get(school.collection('feeAccounts'))).docs.filter(x=>x.data().classId===classId&&x.data().term===term&&x.data().year===year);
   if(!accounts.length||accounts.length>400)fail('failed-precondition','No matching fees, or more than 400 accounts.');
   if(!d.revisions||Object.keys(d.revisions).length!==accounts.length||accounts.some(x=>d.revisions[x.id]!==x.data().revision))fail('aborted','These class balances changed. Refresh and review before editing.');
   const amount=action==='cancelClass'?0:money(d.amount);
   for(const x of accounts){const a=x.data(),total=action==='cancelClass'?0:amount+a.adjustment;if(total<a.paid)fail('failed-precondition','The new charge for '+a.studentName+' would be below payments received. Void incorrect payments or adjust that pupil first.');}
   accounts.forEach(x=>{const a=x.data();tx.set(school.collection('feeAccounts').doc(x.id),{...a,base:amount,adjustment:action==='cancelClass'?0:a.adjustment,cancelled:action==='cancelClass',revision:a.revision+1});});
   details={accountIds:accounts.map(x=>x.id),classId,term,year,amount,reason};result={saved:true,updated:accounts.length};
  }else if(['adjust','edit','cancel','payment','void'].includes(action)){
   const id=str(d.accountId,'Pupil account');if(!/^[a-f0-9]{64}$/.test(id))fail('invalid-argument','Invalid pupil account.');
   const ref=school.collection('feeAccounts').doc(id),snap=await tx.get(ref);if(!snap.exists)fail('not-found','Pupil fee account not found.');
   const account=snap.data();let next={...account,revision:account.revision+1};
   if(action==='edit'||action==='cancel'){
    if(d.revision!==account.revision)fail('aborted','This fee changed. Refresh and review before editing.');
    const amount=action==='cancel'?0:money(d.amount),reason=str(d.reason,'Reason');
    if(amount<account.paid)fail('failed-precondition','Void the payments first before reducing the fee below the amount already paid.');
    next.base=amount;next.adjustment=0;next.cancelled=action==='cancel';details={accountId:id,amount,previousCharge:account.base+account.adjustment,reason};
   }else if(action==='adjust'){
    if(d.revision!==account.revision)fail('aborted','This balance changed. Refresh and review it before adjusting.');
    const amount=money(d.amount,true),reason=str(d.reason,'Adjustment reason');if(!amount||account.base+account.adjustment+amount<account.paid)fail('failed-precondition','The charge cannot be reduced below payments already received. Void an incorrect payment first.');
    next.adjustment+=amount;details={accountId:id,amount,reason};
   }else if(action==='payment'){
    const siblings=(await tx.get(school.collection('feeAccounts'))).docs.filter(x=>x.data().studentId===account.studentId&&period(x.data())<=period(account)).sort((a,b)=>period(a.data()).localeCompare(period(b.data())));
    const due=siblings.reduce((sum,x)=>sum+x.data().base+x.data().adjustment-x.data().paid,0);
    const amount=money(d.amount);if(!amount||amount>due)fail('failed-precondition','Payment must be greater than zero and no more than the current balance.');
    if(!['Cash','Mobile Money','Bank Transfer'].includes(d.method))fail('invalid-argument','Select a payment method.');
    const payer=str(d.payer,'Payer name');const reference=typeof d.reference==='string'?d.reference.trim():'';if(reference.length>200)fail('invalid-argument','Payment reference is too long.');
    const metaRef=school.collection('feeMeta').doc('receipts'),meta=await tx.get(metaRef),schoolData=(await tx.get(school)).data()||{};
    const number=(meta.data()?.number||0)+1,receipt='FEE-'+String(number).padStart(6,'0');
    let remaining=amount;const allocations=[];
    for(const doc of siblings){const a=doc.data(),part=Math.min(remaining,a.base+a.adjustment-a.paid);if(part>0){allocations.push({accountId:doc.id,amount:part});remaining-=part;}}
    const payment={allocations,accountId:id,receipt,amount,method:d.method,payer,reference,studentName:account.studentName,className:account.className,term:account.term,year:account.year,schoolName:schoolData.profile?.schoolName||'School',receivedAt:stamp,receivedBy:actor,balanceAfter:due-amount,voided:false};
    tx.set(metaRef,{number});tx.set(school.collection('feePayments').doc(requestId),payment);for(const allocation of allocations){if(allocation.accountId===id)next.paid+=allocation.amount;else{const older=siblings.find(x=>x.id===allocation.accountId).data();tx.set(school.collection('feeAccounts').doc(allocation.accountId),{...older,paid:older.paid+allocation.amount,revision:older.revision+1});}}result={saved:true,payment:{id:requestId,...payment}};details={accountId:id,amount,receipt};
   }else{
    const paymentId=str(d.paymentId,'Receipt'),reason=str(d.reason,'Void reason');if(!/^[a-zA-Z0-9-]{16,80}$/.test(paymentId))fail('invalid-argument','Invalid receipt.');
    const paymentRef=school.collection('feePayments').doc(paymentId),payment=(await tx.get(paymentRef)).data();
    if(!payment||payment.accountId!==id||payment.voided)fail('failed-precondition','Receipt is missing, already voided or belongs to another pupil.');
    const allocations=payment.allocations||[{accountId:id,amount:payment.amount}];
    const allocationRecords=await Promise.all(allocations.map(a=>tx.get(school.collection('feeAccounts').doc(a.accountId))));
    allocations.forEach((a,i)=>{if(a.accountId===id)next.paid-=a.amount;else{const old=allocationRecords[i].data();if(!old)fail('failed-precondition','Original fee record is missing.');tx.set(school.collection('feeAccounts').doc(a.accountId),{...old,paid:old.paid-a.amount,revision:old.revision+1});}});tx.update(paymentRef,{voided:true,voidReason:reason,voidedAt:stamp,voidedBy:actor});details={accountId:id,receipt:payment.receipt,reason,amount:payment.amount};
   }
   tx.set(ref,next);
  }else fail('invalid-argument','Unknown fee operation.');
  tx.set(eventRef,{action,...details,at:stamp,actor,fingerprint,result});return result;
 }))};
}
module.exports={register,key};
