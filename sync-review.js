/* Review same-field conflicts without disabling the server's revision checks. */
(function(root){
 'use strict';
 const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
 const clone=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
 function equal(a,b){if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;const k=Object.keys(a);return k.length===Object.keys(b).length&&k.every(key=>Object.hasOwn(b,key)&&equal(a[key],b[key]));}
 function merge(base,local,cloud,choices,changes,path=[]){
  if(equal(base,local))return clone(cloud);
  if(object(local)&&(base==null||object(base))&&(cloud==null||object(cloud))){
   const result={...(clone(cloud)||{})};
   for(const key of new Set([...Object.keys(base||{}),...Object.keys(local)])){
    if(['__proto__','prototype','constructor'].includes(key))throw Error('Invalid record key.');
    const value=merge(base?.[key],local[key],cloud?.[key],choices,changes,path.concat(key));
    if(value===undefined)delete result[key];else result[key]=value;
   }
   return result;
  }
  const conflict=!equal(cloud,base)&&!equal(cloud,local),id=JSON.stringify(path);
  if(changes)changes.push({id,path,base:clone(base),local:clone(local),cloud:clone(cloud),conflict});
  if(conflict&&choices){if(!['local','cloud'].includes(choices[id]))throw Error('Choose a value for every conflicting change.');return clone(choices[id]==='local'?local:cloud);}
  return clone(local);
 }
 function plan(base,local,cloud){const changes=[];merge(base,local,cloud,null,changes);return {base:clone(base),local:clone(local),cloud:clone(cloud),changes};}
 function resolve(review,choices){return merge(review.base,review.local,review.cloud,choices||{},null);}
 const supported=['settings','grades','attendance','teacherAttendance','remarks'];
 let opened=null,reading=0;
 const element=id=>document.getElementById(id);
 const status=text=>{const el=element('syncReviewStatus');if(el)el.textContent=text;};
 function context(){return {token:sessionGeneration,uid:currentUid,school:currentSchoolId};}
 function active(c){return !!c.uid&&!!c.school&&isCurrentSession(c.token,c.uid,c.school)&&currentStatus==='active'&&sessionReady&&sessionDataReady&&!offlineAuthenticatedMode;}
 function allowed(field,key){return supported.includes(field)&&(isHeadTeacher()||(['grades','attendance','remarks'].includes(field)&&classIdsForCloudSync().has(key.split('__')[0])));}
 function targets(){
  if(!currentUid||!currentSchoolId||currentStatus!=='active')return [];
  const rows=[];
  for(const match of syncableFields()){
   if(!supported.includes(match.field))continue;
   const ids=dirtyIdsFor(match.key);
   if(match.field==='settings'){if(ids.length&&isHeadTeacher())rows.push({field:match.field,key:'__profile__',rawKey:match.key});}
   else for(const key of ids)if(allowed(match.field,key))rows.push({field:match.field,key,rawKey:match.key});
  }
  return rows;
 }
 function label(t){
  if(t.field==='settings')return 'School setup';
  const parts=t.key.split('__'),classes=DB.get(KEYS.classes,[]),cls=classes.find(c=>String(c.id)===parts[0]);
  const names={attendance:'Pupil attendance',teacherAttendance:'Teacher attendance',grades:'Grades',remarks:'Remarks'};
  return names[t.field]+' · '+(t.field==='teacherAttendance'?parts.join(' · '):[cls?.name||parts[0],...parts.slice(1)].join(' · '));
 }
 function refresh(){
  const select=element('syncReviewSelect'),button=element('syncReviewOpenBtn');if(!select||!button)return;
  const previous=select.value,rows=targets();select.replaceChildren();
  const option=document.createElement('option');option.value='';option.textContent=rows.length?'Select a pending record to review':'No reviewable conflicts';select.append(option);
  for(const t of rows){const o=document.createElement('option');o.value=JSON.stringify(t);o.textContent=label(t);select.append(o);}
  if([...select.options].some(o=>o.value===previous))select.value=previous;
  button.disabled=!rows.length;
  if(opened&&!active(opened.context)){opened=null;element('syncReviewPreview')?.replaceChildren();status('');}
 }
 function localSnapshot(t){
  const value=DB.get(t.rawKey,{}),bases=syncBaseValues.get(t.rawKey)||{};
  if(t.field==='settings'){
   const clean=stripImagesForCloud('settings',value),ids=dirtyIdsFor(t.rawKey).filter(id=>Object.hasOwn(clean,id)&&id!=='teacherName');
   return {local:Object.fromEntries(ids.map(id=>[id,clean[id]])),base:Object.fromEntries(ids.map(id=>[id,bases[id]??null])),ids};
  }
  const clean=x=>Object.fromEntries(Object.entries(x||{}).filter(([k])=>k!=='updatedAt'));
  return {local:clean(value[t.key]),base:clean(bases[t.key]),ids:[t.key]};
 }
 function unchanged(r){return active(r.context)&&allowed(r.target.field,r.target.key)&&dirtyIdsFor(r.target.rawKey).some(id=>r.snapshot.ids.includes(id))&&equal(localSnapshot(r.target),r.snapshot);}
 function describe(value){if(value===undefined)return '(removed)';if(value===null)return '(not set)';if(typeof value==='string'){const marks={P:'Present (P)',L:'Late (L)',A:'Absent (A)',E:'Excused (E)',O:'Other (O)',S:'Strike (S)','':'Not marked'};return Object.hasOwn(marks,value)?marks[value]:value;}return JSON.stringify(value);}
 function pathLabel(t,path){
  const names=[];const students=DB.get(KEYS.students,[]),staff=DB.get(KEYS.staff,[]),subjects=DB.get(KEYS.subjects,[]);
  for(const part of path){if(part==='entries')continue;const record=[...students,...staff,...subjects].find(x=>String(x.id)===part);names.push(record?.name||({c:'Class score',e:'Exam score'}[part])||part);}
  return names.join(' / ')||label(t);
 }
 function draw(r){
  const host=element('syncReviewPreview');host.replaceChildren();
  const title=document.createElement('h4');title.textContent=label(r.target);host.append(title);
  const note=document.createElement('p');note.textContent='Cloud-only changes will be kept. Choose the correct value for each conflict. A recovery copy of your original edit is saved on this device before applying.';host.append(note);
  for(const change of r.plan.changes){
   const row=document.createElement('div');row.className='sync-review-row';
   const heading=document.createElement('strong');heading.textContent=pathLabel(r.target,change.path)+(change.conflict?' — conflict':'');row.append(heading);
   const values=document.createElement('p');values.textContent='This device: '+describe(change.local)+' · Cloud: '+describe(change.cloud);row.append(values);
   if(change.conflict){const pick=document.createElement('select');pick.dataset.reviewPath=change.id;pick.setAttribute('aria-label','Choose value for '+heading.textContent);for(const [v,text] of [['','Choose correct value…'],['local','Keep this device’s value'],['cloud','Use cloud value']]){const o=document.createElement('option');o.value=v;o.textContent=text;pick.append(o);}row.append(pick);}
   host.append(row);
  }
  if(!r.plan.changes.length){const p=document.createElement('p');p.textContent='There is no remaining local difference. Apply to retry safely against the reviewed cloud record.';host.append(p);}
  const apply=document.createElement('button');apply.type='button';apply.className='btn-primary';apply.textContent='Apply reviewed choices and retry';apply.onclick=()=>applyReview(r,apply);host.append(apply);
 }
 async function open(){
  const select=element('syncReviewSelect'),button=element('syncReviewOpenBtn'),ticket=++reading;opened=null;element('syncReviewPreview')?.replaceChildren();
  if(!select?.value)return;const target=JSON.parse(select.value),ctx=context();
  if(!active(ctx)||!allowed(target.field,target.key)||!targets().some(t=>equal(t,target))){status('Connect and reverify your account before reviewing.');return;}
  const snapshot=localSnapshot(target);button.disabled=true;status('Reading the latest cloud record…');
  try{
   let cloud,version=null;
   if(target.field==='settings'){
    const doc=await schoolRef().get({source:'server'});if(!doc.exists)throw Error('School profile is unavailable.');
    cloud=Object.fromEntries(snapshot.ids.map(id=>[id,doc.data()?.profile?.[id]??null]));
   }else{
    const id=cloudKey(target.key),ref=schoolRef();
    const [doc,marker]=await Promise.all([ref.collection(target.field).doc(id).get({source:'server'}),ref.collection('deletedRecords').doc(target.field+'__'+id).get({source:'server'})]);
    version=marker.exists?(marker.data().version||'legacy-deletion'):null;
    if(!doc.exists||version!==recordDeletionVersion(target.field,target.key))throw Error('This record was removed or cleared. Your local edit is retained; it cannot be restored through conflict review.');
    const data=doc.data()||{};cloud=['grades','remarks'].includes(target.field)?(data.entries||{}):Object.fromEntries(Object.entries(data).filter(([k])=>k!=='updatedAt'));
   }
   if(ticket!==reading||!active(ctx)||!allowed(target.field,target.key)||!equal(localSnapshot(target),snapshot))throw Error('The account or local edit changed. Open a fresh review.');
   opened={target,context:ctx,snapshot,version,plan:plan(snapshot.base,snapshot.local,cloud)};draw(opened);status('Review the differences below. Nothing has been changed.');
  }catch(e){if(ticket===reading&&active(ctx))status(e.message||String(e));}
  finally{if(ticket===reading)refresh();}
 }
 async function applyReview(r,button){
  if(opened!==r||!unchanged(r)){status('The account or saved edit changed. Open a fresh review.');return;}
  const choices=Object.fromEntries([...element('syncReviewPreview').querySelectorAll('[data-review-path]')].map(el=>[el.dataset.reviewPath,el.value]));
  let resolved;try{resolved=resolve(r.plan,choices);}catch(e){status(e.message);return;}
  button.disabled=true;
  try{
   // Preserve the old draft before rebasing only this explicitly reviewed record.
   localStorage.setItem('arc_sync_review_backup__'+r.context.school+'__'+r.context.uid+'__'+Date.now(),JSON.stringify({field:r.target.field,key:r.target.key,savedAt:Date.now(),...r.snapshot,cloud:r.plan.cloud,resolved}));
   if(!unchanged(r))throw Error('The saved edit changed. Open a fresh review.');
   const value=DB.get(r.target.rawKey,{}),bases={...(syncBaseValues.get(r.target.rawKey)||{})};
   if(r.target.field==='settings')for(const id of r.snapshot.ids){bases[id]=r.plan.cloud[id];if(resolved[id]===undefined)delete value[id];else value[id]=resolved[id];}
   else {if(r.version!==recordDeletionVersion(r.target.field,r.target.key))throw Error('The record was cleared. Open a fresh review.');bases[r.target.key]=r.plan.cloud;value[r.target.key]=resolved;}
   syncBaseValues.set(r.target.rawKey,bases);
   try { DB.set(r.target.rawKey,value); } catch(error) { sessionDataReady=false; throw Error('Local storage could not finish saving. Uploads are paused. Keep browser data intact and reopen after freeing space; the saved recovery journal is retained.'); } // Durable journal retains both choices and reviewed baseline.
   opened=null;element('syncReviewPreview').replaceChildren();status('Reviewed choices saved. Retrying with normal cloud conflict checks…');
   try{await pushFieldToCloud({field:r.target.field,key:r.target.rawKey});if(active(r.context))status('Retry finished. Check Pending school data for any remaining records.');}
   catch(e){if(active(r.context))status('Choices are saved, but sync still needs attention: '+(e.message||String(e)));}
   if(active(r.context)){renderPendingSyncData();refresh();}
  }catch(e){if(isCurrentSession(r.context.token,r.context.uid,r.context.school))status('Review could not be applied: '+(e.message||String(e)));button.disabled=false;}
 }
 root.SchoolHubConflictReview={plan,resolve,equal,refresh,open};
 if(typeof document!=='undefined')document.addEventListener('click',event=>{if(event.target?.id==='syncReviewOpenBtn')open();});
})(typeof window!=='undefined'?window:globalThis);
