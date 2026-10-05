/* Record editors reuse the existing validated save handlers and durable queues. */
(function(){
 'use strict';
 let active=null;
 const config={
  class:{title:'Edit class',list:'classList',key:()=>KEYS.classes,get:()=>editingClassId,set:v=>editingClassId=v,render:renderClasses,allowed:()=>isHeadTeacher()||isActiveGuest(),fields:['name','classTeacherId']},
  student:{title:'Edit student',list:'studentList',key:()=>KEYS.students,get:()=>editingStudentId,set:v=>editingStudentId=v,render:renderStudents,allowed:r=>canAccessClass(r.classId),fields:['name','gender','dob','admissionId','parentPhone','disability','guardianName','houseGps']},
  staff:{title:'Edit staff',list:'staffList',key:()=>KEYS.staff,get:()=>editingStaffId,set:v=>editingStaffId=v,render:renderStaff,allowed:()=>isHeadTeacher()||isActiveGuest(),fields:['name','role',...STAFF_FIELDS.map(f=>f.key)]},
  subject:{title:'Edit subject',list:'subjectList',key:()=>KEYS.subjects,get:()=>editingSubjectId,set:v=>editingSubjectId=v,render:renderSubjects,allowed:()=>isHeadTeacher()||isActiveGuest(),fields:['name']}
 };
 const context=()=>JSON.stringify([sessionGeneration,currentUid,currentSchoolId,currentRole,currentStatus]);
 const record=(kind,id)=>DB.get(config[kind].key(),[]).find(r=>r.id===id);
 const permitted=(kind,r)=>!!r&&(isActiveGuest()||sessionReady&&currentStatus==='active')&&config[kind].allowed(r);
 const projection=(kind,r)=>JSON.stringify(config[kind].fields.map(k=>r[k]||''));
 function valid(a){return a.context===context()&&permitted(a.kind,record(a.kind,a.id));}
 function restoreFocus(a){if(!a)return;const fallback=document.querySelector('#'+config[a.kind].list+' .edit-'+a.kind+'[data-id="'+CSS.escape(a.id)+'"]');(a.origin?.isConnected?a.origin:fallback)?.focus({preventScroll:true});}
 function detach(reset=true,focus=true){
  const a=active;if(!a)return;active=null;clearInterval(a.timer);a.overlay.remove();
  if(reset)config[a.kind].set(null);
  document.body.style.overflow=a.overflow;
  if(focus)restoreFocus(a);return a;
 }
 function refreshPreview(a){
  if(!a||!['student','staff'].includes(a.kind))return;
  const r=record(a.kind,a.id),student=a.kind==='student',value=r?.[student?'photo':'signature']||'',className=student?'edit-photo-preview':'staff-signature-preview',row=a.overlay.querySelector('.edit-row');
  let image=row.querySelector('.'+className);
  if(value&&!image){image=document.createElement('img');image.className=className;image.alt=student?'Student photo':'Staff signature';row.querySelector('input[type=file]')?.closest('label')?.before(image);}
  if(image){image.hidden=!value;if(value)image.src=value;}
  const remove=row.querySelector(student?'.remove-student-photo':'.remove-staff-signature');if(remove)remove.hidden=!value;
 }
 function refreshList(kind){const c=config[kind],id=c.get();c.set(null);try{const result=c.render();if(active?.kind===kind)refreshPreview(active);return result;}finally{c.set(id);}}
 function mount(kind,id){
  const c=config[kind],row=document.querySelector('#'+c.list+' .save-'+kind+'[data-id="'+CSS.escape(id)+'"]')?.closest('li'),r=record(kind,id);
  if(!row||!permitted(kind,r)){c.set(null);return;}
  const origin=document.activeElement,overlay=document.createElement('div');overlay.id='recordEditDialog';overlay.className='about-overlay';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-labelledby','recordEditTitle');
  overlay.innerHTML='<div class="about-box record-edit-box"><h2 id="recordEditTitle"></h2><p class="hint record-edit-name"></p><ul class="record-edit-fields"></ul><p class="hint" role="status" data-edit-status></p></div>';
  overlay.querySelector('h2').textContent=c.title;overlay.querySelector('.record-edit-name').textContent=r.name||'';overlay.querySelector('ul').append(row);
  const a={kind,id,context:context(),baseline:projection(kind,r),overlay,origin,overflow:document.body.style.overflow,timer:null};active=a;
  const close=row.querySelector('.cancel-'+kind);close.textContent='Close';close.type='button';
  row.querySelectorAll('button').forEach(b=>b.type='button');
  row.querySelectorAll('label').forEach(label=>{const control=label.querySelector('input,select');if(control&&label.querySelector('.required-mark')){const heading=document.createElement('span');while(label.firstChild&&label.firstChild!==control)heading.append(label.firstChild);label.prepend(heading);}});
  row.querySelectorAll('input[placeholder]').forEach(input=>{if(!input.closest('label')){const label=document.createElement('label');label.textContent=input.getAttribute('placeholder');input.before(label);label.append(input);}});
  const primary=row.querySelector('.edit-'+kind+'-name');if(primary&&!primary.closest('label')){const label=document.createElement('label');label.textContent=kind==='student'||kind==='staff'?'Full name':kind==='class'?'Class name':'Subject name';primary.before(label);label.append(primary);}
  overlay.addEventListener('click',e=>{
   if(active!==a)return;
   if(!valid(a)){e.preventDefault();e.stopImmediatePropagation();detach();alert('Your account or access changed. Reopen the record in your current workspace.');return;}
   if(e.target.closest('.save-'+kind)){
    if(FIREBASE_ENABLED&&(!sessionDataReady||cloudHydrationInProgress)){e.preventDefault();e.stopImmediatePropagation();overlay.querySelector('[data-edit-status]').textContent='School data is still synchronizing. Keep this form open and retry when ready.';return;}
    if(projection(kind,record(kind,id))!==a.baseline){e.preventDefault();e.stopImmediatePropagation();overlay.querySelector('[data-edit-status]').textContent='This record changed while you were editing. Your entries remain here. Close and reopen to review the latest details before saving.';}
   }
  },true);
  overlay.addEventListener('keydown',e=>{
   if(e.key==='Escape'){e.preventDefault();if(![...row.querySelectorAll('button')].some(b=>b.disabled))close.click();}
   if(e.key==='Tab'){const controls=[...overlay.querySelectorAll('button,input,select,textarea,a[href]')].filter(el=>!el.disabled&&el.getClientRects().length),first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
  });
  document.body.append(overlay);document.body.style.overflow='hidden';refreshList(kind);
  a.timer=setInterval(()=>{if(active===a&&!valid(a)){detach();c.render();}},1000);
  row.querySelector('input:not([type=file]),select,button')?.focus({preventScroll:true});
 }
 function wrap(kind){const c=config[kind];return function(...args){
  const id=c.get();
  if(active?.kind===kind){if(id===active.id&&valid(active))return refreshList(kind);const closed=detach(id!==null,false);if(!id){const result=c.render(...args);restoreFocus(closed);return result;}}
  if(id&&!permitted(kind,record(kind,id))){c.set(null);return c.render(...args);}
  const result=c.render(...args);if(id)mount(kind,id);return result;
 };}
 renderClasses=wrap('class');renderStudents=wrap('student');renderStaff=wrap('staff');renderSubjects=wrap('subject');
 function open(kind,id){if(!config[kind]||!permitted(kind,record(kind,id)))return false;if(active){const old=active.kind;detach();config[old].render();}if(kind==='subject')subjectArrangeMode=false;config[kind].set(id);({class:renderClasses,student:renderStudents,staff:renderStaff,subject:renderSubjects})[kind]();return active?.kind===kind;}
 const originalTransition=beginSessionTransition;beginSessionTransition=function(...args){detach(true,false);return originalTransition(...args);};
 const originalView=showView;showView=function(...args){if(active){const kind=active.kind;detach();config[kind].render();}return originalView(...args);};
 function addDetailsEdit(kind,id){const button=document.getElementById(kind+'DetailsEditBtn');if(!button)return;const allowed=permitted(kind,record(kind,id));button.hidden=!allowed;button.onclick=()=>{if(!permitted(kind,record(kind,id)))return;document.getElementById(kind+'DetailsDialog').classList.add('hidden');open(kind,id);};}
 const originalStaffView=showStaffDetails;showStaffDetails=function(id){const result=originalStaffView(id);addDetailsEdit('staff',id);return result;};
 const originalStudentView=showStudentDetails;showStudentDetails=async function(id){const token=context();await originalStudentView(id);if(token!==context()||!permitted('student',record('student',id))){document.getElementById('studentDetailsDialog')?.classList.add('hidden');return;}addDetailsEdit('student',id);};
 window.SchoolHubRecordEditors={open,close:()=>{if(active){const kind=active.kind;detach();config[kind].render();}},check:()=>{if(active&&!valid(active)){const kind=active.kind;detach();config[kind].render();}}};
})();
