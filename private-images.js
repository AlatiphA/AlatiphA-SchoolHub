(function(root){
 'use strict';
 const MAX_BYTES=10*1024*1024;
 function reference(options){
  const {storage,schoolId,storagePath,legacyUrl}=options;
  if(!schoolId||/[\/]/.test(schoolId))throw Error('A current school is required for private images.');
  const item=storagePath?storage.ref(storagePath):storage.refFromURL(legacyUrl||'');
  const bucket=storage.ref().bucket;
  if(item.bucket!==bucket||!String(item.fullPath||'').startsWith('schools/'+schoolId+'/'))throw Error('Image does not belong to this school and Storage bucket.');
  return item;
 }
 async function read(options){
  const {auth,uid,isCurrent,fetchImpl=root.fetch.bind(root),endpoint}=options;
  const item=reference(options),check=()=>{if(!uid||auth.currentUser?.uid!==uid||!isCurrent())throw Error('The image account or school changed.');};check();
  let controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  try{
   const token=await Promise.race([auth.currentUser.getIdToken(),new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('Private image request timed out.')),{once:true}))]);check();
   const base=endpoint||'https://firebasestorage.googleapis.com';
   // Emulator endpoint overrides are test-only; production tokens always go to Firebase.
   if(endpoint&&!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint))throw Error('Invalid private-image test endpoint.');
   const url=base+'/v0/b/'+encodeURIComponent(item.bucket)+'/o/'+encodeURIComponent(item.fullPath)+'?alt=media';
   const response=await fetchImpl(url,{method:'GET',headers:{Authorization:'Firebase '+token},credentials:'omit',cache:'no-store',signal:controller.signal});check();
   if(!response.ok)throw Error('Private image access failed (HTTP '+response.status+').');
   const declared=Number(response.headers.get('content-length')||0);if(declared>MAX_BYTES)throw Error('Image exceeds the download limit.');
   const blob=await response.blob();check();if(!blob.size||blob.size>MAX_BYTES)throw Error('Image is empty or exceeds the download limit.');return blob;
  }finally{clearTimeout(timer);controller.abort();}
 }
 const api={reference,read,MAX_BYTES};if(typeof module==='object'&&module.exports)module.exports=api;root.SchoolHubPrivateImages=api;
})(typeof window==='object'?window:globalThis);
