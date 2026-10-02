const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const app=fs.readFileSync('app-4.js','utf8');
const fees=fs.readFileSync('fees.js','utf8');
const sw=fs.readFileSync('sw.js','utf8');

test('service worker registration manages lifecycle, update checks and diagnostics',()=>{
  for(const token of [
    "navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' })",
    "registration.addEventListener('updatefound'",
    "navigator.serviceWorker.addEventListener('controllerchange'",
    "checkSchoolHubServiceWorkerUpdate('periodic')",
    "document.addEventListener('visibilitychange'",
    'SCHOOLHUB_SW_ERROR_KEY',
    'Background Sync ${bgSync ? \'available\' : \'fallback mode\'}'
  ]) assert.ok(app.includes(token),token);
  assert.equal(app.includes("navigator.serviceWorker.register('sw.js').catch(() => {});"),false);
});

test('native Background Sync reuses existing SchoolHub queues and safeguards',()=>{
  for(const token of [
    "const SCHOOLHUB_BACKGROUND_SYNC_TAG = 'schoolhub-pending-sync-v1'",
    'registration.sync.register(SCHOOLHUB_BACKGROUND_SYNC_TAG)',
    "event.data.type !== 'SCHOOLHUB_BACKGROUND_SYNC'",
    "runSchoolHubBackgroundSync('service-worker')",
    'if (offlineAuthenticatedMode) await revalidateAndSyncAfterReconnect();',
    "requestSchoolHubBackgroundSync('local-write')"
  ]) assert.ok(app.includes(token),token);
  for(const token of [
    "window.flushPendingSchoolFeeWrites=flushPendingSchoolFeeWrites;",
    "requestSchoolHubBackgroundSync('fee-write')",
    "requestSchoolHubBackgroundSync('fee-flush-failed')"
  ]) assert.ok(fees.includes(token),token);
  for(const token of [
    "const BACKGROUND_SYNC_TAG = 'schoolhub-pending-sync-v1'",
    "self.addEventListener('sync'",
    "event.tag===BACKGROUND_SYNC_TAG",
    "SCHOOLHUB_BACKGROUND_SYNC_RESULT",
    "SCHOOLHUB_BACKGROUND_SYNC"
  ]) assert.ok(sw.includes(token),token);
});

test('background sync remains progressive enhancement, not a replacement for offline recovery',()=>{
  assert.ok(app.includes("window.addEventListener('online'"));
  assert.ok(app.includes('revalidateAndSyncAfterReconnect();'));
  assert.ok(app.includes('The durable outbox and the'));
  assert.ok(fees.includes("window.addEventListener('online'"));
  assert.match(sw,/schoolhub-cache-v40-profile-security-1/);
});

test('service worker sync event waits for a client acknowledgement',async()=>{
  const listeners={};let delivered=null,pending=null;
  const client={postMessage(message){delivered=message;setTimeout(()=>listeners.message({data:{type:'SCHOOLHUB_BACKGROUND_SYNC_RESULT',syncId:message.syncId,ok:true}}),0);}};
  const context={
    self:{location:{origin:'https://school.example',href:'https://school.example/sw.js'},clients:{matchAll:async()=>[client],claim:async()=>{}},addEventListener:(type,fn)=>{listeners[type]=fn;},skipWaiting:async()=>{}},
    caches:{open:async()=>({}),keys:async()=>[]},fetch:async()=>({ok:true,clone(){return this;}}),URL,setTimeout,clearTimeout,Promise,Map,Error,Date,Math
  };
  vm.createContext(context);vm.runInContext(sw,context);
  listeners.sync({tag:'schoolhub-pending-sync-v1',waitUntil(p){pending=p;}});
  await pending;
  assert.equal(delivered.type,'SCHOOLHUB_BACKGROUND_SYNC');
  assert.ok(delivered.syncId);
});

test('service worker leaves unrelated sync tags alone',()=>{
  const listeners={};let waited=false;
  const context={self:{location:{origin:'https://school.example',href:'https://school.example/sw.js'},clients:{matchAll:async()=>[],claim:async()=>{}},addEventListener:(type,fn)=>{listeners[type]=fn;},skipWaiting:async()=>{}},caches:{open:async()=>({}),keys:async()=>[]},fetch:async()=>({ok:true,clone(){return this;}}),URL,setTimeout,clearTimeout,Promise,Map,Error,Date,Math};
  vm.createContext(context);vm.runInContext(sw,context);
  listeners.sync({tag:'some-other-sync',waitUntil(){waited=true;}});
  assert.equal(waited,false);
});
