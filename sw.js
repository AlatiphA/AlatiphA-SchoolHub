// AlatiphA SchoolHub service worker: cache static assets only.
const CACHE_NAME = 'schoolhub-cache-v40-dialog-close-sizing-1';
const APP_SHELL = ['./','./index.html','./faq.html','./privacy.html','./terms.html','./install.js','./style-3.css','./ui-polish.css','./app-4.js','./offline-drafts.js','./staff-transfer.js','./staff-qualifications.js','./account-security.js','./fees.js','./school-operations.js','./live-class-sync.js','./school-operations.css','./sync-queue.js','./sync-client.js','./sync-worker.js','./firebase-config.js','./manifest.json','./icon.svg','./icon-192.png','./icon-512.png','./icon-512-maskable.png','./apple-touch-icon.png'];
const CORE_FILES = /\/(?:app-4|staff-transfer|firebase-config|install)\.js$|\/(?:style-3|ui-polish)\.css$|\/index\.html$/;
const BACKGROUND_SYNC_TAG = 'schoolhub-pending-sync-v1';
if (typeof importScripts === 'function') importScripts('./sync-queue.js','./sync-worker.js');
const backgroundSyncWaiters = new Map();
self.addEventListener('message',e=>{
  if(e.data?.type==='SKIP_WAITING')self.skipWaiting();
  if(e.data?.type==='SCHOOLHUB_BACKGROUND_SYNC_RESULT'&&e.data.syncId){
    const waiter=backgroundSyncWaiters.get(e.data.syncId);if(waiter&&(!waiter.clientId||!e.source?.id||e.source.id===waiter.clientId)){backgroundSyncWaiters.delete(e.data.syncId);e.data.ok?waiter.resolve():waiter.reject(new Error('Client sync did not complete'));}
  }
});
async function dispatchBackgroundSyncToClient(){
  const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  if(!windows.length)throw new Error('No active SchoolHub client is available yet.');
  const syncId=`${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const completion=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{backgroundSyncWaiters.delete(syncId);reject(new Error('Background sync acknowledgement timed out'));},25000);backgroundSyncWaiters.set(syncId,{clientId:windows[0].id,resolve:()=>{clearTimeout(timer);resolve();},reject:error=>{clearTimeout(timer);reject(error);}});});
  // One client owns the acknowledgement; other tabs cannot reject a successful save.
  windows[0].postMessage({type:'SCHOOLHUB_BACKGROUND_SYNC',syncId});
  return completion;
}
self.addEventListener('sync',event=>{if(event.tag===BACKGROUND_SYNC_TAG)event.waitUntil((async()=>{
  if (self.SchoolHubSyncWorker) {
    const completed = await self.SchoolHubSyncWorker.run();
    if (completed) return;
  }
  await dispatchBackgroundSyncToClient();
})());});self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    if(windows.length){
      const client=windows[0];
      if(typeof client.focus==='function')await client.focus();
      client.postMessage({type:'OPEN_NOTIFICATIONS'});
      return;
    }
    if(self.clients.openWindow)await self.clients.openWindow('./?notifications=1');
  })());
});
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE_NAME).then(async cache=>{
  for(const url of APP_SHELL){const response=await fetch(url,{cache:'reload'});if(!response.ok)throw new Error('Incomplete app shell');await cache.put(url,response);}
}).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('schoolhub-cache-')&&k!==CACHE_NAME).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
async function networkFirst(request){const cache=await caches.open(CACHE_NAME);try{const response=await fetch(request,{cache:'no-store'});if(!response.ok)throw new Error('Network response failed');await cache.put(request,response.clone());return response;}catch(error){const cached=await cache.match(request,{ignoreSearch:true});if(cached)return cached;if(request.mode==='navigate'){const fallback=await cache.match('./index.html');if(fallback)return fallback;}throw error;}}
async function cacheFirst(request){const cache=await caches.open(CACHE_NAME);const cached=await cache.match(request);if(cached)return cached;const response=await fetch(request);if(response.ok)await cache.put(request,response.clone());return response;}
self.addEventListener('fetch',event=>{const request=event.request;if(request.method!=='GET')return;const url=new URL(request.url);const sameOrigin=url.origin===self.location.origin;
  const shell=sameOrigin&&(request.mode==='navigate'||APP_SHELL.some(p=>new URL(p,self.location.href).pathname===url.pathname));
  const library=(url.hostname==='www.gstatic.com'&&url.pathname.startsWith('/firebasejs/'))||(url.hostname==='cdnjs.cloudflare.com'&&url.pathname.startsWith('/ajax/libs/'));
  if(!shell&&!library)return;
  event.respondWith(shell?networkFirst(request):cacheFirst(request));
});
