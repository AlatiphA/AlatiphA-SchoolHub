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
  nodes.studentClassSelect = {value:'class1'};
  const ctx = {Map, Set, JSON, FIREBASE_ENABLED:true, sessionGeneration:1, currentUid:'head', currentSchoolId:'school', sessionDataReady:true, cloudHydrationInProgress:false,
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
    }, setLastSyncedNow(){}, auditAction(){}, renderStudents(){}, renderClasses(){}, renderStaff(){}, alert:message=>alerts.push(message)};
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('const bulkAddPending ='), source.indexOf("document.getElementById('bulkAddStudentsBtn').addEventListener",source.indexOf('const bulkAddPending ='))),ctx);
  return {ctx,data,input,button,alerts,writes,cloud,run:()=>ctx.bulkAddPeople(kind)};
}
test('one click adds 30 students, preserving IDs and clearing the input', async()=>{
  const f=fixture(); f.input.value=Array.from({length:30},(_,i)=>`Student ${i}, 00${i}`).join('\n');
  await f.run(); assert.equal(f.data.students.length,30); assert.equal(f.writes.length,3);
  assert.equal(f.data.students[0].admissionId,'000'); assert.equal(f.input.value,''); assert.equal(f.button.disabled,false);
});
test('staff bulk add handles 65 records and defaults their role to Teacher', async()=>{
  const f=fixture('staff'); f.input.value=Array.from({length:65},(_,i)=>`Staff ${i}, 00${i}`).join('\n');
  await f.run(); assert.equal(f.data.staff.length,65); assert.ok(f.data.staff.every(s=>s.role==='Teacher'));
  assert.equal(f.cloud.size,65);
});
test('validates the entire list before saving missing or repeated Staff IDs',async()=>{
  for (const text of ['Jane','Jane, 1\nJohn, 1','Jane, 1\n, 2']) {
    const f=fixture('staff'); f.input.value=text; await f.run(); assert.equal(f.writes.length,0); assert.equal(f.input.value,text);
  }
});
test('partial failure retains only unsaved lines, and retry avoids duplicates',async()=>{
  for (const loseAck of [false,true]) {
    const f=fixture(); f.ctx.failAt=2; f.ctx.loseAck=loseAck;
    f.input.value=Array.from({length:30},(_,i)=>`Student ${i}`).join('\n');
    await f.run(); assert.equal(f.data.students.length,10); assert.equal(f.input.value.split('\n').length,20);
    f.ctx.failAt=0; await f.run(); assert.equal(f.data.students.length,30); assert.equal(f.cloud.size,30); assert.equal(f.input.value,'');
  }
});
test('duplicate clicks cannot start another save, and session changes stop further writes',async()=>{
  const f=fixture(); f.input.value=Array.from({length:30},(_,i)=>`Student ${i}`).join('\n'); f.ctx.changeSessionAt=1;
  const first=f.run(); await f.run(); await first;
  assert.equal(f.writes.length,1); assert.equal(f.data.students.length,0); assert.equal(f.button.disabled,false);
});
test('existing Student IDs are rejected without saving any part of the list',async()=>{
  const f=fixture(); f.data.students.push({id:'existing',admissionId:'ABC'}); f.input.value='Jane, abc\nJohn, new';
  await f.run(); assert.equal(f.writes.length,0); assert.equal(f.data.students.length,1);
});
