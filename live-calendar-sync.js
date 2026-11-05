/* Verified full calendar snapshots reconcile removals; backups retain recovery copies. */
(()=>{
 let active=null,lastKey='',baseline='',pending=false,retryAt=0;
 const form=()=>Array.from(document.querySelectorAll('#view-attendance input,#view-attendance select,#view-attendance textarea')).map(e=>[e.id,e.value]);
 const signature=()=>JSON.stringify(form());
 const clean=()=>!baseline||signature()===baseline;
 function capture(){baseline=signature();}
 for(const name of ['renderSchoolCalendar','renderTeacherAttendanceForm','renderAttendanceForm']){const original=window[name];if(typeof original==='function')window[name]=function(...args){const result=original.apply(this,args);capture();return result;};}
 const ready=()=>FIREBASE_ENABLED&&currentUid&&currentSchoolId&&currentStatus==='active'&&sessionReady&&sessionDataReady&&!cloudHydrationInProgress&&!offlineAuthenticatedMode&&navigator.onLine!==false&&document.visibilityState==='visible'&&!document.getElementById('view-attendance')?.classList.contains('hidden');
 function stop(){const s=active;active=null;s?.unsubscribe.forEach(fn=>fn());}
 function refresh(){if(!pending||!clean())return;pending=false;const mode=document.querySelector('#attendanceModeBar .attendance-mode.active')?.dataset.mode||'students';setAttendanceMode(mode);capture();}
 function receive(s,field,snapshot){
  if(active!==s||!ready()||!isCurrentSession(s.generation,s.uid,s.school)||snapshot.metadata?.fromCache||snapshot.metadata?.hasPendingWrites)return;
  const local=DB.get(KEYS[field],{}),dirty=new Set(dirtyIdsFor(KEYS[field]).map(String)),incoming={};
  snapshot.forEach(doc=>{const key=decodeURIComponent(doc.id);incoming[key]=doc.data();});
  const next=field==='schoolCalendar'?{...incoming}:{...local,...incoming};
  dirty.forEach(key=>{if(Object.hasOwn(local,key))next[key]=local[key];});
  if(stableSyncJson(local)===stableSyncJson(next))return;
  if(backupLocalSchoolData('before-live-'+field+'-update')===false)return;
  DB.set(KEYS[field],next,{skipCloudSync:true});pending=true;refresh();
 }
 function start(){
  if(!ready()){stop();return;}
  const key=JSON.stringify([sessionGeneration,currentUid,currentSchoolId,isHeadTeacher()]);
  if(active?.key!==key){stop();if(Date.now()<retryAt)return;if(lastKey!==key){lastKey=key;baseline='';pending=false;}if(!baseline)capture();const s={key,generation:sessionGeneration,uid:currentUid,school:currentSchoolId,unsubscribe:[]};active=s;
   const fail=()=>{if(active===s){stop();retryAt=Date.now()+10000;}};
   for(const field of ['schoolCalendar',...(isHeadTeacher()?['teacherAttendance']:[])])try{s.unsubscribe.push(schoolRef().collection(field).onSnapshot({includeMetadataChanges:true},snap=>{try{receive(s,field,snap);}catch(e){fail();}},fail));}catch(e){fail();}
  }refresh();
 }
 window.canSaveLiveTeacherAttendance=()=>{if(!pending||clean())return true;alert('The calendar or teacher attendance changed on another device. Your unfinished entries are kept. Reopen the register to review the latest saved values before saving.');return false;};
 window.stopLiveCalendarSync=stop;
 document.addEventListener('visibilitychange',start);window.addEventListener('offline',stop);window.addEventListener('online',start);setInterval(start,1000);start();
})();
