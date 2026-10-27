const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('app-4.js', 'utf8');
function fixture(kind = 'students') {
  const data = {students:[], staff:[]}, nodes = {}, alerts = [], writes = [], cloud = new Map();
  let sequence = 0, calls = 0;
  const input = {value:'', disabled:false}, button = {textContent:'Add All', disabled:false};
  nodes[kind === 'staff' ? 'bulkStaffInput' : 'bulkStudentInput'] = input;
  nodes[kind === 'staff' ? 'bulkAddStaffBtn' : 'bulkAddStudentsBtn'] = button;
  nodes.studentClassSelect = {value:'class1'}; nodes.studentSearchInput={value:'Filter'};
  const ctx = {Map, Set, JSON, FIREBASE_ENABLED:true,navigator:{onLine:true},offlineAuthenticatedMode:false,sessionReady:true,currentStatus:'active', sessionGeneration:1, currentUid:'head', currentSchoolId:'school', sessionDataReady:true, cloudHydrationInProgress:false,
    KEYS:{students:'students',staff:'staff'}, DB:{get:(key)=>data[key],set:(key,value)=>data[key]=value},
    document:{getElementById:id=>nodes[id]}, uid:()=>`id-${++sequence}`,
    requireHeadTeacher:()=>true, requireClassAccess:()=>true,
    isCurrentSession:(token,user,school)=>token===ctx.sessionGeneration && user===ctx.currentUid && school===ctx.currentSchoolId,
    schoolRef:()=>({collection:name=>({doc:id=>`${name}/${id}`})}), stripImagesForCloud:(_,record)=>record,
    commitChunks:async ops=>{
      calls++;
      assert.ok(ops.length <= 10, 'bulk creates leave room for rules lookups');
      const batch = [];
      ops.forEach(op=>op({set:(path,record)=>batch.push([path,record])}));
      if (ctx.failAt === calls && !ctx.loseAck) throw Error('Network failed');
      batch.forEach(([path,record])=>cloud.set(path,record)); writes.push(batch);
      if (ctx.failAt === calls) throw Error('Acknowledgement lost');
      if (ctx.changeSessionAt === calls) ctx.sessionGeneration++;
    }, recoverSyncJournal(){}, setLastSyncedNow(){}, auditAction(){}, renderStudents(){}, renderClasses(){}, renderStaff(){}, alert:message=>alerts.push(message)};
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('const bulkAddPending ='), source.indexOf("document.getElementById('bulkAddStudentsBtn').addEventListener",source.indexOf('const bulkAddPending ='))),ctx);
  return {ctx,data,input,button,alerts,writes,cloud,run:()=>ctx.bulkAddPeople(kind)};
}
test('one click adds 30 students, preserving IDs and clearing the input', async()=>{
  const f=fixture(); f.input.value=Array.from({length:30},(_,i)=>`Student ${i}, Female, 00${i}`).join('\n');
  await f.run(); assert.equal(f.data.students.length,30); assert.equal(f.writes.length,3);
  assert.equal(f.data.students[0].admissionId,'000'); assert.equal(f.input.value,''); assert.equal(f.button.disabled,false);
  assert.equal(f.ctx.document.getElementById('studentSearchInput').value,'');
});
test('staff bulk add handles 65 records and defaults their role to Teacher', async()=>{
  const f=fixture('staff'); f.input.value=Array.from({length:65},(_,i)=>`Staff ${i}, Female, 00${i}`).join('\n');
  await f.run(); assert.equal(f.data.staff.length,65); assert.ok(f.data.staff.every(s=>s.role==='Teacher'));
  assert.equal(f.cloud.size,65);
});
test('validates the entire list before saving missing or repeated Staff IDs',async()=>{
  for (const text of ['Jane','Jane, F, 1\nJohn, M, 1','Jane, F, 1\n, M, 2']) {
    const f=fixture('staff'); f.input.value=text; await f.run(); assert.equal(f.writes.length,0); assert.equal(f.input.value,text);
  }
});
test('partial failure retains only unsaved lines, and retry avoids duplicates',async()=>{
  for (const loseAck of [false,true]) {
    const f=fixture(); f.ctx.failAt=2; f.ctx.loseAck=loseAck;
    f.input.value=Array.from({length:30},(_,i)=>`Student ${i}, Male`).join('\n');
    await f.run(); assert.equal(f.data.students.length,10); assert.equal(f.input.value.split('\n').length,20);
    f.ctx.failAt=0; await f.run(); assert.equal(f.data.students.length,30); assert.equal(f.cloud.size,30); assert.equal(f.input.value,'');
  }
});
test('duplicate clicks cannot start another save, and session changes stop further writes',async()=>{
  const f=fixture(); f.input.value=Array.from({length:30},(_,i)=>`Student ${i}, Male`).join('\n'); f.ctx.changeSessionAt=1;
  const first=f.run(); await f.run(); await first;
  assert.equal(f.writes.length,1); assert.equal(f.data.students.length,0); assert.equal(f.button.disabled,false);
});
test('existing Student IDs are rejected without saving any part of the list',async()=>{
  const f=fixture(); f.data.students.push({id:'existing',admissionId:'ABC'}); f.input.value='Jane, F, abc\nJohn, M, new';
  await f.run(); assert.equal(f.writes.length,0); assert.equal(f.data.students.length,1);
});

test('offline bulk pupils save locally without network confirmation and show the full class',async()=>{
 const f=fixture();f.ctx.navigator.onLine=false;f.data.students.push({id:'real',name:'Existing pupil'});f.input.value='Offline test, F, TEST-ID';await f.run();assert.equal(f.data.students.length,2);assert.equal(f.writes.length,0);assert.equal(f.input.value,'');assert.equal(f.ctx.document.getElementById('studentSearchInput').value,'');assert(f.alerts.some(x=>x.includes('Pending upload')));assert.equal(f.button.disabled,false);
});
test('offline bulk pupil creation refuses incomplete or disabled school sessions',async()=>{
 for(const state of [{sessionReady:false},{currentStatus:'disabled'},{cloudHydrationInProgress:true}]){const f=fixture();f.ctx.navigator.onLine=false;Object.assign(f.ctx,state);f.input.value='Test, M';await f.run();assert.equal(f.data.students.length,0);assert.equal(f.input.value,'Test, M');assert.equal(f.button.disabled,false);}
});

test('student bulk entry saves sex from full words or letters and keeps optional IDs as text',async()=>{
 const f=fixture();f.input.value='Jane Doe, Female, 001\nJohn Smith, Male\nAma, f\nKofi, m, 0002';await f.run();
 assert.deepEqual(f.data.students.map(s=>[s.name,s.gender,s.admissionId]),[['Jane Doe','F','001'],['John Smith','M',''],['Ama','F',''],['Kofi','M','0002']]);assert(f.cloud.size===4);
});
test('student bulk entry validates sex and column count before saving any row',async()=>{
 for(const bad of ['John','John, 101','John, Other','John, , 002','John, M, 002, extra',', F, 003']){const f=fixture();f.input.value='Valid pupil, F, 001\n'+bad;await f.run();assert.equal(f.data.students.length,0);assert.equal(f.writes.length,0);assert.equal(f.input.value,'Valid pupil, F, 001\n'+bad);assert.match(f.alerts[0],/Line 2:/);}
});
test('student bulk duplicate IDs are caught case-insensitively with the new format',async()=>{
 const f=fixture();f.input.value='Ama, F, abc\nKofi, M, ABC';await f.run();assert.equal(f.writes.length,0);assert.match(f.alerts[0],/already in use/);
});
test('gender survives offline entry and a lost-acknowledgement retry',async()=>{
 const offline=fixture();offline.ctx.navigator.onLine=false;offline.input.value='Offline pupil, Female';await offline.run();assert.equal(offline.data.students[0].gender,'F');
 const f=fixture();f.input.value='Retry pupil, M, 001';f.ctx.failAt=1;f.ctx.loseAck=true;await f.run();assert.equal(f.data.students.length,0);f.ctx.failAt=0;await f.run();assert.equal(f.cloud.size,1);assert.equal(f.data.students[0].gender,'M');
});

test('staff bulk entry stores sex with leading-zero Staff IDs',async()=>{const f=fixture('staff');f.input.value='Jane, Female, 001\nJohn, m, 002';await f.run();assert.deepEqual(f.data.staff.map(s=>[s.sex,s.staffId]),[['F','001'],['M','002']]);assert(f.data.staff.every(s=>s.gender===undefined));});
test('staff bulk validates sex and exact column count before writing any row',async()=>{for(const bad of ['Name, 101','Name, Other, 101','Name, , 101','Name, M','Name, F,','Name, M, 1, extra']){const f=fixture('staff');f.input.value='Valid, F, 001\n'+bad;await f.run();assert.equal(f.writes.length,0);assert.equal(f.data.staff.length,0);assert.match(f.alerts[0],/Line 2:/);}});
test('staff sex and record IDs survive a lost-acknowledgement retry',async()=>{const f=fixture('staff');f.input.value='Retry staff, Male, 0001';f.ctx.failAt=1;f.ctx.loseAck=true;await f.run();assert.equal(f.data.staff.length,0);f.ctx.failAt=0;await f.run();assert.equal(f.cloud.size,1);assert.equal(f.data.staff[0].sex,'M');assert.equal(f.data.staff[0].staffId,'0001');});
