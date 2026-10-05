/* Add Staff drafts are local to one account and school; never auto-submitted. */
(()=>{
 const fields=['name','role',...STAFF_FIELDS.map(f=>f.key)],form=document.getElementById('addStaffForm');
 let owner=null,restored=null,fileWork=Promise.resolve(),fileEpoch=0,blocked=false;
 const key=s=>'schoolhub_add_staff_draft_v1_'+JSON.stringify([s.uid,s.school]);
 const clean=v=>Object.fromEntries(fields.filter(k=>Object.hasOwn(v||{},k)).map(k=>[k,String(v[k]??'')]));
 const read=s=>{const raw=localStorage.getItem(key(s));if(!raw)return null;const d=JSON.parse(raw);if(d.version!==1)throw Error('Saved staff draft needs recovery.');return {...d,values:clean(d.values)};};
 const context=()=>isActiveGuest()?{uid:'local-guest',school:'local-guest-workspace'}:currentUid&&currentSchoolId&&currentStatus==='active'&&isHeadTeacher()?{uid:currentUid,school:currentSchoolId}:null;
 const same=(a,b)=>!!a&&!!b&&a.uid===b.uid&&a.school===b.school;
 const control=k=>document.getElementById(k==='name'?'newStaffName':k==='role'?'newStaffRole':'newStaff_'+k);
 const values=()=>Object.fromEntries(fields.map(k=>[k,control(k)?.value||'']));
 const status=document.createElement('p');status.className='hint';status.id='addStaffDraftStatus';status.setAttribute('role','status');form.append(status);
 const discard=document.createElement('button');discard.type='button';discard.className='btn-secondary';discard.textContent='Discard saved staff draft';discard.id='discardStaffDraftBtn';form.append(discard);
 const preview=document.createElement('img');preview.hidden=true;preview.alt='Selected staff signature';preview.style.cssText='max-width:180px;max-height:90px;object-fit:contain';document.getElementById('newStaffSignature').after(preview);
 function stash(){
  if(!owner||blocked)return;
  const v=values(),filled=Object.entries(v).some(([k,value])=>k!=='role'&&value);
  if(!filled&&!restored?.imageKey){localStorage.removeItem(key(owner));return;}
  const draft={version:1,values:clean(v),imageKey:restored?.imageKey||'',fileName:restored?.fileName||'',fileType:restored?.fileType||'',savedAt:Date.now()};
  localStorage.setItem(key(owner),JSON.stringify(draft));
 }
 function safeStash(){try{stash();}catch(e){status.textContent='Draft could not be saved on this device. Keep the form open. '+e.message;}}
 function clearForm(){form.querySelectorAll('input,select,button').forEach(c=>c.disabled=false);document.getElementById('addStaffBtn').textContent='Add Staff';fields.forEach(k=>{if(control(k))control(k).value=k==='role'?'Teacher':'';});document.getElementById('newStaffSignature').value='';preview.hidden=true;preview.removeAttribute('src');status.textContent='';}
 function ensure(){
  const next=context();if(same(owner,next))return;
  safeStash();owner=next;fileEpoch++;restored=null;blocked=false;clearForm();
  if(!owner)return;
  try{
   const draft=read(owner);if(!draft)return;
   fields.forEach(k=>{if(Object.hasOwn(draft.values,k)&&control(k))control(k).value=draft.values[k];});
   if(draft.imageKey)restored={imageKey:draft.imageKey,fileName:draft.fileName,fileType:draft.fileType};
   form.classList.remove('hidden');const toggle=document.getElementById('toggleAddStaffBtn');toggle.textContent='Collapse';toggle.setAttribute('aria-expanded','true');status.textContent='Staff draft restored on this device. It has not been added.';
   const s={...owner},epoch=fileEpoch;
   if(restored)getCachedLocalImageAsync(restored.imageKey).then(data=>{if(!same(owner,s)||epoch!==fileEpoch)return;if(data){preview.src=data;preview.hidden=false;status.textContent='Staff draft and signature restored. It has not been added.';}else status.textContent='Staff details restored. Choose the signature again; its saved image is unavailable.';});
  }catch(e){blocked=true;status.textContent='Saved staff draft needs recovery. Keep site data; use Discard saved staff draft only if you want to start again.';}
 }
 async function persistSignature(imageKey,data){
  const db=await openImageDB();if(!db)throw Error('Signature draft storage is unavailable.');
  await new Promise((resolve,reject)=>{const tx=db.transaction(IMAGE_DB_STORE,'readwrite');tx.objectStore(IMAGE_DB_STORE).put({dataUrl:data,storagePath:'',sourceUrl:'',updatedAt:new Date().toISOString()},imageKey);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error||Error('Signature draft storage failed.'));tx.onabort=()=>reject(tx.error||Error('Signature draft storage was interrupted.'));});
 }
 form.addEventListener('input',()=>{ensure();safeStash();});form.addEventListener('change',()=>{ensure();safeStash();});
 const input=document.getElementById('newStaffSignature');input.addEventListener('click',()=>{ensure();safeStash();});
 input.addEventListener('change',()=>{
  ensure();const file=input.files[0];if(!file||!owner)return;const s={...owner},epoch=++fileEpoch,imageKey='staff-add-signature-draft-'+crypto.randomUUID(),old=restored?.imageKey;restored=null;safeStash();
  fileWork=(async()=>{const data=await fileToDataUrl(file);if(!isDataImage(data))throw Error('Choose a readable signature image.');await persistSignature(imageKey,data);if(!same(owner,s)||fileEpoch!==epoch){removeCachedLocalImage(imageKey);return;}restored={imageKey,fileName:file.name,fileType:file.type};stash();if(old)removeCachedLocalImage(old);preview.src=data;preview.hidden=false;status.textContent='Staff details and selected signature saved as a draft on this device.';})().catch(e=>{if(same(owner,s)&&fileEpoch===epoch)status.textContent='Details are retained. Signature draft could not be saved; keep this page open or choose it again. '+e.message;});
 });
 function clear(){if(owner)localStorage.removeItem(key(owner));if(restored?.imageKey)removeCachedLocalImage(restored.imageKey);restored=null;fileEpoch++;blocked=false;preview.hidden=true;preview.removeAttribute('src');status.textContent='';}
 discard.onclick=()=>{clear();clearForm();};
 const baseReset=resetWorkspaceState;resetWorkspaceState=function(...args){safeStash();owner=null;fileEpoch++;restored=null;blocked=false;clearForm();return baseReset(...args);};
 const baseRender=renderStaff;renderStaff=function(...args){ensure();return baseRender(...args);};
 window.addEventListener('pagehide',safeStash);document.addEventListener('visibilitychange',()=>{if(document.hidden)safeStash();});window.addEventListener('focus',()=>{ensure();safeStash();});
 window.SchoolHubStaffAddDraft={ensure,stash:safeStash,clear,async file(){const s=context();await fileWork;if(!same(owner,s)||!same(context(),s))throw Error('Your account changed. Reopen Add Staff.');if(input.files[0])return input.files[0];if(!restored)return null;const data=await getCachedLocalImageAsync(restored.imageKey);if(!data)throw Error('Choose the signature again; its saved image is unavailable.');const match=/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(data);if(!match)throw Error('Choose a readable signature image again.');const bytes=Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0));return new File([bytes],restored.fileName||'signature.png',{type:match[1]});}};
 ensure();
})();
