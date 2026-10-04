/* User/school-scoped form drafts only. No credentials or automatic submission. */
(()=>{
 const kinds=new Set(['my-details','stock-request']);
 const key=(kind,uid,school)=>{if(!kinds.has(kind)||!uid||!school)throw Error('Sign in to your school before saving a draft.');return 'schoolhub_draft_v1_'+JSON.stringify([kind,uid,school]);};
 const fields={ 'my-details':['name','sex','dob','registeredNo','licenseNo','emisNo','ssnitNo','ghanaCardId','academicQualification','professionalQualification','bankBranch','bankAccount','phone','email'], 'stock-request':['itemId','quantityMilli','purpose'] };
 const clean=(kind,value)=>Object.fromEntries(fields[kind].filter(k=>Object.hasOwn(value||{},k)).map(k=>[k,String(value[k]??'')]));
 const stockKey=(uid,school)=>key('stock-request',uid,school);
 const stockRead=(uid,school)=>{const raw=localStorage.getItem(stockKey(uid,school));if(!raw)return [];const saved=JSON.parse(raw);if(saved.version===1)return [{id:'legacy-stock-request',values:clean('stock-request',saved.values),savedAt:saved.savedAt||0}];if(saved.version!==2||!Array.isArray(saved.drafts))throw Error('Saved requests need recovery. Do not clear site data.');const ids=new Set();return saved.drafts.map(d=>{if(!d.id||ids.has(d.id))throw Error('Saved requests need recovery.');ids.add(d.id);return {id:String(d.id),values:clean('stock-request',d.values),savedAt:d.savedAt||0};});};
 const stockStore=(uid,school,drafts)=>localStorage.setItem(stockKey(uid,school),JSON.stringify({version:2,drafts}));
 window.SchoolHubDrafts={
  listStock:stockRead,
  saveStock(uid,school,id,values){const drafts=stockRead(uid,school),draft={id:id||crypto.randomUUID(),values:clean('stock-request',values),savedAt:Date.now()},at=drafts.findIndex(x=>x.id===draft.id);if(at<0)drafts.push(draft);else drafts[at]=draft;stockStore(uid,school,drafts);return draft;},
  removeStock(uid,school,id){stockStore(uid,school,stockRead(uid,school).filter(x=>x.id!==id));},
  read(kind,uid,school){const raw=localStorage.getItem(key(kind,uid,school));if(!raw)return null;const draft=JSON.parse(raw);if(draft.version!==1)throw Error('This draft needs recovery; keep it on this device.');return {...draft,values:clean(kind,draft.values),base:clean(kind,draft.base)};},
  write(kind,uid,school,value){if(kind==='stock-request'&&JSON.parse(localStorage.getItem(key(kind,uid,school))||'null')?.version===2)throw Error('Open the saved request list to edit this draft.');const draft={version:1,values:clean(kind,value.values),base:clean(kind,value.base),staffRecordId:String(value.staffRecordId||''),savedAt:Date.now()};localStorage.setItem(key(kind,uid,school),JSON.stringify(draft));return draft;},
  remove(kind,uid,school){localStorage.removeItem(key(kind,uid,school));}
 };
})();
