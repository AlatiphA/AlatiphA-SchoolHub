/* Live Classes reads: scoped listeners, confirmed deletions, no upload or form replacement. */
(()=>{
 let active=null,retryAt=0,blocked=null;
 const scope=()=>{const head=isHeadTeacher(),ids=head?null:[...classIdsForCloudSync()].map(String).sort();return {generation:sessionGeneration,uid:currentUid,school:currentSchoolId,head,ids,key:JSON.stringify([sessionGeneration,currentUid,currentSchoolId,head,ids])};};
 const ready=()=>FIREBASE_ENABLED&&currentUid&&currentSchoolId&&currentStatus==='active'&&sessionReady&&sessionDataReady&&!cloudHydrationInProgress&&!offlineAuthenticatedMode&&navigator.onLine!==false&&document.visibilityState==='visible';
 const valid=s=>active===s&&ready()&&isCurrentSession(s.generation,s.uid,s.school)&&scope().key===s.key;
 function notice(text=''){const el=document.getElementById('liveClassUpdateStatus');if(el){el.textContent=text;el.classList.toggle('hidden',!text);}}
 function stop(){const previous=active;active=null;if(previous)previous.unsubscribers.forEach(fn=>{try{fn();}catch(_){}});notice();}
 function editing(){const form=document.getElementById('addClassForm');return editingClassId!==null||(form&&!form.classList.contains('hidden'));}
 function apply(s){
  if(!valid(s)||!s.classesReady||!s.deletionsReady)return;
  const local=DB.get(KEYS.classes,[]),dirty=new Set(dirtyIdsFor(KEYS.classes).map(String));
  const cloud=[...s.records.values()],existing=new Set(cloud.map(x=>String(x.id)));
  const pending=new Map(local.filter(x=>dirty.has(String(x.id))).map(x=>[String(x.id),x]));
  const markers=s.deletions.filter(x=>x.collection==='classes'&&typeof x.id==='string'&&(s.head||s.ids.includes(localKeyFromCloudId(x.id)))&&!existing.has(localKeyFromCloudId(x.id))&&!dirty.has(localKeyFromCloudId(x.id)));
  const deleted=new Set(markers.map(x=>localKeyFromCloudId(x.id)));
  const next=mergeRecordsById(local,cloud).map(x=>pending.get(String(x.id))||x).filter(x=>!deleted.has(String(x.id)));
  if(editing()){notice(stableSyncJson(local)!==stableSyncJson(next)?'Class changes received. Finish or close the class form to display them.':'');return;}
  if(markers.length)rememberDeletions(markers);
  if(stableSyncJson(local)!==stableSyncJson(next)){
   backupLocalSchoolData('before-live-class-update');
   DB.set(KEYS.classes,next,{skipCloudSync:true});
   renderClasses();
   const home=document.getElementById('view-home');if(home&&!home.classList.contains('hidden'))renderHome();
  }
  notice();
 }
 function start(){
  if(!ready()){stop();return;}
  const context=scope(),verifiedAt=Number(revalidateAndSyncAfterReconnect.verifiedContext?.at||0);
  if(blocked&&blocked.key===context.key&&verifiedAt<=blocked.at)return;
  if(active&&active.key===context.key){apply(active);return;}
  if(Date.now()<retryAt)return;
  stop();const s={...context,unsubscribers:[],records:new Map(),seen:new Set(),deletions:[],classesReady:!context.head&&!context.ids.length,deletionsReady:false};active=s;
  const fail=error=>{
   if(active!==s)return;stop();
   const code=String(error?.code||'');
   if(/permission-denied|unauthenticated/.test(code))blocked={key:s.key,at:verifiedAt};
   else retryAt=Date.now()+10000;
   console.warn('Live class updates paused; saved records remain available:',error);
   notice('Live class updates are paused. Saved records remain available; reconnect or refresh your account to retry.');
  };
  const listen=(ref,receive)=>{
   const unsub=ref.onSnapshot({includeMetadataChanges:true},snapshot=>{
    if(!valid(s)||snapshot.metadata?.fromCache||snapshot.metadata?.hasPendingWrites)return;
    receive(snapshot);apply(s);
   },fail);
   if(active===s)s.unsubscribers.push(unsub);else unsub();
  };
  try{
   const ref=schoolRef();
   listen(ref.collection('deletedRecords').where('collection','==','classes'),snapshot=>{s.deletions=[];snapshot.forEach(d=>s.deletions.push(d.data()));s.deletionsReady=true;});
   if(s.head)listen(ref.collection('classes'),snapshot=>{s.records.clear();snapshot.forEach(d=>s.records.set(d.id,{...d.data(),id:d.id}));s.classesReady=true;});
   else s.ids.forEach(id=>listen(ref.collection('classes').doc(id),snapshot=>{s.records.delete(id);if(snapshot.exists)s.records.set(id,{...snapshot.data(),id});s.seen.add(id);s.classesReady=s.seen.size===s.ids.length;}));
  }catch(error){fail(error);}
 }
 window.startLiveClassSync=start;window.stopLiveClassSync=stop;
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')stop();else start();});
 window.addEventListener('offline',stop);window.addEventListener('online',start);
 // No repeated reads for a healthy subscription. This only reattaches failed
 // listeners or applies buffered updates once a class form has closed.
 setInterval(start,10000);
 start();
})();

