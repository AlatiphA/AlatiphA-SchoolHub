const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('app-4.js','utf8');
function section(start,end){return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));}
function fixture(){
 const records=new Map(), writes=[], timers=[], dirty=new Map();
 const ctx={console,Map,Set,Promise,JSON,FIREBASE_ENABLED:true,currentSchoolId:'school',currentUid:'head',currentStatus:'active',sessionGeneration:1,sessionDataReady:true,cloudHydrationInProgress:false,offlineAuthenticatedMode:false,
  DB:{get:(key,fallback)=>records.has(key)?records.get(key):fallback,set:(key,value)=>records.set(key,value)},
  KEYS:{students:'students',grades:'grades',settings:'settings'},
  syncErrors:new Map(),updateOfflineModeBanner(){},syncDirtyKeys:dirty,syncBaseValues:new Map(),fieldPushes:new Map(),stableSyncJson:JSON.stringify,
  dirtyIdsFor:key=>Array.from(dirty.get(key)||[]),
  clearSyncDirty:(key,ids)=>ids.forEach(id=>dirty.get(key)?.delete(id)),
  isTeacher:()=>false,classIdsForCloudSync:()=>new Set(['class1']),isHeadTeacher:()=>true,
  isCurrentSession:(token,uid,school)=>token===ctx.sessionGeneration&&uid===ctx.currentUid&&school===ctx.currentSchoolId,
  stripImagesForCloud:(_,value)=>value,
  fieldDefault:field=>['students','classes','staff','subjects'].includes(field)?[]:{},
  scheduleCloudPush:key=>timers.push(key),setLastSyncedNow:()=>{},
  firebase:{firestore:{FieldValue:{serverTimestamp:()=>0}}},
  schoolRef:()=>({collection:()=>({}),set:()=>enqueue()}),
  syncCollectionArray:(_,items)=>enqueue(items),syncKeyedCollection:(_,items)=>enqueue(items)
 };
 function enqueue(items){return new Promise((resolve,reject)=>writes.push({items,resolve,reject}));}
 vm.createContext(ctx);
 vm.runInContext(section('function dirtyArrayRecords(', '\nfunction syncableFields()'),ctx);
 vm.runInContext(section('function mergeRecordsById(', '\nfunction pullCloudData('),ctx);
 return {ctx,records,writes,timers,dirty};
}
test('in-flight acknowledgement preserves and reschedules a newer edit',async()=>{
 const f=fixture();f.records.set('students',[{id:'s1',classId:'class1',name:'old'}]);f.dirty.set('students',new Set(['s1']));
 const p=f.ctx.pushFieldToCloud({field:'students',key:'students'});
 f.records.set('students',[{id:'s1',classId:'class1',name:'new'}]);
 f.writes[0].resolve();await p;
 assert.equal(f.dirty.get('students').has('s1'),true);assert.deepEqual(f.timers,['students']);
 const next=f.ctx.pushFieldToCloud({field:'students',key:'students'});f.writes[1].resolve();await next;
 assert.equal(f.dirty.get('students').size,0);
});
test('overlapping pushes share one write and denied-class edits remain queued',async()=>{
 const f=fixture();f.records.set('students',[{id:'s1',classId:'class1'},{id:'s2',classId:'class2'}]);f.dirty.set('students',new Set(['s1','s2']));
 const a=f.ctx.pushFieldToCloud({field:'students',key:'students'}),b=f.ctx.pushFieldToCloud({field:'students',key:'students'});
 assert.equal(f.writes.length,1);f.writes[0].resolve();await Promise.all([a,b]);
 assert.deepEqual([...f.dirty.get('students')],['s2']);assert.equal(f.timers.length,0);
});
test('failed writes and obsolete sessions do not acknowledge the outbox',async()=>{
 const f=fixture();f.records.set('students',[{id:'s1',classId:'class1'}]);f.dirty.set('students',new Set(['s1']));
 const a=f.ctx.pushFieldToCloud({field:'students',key:'students'});f.writes[0].reject(new Error('offline'));await assert.rejects(a);
 assert.equal(f.dirty.get('students').size,1);
 const b=f.ctx.pushFieldToCloud({field:'students',key:'students'});f.ctx.sessionGeneration++;f.writes[1].resolve();await b;
 assert.equal(f.dirty.get('students').size,1);
});
test('cached offline identity cannot initiate writes before reverification',async()=>{
 const f=fixture();f.ctx.offlineAuthenticatedMode=true;f.records.set('students',[{id:'s1',classId:'class1'}]);f.dirty.set('students',new Set(['s1']));
 await f.ctx.pushFieldToCloud({field:'students',key:'students'});assert.equal(f.writes.length,0);assert.equal(f.dirty.get('students').size,1);
});
test('hydration preserves pending array, keyed and settings edits while accepting clean cloud data',()=>{
 const f=fixture();
 f.records.set('students',[{id:'s1',name:'local'},{id:'s2',name:'old'}]);f.dirty.set('students',new Set(['s1']));
 f.ctx.mergeCloudCollection('students',[{id:'s1',name:'cloud'},{id:'s2',name:'fresh'},{id:'s3',name:'new'}],true);
 assert.deepEqual(Array.from(f.records.get('students'),x=>x.name),['local','fresh','new']);
 for(const field of ['grades','settings']){
  f.records.set(field,{pending:'local',clean:'old'});f.dirty.set(field,new Set(['pending']));
  f.ctx.mergeCloudCollection(field,{pending:'cloud',clean:'fresh'},true);
  assert.equal(f.records.get(field).pending,'local');assert.equal(f.records.get(field).clean,'fresh');
 }
});
test('storage quota failure leaves the previous saved value intact',()=>{
 const values=new Map([['students','[{"id":"s1"}]']]);
 const ctx={recoverSyncJournal(){},markSyncDirty(){},syncOutboxJson:()=> '{}',SYNC_JOURNAL_KEY:'journal',persistSyncOutbox(){},console:{error(){}},localStorage:{getItem:k=>values.get(k),setItem(){throw new Error('quota');},removeItem:k=>values.delete(k)},stripImagesForLocalStorage:(_,v)=>v,restoreLocalImagesForDbKey:(_,v)=>v};
 vm.createContext(ctx);vm.runInContext(section('const DB = {','\n// currentUid')+'\nglobalThis.db=DB;',ctx);
 assert.throws(()=>ctx.db.set('students',[{id:'s2'}]),/quota/);assert.equal(values.get('students'),'[{"id":"s1"}]');
});
test('rollover snapshot uses browser-supported batch methods and rejects existing archive',async()=>{
 const writes=[];let exists=false;
 const ref={get:async()=>({exists}),collection:()=>({doc:()=>({})})};
 const ctx={FIREBASE_ENABLED:true,currentSchoolId:'school',currentUid:'head',schoolRef:()=>({collection:()=>({doc:()=>ref})}),firebase:{firestore:{FieldValue:{serverTimestamp:()=>0}}},commitChunks:async ops=>ops.forEach(op=>op({set:(...args)=>writes.push(args)}))};
 vm.createContext(ctx);vm.runInContext(section('function cloudRolloverSnapshot(', '\nfunction rolloverUpdatedStudents('),ctx);
 await ctx.cloudRolloverSnapshot({fromYear:'2026/2027',toYear:'2027/2028'},'year',{});assert.equal(writes.length,2);
 exists=true;await assert.rejects(ctx.cloudRolloverSnapshot({fromYear:'2026/2027'},'year',{}),/already/);
});
test('emergency restore stops when its protective snapshot cannot be stored',()=>{
 const ctx={DB:{get:(_,v)=>v},KEYS:{settings:'settings',students:'students'},currentSchoolId:'school',ns:x=>x,localStorage:{setItem(){throw new Error('quota');}},console:{warn(){}}};
 vm.createContext(ctx);vm.runInContext(section('function preserveBeforeEmergencyRestore(', '\nfunction mergedStudentsForEmergencyRestore('),ctx);
 assert.throws(()=>ctx.preserveBeforeEmergencyRestore(),/pre-restore snapshot/);
});

test('service-worker upgrade deletes only older SchoolHub caches',async()=>{
 const listeners={},deleted=[];let completion;
 const ctx={self:{addEventListener:(name,fn)=>listeners[name]=fn,clients:{claim:async()=>{}},location:{origin:'https://school.example'}},caches:{keys:async()=>['schoolhub-cache-v39','schoolhub-cache-v40-student-layout-sync-4','schoolhub-cache-v40-bulk-staff-attendance-5-teacher-details-1','another-app-cache'],delete:async key=>deleted.push(key)}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync('sw.js','utf8'),ctx);
 listeners.activate({waitUntil:p=>completion=p});await completion;
 assert.deepEqual(deleted,['schoolhub-cache-v39','schoolhub-cache-v40-student-layout-sync-4','schoolhub-cache-v40-bulk-staff-attendance-5-teacher-details-1']);
});

test('moving an exception to School Open clears both cloud calendar dates atomically',async()=>{
 const start=source.indexOf('          const batch =',source.indexOf('if (dateChanged) {'));
 const end=source.indexOf('          await batch.commit();',start)+'          await batch.commit();'.length;
 const records=new Map([['old',{type:'holiday'}],['new',{type:'midterm'}]]),removed=[];let commits=0;
 const firestore=()=>({batch:()=>({delete:key=>removed.push(key),set:()=>assert.fail('open day must not write an exception'),commit:async()=>{commits++;removed.forEach(key=>records.delete(key));}})});
 firestore.FieldValue={serverTimestamp:()=>0};
 const ctx={firebase:{firestore},schoolCalendarRef:key=>key,key:'new',originalKey:'old',type:'open'};
 vm.createContext(ctx);await vm.runInContext('(async()=>{'+source.slice(start,end)+'})()',ctx);
 assert.equal(commits,1);assert.equal(records.size,0);
});
