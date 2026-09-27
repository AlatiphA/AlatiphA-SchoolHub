const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app-4.js','utf8');
const start=source.indexOf('async function resolveReportStaffForClass(');
const end=source.indexOf('async function prepareReportAssets(',start);
function fixture(role,designated){
 const staff=[{id:'a',name:'Teacher A',signature:'signature-a'},{id:'b',name:'Teacher B',signature:'signature-b'},{id:'h',name:'Head',role:'headteacher'}];
 const cls={id:'c',classTeacherId:designated};
 const ctx={KEYS:{staff:'staff',classes:'classes'},DB:{get:key=>key==='staff'?staff:[cls]},isTeacher:()=>role!=='head',isHeadTeacher:()=>role==='head',currentUid:role,currentAssignedClassIds:['c'],getStaffForUserUid:()=>staff.find(s=>s.id===role),fetchSchoolMembers:()=>{throw Error('Access assignments must not choose signatures');}};
 vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);return {ctx,cls};
}
test('both assigned teachers and the Head Teacher resolve the designated signer',async()=>{
 for(const role of ['a','b','head']){
  const {ctx,cls}=fixture(role,'b');
  assert.equal((await ctx.resolveReportStaffForClass({},cls)).classTeacher.signature,'signature-b');
  assert.equal((await ctx.resolveReportStaffForClass({},null,'c')).classTeacher.id,'b');
 }
});
test('missing or deleted designated staff never falls back to the signed-in teacher',async()=>{
 for(const role of ['a','b','head'])for(const designation of ['', 'deleted']){
  const {ctx,cls}=fixture(role,designation);
  assert.equal((await ctx.resolveReportStaffForClass({},cls)).classTeacher==null,true);
 }
});
