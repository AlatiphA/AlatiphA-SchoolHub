const {test}=require('node:test'),assert=require('node:assert/strict');
const {register}=require('./school-operations');
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
function fixture(){
 const records=new Map([['users/head',{status:'active',role:'headteacher',schoolId:'s'}],['users/teacher',{status:'active',role:'teacher',schoolId:'s',displayName:'Teacher'}],['users/otherTeacher',{status:'active',role:'teacher',schoolId:'s'}],['users/disabled',{status:'disabled',role:'headteacher',schoolId:'s'}],['schools/s',{ownerUid:'head'}]]);
 const ref=(path,filters=[],order='',limit=Infinity)=>({path,filters,order,limitN:limit,collection:n=>ref(path+'/'+n),doc:n=>ref(path+'/'+n),where:(k,op,v)=>ref(path,[...filters,[k,v]],order,limit),orderBy:k=>ref(path,filters,k,limit),limit:n=>ref(path,filters,order,n)});
 let failCommit=false,tail=Promise.resolve();
 const db={collection:ref,runTransaction:fn=>{
  const result=tail.catch(()=>{}).then(async()=>{const writes=[];const tx={get:async r=>{assert.equal(writes.length,0,'transaction reads must precede writes');if(r.path.split('/').length%2===0)return {exists:records.has(r.path),data:()=>structuredClone(records.get(r.path))};let rows=[...records].filter(([k,v])=>k.startsWith(r.path+'/')&&k.split('/').length===r.path.split('/').length+1&&r.filters.every(([key,value])=>v[key]===value));if(r.order)rows.sort((a,b)=>String(b[1][r.order]).localeCompare(String(a[1][r.order])));return {docs:rows.slice(0,r.limitN).map(([k,v])=>({id:k.split('/').at(-1),data:()=>structuredClone(v)}))};},set:(r,v)=>writes.push([r.path,v])};const result=await fn(tx);if(failCommit)throw Error('Commit failed');writes.forEach(([p,v])=>records.set(p,structuredClone(v)));return result;});tail=result;return result;
 }};
 const handlers=register({db,HttpsError,onCall:(_,fn)=>fn,admin:{firestore:{FieldValue:{serverTimestamp:()=>123}}}});
 const req=(data,uid='head')=>({auth:uid?{uid}:null,data:{expectedUid:uid,expectedSchoolId:'s',requestId:'request-'+Math.random().toString(36).slice(2),...data}});
 const update=(data,uid)=>handlers.updateSchoolOperations(req(data,uid));
 const item=()=>update({action:'createItem',id:'stock-item-01',code:'BOOK',name:'Exercise books',unit:'pieces',category:'Stationery',quantityMilli:10000,minimumMilli:2000,unitCost:300});
 return {records,handlers,req,update,item,fail:()=>failCommit=true};
}
test('stock receives, issues and corrections preserve exact balances with a history',async()=>{
 const f=fixture();await f.item();await f.update({action:'receive',id:'stock-item-01',revision:0,quantityMilli:1500,reason:'Delivery 1'});await f.update({action:'issue',id:'stock-item-01',revision:1,quantityMilli:2500,reason:'Class 1'});await f.update({action:'adjust',id:'stock-item-01',revision:2,quantityMilli:-1000,reason:'Count correction'});assert.equal(f.records.get('schools/s/opItems/stock-item-01').quantityMilli,8000);assert.equal([...f.records.keys()].filter(x=>x.includes('/opHistory/')).length,4);
});
test('replayed stock mutation has one effect; altered request identifier payload is rejected',async()=>{
 const f=fixture();await f.item();const r=f.req({action:'issue',id:'stock-item-01',revision:0,quantityMilli:3000,reason:'Teacher'});const a=await f.handlers.updateSchoolOperations(r),b=await f.handlers.updateSchoolOperations(r);assert.deepEqual(a,b);assert.equal(f.records.get('schools/s/opItems/stock-item-01').quantityMilli,7000);await assert.rejects(f.handlers.updateSchoolOperations({...r,data:{...r.data,quantityMilli:1000}}),e=>e.code==='failed-precondition');
});
test('concurrent stale stock issues cannot overspend the same balance',async()=>{
 const f=fixture();await f.item();const outcomes=await Promise.allSettled([1,2].map(i=>f.update({action:'issue',id:'stock-item-01',revision:0,quantityMilli:7000,reason:'Issue '+i})));assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.records.get('schools/s/opItems/stock-item-01').quantityMilli,3000);
});
test('negative stock, invalid quantities and missing reasons make no changes',async()=>{
 const f=fixture();await f.item();const before=structuredClone([...f.records]);for(const changes of [{quantityMilli:11000},{quantityMilli:1.5},{quantityMilli:NaN},{reason:''}])await assert.rejects(f.update({action:'issue',id:'stock-item-01',revision:0,quantityMilli:1000,reason:'Issue',...changes}));assert.deepEqual([...f.records],before);
});
test('stock code and asset tag uniqueness are case insensitive',async()=>{
 const f=fixture();await f.item();await assert.rejects(f.update({action:'createItem',id:'stock-item-02',code:'book',name:'Duplicate',unit:'pieces',quantityMilli:0,minimumMilli:0,unitCost:0}),e=>e.code==='already-exists');
});
test('archival requires zero stock and no pending request',async()=>{
 const f=fixture();await f.item();const edit={action:'editItem',id:'stock-item-01',revision:0,name:'Books',category:'',minimumMilli:0,unitCost:0,active:false};await assert.rejects(f.update(edit));await f.update({action:'requestStock',itemId:'stock-item-01',quantityMilli:1000,purpose:'Lesson'},'teacher');await f.update({action:'issue',id:'stock-item-01',revision:0,quantityMilli:10000,reason:'All used'});await assert.rejects(f.update({...edit,revision:1}),/pending requests/);
});
test('teachers submit requests; approval issues once and notifies the requester',async()=>{
 const f=fixture();await f.item();await f.update({action:'requestStock',id:'request-record-01',itemId:'stock-item-01',quantityMilli:3000,purpose:'Lessons'},'teacher');const r=f.req({action:'approveRequest',id:'request-record-01',revision:0,reason:'Approved'});await f.handlers.updateSchoolOperations(r);await f.handlers.updateSchoolOperations(r);assert.equal(f.records.get('schools/s/opItems/stock-item-01').quantityMilli,7000);assert.equal(f.records.get('schools/s/opRequests/request-record-01').status,'approved');assert.equal([...f.records.keys()].filter(x=>x.startsWith('users/teacher/notifications/')).length,1);await assert.rejects(f.update({action:'approveRequest',id:'request-record-01',revision:1,reason:'Again'}));
});
test('approval checks both stock availability and current requester membership',async()=>{
 for(const revoked of [true,false]){const f=fixture();await f.item();await f.update({action:'requestStock',id:'request-record-01',itemId:'stock-item-01',quantityMilli:11000,purpose:'Lesson'},'teacher');if(revoked)f.records.set('users/teacher',{role:'teacher',status:'removed',schoolId:'s'});await assert.rejects(f.update({action:'approveRequest',id:'request-record-01',revision:0,reason:'Okay'}));assert.equal(f.records.get('schools/s/opItems/stock-item-01').quantityMilli,10000);}
});
test('cancellation belongs to requester and rejection never issues stock',async()=>{
 const f=fixture();await f.item();await f.update({action:'requestStock',id:'request-record-01',itemId:'stock-item-01',quantityMilli:1000,purpose:'Lesson'},'teacher');await assert.rejects(f.update({action:'cancelRequest',id:'request-record-01',revision:0,reason:'Cancel'},'otherTeacher'));await f.update({action:'rejectRequest',id:'request-record-01',revision:0,reason:'Unavailable'});assert.equal(f.records.get('schools/s/opItems/stock-item-01').quantityMilli,10000);
});
test('assets retain acquisition cost and require zero value when disposed',async()=>{
 const f=fixture();await f.update({action:'createAsset',id:'asset-record-01',code:'PC-1',name:'Computer',cost:100000,value:80000,purchasedOn:'2026-10-01',location:'Office',custodian:'Head'});await assert.rejects(f.update({action:'editAsset',id:'asset-record-01',revision:0,name:'Computer',condition:'poor',status:'disposed',value:100,reason:'Disposal'}));await f.update({action:'editAsset',id:'asset-record-01',revision:0,name:'Computer',condition:'poor',status:'disposed',value:0,reason:'Broken'});assert.equal(f.records.get('schools/s/opAssets/asset-record-01').cost,100000);
});
test('liability payments are exact and idempotent; reversal is recorded once',async()=>{
 const f=fixture();await f.update({action:'createLiability',id:'liability-0001',creditor:'Supplier',description:'Books',amount:10000,dueOn:'2026-10-31'});const r=f.req({action:'settle',id:'liability-0001',revision:0,amount:6000,reason:'Cash / REF1'}),payment=await f.handlers.updateSchoolOperations(r);await f.handlers.updateSchoolOperations(r);assert.equal(f.records.get('schools/s/opLiabilities/liability-0001').paid,6000);await assert.rejects(f.update({action:'settle',id:'liability-0001',revision:1,amount:5000,reason:'Overpay'}));await f.update({action:'reverseSettlement',paymentId:payment.paymentId,revision:1,reason:'Mistake'});assert.equal(f.records.get('schools/s/opLiabilities/liability-0001').paid,0);await assert.rejects(f.update({action:'reverseSettlement',paymentId:payment.paymentId,revision:2,reason:'Again'}));
});
test('liability amount cannot fall below payments and invalid dates are rejected',async()=>{
 const f=fixture();await f.update({action:'createLiability',id:'liability-0001',creditor:'Supplier',description:'Books',amount:10000,dueOn:'2026-10-31'});await f.update({action:'settle',id:'liability-0001',revision:0,amount:6000,reason:'Payment'});await assert.rejects(f.update({action:'editLiability',id:'liability-0001',revision:1,creditor:'Supplier',description:'Books',amount:5000,dueOn:'2026-10-31'}));await assert.rejects(f.update({action:'createLiability',creditor:'Supplier',description:'Books',amount:100,dueOn:'2026-02-30'}),e=>e.code==='invalid-argument');
});
test('teachers see only active catalogue and their own requests, never financial records',async()=>{
 const f=fixture();await f.item();await f.update({action:'requestStock',itemId:'stock-item-01',quantityMilli:1000,purpose:'Lesson'},'teacher');await f.update({action:'requestStock',itemId:'stock-item-01',quantityMilli:1000,purpose:'Other'},'otherTeacher');const data=await f.handlers.getSchoolOperations(f.req({},'teacher'));assert.equal(data.requests.length,1);assert.equal(Object.hasOwn(data.items[0],'unitCost'),false);assert.deepEqual(data.assets,[]);assert.deepEqual(data.liabilities,[]);assert.deepEqual(data.history,[]);
});
test('teachers cannot mutate managed balances or read another school',async()=>{
 const f=fixture();for(const action of ['createItem','receive','issue','createAsset','createLiability','settle','approveRequest','rejectRequest'])await assert.rejects(f.update({action},'teacher'),e=>e.code==='permission-denied');for(const uid of ['disabled',null])await assert.rejects(f.handlers.getSchoolOperations(f.req({},uid)));await assert.rejects(f.handlers.getSchoolOperations(f.req({expectedSchoolId:'other'})),e=>e.code==='failed-precondition');
});
test('membership changes stop replay of an already confirmed save',async()=>{
 const f=fixture();await f.item();const r=f.req({action:'issue',id:'stock-item-01',revision:0,quantityMilli:1000,reason:'Issue'});await f.handlers.updateSchoolOperations(r);f.records.set('users/head',{status:'active',role:'headteacher',schoolId:'other'});await assert.rejects(f.handlers.updateSchoolOperations(r),e=>e.code==='failed-precondition');
});
test('a new identity in the same school cannot execute a prior account pending request',async()=>{
 const f=fixture();await f.item();const old=f.req({action:'issue',id:'stock-item-01',revision:0,quantityMilli:1000,reason:'Old account'});f.records.set('users/new-head',{status:'active',role:'headteacher',schoolId:'s'});await assert.rejects(f.handlers.updateSchoolOperations({...old,auth:{uid:'new-head'}}),e=>e.code==='failed-precondition');assert.equal(f.records.get('schools/s/opItems/stock-item-01').quantityMilli,10000);
});
test('commit failure cannot partially change stock, history or retry receipt',async()=>{
 const f=fixture();await f.item();const before=structuredClone([...f.records]);f.fail();await assert.rejects(f.update({action:'issue',id:'stock-item-01',revision:0,quantityMilli:1000,reason:'Issue'}));assert.deepEqual([...f.records],before);
});
