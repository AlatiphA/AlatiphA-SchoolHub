const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const fees=fs.readFileSync('fees.js','utf8');
const css=fs.readFileSync('ui-polish.css','utf8');
function helpers(){
 const context={navigator:{},localStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},Map,Set,Promise,URL:{createObjectURL:()=>'',revokeObjectURL:()=>{}},Blob:function(){},document:{createElement:()=>({click(){}})},setTimeout(){},Date};
 vm.createContext(context);vm.runInContext(fees.split('window.addEventListener')[0],context);return context;
}

test('Arrears Management and Reminder Generator controls ship with responsive parent statement UI',()=>{
 for(const token of ['Arrears management','feeArrearsClass','feeArrearsCategory','feeArrearsMode','feeArrearsRows','Prepare selected reminders','Parent fee statements','feeStatementTiming','Reminder generator','feeReminderScope','feeReminderWhatsApp','feeReminderPrint'])assert.ok(fees.includes(token),token);
 for(const token of ['.fee-arrears-kpis','.fee-arrears-table','.fee-parent-details','.fee-reminder-notice','.fee-reminder-kpis'])assert.ok(css.includes(token),token);
});

test('arrears rows exclude settled, cancelled, future and test records by default',()=>{
 const c=helpers(),students=[{id:'s1',name:'Ama',classId:'c1',guardianName:'Amina',parentPhone:'0240000000'},{id:'s2',name:'Kojo',classId:'c2'}],classes=[{id:'c1',name:'B4'},{id:'c2',name:'B5'}],cats=new Map([['pta',{name:'PTA'}],['ict',{name:'ICT'}]]),charges=[
  {id:'a',studentId:'s1',classId:'c1',categoryId:'pta',itemName:'PTA',year:'2025/2026',term:'Term 3',baseAmount:10000,paid:2000},
  {id:'b',studentId:'s1',classId:'c1',categoryId:'ict',itemName:'ICT',year:'2026/2027',term:'Term 1',baseAmount:5000,paid:0},
  {id:'c',studentId:'s2',classId:'c2',categoryId:'pta',itemName:'Future',year:'2026/2027',term:'Term 2',baseAmount:7000,paid:0},
  {id:'d',studentId:'s2',classId:'c2',categoryId:'pta',itemName:'Test',year:'2025/2026',term:'Term 3',baseAmount:9000,paid:0,isTestData:true},
  {id:'e',studentId:'s2',classId:'c2',categoryId:'pta',itemName:'Paid',year:'2025/2026',term:'Term 3',baseAmount:4000,paid:4000},
  {id:'f',studentId:'s2',classId:'c2',categoryId:'pta',itemName:'Cancelled',year:'2025/2026',term:'Term 3',baseAmount:4000,paid:0,cancelled:true}
 ];
 const arrears=c.feeArrearsRows(charges,students,classes,cats,'2026/2027','Term 1',{mode:'arrears',dataMode:'production'});
 assert.equal(arrears.length,1);assert.equal(arrears[0].studentId,'s1');assert.equal(arrears[0].balance,8000);assert.equal(arrears[0].arrearsBalance,8000);assert.equal(arrears[0].currentBalance,0);
 const due=c.feeArrearsRows(charges,students,classes,cats,'2026/2027','Term 1',{mode:'due',dataMode:'production'});
 assert.equal(due.length,1);assert.equal(due[0].balance,13000);assert.equal(due[0].currentBalance,5000);
});

test('arrears filters cover class, category and guardian or phone search',()=>{
 const c=helpers(),students=[{id:'s1',name:'Ama',classId:'c1',guardianName:'Amina',parentPhone:'0241234567'}],classes=[{id:'c1',name:'B4'}],cats=new Map([['pta',{name:'PTA'}]]),charges=[{id:'a',studentId:'s1',classId:'c1',categoryId:'pta',itemName:'Levy',year:'2025/2026',term:'Term 3',baseAmount:10000,paid:0}];
 assert.equal(c.feeArrearsRows(charges,students,classes,cats,'2026/2027','Term 1',{mode:'arrears',dataMode:'production',classId:'c1',categoryId:'pta',search:'amina'}).length,1);
 assert.equal(c.feeArrearsRows(charges,students,classes,cats,'2026/2027','Term 1',{mode:'arrears',dataMode:'production',search:'024123'}).length,1);
 assert.equal(c.feeArrearsRows(charges,students,classes,cats,'2026/2027','Term 1',{mode:'arrears',dataMode:'production',classId:'other'}).length,0);
});

test('statement buckets separate previous arrears, current balance and future charges',()=>{
 const c=helpers(),rows=[
  {year:'2025/2026',term:'Term 3',baseAmount:10000,paid:3000},
  {year:'2026/2027',term:'Term 1',baseAmount:5000,paid:1000},
  {year:'2026/2027',term:'Term 2',baseAmount:8000,paid:0}
 ];
 assert.deepEqual(JSON.parse(JSON.stringify(c.feeStatementBuckets(rows,'2026/2027','Term 1'))),{arrears:7000,current:4000,future:8000});
});

test('parent reminder text is personalized and Ghana local phones normalize for WhatsApp',()=>{
 const c=helpers(),row={studentName:'Ama',className:'B4',guardianName:'Amina',parentPhone:'0241234567',balance:12000,arrearsBalance:12000,currentBalance:0,charges:[{itemName:'PTA',year:'2025/2026',term:'Term 3',baseAmount:12000,paid:0}]};
 const text=c.feeReminderText(row,{schoolName:'Test School'},{mode:'arrears',deadline:'2026-10-15',note:'Please contact the office.'});
 assert.match(text,/Dear Amina/);assert.match(text,/Ama \(B4\)/);assert.match(text,/GH₵ 120\.00/);assert.match(text,/2026-10-15/);assert.match(text,/Please contact the office/);
 assert.equal(c.feeWhatsAppDigits('024 123 4567'),'233241234567');assert.equal(c.feeWhatsAppDigits('+233 24 123 4567'),'233241234567');
});

test('parent statement rendering includes guardian contact and arrears/current summary',()=>{
 for(const token of ['Parent Fee Statement','Parent/Guardian:','Previous arrears','Current outstanding','feeStatementBuckets','settings.address','settings.email'])assert.ok(fees.includes(token),token);
});
