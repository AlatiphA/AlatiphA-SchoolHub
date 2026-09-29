const {test}=require('node:test');
const assert=require('node:assert/strict');
const {register,key}=require('./fees');
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
function fixture(){
 const records=new Map([
  ['users/head',{schoolId:'s',role:'headteacher',status:'active'}],
  ['users/teacher',{schoolId:'s',role:'teacher',status:'active',assignedClassIds:['c1']}],
  ['users/disabled',{schoolId:'s',role:'headteacher',status:'disabled'}],
  ['schools/s',{profile:{schoolName:'Test School',currentYear:'2026/2027',currentTerm:'Term 3'}}],
  ['schools/s/classes/c1',{name:'Class 1'}],['schools/s/classes/c2',{name:'Class 2'}],
  ['schools/s/students/p1',{name:'Ama',classId:'c1',isActive:true}],
  ['schools/s/students/p2',{name:'Kojo',classId:'c1',isActive:true}],
  ['schools/s/students/p3',{name:'Abena',classId:'c2',isActive:true}],
  ['schools/s/students/p4',{name:'Inactive',classId:'c2',isActive:false}]
 ]);
 let failCommit=false;
 const ref=path=>({path,collection:name=>ref(path+'/'+name),doc:id=>ref(path+'/'+id)});
 const get=async r=>{
  if(r.path.split('/').length%2===1){const depth=r.path.split('/').length+1;const docs=[...records].filter(([k])=>k.startsWith(r.path+'/')&&k.split('/').length===depth).map(([k,v])=>({id:k.split('/').at(-1),data:()=>structuredClone(v)}));return {docs};}
  return {exists:records.has(r.path),data:()=>structuredClone(records.get(r.path))};
 };
 const db={collection:ref,runTransaction:async fn=>{const writes=[];const tx={get,set:(r,v)=>writes.push(['set',r.path,structuredClone(v)]),update:(r,v)=>writes.push(['set',r.path,{...records.get(r.path),...structuredClone(v)}]),delete:r=>writes.push(['delete',r.path])};const result=await fn(tx);if(failCommit)throw Error('injected commit failure');for(const [op,path,value] of writes){if(op==='delete')records.delete(path);else records.set(path,value);}return result;}};
 const handlers=register({db,onCall:(_,fn)=>fn,HttpsError});
 return {records,handlers,req:(data,uid='head')=>({auth:{uid},data}),setFail:()=>{failCommit=true;}};
}
const rid=n=>'fis-request-'+String(n).padStart(8,'0');
async function category(f,name='Tuition',n=1,isTestData=false){const r=await f.handlers.updateSchoolFees(f.req({action:'createCategory',requestId:rid(n),name,description:name+' category',isTestData}));return r.categoryId;}
async function item(f,{categoryId,name='Term fee',term='Term 1',year='2026/2027',amount=30000,scopeType='class',classIds=['c1'],studentId='',isTestData=false,n=2}={}){return f.handlers.updateSchoolFees(f.req({action:'createFeeItem',requestId:rid(n),categoryId,name,term,year,amount,scopeType,classIds,studentId,isTestData}));}
function collection(records,name){return [...records].filter(([p])=>p.startsWith('schools/s/'+name+'/')).map(([p,v])=>({id:p.split('/').at(-1),...v}));}

test('reusable categories create fee items for one class, multiple classes, all classes and one pupil',async()=>{
 const f=fixture(),cat=await category(f);
 await assert.rejects(category(f,'tuition',9),e=>e.code==='already-exists');
 const one=await item(f,{categoryId:cat,n:2});assert.equal(one.created,2);
 const multi=await item(f,{categoryId:cat,name:'PTA',scopeType:'classes',classIds:['c1','c2'],n:3});assert.equal(multi.created,3);
 const all=await item(f,{categoryId:cat,name:'ICT',scopeType:'allClasses',classIds:[],n:4});assert.equal(all.created,3);
 const pupil=await item(f,{categoryId:cat,name:'Bus',scopeType:'pupil',classIds:[],studentId:'p3',n:5});assert.equal(pupil.created,1);
 const charges=collection(f.records,'pupilCharges');assert.equal(charges.length,9);assert.equal(charges.filter(x=>x.itemName==='Bus')[0].studentId,'p3');
});

test('fee item edits are revision-safe, preserve discounts and cannot reduce below payments or cancel paid charges',async()=>{
 const f=fixture(),cat=await category(f),created=await item(f,{categoryId:cat,n:2}),itemId=created.itemId;
 const charges=collection(f.records,'pupilCharges').filter(x=>x.feeItemId===itemId),charge=charges.find(x=>x.studentId==='p1');
 await f.handlers.updateSchoolFees(f.req({action:'adjustCharge',requestId:rid(3),chargeId:charge.id,revision:0,amount:-5000,reason:'Sibling discount'}));
 await f.handlers.updateSchoolFees(f.req({action:'editFeeItem',requestId:rid(4),itemId,revision:0,categoryId:cat,name:'Updated term fee',amount:25000,reason:'Correct approved amount'}));
 let saved=f.records.get('schools/s/pupilCharges/'+charge.id);assert.equal(saved.baseAmount,25000);assert.equal(saved.adjustment,-5000);
 await assert.rejects(f.handlers.updateSchoolFees(f.req({action:'editFeeItem',requestId:rid(5),itemId,revision:0,categoryId:cat,name:'Stale',amount:24000,reason:'stale'})),e=>e.code==='aborted');
 await f.handlers.updateSchoolFees(f.req({action:'recordPayment',requestId:rid(6),studentId:'p1',amount:10000,method:'Cash',payer:'Parent',allocationMode:'oldest-first'}));
 await assert.rejects(f.handlers.updateSchoolFees(f.req({action:'editFeeItem',requestId:rid(7),itemId,revision:1,categoryId:cat,name:'Too low',amount:10000,reason:'bad'})),e=>e.code==='failed-precondition');
 await assert.rejects(f.handlers.updateSchoolFees(f.req({action:'cancelFeeItem',requestId:rid(8),itemId,revision:1,reason:'cancel'})),e=>e.code==='failed-precondition');
});

test('oldest-first and manual payment allocations are exact, shown on receipts and reversible',async()=>{
 const f=fixture(),cat=await category(f);
 const old=await item(f,{categoryId:cat,name:'Old fee',term:'Term 1',amount:12000,scopeType:'pupil',classIds:[],studentId:'p1',n:2});
 const now=await item(f,{categoryId:cat,name:'Current fee',term:'Term 2',amount:20000,scopeType:'pupil',classIds:[],studentId:'p1',n:3});
 const oldCharge=collection(f.records,'pupilCharges').find(x=>x.feeItemId===old.itemId),nowCharge=collection(f.records,'pupilCharges').find(x=>x.feeItemId===now.itemId);
 const first=await f.handlers.updateSchoolFees(f.req({action:'recordPayment',requestId:rid(4),studentId:'p1',amount:15000,method:'Cash',payer:'Parent',allocationMode:'oldest-first'}));
 assert.deepEqual(first.payment.allocations.map(x=>[x.chargeId,x.amount]),[[oldCharge.id,12000],[nowCharge.id,3000]]);assert.equal(first.payment.balanceAfter,17000);
 const second=await f.handlers.updateSchoolFees(f.req({action:'recordPayment',requestId:rid(5),studentId:'p1',amount:7000,method:'Mobile Money',payer:'Parent',reference:'MOMO-1',allocationMode:'manual',allocations:[{chargeId:nowCharge.id,amount:7000}]}));
 assert.equal(second.payment.allocations[0].itemName,'Current fee');assert.equal(f.records.get('schools/s/pupilCharges/'+nowCharge.id).paid,10000);
 await assert.rejects(f.handlers.updateSchoolFees(f.req({action:'recordPayment',requestId:rid(6),studentId:'p1',amount:8000,method:'Cash',payer:'Parent',allocationMode:'manual',allocations:[{chargeId:nowCharge.id,amount:7000}]})),e=>e.code==='failed-precondition');
 await f.handlers.updateSchoolFees(f.req({action:'voidPayment',requestId:rid(7),paymentId:rid(5),reason:'Wrong receipt'}));assert.equal(f.records.get('schools/s/pupilCharges/'+nowCharge.id).paid,3000);assert.equal(f.records.get('schools/s/feePayments/'+rid(5)).voided,true);
});

test('legacy v40 accounts migrate without deletion and keep report balances exact',async()=>{
 const f=fixture(),id=key('Term 1','2025/2026','p1');f.records.set('schools/s/feeAccounts/'+id,{studentId:'p1',studentName:'Ama',classId:'c1',className:'Class 1',term:'Term 1',year:'2025/2026',base:30000,adjustment:-5000,paid:10000,revision:2,createdAt:'2025-01-01'});
 const before=structuredClone(f.records.get('schools/s/feeAccounts/'+id)),m=await f.handlers.updateSchoolFees(f.req({action:'migrateLegacy',requestId:rid(1)}));assert.equal(m.migrated,1);assert.deepEqual(f.records.get('schools/s/feeAccounts/'+id),before);
 const charge=f.records.get('schools/s/pupilCharges/'+id);assert.equal(charge.baseAmount,30000);assert.equal(charge.adjustment,-5000);assert.equal(charge.paid,10000);assert.equal(charge.isLegacy,true);
 const again=await f.handlers.updateSchoolFees(f.req({action:'migrateLegacy',requestId:rid(2)}));assert.equal(again.migrated,0);
 const report=await f.handlers.getReportFeeBalances(f.req({classId:'c1',term:'Term 3',year:'2026/2027'},'teacher'));assert.equal(report.balances.p1,15000);
});

test('new adjustments and payments on migrated charges remain mirrored to the v40 account',async()=>{
 const f=fixture(),id=key('Term 1','2026/2027','p1');f.records.set('schools/s/feeAccounts/'+id,{studentId:'p1',studentName:'Ama',classId:'c1',className:'Class 1',term:'Term 1',year:'2026/2027',base:30000,adjustment:0,paid:0,revision:0,createdAt:'2026-01-01'});
 await f.handlers.updateSchoolFees(f.req({action:'migrateLegacy',requestId:rid(1)}));
 await f.handlers.updateSchoolFees(f.req({action:'adjustCharge',requestId:rid(2),chargeId:id,revision:0,amount:-5000,reason:'Scholarship'}));assert.equal(f.records.get('schools/s/feeAccounts/'+id).adjustment,-5000);
 const payment=await f.handlers.updateSchoolFees(f.req({action:'recordPayment',requestId:rid(3),studentId:'p1',amount:10000,method:'Cash',payer:'Parent'}));assert.equal(f.records.get('schools/s/feeAccounts/'+id).paid,10000);
 await f.handlers.updateSchoolFees(f.req({action:'voidPayment',requestId:rid(4),paymentId:payment.payment.id,reason:'Correction'}));assert.equal(f.records.get('schools/s/feeAccounts/'+id).paid,0);
});

test('arrears are grouped by category and term with pupil due, paid and balance totals',async()=>{
 const f=fixture(),cat=await category(f);
 await item(f,{categoryId:cat,name:'T1',term:'Term 1',amount:10000,n:2});await item(f,{categoryId:cat,name:'T2',term:'Term 2',amount:20000,n:3});
 await f.handlers.updateSchoolFees(f.req({action:'recordPayment',requestId:rid(4),studentId:'p1',amount:15000,method:'Cash',payer:'Parent'}));
 const data=await f.handlers.getSchoolFees(f.req({})),t1=data.arrears.find(x=>x.term==='Term 1'),t2=data.arrears.find(x=>x.term==='Term 2');assert.deepEqual([t1.due,t1.paid,t1.balance,t1.pupilCount,t1.isArrear],[20000,10000,10000,2,true]);assert.deepEqual([t2.due,t2.paid,t2.balance,t2.pupilCount,t2.isArrear],[40000,5000,35000,2,true]);
});

test('test cleanup removes only flagged test fee data and leaves production records untouched',async()=>{
 const f=fixture(),prod=await category(f,'Production',1,false),testCat=await category(f,'Synthetic',2,true);
 await item(f,{categoryId:prod,name:'Production fee',n:3});await item(f,{categoryId:testCat,name:'Synthetic fee',isTestData:true,n:4});
 const beforeProd=collection(f.records,'pupilCharges').filter(x=>x.isTestData!==true).map(x=>x.id).sort();
 await assert.rejects(f.handlers.updateSchoolFees(f.req({action:'cleanupTestData',requestId:rid(5),confirmText:'DELETE'})),e=>e.code==='failed-precondition');
 const cleaned=await f.handlers.updateSchoolFees(f.req({action:'cleanupTestData',requestId:rid(6),confirmText:'CLEAN TEST DATA'}));assert.ok(cleaned.deleted>=4);
 assert.deepEqual(collection(f.records,'pupilCharges').filter(x=>x.isTestData!==true).map(x=>x.id).sort(),beforeProd);assert.equal(collection(f.records,'pupilCharges').some(x=>x.isTestData===true),false);assert.equal(collection(f.records,'feeCategories').some(x=>x.name==='Production'),true);
});

test('all v2 financial mutations require the active Head Teacher',async()=>{
 const f=fixture();
 for(const uid of ['teacher','disabled']){
  await assert.rejects(f.handlers.getSchoolFees(f.req({},uid)),e=>e.code==='permission-denied');
  await assert.rejects(f.handlers.updateSchoolFees(f.req({action:'createCategory',requestId:rid(uid==='teacher'?1:2),name:'Nope'},uid)),e=>e.code==='permission-denied');
 }
});
