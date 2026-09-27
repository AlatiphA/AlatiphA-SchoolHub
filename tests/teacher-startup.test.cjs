const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app-4.js','utf8');
function fn(name){const start=source.indexOf('function '+name+'(');let depth=0,begin=source.indexOf('{',start);for(let i=begin;i<source.length;i++){if(source[i]==='{')depth++;if(source[i]==='}'&&!--depth)return source.slice(start,i+1);}}
test('teacher startup does not create defaults and removes only school-wide pending flags',()=>{
 const fields=['settings','classes','subjects','staff','teacherAttendance','schoolCalendar','grades','attendance'];
 const dirty=new Map(fields.map(f=>[f,['saved']]));
 const ctx={isTeacher:()=>true,KEYS:Object.fromEntries(fields.map(f=>[f,f])),dirtyIdsFor:k=>dirty.get(k)||[],clearSyncDirty:k=>dirty.delete(k),syncErrors:new Map(),DB:{set(){throw Error('must not create teacher defaults');}}};
 vm.createContext(ctx);vm.runInContext(fn('repairTeacherDefaultQueue')+'\n'+fn('ensureDefaults')+'\nensureDefaults();',ctx);
 assert.deepEqual([...dirty.keys()],['grades','attendance']);
});
test('school profile replaces stale teacher defaults while head teacher edits remain protected',()=>{
 for(const teacher of [true,false]){
 let saved;
 const ctx={discardUneditedSetupDefaults:()=>{},isTeacher:()=>teacher,KEYS:{settings:'settings'},dirtyIdsFor:()=>['currentYear'],DB:{get:()=>({currentYear:''}),set:(_,value)=>saved=value}};
 vm.createContext(ctx);vm.runInContext(fn('mergeCloudCollection')+"\nmergeCloudCollection('settings',{currentYear:'2026/2027'},true);",ctx);
 assert.equal(saved.currentYear,teacher?'2026/2027':'');
 }
});
test('Grades is reachable from the teacher bottom navigation',()=>{
 const ctx={isHeadTeacher:()=>false};vm.createContext(ctx);vm.runInContext(fn('floatingPillItems')+'\nglobalThis.items=floatingPillItems();',ctx);
 assert(ctx.items.some(x=>x.view==='grades'));
});

test('fresh-device defaults do not override the cloud but real Setup edits survive',()=>{
 let local={schoolName:'',currentYear:'',currentTerm:'Term 1',email:'new@example.com'};
 let dirty=Object.keys(local);
 const ctx={KEYS:{settings:'settings'},isTeacher:()=>false,syncBaseValues:new Map([['settings',{schoolName:null,currentYear:null,currentTerm:null,email:'old@example.com'}]]),dirtyIdsFor:()=>dirty,clearSyncDirty:(_,ids)=>{dirty=dirty.filter(x=>!ids.includes(x));},DB:{get:()=>local,set:(_,v)=>{local=v;}}};
 vm.createContext(ctx);vm.runInContext(fn('discardUneditedSetupDefaults')+'\n'+fn('mergeCloudCollection')+"\nmergeCloudCollection('settings',{schoolName:'Real School',currentYear:'2026/2027',currentTerm:'Term 3',email:'old@example.com'},true)",ctx);
 assert.equal(local.schoolName,'Real School');assert.equal(local.currentYear,'2026/2027');assert.equal(local.currentTerm,'Term 3');assert.equal(local.email,'new@example.com');assert.deepEqual(dirty,['email']);
});

test('an explicitly named new school keeps its Term 1 choice queued',()=>{
 const ctx={KEYS:{settings:'settings'},syncBaseValues:new Map([['settings',{currentTerm:null}]]),DB:{get:()=>({schoolName:'New School',currentTerm:'Term 1'})},dirtyIdsFor:()=>['currentTerm'],clearSyncDirty:()=>{throw Error('explicit choice discarded');}};
 vm.createContext(ctx);vm.runInContext(fn('discardUneditedSetupDefaults')+'\ndiscardUneditedSetupDefaults();',ctx);
});
