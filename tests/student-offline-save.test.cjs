const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app-4.js','utf8');
const storageCode=source.slice(source.indexOf('const SYNC_OUTBOX_KEY'),source.indexOf('// currentUid'));
const handlerCode=source.slice(source.indexOf("  list.querySelectorAll('.save-student')"),source.indexOf("  list.querySelectorAll('.del-student')"));
function fixture(values=new Map(),opts={}){
 if(!values.has('students'))values.set('students',JSON.stringify([{id:'test',classId:'c4',name:'Original',dob:'2015-01-01',gender:'Male'},{id:'real',classId:'c4',name:'Real pupil'}]));
 let callback,renders=0,cloudCalls=0,scheduled=0;
 const fields={'.edit-student-name':'Offline name','.edit-student-dob':'2015-01-01','.edit-student-gender':'Male','.edit-student-id':'','.edit-student-phone':'','.edit-student-disability':'','.edit-student-guardian':'','.edit-student-house-gps':''};
 const btn={dataset:{id:'test'},disabled:false,textContent:'Update',closest:()=>({querySelector:s=>({value:fields[s]})}),addEventListener:(_,fn)=>callback=fn};
 const c={console:{warn(){},error(){}},navigator:{onLine:false},localStorage:{getItem:k=>values.get(k)||null,setItem(k,v){if(k===opts.failKey)throw Error('storage full');values.set(k,v);},removeItem:k=>values.delete(k)},stripImagesForLocalStorage:(_,v)=>v,restoreLocalImagesForDbKey:(_,v)=>v,stableSyncJson:JSON.stringify,updateOfflineModeBanner(){},scheduleCloudPush(){scheduled++;},
 alert:m=>c.messages.push(m),messages:[],KEYS:{students:'students'},FIREBASE_ENABLED:true,currentUid:'teacher',currentSchoolId:'school',currentStatus:'active',sessionGeneration:1,sessionReady:true,sessionDataReady:true,cloudHydrationInProgress:false,editingStudentId:'test',
 requireClassAccess:id=>id==='c4'&&!opts.denied,isCurrentSession:(g,u,s)=>g===c.sessionGeneration&&u===c.currentUid&&s===c.currentSchoolId,
 schoolRef(){cloudCalls++;throw Error('Form must not send direct cloud writes');},auditAction(){if(opts.auditFails)throw Error('audit failed');},renderStudents(){renders++;},renderClasses(){},list:{querySelectorAll:s=>s==='.save-student'?[btn]:[]}};
 vm.createContext(c);vm.runInContext(storageCode+'\nglobalThis.db=DB;',c);vm.runInContext(handlerCode,c);
 return {c,btn,fields,values,click:()=>callback(),get:()=>c.db.get('students',[]),renders:()=>renders,cloudCalls:()=>cloudCalls,scheduled:()=>scheduled};
}
test('offline pupil edit returns immediately with local data and durable pending intent, without cloud confirmation',async()=>{
 const f=fixture();await f.click();assert.equal(f.get()[0].name,'Offline name');assert.equal(f.get()[1].name,'Real pupil');assert.equal(f.cloudCalls(),0);assert.equal(f.btn.disabled,false);assert.equal(f.btn.textContent,'Update');assert.equal(f.renders(),1);assert.equal(f.scheduled(),1);
 const out=JSON.parse(f.values.get('arc_sync_outbox_v1'));assert.deepEqual(out.dirty.students,['test']);assert.equal(out.bases.students.test.name,'Original');assert(!f.values.has('arc_sync_journal_v2'));
});
test('closing and reopening offline restores the edited pupil and pending record',async()=>{
 const first=fixture();await first.click();const reopened=fixture(first.values);assert.equal(reopened.get()[0].name,'Offline name');assert.deepEqual(JSON.parse(reopened.values.get('arc_sync_outbox_v1')).dirty.students,['test']);
});
test('local storage failure keeps the form usable and journal replays data plus intent on restart',async()=>{
 const f=fixture(new Map(),{failKey:'students'});await f.click();assert.equal(f.get()[0].name,'Original');assert.equal(f.btn.disabled,false);assert.equal(f.btn.textContent,'Update');assert(f.c.messages.some(x=>x.includes('NOT saved')));const recovered=fixture(f.values);assert.equal(recovered.get()[0].name,'Offline name');assert.deepEqual(JSON.parse(recovered.values.get('arc_sync_outbox_v1')).dirty.students,['test']);
});
test('unassigned class and invalid required fields cannot queue a pupil edit',async()=>{
 const denied=fixture(new Map(),{denied:true});await denied.click();assert.equal(denied.get()[0].name,'Original');assert(!denied.values.has('arc_sync_outbox_v1'));const invalid=fixture();invalid.fields['.edit-student-dob']='';await invalid.click();assert.equal(invalid.get()[0].name,'Original');assert.match(invalid.c.messages[0],/Date of Birth/);
});
test('inactive membership, unfinished hydration and not-ready sessions cannot queue edits',async()=>{
 for(const change of [{currentStatus:'disabled'},{cloudHydrationInProgress:true},{sessionDataReady:false},{sessionReady:false}]){const f=fixture();Object.assign(f.c,change);await f.click();assert.equal(f.get()[0].name,'Original');assert.equal(f.btn.disabled,false);assert(!f.values.has('arc_sync_outbox_v1'));}
});
test('duplicate admission ID and disappeared pupil keep the entered form instead of saving',async()=>{
 const f=fixture();const original=f.get();original[1].admissionId='DUP';f.values.set('students',JSON.stringify(original));f.fields['.edit-student-id']='dup';await f.click();assert.equal(f.get()[0].name,'Original');assert.match(f.c.messages[0],/unique/);const missing=fixture();missing.values.set('students',JSON.stringify(missing.get().filter(x=>x.id!=='test')));await missing.click();assert(!missing.values.has('arc_sync_outbox_v1'));
});
test('an audit failure after local persistence never reports the pupil edit as unsaved',async()=>{
 const f=fixture(new Map(),{auditFails:true});await f.click();assert.equal(f.get()[0].name,'Offline name');assert(f.c.messages.some(x=>x.includes('saved on this device')));assert(!f.c.messages.some(x=>x.includes('NOT saved')));assert.equal(f.btn.disabled,false);
});
