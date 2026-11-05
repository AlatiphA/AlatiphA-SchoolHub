/* Automatic server refresh for areas without dedicated live subscriptions. */
(()=>{
 let gateAt=0,context='',busy=false,nextAt=0,baseline=new WeakMap(),deferred=null;
 const controls=()=>Array.from(document.querySelectorAll('main input,main select,main textarea')).filter(e=>e.getClientRects().length&&!e.disabled&&e.type!=='search'&&!/search|filter|Date$|ClassSelect$|YearSelect$|TermSelect$/i.test(e.id||''));
 const value=e=>e.type==='checkbox'||e.type==='radio'?String(e.checked):e.type==='file'?String(e.files?.length||0):String(e.value);
 function capture(){for(const e of controls())if(!baseline.has(e))baseline.set(e,value(e));}
 function editing(){capture();return !!document.querySelector('dialog[open],.modal:not(.hidden),#profileMenu:not(.hidden)')||controls().some(e=>baseline.get(e)!==value(e));}
 const key=()=>JSON.stringify([sessionGeneration,currentUid,currentSchoolId,currentVisibleViewName()]);
 const ready=()=>FIREBASE_ENABLED&&currentUid&&currentSchoolId&&currentStatus==='active'&&sessionReady&&sessionDataReady&&!cloudHydrationInProgress&&!offlineAuthenticatedMode&&navigator.onLine!==false&&document.visibilityState==='visible';
 const original=window.refreshAfterReconnectWhenMenuCloses;
 if(typeof original==='function')window.refreshAfterReconnectWhenMenuCloses=function(refresh){return original(()=>{if(editing()){deferred=refresh;return;}refresh();baseline=new WeakMap();capture();});};
 async function activeView(){const scope=key(),canRefresh=()=>ready()&&key()===scope&&!editing();const view=currentVisibleViewName(),x=window.scrollX,y=window.scrollY;
  if(view==='fees'&&typeof renderSchoolFees==='function')await renderSchoolFees({silent:true,canRefresh});
  else if(view==='billing'&&typeof renderBilling==='function'){const data=await manualBillingCall('getSchoolManualBilling',{expectedSchoolId:currentSchoolId});if(canRefresh())await renderManualSchoolBilling(document.getElementById('billingWrap'),undefined,data);}
  else if(view==='supervision'&&typeof renderWeeklySupervision==='function')await renderWeeklySupervision(true,canRefresh);
  else if(view==='manage-teachers')await renderManageTeachers({canRefresh});
  else if(view==='remarks')renderRemarksForm();
  window.scrollTo(x,y);
 }
 async function tick(){
  if(FIREBASE_ENABLED&&['pending','disabled','suspended'].includes(currentStatus)&&navigator.onLine!==false&&document.visibilityState==='visible'&&Date.now()>=gateAt){
   gateAt=Date.now()+30000;const user=firebase.auth().currentUser,uid=currentUid,status=currentStatus;
   if(user?.uid===uid)try{const snap=await firebase.firestore().collection('users').doc(uid).get({source:'server'});let data=snap.data();if(window.SchoolHubServiceAccess)data=await SchoolHubServiceAccess.verify(data);if(firebase.auth().currentUser?.uid===uid&&currentStatus===status&&data?.status==='active'&&data.schoolId)window.location.reload();}catch(_){}
   return;
  }
  if(!ready())return;const current=key();if(current!==context){context=current;baseline=new WeakMap();capture();nextAt=Date.now()+30000;deferred=null;return;}
  if(busy||editing())return;
  if(deferred){const refresh=deferred;deferred=null;refresh();baseline=new WeakMap();capture();}
  if(Date.now()<nextAt)return;
  busy=true;nextAt=Date.now()+30000;const token=sessionGeneration,uid=currentUid,school=currentSchoolId;
  try{await revalidateAndSyncAfterReconnect(true);if(!isCurrentSession(token,uid,school)||!ready()||key()!==current||editing())return;await activeView();if(isCurrentSession(token,uid,school)){baseline=new WeakMap();capture();}}
  catch(error){console.warn('Automatic workspace refresh paused; saved work is retained:',error);nextAt=Date.now()+60000;}
  finally{busy=false;}
 }
 document.addEventListener('focusin',capture,true);document.addEventListener('pointerdown',capture,true);
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')tick();});
 window.addEventListener('online',tick);setInterval(tick,2000);tick();
 window.SchoolHubAutomaticSync={editing,tick};
})();
