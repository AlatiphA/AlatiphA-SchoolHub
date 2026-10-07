/* Selected pupil attendance register: verified server reads and in-place cell updates. */
(() => {
  let active=null, retryAt=0, blocked=null;
  const visible=()=>!document.getElementById('view-attendance')?.classList.contains('hidden')&&!document.getElementById('studentAttendancePanel')?.classList.contains('hidden');
  const inputs=()=>Array.from(document.querySelectorAll('#attendanceFormWrap select[data-student]'));
  const cellKey=e=>String(e.dataset.student);
  const value=(entries,e)=>String(entries?.[e.dataset.student] ?? '');
  let baseline=new Map(), conflicts=new Set();
  function capture(){baseline=new Map(inputs().map(e=>[cellKey(e),String(e.value)]));conflicts.clear();start();}
  const context=()=>{
    const classId=document.getElementById('attendanceClassSelect')?.value,settings=DB.get(KEYS.settings,{});
    const recordKey=attendanceKey(classId,settings.currentTerm,settings.currentYear,document.getElementById('attendanceDate')?.value);
    return {generation:sessionGeneration,uid:currentUid,school:currentSchoolId,classId,recordKey,
      key:JSON.stringify([sessionGeneration,currentUid,currentSchoolId,classId,settings.currentTerm,settings.currentYear,document.getElementById('attendanceDate')?.value,isHeadTeacher(),[...classIdsForCloudSync()].sort()])};
  };
  const ready=()=>FIREBASE_ENABLED&&currentUid&&currentSchoolId&&currentStatus==='active'&&sessionReady&&sessionDataReady
    &&!cloudHydrationInProgress&&!offlineAuthenticatedMode&&navigator.onLine!==false&&document.visibilityState==='visible'&&visible()
    &&document.getElementById('attendanceClassSelect')?.value&&canAccessClass(document.getElementById('attendanceClassSelect').value);
  const valid=s=>active===s&&ready()&&isCurrentSession(s.generation,s.uid,s.school)&&context().key===s.key;
  function notice(text=''){const el=document.getElementById('liveAttendanceUpdateStatus');if(el&&el.textContent!==text){el.textContent=text;el.classList.toggle('hidden',!text);}}
  function stop(){const old=active;active=null;if(old?.unsubscribe)old.unsubscribe();notice();}
  function receive(s,snapshot){
    if(!valid(s)||snapshot.metadata?.fromCache||snapshot.metadata?.hasPendingWrites)return;
    // A missing document is not proof that local attendance were intentionally deleted.
    if(!snapshot.exists){notice('Attendance updates connected.');return;}
    if(dirtyIdsFor(KEYS.attendance).map(String).includes(s.recordKey)){notice('Your saved attendance are waiting to upload before receiving updates.');return;}
    const entries=snapshot.data()?.entries;
    if(!entries||typeof entries!=='object'||Array.isArray(entries))return;
    const all=DB.get(KEYS.attendance,{});
    if(stableSyncJson(all[s.recordKey]?.entries||{})!==stableSyncJson(entries)){
      if(backupLocalSchoolData('before-live-attendance-update')===false){notice('Attendance update received; local recovery backup could not be saved.');return;}
      DB.set(KEYS.attendance,{...all,[s.recordKey]:{...snapshot.data(),classId:s.classId,entries}},{skipCloudSync:true});
    }
    let kept=false;
    for(const e of inputs()){
      const key=cellKey(e),before=baseline.get(key),next=value(entries,e),current=String(e.value);
      // Do not replace input nodes or erase a user's unfinished attendance status.
      if(before===undefined){baseline.set(key,current);continue;}
      if(current===before){conflicts.delete(key);if(current!==next)e.value=next;}
      else {kept=true;if(next===current)conflicts.delete(key);else if(next!==before)conflicts.add(key);}
      baseline.set(key,next);
    }
    if (typeof refreshLiveAttendanceTotals === 'function') refreshLiveAttendanceTotals();
    notice(conflicts.size?'A attendance status you are editing changed on another device. Review it before saving.':kept?'Attendance updates connected. Your unsaved attendance statuss are kept.':'Attendance updates connected.');
  }
  function start(){
    if(!ready()){stop();return;}
    const c=context(),verifiedAt=Number(revalidateAndSyncAfterReconnect.verifiedContext?.at||0);
    if(blocked&&blocked.key===c.key&&verifiedAt<=blocked.at)return;
    if(active?.key===c.key||Date.now()<retryAt)return;
    stop();const s={...c,unsubscribe:null};active=s;notice('Connecting grade updates…');
    const fail=error=>{if(active!==s)return;stop();if(/permission-denied|unauthenticated/.test(String(error?.code||'')))blocked={key:s.key,at:verifiedAt};else retryAt=Date.now()+10000;notice('Attendance updates paused. Saved attendance statuss remain available.');};
    try{const unsubscribe=attendanceRef(s.recordKey).onSnapshot({includeMetadataChanges:true},snapshot=>{try{receive(s,snapshot);}catch(error){fail(error);}},fail);if(active===s)s.unsubscribe=unsubscribe;else unsubscribe();}catch(error){fail(error);}
  }
  window.captureLiveAttendanceBaseline=capture;window.startLiveAttendanceSync=start;window.stopLiveAttendanceSync=stop;
  window.canSaveLiveAttendance=()=>{
    const current=inputs();
    conflicts=new Set([...conflicts].filter(key=>{const e=current.find(e=>cellKey(e)===key);return e&&String(e.value)!==baseline.get(key);}));
    if(!conflicts.size)return true;
    alert('A attendance status you are editing changed on another device. Your entries are preserved. Reopen this attendance register to review the latest saved attendance statuss before entering your change again.');return false;
  };
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')stop();else start();});
  window.addEventListener('offline',stop);window.addEventListener('online',start);
  setInterval(start,10000);
  capture();
})();
