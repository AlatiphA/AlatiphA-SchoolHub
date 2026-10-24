const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app-4.js','utf8');
const start=source.indexOf('async function prepareTeacherApproval('),end=source.indexOf('\nlet editingManageTeacherUid',start);
function fixture(){
 const dirty=new Map([['classes',['c']],['subjects',['math']],['staff',['existing']]]);
 const rows={classes:[{id:'c'}],subjects:[{id:'math',name:'Mathematics'}],staff:[{id:'existing'}]};
 const calls=[];const cloud=[{id:'math'}];const prompts=[];
 const c={schoolRef:()=>({collection:()=>({get:async options=>{assert.equal(options.source,'server');return {docs:cloud};}})}),confirm:message=>{prompts.push(message);return true;},sessionGeneration:1,currentUid:'head',currentSchoolId:'school',isHeadTeacher:()=>true,isCurrentSession:(a,b,d)=>a===c.sessionGeneration&&b===c.currentUid&&d===c.currentSchoolId,offlineAuthenticatedMode:false,cloudHydrationInProgress:false,sessionDataReady:true,navigator:{onLine:true},KEYS:{classes:'classes',subjects:'subjects',staff:'staff'},dirtyIdsFor:k=>dirty.get(k)||[],DB:{get:k=>rows[k]},syncableFields:()=>['classes','subjects','staff'].map(field=>({field,key:field})),pushFieldToCloud:async f=>{calls.push(f.field);dirty.delete(f.key);}};
 vm.createContext(c);vm.runInContext(source.slice(start,end),c);
 return {c,dirty,rows,calls,cloud,prompts,run:()=>c.prepareTeacherApproval(['c'],['math'],'existing')};
}
test('approval waits for class, subject and Staff uploads in order',async()=>{
 const f=fixture();let release;f.c.pushFieldToCloud=async field=>{f.calls.push(field.field);if(field.field==='classes')await new Promise(r=>release=r);f.dirty.delete(field.key);};
 let finished=false;const pending=f.run().then(()=>finished=true);await Promise.resolve();assert.deepEqual(f.calls,['classes']);assert.equal(finished,false);release();await pending;assert.deepEqual(f.calls,['classes','subjects','staff']);
});
test('approval stops on dependency failure and preserves pending records',async()=>{const f=fixture();f.c.pushFieldToCloud=async()=>{throw Error('permission denied');};await assert.rejects(f.run(),/Could not sync classes.*permission denied/);assert(f.dirty.has('classes'));assert(f.dirty.has('staff'));});
test('approval retries edits made while an earlier dependency upload is running',async()=>{const f=fixture();let attempts=0;f.c.pushFieldToCloud=async field=>{if(field.field==='classes'&&++attempts===1)return;f.dirty.delete(field.key);};await f.run();assert.equal(attempts,2);});
test('continuously changing dependencies stop approval instead of an endless loop',async()=>{const f=fixture();let attempts=0;f.c.pushFieldToCloud=async()=>{attempts++;};await assert.rejects(f.run(),/still pending/);assert.equal(attempts,3);});
test('account or school switch during upload prevents approval',async()=>{for(const key of ['currentSchoolId','currentUid','sessionGeneration']){const f=fixture();f.c.pushFieldToCloud=async()=>{f.c[key]='changed';};await assert.rejects(f.run(),/session changed/);}});
test('offline and incomplete school hydration prevent approval without writes',async()=>{for(const change of [{offlineAuthenticatedMode:true},{cloudHydrationInProgress:true},{sessionDataReady:false},{navigator:{onLine:false}}]){const f=fixture();Object.assign(f.c,change);await assert.rejects(f.run(),/Connect to the internet/);assert.equal(f.calls.length,0);}});
test('a removed selected record cannot be submitted or recreated by preflight',async()=>{const f=fixture();f.rows.subjects=[];await assert.rejects(f.run(),/selected subjects record changed/);assert.deepEqual(f.rows.subjects,[]);});
test('only dependencies are flushed; no selection of a Staff record is needed for creation',async()=>{const f=fixture();f.dirty.clear();await f.c.prepareTeacherApproval(['c'],[],'');assert.equal(f.calls.length,0);});

test('clean local-only subjects are detected even without a pending upload flag',async()=>{const f=fixture();f.dirty.clear();f.cloud.length=0;const prepared=await f.run();assert.equal(prepared.confirmLocalSubjects,true);assert.equal(prepared.expectedSchoolId,'school');assert.equal(prepared.localSubjects[0].id,'math');assert.equal(f.calls.length,0);assert.match(f.prompts[0],/Mathematics/);});
test('saved subjects require no recovery confirmation',async()=>{const f=fixture();const prepared=await f.run();assert.equal(prepared.confirmLocalSubjects,false);assert.equal(prepared.localSubjects.length,0);assert.equal(f.prompts.length,0);});
test('cancelling local subject recovery does not change local data or membership',async()=>{const f=fixture();f.cloud.length=0;f.c.confirm=()=>false;const before=JSON.stringify(f.rows);await assert.rejects(f.run(),/Approval cancelled/);assert.equal(JSON.stringify(f.rows),before);});
test('failed server subject verification stops approval',async()=>{const f=fixture();f.c.schoolRef=()=>({collection:()=>({get:async()=>{throw Error('server unavailable');}})});await assert.rejects(f.run(),/server unavailable/);assert.equal(f.prompts.length,0);});
test('school or subject edits during server verification stop approval',async()=>{for(const mutate of [f=>f.c.currentSchoolId='other',f=>f.rows.subjects[0].name='Changed']){const f=fixture();f.c.schoolRef=()=>({collection:()=>({get:async()=>{mutate(f);return {docs:f.cloud};}})});await assert.rejects(f.run(),/changed/);assert.equal(f.prompts.length,0);}});
