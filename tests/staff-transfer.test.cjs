const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const transfer = require('../staff-transfer.js');
const source=fs.readFileSync('app-4.js','utf8');
const context=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('const STAFF_FIELDS ='), source.indexOf('function staffFieldControl('))+'\nglobalThis.fields=STAFF_FIELDS;',context);
const fields=context.fields;
const existing=[{id:'internal-1',name:'Old Name',staffId:'0012',phone:'0123',signature:'image',signatureUrl:'url',userUid:'account',role:'Teacher'}];
test('updates by Staff ID and preserves blanks, signatures and linked accounts',()=>{
 const plan=transfer.plan([['Full name','Staff ID','Phone','Bank Account'],['New Name','0012','','000456']],existing,fields);
 assert.deepEqual(plan.errors,[]);
 const result=transfer.merge(existing,plan.changes,()=> 'new-id');
 assert.equal(result[0].id,'internal-1');assert.equal(result[0].phone,'0123');assert.equal(result[0].bankAccount,'000456');
 assert.equal(result[0].signature,'image');assert.equal(result[0].userUid,'account');assert.equal(existing[0].name,'Old Name');
});
test('new rows receive new internal IDs; unknown identity columns are ignored',()=>{
 const result=transfer.plan([['Full name','Staff ID','id','userUid'],['Person','0001','evil','evil']],[],fields);
 assert.equal(result.errors.length,0);
 const row=transfer.merge([],result.changes,()=> 'generated')[0];
 assert.equal(row.id,'generated');assert.equal(row.userUid,undefined);assert.equal(row.role,'Teacher');
});
test('duplicates, missing required values and conflicting headers block the import',()=>{
 for(const rows of [ [['Full name','Staff ID'],['A','001'],['B','001']], [['Full name','Staff ID'],['A','']], [['Full name','Staff ID','staffId'],['A','1','1']] ]) assert.ok(transfer.plan(rows,[],fields).errors.length);
 assert.ok(transfer.plan([['Full name','Staff ID'],['A','0012']],existing.concat(existing),fields).errors.length);
});
test('validates real dates and select fields without deleting records',()=>{
 const good=transfer.plan([['Full name','Staff ID','Date of Birth','Sex'],['A','123','2000-02-29','Female']],existing,fields);
 assert.equal(good.errors.length,0);assert.equal(good.changes[0].values.sex,'F');
 assert.equal(transfer.merge(existing,good.changes,()=> 'new').length,2);
 for(const date of ['2001-02-29','2026-13-01','01/02/2026']) assert.ok(transfer.plan([['Full name','Staff ID','Date of Birth'],['A','1',date]],[],fields).errors.length);
});
test('exported schema can be imported with every personnel field intact',()=>{
 const columns=transfer.columns(fields);
 const record={name:'A, B <C>',staffId:'00021',role:'Teacher',bankAccount:'00012345',phone:'+233200000000',email:'person@example.com'};
 const plan=transfer.plan([columns.map(f=>f.label),columns.map(f=>record[f.key]||'')],[],fields);
 assert.equal(plan.errors.length,0);
 const imported=transfer.merge([],plan.changes,()=> 'new')[0];
 for(const [key,value] of Object.entries(record))assert.equal(imported[key],value);
});
