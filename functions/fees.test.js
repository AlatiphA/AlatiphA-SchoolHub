const {test}=require('node:test');const assert=require('node:assert/strict');
const {register,key}=require('./fees');
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
 const db={collection:ref,runTransaction:async fn=>{const writes=[];const tx={get,set:(r,v)=>writes.push(['set',r.path,v]),create:(r,v)=>{if(records.has(r.path))throw Error('already exists');writes.push(['set',r.path,v]);},update:(r,v)=>writes.push(['set',r.path,{...records.get(r.path),...v}]),delete:r=>writes.push(['delete',r.path])};const result=await fn(tx);if(failCommit)throw Error('injected commit failure');writes.forEach(([op,k,v])=>{if(op==='delete')records.delete(k);else records.set(k,v);});return result;}};
 const firestore={FieldValue:{serverTimestamp:()=>123}};
 const handlers=register({db,onCall:(_,fn)=>fn,HttpsError,admin:{firestore}});
 return {records,handlers,setFail:()=>failCommit=true,req:(data,uid='head')=>({auth:{uid},data})};
}
const reqId=n=>'request-identifier-'+n;
async function charged(){const f=fixture();await f.handlers.updateSchoolFees(f.req({action:'classFee',requestId:reqId(1),classId:'c1',term:'Term 1',year:'2026/2027',amount:30000}));return f;}
const accountId=key('Term 1','2026/2027','p1');
test('class fees are applied once and individual discounts stay intact',async()=>{
 const f=await charged();
 await f.handlers.updateSchoolFees(f.req({action:'adjust',requestId:reqId(2),accountId,revision:0,amount:-5000,reason:'Sibling discount'}));
 await f.handlers.updateSchoolFees(f.req({action:'classFee',requestId:reqId(3),classId:'c1',term:'Term 1',year:'2026/2027',amount:40000}));
 const a=f.records.get('schools/s/feeAccounts/'+accountId);assert.equal(a.base,30000);assert.equal(a.adjustment,-5000);
 await assert.rejects(f.handlers.updateSchoolFees(f.req({action:'adjust',requestId:reqId(4),accountId,revision:0,amount:-1000,reason:'Stale edit'})),e=>e.code==='aborted');
});
test('payment retries issue one receipt and void restores the balance once',async()=>{
 const f=await charged(),r=f.req({action:'payment',requestId:reqId(2),accountId,amount:10000,method:'Cash',payer:'Parent',reference:''});
 const first=await f.handlers.updateSchoolFees(r),again=await f.handlers.updateSchoolFees(r);assert.deepEqual(first,again);assert.equal(first.payment.receipt,'FEE-000001');
 assert.equal(f.records.get('schools/s/feeAccounts/'+accountId).paid,10000);
 await assert.rejects(f.handlers.updateSchoolFees(f.req({...r.data,requestId:reqId(3),amount:25000})),e=>e.code==='failed-precondition');
 await f.handlers.updateSchoolFees(f.req({action:'void',requestId:reqId(4),accountId,paymentId:reqId(2),reason:'Entered twice in error'}));
 assert.equal(f.records.get('schools/s/feeAccounts/'+accountId).paid,0);assert.equal(f.records.get('schools/s/feePayments/'+reqId(2)).voided,true);
 await assert.rejects(f.handlers.updateSchoolFees(f.req({action:'void',requestId:reqId(5),accountId,paymentId:reqId(2),reason:'Again'})),e=>e.code==='failed-precondition');
});
test('fees require an active head and reject invalid amounts without writes',async()=>{
 const f=await charged(),before=structuredClone([...f.records]);
 for(const uid of ['teacher','disabled']){
  await assert.rejects(f.handlers.getSchoolFees(f.req({},uid)),e=>e.code==='permission-denied');
  await assert.rejects(f.handlers.updateSchoolFees(f.req({},uid)),e=>e.code==='permission-denied');
 }
 for(const amount of [-1,0,1.5,Infinity,30001])await assert.rejects(f.handlers.updateSchoolFees(f.req({action:'payment',requestId:reqId(2),accountId,amount,method:'Cash',payer:'Parent'})));
 assert.deepEqual([...f.records],before);
});
test('old term balances survive new term charges and pupil deletion',async()=>{
 const f=await charged();await f.handlers.updateSchoolFees(f.req({action:'classFee',requestId:reqId(2),classId:'c1',term:'Term 2',year:'2026/2027',amount:35000}));
 f.records.delete('schools/s/students/p1');const result=await f.handlers.getSchoolFees(f.req({}));assert.equal(result.accounts.length,2);assert.equal(result.accounts[0].studentName,'Pupil');
});
test('failed transaction does not issue a receipt or alter balances',async()=>{
 const f=await charged(),before=structuredClone([...f.records]);f.setFail();await assert.rejects(f.handlers.updateSchoolFees(f.req({action:'payment',requestId:reqId(2),accountId,amount:10000,method:'Cash',payer:'Parent'})),/injected/);assert.deepEqual([...f.records],before);
});

test('fee editing and cancellation preserve paid money and reject stale changes',async()=>{
 const f=await charged(),call=d=>f.handlers.updateSchoolFees(f.req(d));
 await call({action:'edit',requestId:reqId(10),accountId,revision:0,amount:20000,reason:'Correct test'});
 await assert.rejects(call({action:'cancel',requestId:reqId(11),accountId,revision:0,reason:'Stale'}),e=>e.code==='aborted');
 await call({action:'payment',requestId:reqId(12),accountId,amount:5000,method:'Cash',payer:'Parent'});
 await assert.rejects(call({action:'cancel',requestId:reqId(13),accountId,revision:2,reason:'Remove'}),e=>e.code==='failed-precondition');
 await call({action:'void',requestId:reqId(14),accountId,paymentId:reqId(12),reason:'Test payment'});
 const request={action:'cancel',requestId:reqId(15),accountId,revision:3,reason:'Remove test'};
 await call(request);await call(request);
 const a=f.records.get('schools/s/feeAccounts/'+accountId);assert.equal(a.base,0);assert.equal(a.paid,0);assert.equal(a.cancelled,true);assert.equal(a.revision,4);
});
test('class edits preserve discounts and cancellation is atomic when one pupil has paid',async()=>{
 const f=await charged(),call=d=>f.handlers.updateSchoolFees(f.req(d));
 await call({action:'adjust',requestId:reqId(10),accountId,revision:0,amount:-5000,reason:'Discount'});
 await call({action:'reviseClass',requestId:reqId(11),classId:'c1',term:'Term 1',year:'2026/2027',amount:25000,reason:'Correction',revisions:{[accountId]:1}});
 assert.equal(f.records.get('schools/s/feeAccounts/'+accountId).adjustment,-5000);
 await call({action:'payment',requestId:reqId(12),accountId,amount:5000,method:'Cash',payer:'Parent'});
 const before=structuredClone([...f.records]);
 await assert.rejects(call({action:'cancelClass',requestId:reqId(13),classId:'c1',term:'Term 1',year:'2026/2027',reason:'Test',revisions:{[accountId]:3}}),e=>e.code==='failed-precondition');assert.deepEqual([...f.records],before);
});
test('new year payments clear oldest debt without duplicating charges and void reverses allocations',async()=>{
 const f=await charged(),call=d=>f.handlers.updateSchoolFees(f.req(d));
 await call({action:'classFee',requestId:reqId(10),classId:'c1',term:'Term 1',year:'2027/2028',amount:20000});
 const current=key('Term 1','2027/2028','p1');
 const r=await call({action:'payment',requestId:reqId(11),accountId:current,amount:40000,method:'Cash',payer:'Parent'});
 assert.equal(r.payment.balanceAfter,10000);assert.deepEqual(r.payment.allocations,[{accountId,amount:30000},{accountId:current,amount:10000}]);
 assert.equal(f.records.get('schools/s/feeAccounts/'+accountId).paid,30000);assert.equal(f.records.get('schools/s/feeAccounts/'+current).paid,10000);
 await call({action:'void',requestId:reqId(12),accountId:current,paymentId:reqId(11),reason:'Test'});
 assert.equal(f.records.get('schools/s/feeAccounts/'+accountId).paid,0);assert.equal(f.records.get('schools/s/feeAccounts/'+current).paid,0);
});

test('report balances include arrears and payments, exclude future terms and unrelated pupils',async()=>{
 const f=await charged(),call=d=>f.handlers.updateSchoolFees(f.req(d));
 await call({action:'classFee',requestId:reqId(30),classId:'c1',term:'Term 1',year:'2027/2028',amount:20000});
 await call({action:'payment',requestId:reqId(31),accountId,amount:5000,method:'Cash',payer:'Private parent'});
 const d={classId:'c1',term:'Term 1',year:'2026/2027'};
 const result=await f.handlers.getReportFeeBalances(f.req(d,'teacher'));assert.deepEqual(result,{balances:{p1:25000}});
 assert.deepEqual(await f.handlers.getReportFeeBalances(f.req({...d,year:'2027/2028'})),{balances:{p1:45000}});
 for(const uid of ['teacher','disabled'])await assert.rejects(f.handlers.getReportFeeBalances(f.req({...d,classId:'c2'},uid)),e=>e.code==='permission-denied');
});
test('managed zero balance overrides manual fees and cancellations remain visible',async()=>{
 const f=await charged();await f.handlers.updateSchoolFees(f.req({action:'cancel',accountId,revision:0,requestId:reqId(32),reason:'Test'}));
 assert.deepEqual(await f.handlers.getReportFeeBalances(f.req({classId:'c1',term:'Term 1',year:'2026/2027'})),{balances:{p1:0}});
 const vm=require('node:vm'),fs=require('node:fs'),source=fs.readFileSync(require('node:path').join(__dirname,'../fees.js'),'utf8');const body=source.slice(source.indexOf('function reportFeeRemarks('),source.indexOf('async function refreshRemarksFeeBalance('));
 const ctx={};vm.createContext(ctx);vm.runInContext(body,ctx);assert.equal(ctx.reportFeeRemarks({feesDue:'90'},'p1',{balances:{p1:0}}).feesDue,'0.00');assert.equal(ctx.reportFeeRemarks({feesDue:'90'},'p2',{balances:{p1:0}}).feesDue,'90');
});

test('background fee context keeps original payment idempotency fingerprint',async()=>{const f=await charged(),input={action:'payment',requestId:reqId(720),accountId,amount:1000,method:'Cash',payer:'Parent',reference:''};await f.handlers.updateSchoolFees(f.req(input));const first=f.records.get('schools/s/feeEvents/'+input.requestId);await f.handlers.updateSchoolFees(f.req({...input,expectedSchoolId:'s'}));assert.deepEqual(f.records.get('schools/s/feeEvents/'+input.requestId),first);await assert.rejects(f.handlers.updateSchoolFees(f.req({...input,expectedSchoolId:'other'})),e=>e.code==='failed-precondition');});
