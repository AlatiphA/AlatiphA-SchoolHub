'use strict';
// Server-side validation shared by callable handlers and regression tests.
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const badKey = k => ['__proto__','prototype','constructor'].includes(k);
function mergeEdit(base, desired, remote, validate, path=[]) {
  if (equal(base, desired)) return remote;
  if (object(desired) && (base === undefined || base === null || object(base))) {
    if (remote != null && !object(remote)) throw new Error('conflict');
    const result = {...(remote || {})};
    for (const key of new Set([...Object.keys(base || {}), ...Object.keys(desired)])) {
      if (badKey(key)) throw new Error('invalid-field');
      const value = mergeEdit(base?.[key], desired[key], remote?.[key], validate, path.concat(key));
      if (value === undefined) delete result[key]; else result[key] = value;
    }
    return result;
  }
  validate(path, desired);
  if (!equal(remote, base) && !equal(remote, desired)) throw new Error('conflict');
  return desired;
}
function reportStaff(record,id) {
  const out={id};
  for(const key of ['name','role','signatureUrl','signatureStoragePath','isActive'])
    if(record[key]!==undefined)out[key]=record[key];
  return out;
}
function archiveParts(snapshot) {
  const bytes=Buffer.from(JSON.stringify(snapshot));
  if(bytes.length>6*1024*1024)throw new Error('Snapshot exceeds the safe atomic size. Export a backup and contact support.');
  const chunks=[];
  for(let i=0;i<bytes.length;i+=180000)chunks.push(bytes.subarray(i,i+180000).toString('base64'));
  return chunks;
}
function rolloverStudent(student, decision, fromYear,toYear,now) {
  if(!decision || student.isActive===false)return student;
  const next={...student,classHistory:{...(student.classHistory||{}),[fromYear]:student.classId},rolloverHistory:[...(student.rolloverHistory||[]),{fromYear,toYear,decision:decision.decision,fromClassId:student.classId,toClassId:decision.destinationClassId||'',at:now}]};
  if(decision.decision==='promote'){next.classId=decision.destinationClassId;next.isActive=true;next.enrollmentStatus='active';}
  else if(decision.decision==='repeat'){next.isActive=true;next.enrollmentStatus='active';}
  else if(decision.decision==='graduate'){next.isActive=false;next.enrollmentStatus='graduated';next.completedYear=fromYear;}
  else if(decision.decision==='leave'){next.isActive=false;next.enrollmentStatus='left';next.leftYear=fromYear;}
  else throw new Error('Invalid rollover decision.');
  return next;
}
function register({onCall,HttpsError,db,admin}) {
 const fail=(code,message)=>{throw new HttpsError(code,message);};
 const callable=fn=>onCall({region:'us-central1',invoker:'public',timeoutSeconds:120,memory:'512MiB'},fn);
 async function member(tx,request,head=false){
  if(!request.auth)fail('unauthenticated','Sign in first.');
  const snap=await tx.get(db.collection('users').doc(request.auth.uid));const u=snap.data();
  if(!u||u.status!=='active'||!u.schoolId||!['headteacher','teacher'].includes(u.role)||(head&&u.role!=='headteacher'))fail('permission-denied','Active school access required.');
  return u;
 }
 const exports={};
 exports.migrateSchoolLegacy=callable(async request=>db.runTransaction(async tx=>{
  const u=await member(tx,request,true), school=db.collection('schools').doc(u.schoolId);
  const current=await tx.get(school), data=current.data()||{};
  if(Number(data.schemaVersion||0)>=4)return {migrated:false};
  const arrays=['students','classes','subjects','staff'], keyed=['grades','attendance','teacherAttendance','schoolCalendar','remarks'];
  const planned=[];
  for(const name of arrays)for(const value of (Array.isArray(data[name])?data[name]:[])){
   if(!value||typeof value.id!=='string'||!value.id||value.id.includes('/'))fail('failed-precondition','Legacy record has an invalid identifier. Contact support.');
   const clean={...value};delete clean.photo;delete clean.signature;
   planned.push([school.collection(name).doc(value.id),clean,school.collection('deletedRecords').doc(name+'__'+value.id)]);
  }
  for(const name of keyed)for(const [key,value] of Object.entries(data[name]||{})){
   const id=encodeURIComponent(key),classId=key.split('__')[0];
   const record=['grades','remarks'].includes(name)?{classId,entries:value}:{...value,...(name==='attendance'?{classId}:{}),...(name.includes('Attendance')||name==='attendance'?{entries:value.entries||value}:{})};
   planned.push([school.collection(name).doc(id),record,school.collection('deletedRecords').doc(name+'__'+id)]);
  }
  if(planned.length>440)fail('resource-exhausted','Legacy school requires a supervised migration. No records were changed.');
  const states=await Promise.all(planned.map(async ([ref,,marker])=>[await tx.get(ref),await tx.get(marker)]));
  planned.forEach(([ref,value],i)=>{if(!states[i][0].exists&&!states[i][1].exists)tx.set(ref,value);});
  const next={...data,schemaVersion:4};arrays.concat(keyed).forEach(name=>delete next[name]);
  tx.set(school,next);return {migrated:true};
 }));
 exports.getSchoolReportStaff=callable(async request=>db.runTransaction(async tx=>{
  const u=await member(tx,request);const snap=await tx.get(db.collection('schools').doc(u.schoolId).collection('staff'));
  return {staff:snap.docs.map(d=>reportStaff(d.data(),d.id))};
 }));
 exports.saveSchoolRecord=callable(async request=>{
  const {field,key,base,value,deletionVersion=null}=request.data||{};
  if(!['grades','attendance','teacherAttendance','remarks'].includes(field)||typeof key!=='string'||!key||key.length>500||!object(value))fail('invalid-argument','Invalid record.');
  const classId=key.split('__')[0];
  return db.runTransaction(async tx=>{
   const u=await member(tx,request);const school=db.collection('schools').doc(u.schoolId);const id=encodeURIComponent(key);
   if(u.role!=='headteacher'&&(field==='teacherAttendance'||!(u.assignedClassIds||[]).includes(classId)))fail('permission-denied','Class access required.');
   const ref=school.collection(field).doc(id);
   if(field!=='teacherAttendance'&&!(await tx.get(school.collection('classes').doc(classId))).exists)fail('failed-precondition','This class no longer exists. Reload the school records.');
   const [existing,tombstone]=await Promise.all([tx.get(ref),tx.get(school.collection('deletedRecords').doc(field+'__'+id))]);
   const currentDeletionVersion=tombstone.exists ? (tombstone.data().version || 'legacy-deletion') : null;
   if(deletionVersion!==currentDeletionVersion)fail('failed-precondition','This record was cleared on another device. Reload before entering new values. Your pending edit remains on this device.');
   const data=existing.data()||{};
   const remote=(field==='grades'||field==='remarks')?(data.entries||{}):Object.fromEntries(Object.entries(data).filter(([k])=>k!=='updatedAt'));
   const validate=(path,v)=>{
    if(field==='grades'){
     // Student/subject deletion removes a container, not a single score.
     // Validate every removed score; mergeEdit still checks the whole subtree
     // against remote changes before accepting the deletion.
     if(v===undefined && (path.length===1 || path.length===2)){
      const previous=path.reduce((node,key)=>node?.[key],base);
      if(!object(previous))fail('invalid-argument','Invalid grade field.');
      if(path.length===2 && u.role!=='headteacher' && !(u.assignedSubjectIds||[]).includes(path[1]))fail('permission-denied','Subject is not assigned.');
      mergeEdit(previous,{},previous,validate,path);
      return;
     }
     if(path.length!==3||!['c','e'].includes(path[2]))fail('invalid-argument','Invalid grade field.');
     if(u.role!=='headteacher'&&!(u.assignedSubjectIds||[]).includes(path[1]))fail('permission-denied','Subject is not assigned.');
     if(v!==undefined&&(typeof v!=='number'||!Number.isFinite(v)||v<0||v>(path[2]==='c'?60:100)))fail('invalid-argument','Grade out of range.');
    }else if(field!=='remarks'&&path[0]==='classId'&&v!==classId)fail('invalid-argument','Class cannot change.');
   };
   let merged;
   try{const clean=x=>Object.fromEntries(Object.entries(x||{}).filter(([k])=>k!=='updatedAt'));merged=mergeEdit(clean(base),clean(value),remote,validate);}catch(e){if(e instanceof HttpsError)throw e;fail(e.message==='conflict'?'aborted':'invalid-argument',e.message==='conflict'?'Another device changed this record. Your local edit is preserved. Review the current cloud record before retrying.':'Invalid field.');}
   const document=(field==='grades'||field==='remarks')?{classId,entries:merged}:merged;
   if(field==='attendance')document.classId=classId;
   if(Buffer.byteLength(JSON.stringify(document))>750000)fail('resource-exhausted','Record too large.');
   tx.set(ref,{...document,updatedAt:admin.firestore.FieldValue.serverTimestamp()});
   return {saved:true};
  });
 });
 exports.applySchoolYearChange=callable(async request=>db.runTransaction(async tx=>{
  const u=await member(tx,request,true);const school=db.collection('schools').doc(u.schoolId);const input=request.data||{};
  if(!['rollover','restore'].includes(input.mode))fail('invalid-argument','Invalid year operation.');
  const names=['students','classes','subjects','grades','attendance','teacherAttendance','schoolCalendar','remarks','staff'];
  const schoolSnap=await tx.get(school);const collections=await Promise.all(names.map(n=>tx.get(school.collection(n))));
  const data=Object.fromEntries(names.map((n,i)=>[n,collections[i].docs.map(d=>({...d.data(),id:d.id}))]));const settings=schoolSnap.data()?.profile||{};
  const stamp=new Date().toISOString();let students,nextSettings,archiveId,snapshot;
  if(input.mode==='rollover'){
   const {fromYear,toYear,decisions}=input;
   if(!/^\d{4}\/\d{4}$/.test(toYear||'')||Number(toYear.slice(5))!==Number(toYear.slice(0,4))+1||fromYear===toYear||!object(decisions))fail('invalid-argument','Invalid academic year or decisions.');
   archiveId='year_'+String(fromYear).replace(/[^a-z0-9]+/gi,'_');
   const archive=await tx.get(school.collection('yearRollovers').doc(archiveId));
   if(archive.exists){if(settings.lastYearRollover?.id===archiveId&&settings.currentYear===toYear)return {completed:true,repeated:true};fail('already-exists','This year already has an archive. Review it before another rollover.');}
   if(settings.currentYear!==fromYear)fail('aborted','The current year changed. Reload and review.');
   const classIds=new Set(data.classes.map(c=>c.id));
   for(const s of data.students.filter(s=>s.isActive!==false)){
    const d=decisions[s.id];if(!d||!['promote','repeat','graduate','leave'].includes(d.decision)||(d.decision==='promote'&&!classIds.has(d.destinationClassId)))fail('failed-precondition','Review every current student and destination.');
   }
   students=data.students.map(s=>rolloverStudent(s,decisions[s.id],fromYear,toYear,stamp));
   nextSettings={...settings,currentYear:toYear,currentTerm:'Term 1',attendanceOutOf:'',nextTermBegins:'',lastYearRollover:{id:archiveId,fromYear,toYear,at:stamp}};
   snapshot={app:'AlatiphA SchoolHub',type:'academic-year-rollover',schoolId:u.schoolId,fromYear,toYear,createdAt:stamp,data:{...data,settings}};
  }else{
   snapshot=input.snapshot;
   if(!snapshot||snapshot.schoolId!==u.schoolId||snapshot.type!=='academic-year-rollover'||!Array.isArray(snapshot.data?.students)||!object(snapshot.data?.settings))fail('invalid-argument','A complete backup from this school is required.');
   if(settings.currentYear!==input.expectedYear)fail('aborted','The current year changed. Reload and review.');
   students=snapshot.data.students;
   const seen=new Set();for(const s of students){if(!s||typeof s.id!=='string'||!s.id||s.id.includes('/')||seen.has(s.id))fail('invalid-argument','Invalid or duplicate student.');seen.add(s.id);}
   nextSettings=snapshot.data.settings;
   const crypto=require('node:crypto');archiveId='restore_'+crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex').slice(0,32);
   const previous=await tx.get(school.collection('yearRollovers').doc(archiveId));
   if(previous.exists)fail('already-exists','This backup has already been restored. Reload to see the current state.');
   snapshot={app:'AlatiphA SchoolHub',type:'pre-emergency-restore',schoolId:u.schoolId,createdAt:stamp,data:{...data,settings}};
  }
  let chunks;try{chunks=archiveParts(snapshot);}catch(e){fail('resource-exhausted',e.message);}
  // Bound the operation before writing; no multi-batch partial application.
  if(students.length*(input.mode==='restore'?2:1)+chunks.length+2>450 || Buffer.byteLength(JSON.stringify({students,nextSettings,chunks}))>8*1024*1024)fail('resource-exhausted','This school exceeds the safe atomic year-change limit. No changes were made. Contact support for a supervised migration.');
  const archive=school.collection('yearRollovers').doc(archiveId);
  tx.create(archive,{type:input.mode,createdAt:stamp,createdBy:request.auth.uid,chunkCount:chunks.length,immutable:true});
  chunks.forEach((chunk,i)=>tx.create(archive.collection('snapshot').doc(String(i).padStart(4,'0')),{index:i,total:chunks.length,encoding:'base64-json',chunk}));
  students.forEach(s=>{const clean={...s};delete clean.photo;if(String(clean.photoUrl||'').startsWith('data:'))delete clean.photoUrl;if(input.mode==='restore')tx.delete(school.collection('deletedRecords').doc('students__'+s.id));tx.set(school.collection('students').doc(s.id),clean);});
  const cleanSettings={...nextSettings};delete cleanSettings.logo;tx.update(school,{profile:cleanSettings,updatedAt:admin.firestore.FieldValue.serverTimestamp()});
  return {completed:true};
 }));
 return exports;
}
module.exports={register,mergeEdit,reportStaff,archiveParts,rolloverStudent};
