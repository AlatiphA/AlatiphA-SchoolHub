'use strict';
const crypto=require('node:crypto');
const norm=s=>String(s||'').trim().toLowerCase();
const nameKey=s=>norm(s).normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
function register({onCall,HttpsError,db}){
 const fail=(code,msg)=>{throw new HttpsError(code,msg);};
 const call=fn=>onCall({region:'us-central1',invoker:'public'},fn);
 async function member(tx,r,head=false){if(!r.auth)fail('unauthenticated','Sign in first.');const u=(await tx.get(db.collection('users').doc(r.auth.uid))).data();if(!u||!u.schoolId||u.status!=='active'||!['teacher','headteacher'].includes(u.role)||(head&&u.role!=='headteacher'))fail('permission-denied','Active school access required.');return u;}
 return {
 getTeacherHomeSummary:call(async r=>db.runTransaction(async tx=>{
  const u=await member(tx,r),assigned=new Set(u.assignedClassIds||[]);
  const users=await tx.get(db.collection('users').where('schoolId','==',u.schoolId));
  return {teachers:users.docs.filter(x=>{const m=x.data();return m.role==='teacher'&&m.status==='active'&&(m.assignedClassIds||[]).some(id=>assigned.has(id));}).length};
 })),
 manageTeacherLifecycle:call(async r=>db.runTransaction(async tx=>{
  const h=await member(tx,r,true),d=r.data||{},id=d.teacherUid;
  if(typeof id!=='string'||!id||id.includes('/')||id===r.auth.uid)fail('invalid-argument','Select a teacher account.');
  const userRef=db.collection('users').doc(id),u=(await tx.get(userRef)).data();
  if(!u||u.schoolId!==h.schoolId||u.role!=='teacher'||!['pending','active','disabled'].includes(u.status))fail('failed-precondition','This teacher membership changed. Reload Manage Teachers.');
  const school=db.collection('schools').doc(h.schoolId),staffSnap=await tx.get(school.collection('staff'));
  const staff=staffSnap.docs.map(x=>({id:x.id,...x.data()})),linked=staff.filter(s=>s.userUid===id),next={...u};
  const remembered=await tx.get(school.collection('teacherLinks').doc(id));
  const matching=staff.filter(s=>s.id===u.staffId||s.userUid===id||s.id===remembered.data()?.staffId|| (norm(u.email)&&norm(s.email)===norm(u.email)));
  let selected=null;
  if(d.action==='save'){
   if(!Array.isArray(d.assignedClassIds)||!d.assignedClassIds.length||!Array.isArray(d.assignedSubjectIds))fail('invalid-argument','Assign at least one class.');
   for(const [field,ids] of [['classes',d.assignedClassIds],['subjects',d.assignedSubjectIds]])for(const value of ids){if(typeof value!=='string'||!value||value.includes('/')||!(await tx.get(school.collection(field).doc(value))).exists)fail('invalid-argument','An assignment no longer exists.');}
   if(d.staffId)selected=staff.find(s=>s.id===d.staffId);
   else if(matching.length===1)selected=matching[0];
   else if(matching.length>1)fail('failed-precondition','Several Staff records match. Select the correct existing Staff record.');
   if(d.staffId&&!selected)fail('not-found','Staff record not found.');
   if(selected&&selected.userUid&&selected.userUid!==id)fail('already-exists','That Staff record belongs to another account. Unlink it first.');
   if(linked.some(s=>!selected||s.id!==selected.id))fail('failed-precondition','This account already has another Staff link. Unlink it first.');
   if(!selected){
    const name=String(d.name||'').trim();if(!name||name.length>200)fail('invalid-argument','Enter the full Staff name.');
    if(staff.some(s=>nameKey(s.name)===nameKey(name))&&!d.confirmSimilarName)fail('failed-precondition','A similar Staff name exists. Review it before confirming a different person.');
    selected={id:crypto.randomUUID(),name,email:u.email||'',role:'Teacher',createdAt:new Date().toISOString()};
   }
   next.staffId=selected.id;next.assignedClassIds=[...new Set(d.assignedClassIds)];next.assignedSubjectIds=[...new Set(d.assignedSubjectIds)];
   // Updating assignments must not silently reactivate a disabled account.
   next.status=u.status==='pending'?'active':u.status;
  }else if(d.action==='disable'){if(u.status!=='active')fail('failed-precondition','Only approved active teachers can be disabled.');next.status='disabled';}
  else if(d.action==='reactivate'){if(u.status!=='disabled'||!(u.assignedClassIds||[]).length)fail('failed-precondition','Review assignments before reactivating.');next.status='active';}
  else if(['unlink','remove','reject'].includes(d.action)){
   if(d.action==='reject'&&u.status!=='pending')fail('failed-precondition','Only pending requests can be rejected.');
   if(d.action==='remove'&&u.status==='pending')fail('failed-precondition','Reject pending requests instead.');
   delete next.staffId;delete next.staffLinkedAt;
   if(d.action!=='unlink'){delete next.schoolId;delete next.role;next.assignedClassIds=[];next.assignedSubjectIds=[];next.status=d.action==='remove'?'removed':'rejected';}
  }else fail('invalid-argument','Unknown teacher action.');
  // All reads have completed; membership and both relationship ends commit together.
  if(selected){tx.set(school.collection('staff').doc(selected.id),{...selected,userUid:id});tx.set(school.collection('teacherLinks').doc(id),{staffId:selected.id});}
  if(['unlink','remove','reject'].includes(d.action)){
   for(const s of linked)tx.set(school.collection('staff').doc(s.id),{...s,userUid:''});
   if(linked.length===1)tx.set(school.collection('teacherLinks').doc(id),{staffId:linked[0].id});
  }
  tx.set(userRef,next);
  tx.set(school.collection('activity').doc(crypto.randomUUID()),{action:d.action,entity:'teacher',entityId:id,uid:r.auth.uid,role:'headteacher',actorName:h.displayName||h.email||'Head Teacher',at:new Date().toISOString(),summary:'Teacher membership '+d.action});
  return {saved:true,staffId:next.staffId||null,status:next.status};
 }))};
}
module.exports={register,nameKey};
