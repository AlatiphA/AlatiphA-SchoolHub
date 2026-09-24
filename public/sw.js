// AlatiphA SchoolHub service worker: cache static assets only.
const CACHE_NAME = 'schoolhub-cache-v40-bulk-staff-attendance-5-subjects-layout-1';
const APP_SHELL = ['./','./index.html','./faq.html','./privacy.html','./terms.html','./install.js','./style-3.css','./ui-polish.css','./app-4.js','./staff-transfer.js','./firebase-config.js','./manifest.json','./icon.svg','./icon-192.png','./icon-512.png','./icon-512-maskable.png','./apple-touch-icon.png'];
const CORE_FILES = /\/(?:app-4|staff-transfer|firebase-config|install)\.js$|\/(?:style-3|ui-polish)\.css$|\/index\.html$/;
self.addEventListener('message',e=>{if(e.data?.type==='SKIP_WAITING')self.skipWaiting();});
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
