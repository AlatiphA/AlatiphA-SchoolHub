const {test}=require('node:test');const assert=require('node:assert/strict');
const {register,mergeEdit,reportStaff,archiveParts}=require('./safety');
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
function fixture(){
 const records=new Map([
 ['users/head',{schoolId:'s',role:'headteacher',status:'active'}],
 ['users/teacher',{schoolId:'s',role:'teacher',status:'active',assignedClassIds:['c1'],assignedSubjectIds:['math']}],
 ['users/disabled',{schoolId:'s',role:'teacher',status:'disabled'}],
 ['schools/s',{profile:{schoolName:'Test',currentYear:'2026/2027',currentTerm:'Term 3'}}],
 ['schools/s/classes/c1',{name:'Class 1'}],['schools/s/classes/c2',{name:'Class 2'}],
 ['schools/s/students/p1',{id:'p1',name:'Pupil',classId:'c1',isActive:true}],
 ['schools/s/staff/h',{name:'Head',role:'headteacher',bankAccount:'SECRET',ghanaCard:'SECRET'}]
 ]);let failCommit=false;
 const ref=path=>({path,collection:name=>ref(path+'/'+name),doc:id=>ref(path+'/'+id)});
 const get=async r=>{
  if(r.path.split('/').length%2===1){const docs=[...records].filter(([k])=>k.startsWith(r.path+'/')&&k.split('/').length===r.path.split('/').length+1).map(([k,v])=>({id:k.split('/').at(-1),data:()=>structuredClone(v)}));return {docs};}
  return {exists:records.has(r.path),data:()=>structuredClone(records.get(r.path))};
 };
 const db={collection:ref,runTransaction:async fn=>{const writes=[];const tx={get,set:(r,v)=>writes.push([r.path,v]),create:(r,v)=>{if(records.has(r.path))throw Error('already exists');writes.push([r.path,v]);},update:(r,v)=>writes.push([r.path,{...records.get(r.path),...v}])};const result=await fn(tx);if(failCommit)throw Error('injected commit failure');writes.forEach(([k,v])=>records.set(k,v));return result;}};
 const firestore={FieldValue:{serverTimestamp:()=>123}};
 const handlers=register({db,onCall:(_,fn)=>fn,HttpsError,admin:{firestore}});
 return {records,handlers,setFail:()=>failCommit=true,req:(data,uid='head')=>({auth:{uid},data})};
}
test('leaf merge clears a score without losing another device subject edit',()=>{
 const base={p:{math:{e:60},english:{e:50}}},desired={p:{math:{},english:{e:50}}},remote={p:{math:{e:60},english:{e:75}}};
 assert.deepEqual(mergeEdit(base,desired,remote,()=>{}),{p:{math:{},english:{e:75}}});
 assert.throws(()=>mergeEdit({e:60},{e:70},{e:80},()=>{}),/conflict/);
});
test('teacher writes require active class and subject permissions',async()=>{
 const f=fixture();const input={field:'grades',key:'c1__Term 1__2026/2027',base:{},value:{p1:{math:{e:75}}}};
 await f.handlers.saveSchoolRecord(f.req(input,'teacher'));
 for(const [uid,value,key] of [['disabled',input.value,input.key],['teacher',{p1:{english:{e:80}}},input.key],['teacher',input.value,'c2__Term 1__2026/2027']])await assert.rejects(f.handlers.saveSchoolRecord(f.req({...input,value,key},uid)),e=>e.code==='permission-denied');
 await assert.rejects(f.handlers.saveSchoolRecord({data:input}),e=>e.code==='unauthenticated');
});
test('server conflicts and deletion markers reject stale edits',async()=>{
 const f=fixture(),key='c1__Term 1__2026/2027',id=encodeURIComponent(key);
 f.records.set('schools/s/grades/'+id,{classId:'c1',entries:{p1:{math:{e:90}}}});
 await assert.rejects(f.handlers.saveSchoolRecord(f.req({field:'grades',key,base:{p1:{math:{e:60}}},value:{p1:{math:{e:70}}}},'teacher')),e=>e.code==='aborted');
 f.records.set('schools/s/deletedRecords/grades__'+id,{});
 await assert.rejects(f.handlers.saveSchoolRecord(f.req({field:'grades',key,base:{},value:{p1:{math:{e:90}}}},'teacher')),e=>e.code==='failed-precondition');
});
test('staff response excludes personnel identifiers and bank details',async()=>{
 const f=fixture(),result=await f.handlers.getSchoolReportStaff(f.req({},'teacher'));
 assert.deepEqual(result.staff,[{id:'h',name:'Head',role:'headteacher'}]);
 assert.deepEqual(reportStaff({name:'n',bankAccount:'secret'},'x'),{id:'x',name:'n'});
});
test('rollover commits archive and roster together and retry is idempotent',async()=>{
 const f=fixture(),input={mode:'rollover',fromYear:'2026/2027',toYear:'2027/2028',decisions:{p1:{decision:'promote',destinationClassId:'c2'}}};
 await f.handlers.applySchoolYearChange(f.req(input));
 assert.equal(f.records.get('schools/s/students/p1').classId,'c2');assert.equal(f.records.get('schools/s').profile.currentYear,'2027/2028');
 assert.equal((await f.handlers.applySchoolYearChange(f.req(input))).repeated,true);
 const g=fixture();g.setFail();await assert.rejects(g.handlers.applySchoolYearChange(g.req(input)),/injected/);
 assert.equal(g.records.get('schools/s/students/p1').classId,'c1');assert.equal([...g.records.keys()].some(k=>k.includes('yearRollovers')),false);
});
test('oversized rollover and foreign-school restore fail before any writes',async()=>{
 const f=fixture(),decisions={};for(let i=0;i<451;i++){f.records.set('schools/s/students/p'+i,{id:'p'+i,classId:'c1'});decisions['p'+i]={decision:'repeat'};}
 await assert.rejects(f.handlers.applySchoolYearChange(f.req({mode:'rollover',fromYear:'2026/2027',toYear:'2027/2028',decisions})),e=>e.code==='resource-exhausted');
 assert.equal(f.records.get('schools/s').profile.currentYear,'2026/2027');
 await assert.rejects(f.handlers.applySchoolYearChange(f.req({mode:'restore',snapshot:{schoolId:'other',type:'academic-year-rollover',data:{students:[],settings:{}}}})),e=>e.code==='invalid-argument');
});
test('UTF-8 archives preserve non-ASCII characters at byte boundaries',()=>{
 const value={text:'🎒 école '.repeat(60000)};const chunks=archiveParts(value);
 assert(chunks.every(c=>Buffer.byteLength(c)<250000));assert.deepEqual(JSON.parse(Buffer.concat(chunks.map(c=>Buffer.from(c,'base64'))).toString()),value);
});
test('fresh entry after a clear is accepted but older devices stay blocked',async()=>{
 const f=fixture(),key='c1__Term 1__2026/2027',id=encodeURIComponent(key),input={field:'grades',key,base:{},value:{p1:{math:{e:50}}}};
 f.records.set('schools/s/deletedRecords/grades__'+id,{version:'clear-1'});
 await assert.rejects(f.handlers.saveSchoolRecord(f.req(input,'teacher')),e=>e.code==='failed-precondition');
 await f.handlers.saveSchoolRecord(f.req({...input,deletionVersion:'clear-1'},'teacher'));
 assert.equal(f.records.get('schools/s/grades/'+id).entries.p1.math.e,50);
 await assert.rejects(f.handlers.saveSchoolRecord(f.req({...input,value:{p1:{math:{c:20}}}},'teacher')),e=>e.code==='failed-precondition');
});
test('attendance always retains its queryable class and deleted classes reject edits',async()=>{
 const f=fixture(),key='c1__Term 1__2026/2027__2026-09-23';
 await f.handlers.saveSchoolRecord(f.req({field:'attendance',key,base:{},value:{entries:{p1:'present'}}},'teacher'));
 assert.equal(f.records.get('schools/s/attendance/'+encodeURIComponent(key)).classId,'c1');
 f.records.delete('schools/s/classes/c1');
 await assert.rejects(f.handlers.saveSchoolRecord(f.req({field:'grades',key:'c1__Term 1__2026/2027',base:{},value:{}})),e=>e.code==='failed-precondition');
});
test('legacy migration preserves newer and explicitly deleted records',async()=>{
 const f=fixture();f.records.get('schools/s').students=[{id:'p1',name:'Old'},{id:'gone',classId:'c1'},{id:'new',classId:'c1'}];
 f.records.get('schools/s').grades={'c1__Term 1__2026/2027':{p1:{math:{e:55}}}};
 f.records.set('schools/s/deletedRecords/students__gone',{});
 await f.handlers.migrateSchoolLegacy(f.req({}));
 assert.equal(f.records.get('schools/s/students/p1').name,'Pupil');
 assert.equal(f.records.has('schools/s/students/gone'),false);
 assert.equal(f.records.get('schools/s/students/new').classId,'c1');
 assert.equal(f.records.get('schools/s').students,undefined);
 assert.equal(f.records.get('schools/s').schemaVersion,4);
 await assert.rejects(f.handlers.migrateSchoolLegacy(f.req({},'teacher')),e=>e.code==='permission-denied');
});

test('deleting a student with grades syncs and preserves other pupils and concurrent edits',async()=>{
 const f=fixture(),key='c1__Term 1__2026/2027',path='schools/s/grades/'+encodeURIComponent(key);
 const base={p1:{math:{c:25,e:70},english:{e:80}},p2:{math:{e:60}}};
 f.records.set(path,{classId:'c1',entries:{...base,p2:{math:{e:85}}}});
 f.records.delete('schools/s/students/p1');
 const input={field:'grades',key,base,value:{p2:base.p2}};
 await f.handlers.saveSchoolRecord(f.req(input));
 assert.deepEqual(f.records.get(path).entries,{p2:{math:{e:85}}});
 await f.handlers.saveSchoolRecord(f.req(input));
 assert.deepEqual(f.records.get(path).entries,{p2:{math:{e:85}}});
});

test('grade container deletion retains subject permissions and is atomic',async()=>{
 const f=fixture(),key='c1__Term 1__2026/2027',path='schools/s/grades/'+encodeURIComponent(key);
 const base={p1:{math:{c:25,e:70},english:{e:80}}};
 f.records.set(path,{classId:'c1',entries:base});
 await assert.rejects(f.handlers.saveSchoolRecord(f.req({field:'grades',key,base,value:{}},'teacher')),e=>e.code==='permission-denied');
 assert.deepEqual(f.records.get(path).entries,base);
 await f.handlers.saveSchoolRecord(f.req({field:'grades',key,base,value:{p1:{english:{e:80}}}},'teacher'));
 assert.deepEqual(f.records.get(path).entries,{p1:{english:{e:80}}});
 const mathOnly={p1:{math:{e:70}}};f.records.set(path,{classId:'c1',entries:mathOnly});
 await f.handlers.saveSchoolRecord(f.req({field:'grades',key,base:mathOnly,value:{}},'teacher'));
 assert.deepEqual(f.records.get(path).entries,{});
});

test('student grade deletion rejects concurrent changes and malformed replacements',async()=>{
 const f=fixture(),key='c1__Term 1__2026/2027',path='schools/s/grades/'+encodeURIComponent(key);
 const base={p1:{math:{e:70}}},remote={p1:{math:{e:75}}};
 f.records.set(path,{classId:'c1',entries:remote});
 await assert.rejects(f.handlers.saveSchoolRecord(f.req({field:'grades',key,base,value:{}})),e=>e.code==='aborted');
 assert.deepEqual(f.records.get(path).entries,remote);
 for(const value of [{p1:null},{p1:10},{p1:{math:null}},{p1:{math:{wrong:1}}}]) {
  await assert.rejects(f.handlers.saveSchoolRecord(f.req({field:'grades',key,base:remote,value})),e=>e.code==='invalid-argument');
 }
 assert.deepEqual(f.records.get(path).entries,remote);
});

test('teachers can finish all-subject cleanup only for deleted pupils in their assigned class',async()=>{
 const f=fixture(),key='c1__Term 1__2026/2027',path='schools/s/grades/'+encodeURIComponent(key);
 const base={p1:{math:{e:70},english:{e:85}},p2:{english:{e:55}}};
 f.records.set(path,{classId:'c1',entries:base});
 const input={field:'grades',key,base,value:{p2:base.p2}};
 await assert.rejects(f.handlers.saveSchoolRecord(f.req(input,'teacher')),e=>e.code==='permission-denied');
 f.records.set('schools/s/deletedRecords/students__p1',{collection:'students',id:'p1'});
 f.records.delete('schools/s/students/p1');
 await f.handlers.saveSchoolRecord(f.req(input,'teacher'));
 assert.deepEqual(f.records.get(path).entries,{p2:{english:{e:55}}});
 await assert.rejects(f.handlers.saveSchoolRecord(f.req({...input,key:'c2__Term 1__2026/2027'},'teacher')),e=>e.code==='permission-denied');
 await assert.rejects(f.handlers.saveSchoolRecord(f.req({...input,value:{p1:{english:{e:90}},p2:base.p2}},'teacher')),e=>e.code==='permission-denied');
});

test('object key order does not produce false conflicts when deleting grade containers',()=>{
 const base={p:{math:{c:20,e:70},english:{e:80}}};
 const remote={p:{english:{e:80},math:{e:70,c:20}}};
 assert.deepEqual(mergeEdit(base,{},remote,()=>{}),{});
});

for(const field of ['grades','remarks','attendance'])test(`confirmed pupil deletion resolves stale ${field} cleanup without changing surviving pupils`,async()=>{
 const f=fixture(),key='c1__Term 1__2026/2027',path='schools/s/'+field+'/'+encodeURIComponent(key);
 const old={p1:{math:{e:70}},p2:{math:{e:50}}};
 const latest={p1:{math:{e:90}},p2:{math:{e:85}}};
 const wrap=x=>field==='attendance'?{entries:x}:x;
 f.records.set(path,{classId:'c1',entries:latest});
 f.records.delete('schools/s/students/p1');
 f.records.set('schools/s/deletedRecords/students__p1',{collection:'students',id:'p1'});
 const input={field,key,base:wrap(old),value:wrap({p2:old.p2})};
 await f.handlers.saveSchoolRecord(f.req(input));
 assert.deepEqual(f.records.get(path).entries,{p2:{math:{e:85}}});
 await f.handlers.saveSchoolRecord(f.req(input));
 assert.deepEqual(f.records.get(path).entries,{p2:{math:{e:85}}});
});

test('deletion cleanup does not hide surviving-pupil conflicts or delete a restored pupil',async()=>{
 const f=fixture(),key='c1__Term 1__2026/2027',path='schools/s/grades/'+encodeURIComponent(key);
 const base={p1:{math:{e:70}},p2:{math:{e:50}}};
 const remote={p1:{math:{e:90}},p2:{math:{e:85}}};
 f.records.set(path,{classId:'c1',entries:remote});
 f.records.set('schools/s/deletedRecords/students__p1',{collection:'students',id:'p1'});
 await assert.rejects(f.handlers.saveSchoolRecord(f.req({field:'grades',key,base,value:{p2:base.p2}})),e=>e.code==='aborted');
 f.records.delete('schools/s/students/p1');
 await assert.rejects(f.handlers.saveSchoolRecord(f.req({field:'grades',key,base,value:{p2:{math:{e:60}}}})),e=>e.code==='aborted');
 assert.deepEqual(f.records.get(path).entries,remote);
});
