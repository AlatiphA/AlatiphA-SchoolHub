/* Automatic server refresh for areas without dedicated live subscriptions. */
(()=>{
 let lastFailure=false,lastChecked=0,gateAt=0,context='',account='',busy=false,nextAt=0,baseline=new WeakMap(),deferred=null;
 const controls=()=>Array.from(document.querySelectorAll('main input,main select,main textarea')).filter(e=>e.getClientRects().length&&!e.disabled&&!e.readOnly&&e.type!=='search'&&!/search|filter|^(attendanceDate|teacherAttendanceDate)$|ClassSelect$|YearSelect$|TermSelect$/i.test(e.id||''));
 const value=e=>e.type==='checkbox'||e.type==='radio'?String(e.checked):e.type==='file'?String(e.files?.length||0):String(e.value);
 function capture(){for(const e of controls())if(!baseline.has(e))baseline.set(e,value(e));}
 function editing(){capture();return !!document.querySelector('dialog[open],[role="dialog"]:not(.hidden):not([hidden]),.modal:not(.hidden),#profileDropdown:not(.hidden)')||controls().some(e=>baseline.get(e)!==value(e));}
 function status(info={}){
  const result=(label,state,detail)=>({label,state,detail});
  if(info.hydrationFailed&&!info.writeFailed)return result('Updates paused','error','School data could not be refreshed. Saved work is retained; reconnect or use Sync Center to retry.');
  if(info.failed)return result('Needs review','error','A saved change or connection needs attention. Open Sync Center; keep browser data intact.');
  if(navigator.onLine===false||info.offline)return result('Offline','offline','Saved work stays on this device. Updates resume after connection and account verification.');
  if(info.pending)return result(info.pending+' pending','pending','Saved on this device; waiting for cloud confirmation.');
  if(editing())return result('Updates paused','paused','Finish or save your edits, or close the open dialog/menu, to resume automatic updates.');
  if(info.waiting||info.checking&&!info.quietRecovery)return result('Reconnecting','pending','Checking school access before receiving or sending updates.');
  if(info.loading)return result('Connecting','pending','Loading and verifying school data before updates can be confirmed.');
  if(lastFailure)return result('Updates paused','paused','The last refresh failed. Saved work is retained; SchoolHub will retry automatically.');
  return result('Connected','saved','Automatic updates are connected. Other areas refresh about every 30 seconds while visible.'+(lastChecked?' Last successful refresh: '+new Date(lastChecked).toLocaleTimeString()+'.':''));
 }
 function paint(){if(typeof updateOfflineModeBanner==='function')updateOfflineModeBanner();}
 const key=()=>JSON.stringify([sessionGeneration,currentUid,currentSchoolId,currentVisibleViewName()]);
 const ready=()=>FIREBASE_ENABLED&&currentUid&&currentSchoolId&&currentStatus==='active'&&sessionReady&&sessionDataReady&&!cloudHydrationInProgress&&!offlineAuthenticatedMode&&navigator.onLine!==false&&document.visibilityState==='visible';
 const original=window.refreshAfterReconnectWhenMenuCloses;
 if(typeof original==='function')window.refreshAfterReconnectWhenMenuCloses=function(refresh){return original(()=>{if(editing()){deferred=refresh;return;}refresh();baseline=new WeakMap();capture();});};
 async function refreshCore(scope){
  if(typeof schoolRef!=='function')return;
  const view=currentVisibleViewName(),valid=()=>ready()&&key()===scope&&!editing(),head=isHeadTeacher();
  // Existing live listeners already cover pupils, grades, attendance and classes.
  const profile=await schoolRef().get();if(!valid())return;
  if(profile.exists){const before=DB.get(KEYS.settings,{}),next={...before,...(profile.data().profile||{})};if(before.logo)next.logo=before.logo;if(stableSyncJson(before)!==stableSyncJson(next)){mergeCloudCollection('settings',next,true);if(view==='setup')loadSettingsForm();}}
  const field=view==='staff'&&head?'staff':view==='subjects'?'subjects':view==='remarks'?'remarks':null;
  if(!field)return;
  let snapshot;if(field==='staff')snapshot=await pullStaffForAccess(true);
  else if(field==='remarks')snapshot=await pullRemarksForAccess(head,head?null:classIdsForCloudSync());
  else snapshot=await pullSubcollection('subjects',head||(currentUserData?.formClassIds||[]).some(id=>canAccessClass(id))?null:new Set(currentAssignedSubjectIds||[]));
  if(!valid())return;
  const incoming=field==='remarks'?{}:[];
  snapshot.forEach(doc=>{if(field==='remarks')incoming[localKeyFromCloudId(doc.id)]=doc.data().entries||{};else incoming.push(field==='staff'?mergeLocalImage('staff',doc.data(),doc.id):{...doc.data(),id:doc.id});});
  const deleted=await schoolRef().collection('deletedRecords').where('collection','==',field).get();if(!valid())return;
  const markers=[];deleted.forEach(doc=>markers.push(doc.data()));
  const before=stableSyncJson(DB.get(KEYS[field],field==='remarks'?{}:[]));mergeCloudCollection(field,incoming,head);
  const dirty=new Set(dirtyIdsFor(KEYS[field]).map(String)),present=new Set(field==='remarks'?Object.keys(incoming):incoming.map(x=>String(x.id)));
  const removed=new Set(markers.map(m=>localKeyFromCloudId(m.id)).filter(id=>!dirty.has(id)&&!present.has(id)));
  if(removed.size){if(backupLocalSchoolData('before-automatic-'+field+'-deletion')!==false){const all=DB.get(KEYS[field],field==='remarks'?{}:[]);if(Array.isArray(all))DB.set(KEYS[field],all.filter(x=>!removed.has(String(x.id))),{skipCloudSync:true});else{const next={...all};removed.forEach(id=>delete next[id]);DB.set(KEYS[field],next,{skipCloudSync:true});}}}

  if(before!==stableSyncJson(DB.get(KEYS[field],{}))){if(field==='staff')renderStaff();else if(field==='subjects')renderSubjects();}
 }
 async function activeView(){const scope=key(),canRefresh=()=>ready()&&key()===scope&&!editing();const view=currentVisibleViewName();
  if(view==='fees'&&typeof renderSchoolFees==='function')await renderSchoolFees({silent:true,canRefresh});
  else if(view==='billing'&&typeof renderBilling==='function'){const data=await manualBillingCall('getSchoolManualBilling',{expectedSchoolId:currentSchoolId});if(canRefresh())await renderManualSchoolBilling(document.getElementById('billingWrap'),undefined,data);}
  else if(view==='supervision'&&typeof renderWeeklySupervision==='function')await renderWeeklySupervision(true,canRefresh);
  else if(view==='manage-teachers')await renderManageTeachers({canRefresh});
  else if(view==='remarks')renderRemarksForm();

 }
 async function tick(){
  paint();
  if(FIREBASE_ENABLED&&['pending','disabled','suspended'].includes(currentStatus)&&navigator.onLine!==false&&document.visibilityState==='visible'&&Date.now()>=gateAt){
   gateAt=Date.now()+30000;const user=firebase.auth().currentUser,uid=currentUid,status=currentStatus;
   if(user?.uid===uid)try{const snap=await firebase.firestore().collection('users').doc(uid).get({source:'server'});let data=snap.data();if(window.SchoolHubServiceAccess)data=await SchoolHubServiceAccess.verify(data);if(firebase.auth().currentUser?.uid===uid&&currentStatus===status&&data?.status==='active'&&data.schoolId)window.location.reload();}catch(_){}
   return;
  }
  if(!ready())return;const identity=JSON.stringify([sessionGeneration,currentUid,currentSchoolId]);if(identity!==account){account=identity;lastFailure=false;lastChecked=0;}const current=key();if(current!==context){context=current;baseline=new WeakMap();capture();nextAt=Date.now()+30000;deferred=null;return;}
  if(busy||editing())return;
  if(deferred){const refresh=deferred;deferred=null;refresh();baseline=new WeakMap();capture();}
  if(Date.now()<nextAt)return;
  busy=true;nextAt=Date.now()+30000;const token=sessionGeneration,uid=currentUid,school=currentSchoolId;
  try{await revalidateAndSyncAfterReconnect(true,{metadataOnly:true});if(!isCurrentSession(token,uid,school)||!ready()||key()!==current||editing())return;await refreshCore(current);if(!ready()||key()!==current||editing())return;await activeView();lastFailure=false;lastChecked=Date.now();if(isCurrentSession(token,uid,school)){baseline=new WeakMap();capture();}}
  catch(error){lastFailure=true;console.warn('Automatic workspace refresh paused; saved work is retained:',error);nextAt=Date.now()+60000;}
  finally{busy=false;paint();}
 }
 document.addEventListener('focusin',capture,true);document.addEventListener('pointerdown',capture,true);
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')tick();});
 window.addEventListener('online',tick);setInterval(tick,2000);tick();
 window.SchoolHubAutomaticSync={editing,tick,refreshCore,status,saved:view=>{if(currentVisibleViewName()===view){baseline=new WeakMap();capture();}}};
})();
