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
 const ctx={isTeacher:()=>teacher,KEYS:{settings:'settings'},dirtyIdsFor:()=>['currentYear'],DB:{get:()=>({currentYear:''}),set:(_,value)=>saved=value}};
 vm.createContext(ctx);vm.runInContext(fn('mergeCloudCollection')+"\nmergeCloudCollection('settings',{currentYear:'2026/2027'},true);",ctx);
 assert.equal(saved.currentYear,teacher?'2026/2027':'');
 }
});
test('Grades is reachable from the teacher bottom navigation',()=>{
 const ctx={isHeadTeacher:()=>false};vm.createContext(ctx);vm.runInContext(fn('floatingPillItems')+'\nglobalThis.items=floatingPillItems();',ctx);
 assert(ctx.items.some(x=>x.view==='grades'));
});
