const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{webcrypto}=require('node:crypto');
const code=fs.readFileSync('school-operations.js','utf8');
function fixture(){
 const storage=new Map(),calls=[],c={console,crypto:webcrypto,currentUid:'u',currentSchoolId:'s',currentStatus:'active',sessionGeneration:1,sessionReady:true,sessionDataReady:true,offlineAuthenticatedMode:false,navigator:{onLine:true},isHeadTeacher:()=>true,FIREBASE_ENABLED:true,isCurrentSession:(g,u,s)=>g===c.sessionGeneration&&u===c.currentUid&&s===c.currentSchoolId,localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},document:{body:{},getElementById:()=>null,addEventListener(){}},MutationObserver:class{observe(){}},window:{},updateOfflineModeBanner(){},setTimeout,URL,Blob,safetyCall:async(name,d)=>calls.push({name,data:structuredClone(d)}),requestSchoolHubBackgroundSync:async()=>{}};
 vm.createContext(c);vm.runInContext(code,c);return {c,calls,storage};
}
test('quantity and money parsing retains precision and rejects invalid inputs',()=>{
 const f=fixture();assert.equal(f.c.operationsQuantity('1.125'),1125);assert.equal(f.c.operationsQuantity('-1.5',true),-1500);assert.equal(f.c.operationsMoney('12.34'),1234);for(const v of ['1e2','NaN','Infinity','1.2345','-1'])assert.throws(()=>f.c.operationsQuantity(v));for(const v of ['1.234','-1','Infinity'])assert.throws(()=>f.c.operationsMoney(v));
});
test('request is durable before submission and confirmation retires it',async()=>{
 const f=fixture();f.c.safetyCall=async(_,data)=>{assert.equal(f.c.operationsQueueRead()[0].request.requestId,data.requestId);f.calls.push(data);};await f.c.operationsSubmit('receive',{id:'stock-item-01',revision:0,quantityMilli:1000,reason:'Delivery'});assert.equal(f.calls.length,1);assert.equal(f.c.operationsQueueRead().length,0);
});
test('ambiguous network response retains the same identifier for safe retry',async()=>{
 const f=fixture();f.c.safetyCall=async(_,data)=>{f.calls.push(data);throw Object.assign(Error('network'),{code:'functions/unavailable'});};await assert.rejects(f.c.operationsSubmit('settle',{id:'liability-0001',revision:0,amount:100,reason:'Payment'}));assert.equal(f.c.operationsQueueRead().length,1);const original=f.calls[0].requestId;f.c.safetyCall=async(_,data)=>f.calls.push(data);await f.c.flushPendingSchoolOperationWrites();assert.equal(f.calls[1].requestId,original);assert.equal(f.c.operationsQueueRead().length,0);
});
test('a rejected save stays visible and cannot trigger a later transaction',async()=>{
 const f=fixture();f.c.safetyCall=async()=>{throw Object.assign(Error('Stale revision'),{code:'functions/aborted'});};await assert.rejects(f.c.operationsSubmit('issue',{id:'stock-item-01'}),/Stale revision/);assert.equal(f.c.operationsQueueRead()[0].error,'Stale revision');await assert.rejects(f.c.operationsSubmit('receive',{id:'stock-item-01'}),/pending save/);
});
test('offline entry and unverified session cannot create financial or stock writes',async()=>{
 for(const mode of ['offline','unverified']){const f=fixture();if(mode==='offline')f.c.navigator.onLine=false;else f.c.offlineAuthenticatedMode=true;await assert.rejects(f.c.operationsSubmit('settle',{}));assert.equal(f.calls.length,0);assert.equal(f.storage.size,0);}
});
test('storage failure stops upload before any server mutation',async()=>{
 const f=fixture();f.c.localStorage.setItem=()=>{throw Error('Quota exceeded');};await assert.rejects(f.c.operationsSubmit('issue',{}),/Quota/);assert.equal(f.calls.length,0);
});
test('account switch during confirmation retains old pending request and touches no new school',async()=>{
 const f=fixture();f.c.safetyCall=async()=>{f.c.currentSchoolId='other';f.c.sessionGeneration++;};await f.c.operationsSubmit('receive',{});assert.equal(JSON.parse(f.storage.get('schoolhub_operations_queue_s_u')).length,1);assert.equal(f.c.operationsQueueRead().length,0);
});
test('malformed local pending queue fails closed without sending or overwriting it',async()=>{
 const f=fixture();f.storage.set('schoolhub_operations_queue_s_u','{"broken":true}');await assert.rejects(f.c.operationsSubmit('receive',{}),/recovery/);assert.equal(f.calls.length,0);assert.equal(f.storage.get('schoolhub_operations_queue_s_u'),'{'+'"broken":true}');
});
test('double click cannot create two pending requests while confirmation is running',async()=>{
 const f=fixture();let release;f.c.safetyCall=()=>new Promise(r=>release=r);const p=f.c.operationsSubmit('receive',{});while(!release)await new Promise(r=>setImmediate(r));await assert.rejects(f.c.operationsSubmit('receive',{}),/current save/);release();await p;
});
test('manager assets are included in hosting, shell cache and navigation restoration',()=>{
 const app=fs.readFileSync('app-4.js','utf8'),html=fs.readFileSync('index.html','utf8'),sw=fs.readFileSync('sw.js','utf8');assert(app.includes("const views = ['operations'"));assert(app.includes('const allowed = views;'));assert(html.includes('id="view-operations"'));for(const file of ['school-operations.js','school-operations.css']){assert.equal(fs.readFileSync(file,'utf8'),fs.readFileSync('public/'+file,'utf8'));assert(sw.includes('./'+file));}assert(app.includes("if (typeof renderSchoolOperations === 'function') renderSchoolOperations();"));
});
test('stock save waits for ongoing online verification and confirms once',async()=>{
 const f=fixture();f.c.offlineAuthenticatedMode=true;let release;
 f.c.revalidateAndSyncAfterReconnect=()=>new Promise(r=>release=()=>{f.c.offlineAuthenticatedMode=false;r();});
 const save=f.c.operationsSubmit('receive',{id:'stock-item-01',quantityMilli:1000,reason:'Delivery'});
 assert.equal(f.calls.length,0);assert.equal(f.storage.size,0);release();await save;assert.equal(f.calls.length,1);assert.equal(f.c.operationsQueueRead().length,0);
});
test('failed verification keeps stock save unsent',async()=>{
 const f=fixture();f.c.offlineAuthenticatedMode=true;f.c.revalidateAndSyncAfterReconnect=async()=>{};
 await assert.rejects(f.c.operationsSubmit('issue',{}),/Connect to the internet/);assert.equal(f.calls.length,0);assert.equal(f.storage.size,0);
});
test('double confirmation during account verification cannot issue stock twice',async()=>{
 const f=fixture();f.c.offlineAuthenticatedMode=true;let release;f.c.revalidateAndSyncAfterReconnect=()=>new Promise(r=>release=()=>{f.c.offlineAuthenticatedMode=false;r();});
 const first=f.c.operationsSubmit('issue',{id:'stock-item-01',quantityMilli:1000,reason:'Lesson'});
 await assert.rejects(f.c.operationsSubmit('issue',{id:'stock-item-01',quantityMilli:1000,reason:'Lesson'}),/current save/);
 release();await first;assert.equal(f.calls.length,1);
});
