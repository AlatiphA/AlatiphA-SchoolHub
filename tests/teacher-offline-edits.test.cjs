const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(process.cwd(),'app-4.js'),'utf8');
const storage=source.slice(source.indexOf('const SYNC_OUTBOX_KEY'),source.indexOf('// currentUid'));
const sections={grades:source.slice(source.indexOf("document.getElementById('saveGradesBtn').addEventListener"),source.indexOf('/* ---------- Bulk Grade')),
 attendance:source.slice(source.indexOf("document.getElementById('saveAttendanceBtn').addEventListener('click'"),source.indexOf("document.getElementById('saveTeacherAttendanceBtn').addEventListener")),
 remarks:source.slice(source.indexOf('function saveCurrentRemarks('),source.indexOf("document.getElementById('remarksClassSelect').addEventListener"))};
function context(values=new Map(),denied=false){
 const handlers={},rm={attendance:'1',promoted:'',feesDue:'',conduct:'Test conduct',attitude:'',interest:'',comment:'Offline test remark'};
 const c={console:{warn(){},error(){}},navigator:{onLine:false},localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},stripImagesForLocalStorage:(_,v)=>v,restoreLocalImagesForDbKey:(_,v)=>v,stableSyncJson:JSON.stringify,updateOfflineModeBanner(){},scheduleCloudPush(){},alert(){},auditAction(){},renderAttendanceForm(){},requireClassAccess:id=>id==='c4'&&!denied,
 KEYS:{grades:'grades',attendance:'attendance',remarks:'remarks',settings:'settings'},gradeKey:()=> 'c4__term__year',attendanceKey:()=> 'c4__term__year__2026-10-05',attendanceDayType:()=> 'open',attendanceSummary:()=>({summary:{test:{total:1}}}),
 clampScore:v=>Number(v),subjectEntryHasScore:v=>Object.keys(v).length>0,remarksCurrentStudent:()=>({id:'test',name:'Synthetic test pupil'}),
 document:{getElementById:id=>({value:id==='attendanceDate'?'2026-10-05':'c4',addEventListener:(event,fn)=>handlers[id]=fn}),querySelector:()=>({querySelector:s=>({value:rm[s.replace('.rm-','').replace('fees','feesDue')],readOnly:s==='.rm-fees'})}),querySelectorAll:selector=>selector.includes('grades')?[{dataset:{student:'test',subject:'math',part:'e'},value:'70'}]:[{dataset:{student:'test'},value:'P'}]}};
 if(!values.has('settings'))values.set('settings',JSON.stringify({currentTerm:'term',currentYear:'year'}));
 vm.createContext(c);vm.runInContext(storage+'\nglobalThis.db=DB;',c);
 return {c,values,handlers,load:name=>vm.runInContext(sections[name],c),get:key=>c.db.get(key,{})};
}
for(const name of ['grades','attendance','remarks']){
 test(name+' saves offline immediately and its data/outbox survive reopening',()=>{
  const f=context();f.load(name);if(name==='remarks')assert.equal(f.c.saveCurrentRemarks(),true);else f.handlers[name==='grades'?'saveGradesBtn':'saveAttendanceBtn']();
  const reopened=context(f.values);assert(Object.keys(reopened.get(name)).length);const out=JSON.parse(f.values.get('arc_sync_outbox_v1'));assert(out.dirty[name].length);assert(out.bases[name]);assert(!f.values.has('arc_sync_journal_v2'));
  if(name==='grades')assert.equal(reopened.get(name).c4__term__year.test.math.e,70);
  if(name==='attendance')assert.equal(reopened.get(name)['c4__term__year__2026-10-05'].entries.test,'P');
  if(name==='remarks')assert.equal(reopened.get(name).c4__term__year.test.comment,'Offline test remark');
 });
 test(name+' refuses edits outside teacher assigned class',()=>{
  const f=context(new Map(),true);f.load(name);if(name==='remarks')assert.equal(f.c.saveCurrentRemarks(),false);else f.handlers[name==='grades'?'saveGradesBtn':'saveAttendanceBtn']();assert(!f.values.has(name));assert(!f.values.has('arc_sync_outbox_v1'));
 });
}
test('teacher remarks preserves read-only fee balance while saving comment offline',()=>{
 const f=context();f.values.set('remarks',JSON.stringify({c4__term__year:{test:{feesDue:'123.45'}}}));f.load('remarks');f.c.saveCurrentRemarks();assert.equal(f.get('remarks').c4__term__year.test.feesDue,'123.45');
});
