'use strict';
const crypto=require('node:crypto');
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
const canonical=v=>JSON.stringify(v,function(k,x){return x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x;});
const subjectKey=value=>String(value??'').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase();
function subjectChoices(subjects){
 const order=s=>Number.isFinite(Number(s.order))?Number(s.order):0;
 const sorted=subjects.slice().sort((a,b)=>order(a)-order(b)||String(a.name||'').localeCompare(String(b.name||''))||String(a.id).localeCompare(String(b.id))),groups=new Map();
 for(const s of sorted){const key=subjectKey(s.name);if(!key)continue;if(!groups.has(key))groups.set(key,{id:s.id,name:String(s.name).normalize('NFKC').trim().replace(/\s+/g,' '),order:order(s),aliases:[]});groups.get(key).aliases.push({id:s.id,name:s.name});}
 return [...groups.values()];
}
const isHeadStaff=(staff,headIds)=>headIds.has(staff.id)||String(staff.role||'').toLowerCase().replace(/[\s_-]/g,'')==='headteacher';
function register({onCall,HttpsError,db}){
 const fail=(code,msg)=>{throw new HttpsError(code,msg);};
 const call=fn=>onCall({region:'us-central1',invoker:'public',timeoutSeconds:60},fn);
 const text=(v,label,max=500,optional=false)=>{if(optional&&(v==null||v===''))return '';if(typeof v!=='string'||!v.trim()||v.trim().length>max)fail('invalid-argument','Enter '+label+' (maximum '+max+' characters).');return v.trim();};
 const date=(v,optional=false)=>{if(optional&&!v)return '';text(v,'date',10);const d=new Date(v+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==v)fail('invalid-argument','Enter a valid date.');return v;};
 const week=v=>{date(v);if(new Date(v+'T00:00:00Z').getUTCDay()!==1)fail('invalid-argument','Week beginning must be a Monday.');return v;};
 const count=v=>{if(!Number.isSafeInteger(v)||v<0||v>1000)fail('invalid-argument','Counts must be whole numbers from 0 to 1000.');return v;};
 const choice=(v,allowed)=>{if(!allowed.includes(v))fail('invalid-argument','Select a valid check status.');return v;};
 const recordId=v=>{text(v,'record identifier',120);if(!/^[a-zA-Z0-9_-]{1,120}$/.test(v))fail('invalid-argument','Invalid record identifier.');return v;};
 async function access(tx,r){
  if(!r.auth)fail('unauthenticated','Sign in first.');
  const u=(await tx.get(db.collection('users').doc(r.auth.uid))).data();
  if(!u||u.status!=='active'||!u.schoolId||!['teacher','headteacher'].includes(u.role))fail('permission-denied','An active school membership is required.');
  if(r.data?.expectedUid!==r.auth.uid||r.data?.expectedSchoolId!==u.schoolId)fail('failed-precondition','Your account or school changed. Reopen this page.');
  return {u,school:db.collection('schools').doc(u.schoolId)};
 }
 const rows=s=>s.docs.map(d=>({...d.data(),id:d.id}));
 const getWeeklySupervision=call(r=>db.runTransaction(async tx=>{
  const {u,school}=await access(tx,r),w=week(r.data.week),head=u.role==='headteacher';
  if(!head&&!u.staffId)return {role:'teacher',records:[],staff:[],classes:[],subjects:[],unlinked:true};
  const query=head?school.collection('weeklySupervision').where('week','==',w):school.collection('weeklySupervision').where('staffId','==',u.staffId);
  const records=rows(await tx.get(query)).filter(x=>x.week===w);
  if(!head)return {role:'teacher',records,staff:[],classes:[],subjects:[]};
  const [staff,classes,subjects,schoolSnap]=await Promise.all([...['staff','classes','subjects'].map(n=>tx.get(school.collection(n))),tx.get(school)]);
  const headIds=new Set([u.staffId,schoolSnap.data()?.profile?.headTeacherId].filter(Boolean)),allStaff=rows(staff).map(x=>({id:x.id,name:x.name,role:x.role||'Teacher'}));
  return {role:'headteacher',records,staff:allStaff.filter(x=>!isHeadStaff(x,headIds)),excludedStaff:allStaff.filter(x=>isHeadStaff(x,headIds)),classes:rows(classes).map(x=>({id:x.id,name:x.name})),subjects:subjectChoices(rows(subjects))};
 }));
 const saveWeeklySupervision=call(r=>db.runTransaction(async tx=>{
  const {u,school}=await access(tx,r);if(u.role!=='headteacher')fail('permission-denied','Only the Head Teacher records supervision checks.');
  const d=r.data,requestId=recordId(d.requestId);if(Buffer.byteLength(canonical(d))>18000)fail('invalid-argument','This record is too large.');
  const receipt=school.collection('supervisionReceipts').doc(digest(r.auth.uid+'|'+requestId)),prior=await tx.get(receipt),fingerprint=digest(canonical(d));
  if(prior.exists){if(prior.data().fingerprint!==fingerprint)fail('failed-precondition','This retry differs from the original save.');return prior.data().result;}
  const w=week(d.week),staffId=recordId(d.staffId),classId=recordId(d.classId),year=text(d.year,'academic year',40),term=text(d.term,'term',30),checkedOn=date(d.checkedOn);
  if(checkedOn<w)fail('invalid-argument','Check date cannot be before the selected week.');
  const [staff,cls,schoolSnap]=await Promise.all([tx.get(school.collection('staff').doc(staffId)),tx.get(school.collection('classes').doc(classId)),tx.get(school)]);
  if(!staff.exists||!cls.exists)fail('not-found','The selected staff member or class no longer exists.');
  const id=digest(canonical([year,term,w,staffId,classId])),ref=school.collection('weeklySupervision').doc(id),old=await tx.get(ref);
  if(!old.exists&&isHeadStaff({...staff.data(),id:staffId},new Set([u.staffId,schoolSnap.data()?.profile?.headTeacherId].filter(Boolean))))fail('invalid-argument','Choose a classroom staff member. The Head Teacher is the reviewer, not a teacher awaiting supervision.');
  if(d.id&&d.id!==id)fail('invalid-argument','Teacher, class, year, term and week cannot be changed when editing. Create another record.');
  if(old.exists){if(!Number.isSafeInteger(d.revision)||d.revision!==old.data().revision)fail('aborted','This weekly record already exists or changed on another device. Refresh and edit that record.');}else if(d.id||d.revision!=null)fail('not-found','The record being edited no longer exists.');
  if(!Array.isArray(d.assessments)||d.assessments.length>30)fail('invalid-argument','Use at most 30 subject rows.');
  const seen=new Set(),seenNames=new Set(),assessments=[];
  for(const a of d.assessments){const subjectId=recordId(a.subjectId);if(seen.has(subjectId))fail('invalid-argument','Use one row per subject.');seen.add(subjectId);const subject=await tx.get(school.collection('subjects').doc(subjectId));if(!subject.exists)fail('not-found','A selected subject no longer exists.');const nameKey=subjectKey(subject.data().name);if(!nameKey)fail('invalid-argument','This subject needs a name in the Subjects tab.');if(seenNames.has(nameKey))fail('invalid-argument','Use one row per subject name. Remove the repeated subject row; existing subject records are preserved.');seenNames.add(nameKey);const booksChecked=count(a.booksChecked),booksMarked=count(a.booksMarked);if(booksMarked>booksChecked)fail('invalid-argument','Marked books cannot exceed books checked.');assessments.push({subjectId,subjectName:subject.data().name||subjectId,exercises:count(a.exercises),assessments:count(a.assessments),booksChecked,booksMarked,note:text(a.note,'subject note',500,true)});}
  const lessonStatus=choice(d.lessonStatus,['not_checked','submitted','not_submitted','needs_revision']),lessonReviewed=!!d.lessonReviewed;
  if(typeof d.lessonReviewed!=='boolean'||typeof d.registerReviewed!=='boolean')fail('invalid-argument','Choose whether each register or plan was reviewed.');
  if(lessonReviewed&&lessonStatus==='not_checked')fail('invalid-argument','Choose the lesson-plan outcome after reviewing it.');
  const registerStatus=choice(d.registerStatus,['not_checked','up_to_date','incomplete','not_available']);if(d.registerReviewed&&registerStatus==='not_checked')fail('invalid-argument','Choose the attendance-register outcome after reviewing it.');
  const now=new Date().toISOString(),record={id,year,term,week:w,staffId,staffName:staff.data().name||staffId,classId,className:cls.data().name||classId,checkedOn,lessonStatus,lessonReviewed,lessonNote:text(d.lessonNote,'lesson-plan note',1000,true),registerReviewed:d.registerReviewed,registerStatus,registerNote:text(d.registerNote,'attendance-register note',1000,true),assessments,feedback:text(d.feedback,'feedback',2000,true),followUpOn:date(d.followUpOn,true),followUpStatus:choice(d.followUpStatus,['none','open','completed']),revision:old.exists?old.data().revision+1:0,createdAt:old.exists?old.data().createdAt:now,createdBy:old.exists?old.data().createdBy:r.auth.uid,updatedAt:now,updatedBy:r.auth.uid};
  if(record.followUpOn&&record.followUpOn<checkedOn)fail('invalid-argument','Follow-up date cannot be before the check date.');
  const result={id,revision:record.revision};
  tx.set(ref,record);tx.set(school.collection('supervisionHistory').doc(digest(r.auth.uid+'|'+requestId)),{recordId:id,actor:r.auth.uid,at:now,before:old.exists?old.data():null,after:record});tx.set(receipt,{fingerprint,result,createdAt:now});return result;
 }));
 return {getWeeklySupervision,saveWeeklySupervision};
}
module.exports={register,subjectChoices,isHeadStaff};
