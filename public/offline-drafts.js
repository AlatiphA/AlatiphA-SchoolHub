/* User/school-scoped form drafts only. No credentials or automatic submission. */
(()=>{
 const kinds=new Set(['my-details','stock-request']);
 const key=(kind,uid,school)=>{if(!kinds.has(kind)||!uid||!school)throw Error('Sign in to your school before saving a draft.');return 'schoolhub_draft_v1_'+JSON.stringify([kind,uid,school]);};
 const fields={ 'my-details':['name','sex','dob','registeredNo','licenseNo','emisNo','ssnitNo','ghanaCardId','academicQualification','professionalQualification','bankBranch','bankAccount','phone','email'], 'stock-request':['itemId','quantityMilli','purpose'] };
 const clean=(kind,value)=>Object.fromEntries(fields[kind].filter(k=>Object.hasOwn(value||{},k)).map(k=>[k,String(value[k]??'')]));
 window.SchoolHubDrafts={
  read(kind,uid,school){const raw=localStorage.getItem(key(kind,uid,school));if(!raw)return null;const draft=JSON.parse(raw);if(draft.version!==1)throw Error('This draft needs recovery; keep it on this device.');return {...draft,values:clean(kind,draft.values),base:clean(kind,draft.base)};},
  write(kind,uid,school,value){const draft={version:1,values:clean(kind,value.values),base:clean(kind,value.base),staffRecordId:String(value.staffRecordId||''),savedAt:Date.now()};localStorage.setItem(key(kind,uid,school),JSON.stringify(draft));return draft;},
  remove(kind,uid,school){localStorage.removeItem(key(kind,uid,school));}
 };
})();
