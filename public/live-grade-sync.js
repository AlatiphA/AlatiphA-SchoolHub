/* Selected grade sheet: verified server reads and in-place cell updates. */
(() => {
  let active=null, retryAt=0, blocked=null;
  const visible=()=>!document.getElementById('view-grades')?.classList.contains('hidden');
  const inputs=()=>Array.from(document.querySelectorAll('#gradesTableWrap input[data-student]'));
  const cellKey=e=>JSON.stringify([e.dataset.student,e.dataset.subject,e.dataset.part]);
  const value=(entries,e)=>String(entries?.[e.dataset.student]?.[e.dataset.subject]?.[e.dataset.part] ?? '');
  let baseline=new Map(), conflicts=new Set();
  function capture(){baseline=new Map(inputs().map(e=>[cellKey(e),String(e.value)]));conflicts.clear();start();}
  const context=()=>{
    const classId=document.getElementById('gradesClassSelect')?.value,settings=DB.get(KEYS.settings,{});
    const recordKey=gradeKey(classId,settings.currentTerm,settings.currentYear);
    return {generation:sessionGeneration,uid:currentUid,school:currentSchoolId,classId,recordKey,
      key:JSON.stringify([sessionGeneration,currentUid,currentSchoolId,classId,settings.currentTerm,settings.currentYear,isHeadTeacher(),[...classIdsForCloudSync()].sort()])};
  };
  const ready=()=>FIREBASE_ENABLED&&currentUid&&currentSchoolId&&currentStatus==='active'&&sessionReady&&sessionDataReady
    &&!cloudHydrationInProgress&&!offlineAuthenticatedMode&&navigator.onLine!==false&&document.visibilityState==='visible'&&visible()
    &&document.getElementById('gradesClassSelect')?.value&&canAccessClass(document.getElementById('gradesClassSelect').value);
  const valid=s=>active===s&&ready()&&isCurrentSession(s.generation,s.uid,s.school)&&context().key===s.key;
  function notice(text=''){const el=document.getElementById('liveGradeUpdateStatus');if(el&&el.textContent!==text){el.textContent=text;el.classList.toggle('hidden',!text);}}
  function stop(){const old=active;active=null;if(old?.unsubscribe)old.unsubscribe();notice();}
  function receive(s,snapshot){
    if(!valid(s)||snapshot.metadata?.fromCache||snapshot.metadata?.hasPendingWrites)return;
    // A missing document is not proof that local grades were intentionally deleted.
    if(!snapshot.exists){notice('Grade updates connected.');return;}
    if(dirtyIdsFor(KEYS.grades).map(String).includes(s.recordKey)){notice('Your saved grades are waiting to upload before receiving updates.');return;}
    const entries=snapshot.data()?.entries;
    if(!entries||typeof entries!=='object'||Array.isArray(entries))return;
    const all=DB.get(KEYS.grades,{});
    if(stableSyncJson(all[s.recordKey]||{})!==stableSyncJson(entries)){
      if(backupLocalSchoolData('before-live-grade-update')===false){notice('Grade update received; local recovery backup could not be saved.');return;}
      DB.set(KEYS.grades,{...all,[s.recordKey]:entries},{skipCloudSync:true});
    }
    let kept=false;
    for(const e of inputs()){
      const key=cellKey(e),before=baseline.get(key),next=value(entries,e),current=String(e.value);
      // Do not replace input nodes or erase a user's unfinished score.
      if(before===undefined){baseline.set(key,current);continue;}
      if(current===before){conflicts.delete(key);if(current!==next)e.value=next;}
      else {kept=true;if(next===current)conflicts.delete(key);else if(next!==before)conflicts.add(key);}
      baseline.set(key,next);
    }
    notice(conflicts.size?'A score you are editing changed on another device. Review it before saving.':kept?'Grade updates connected. Your unsaved scores are kept.':'Grade updates connected.');
  }
  function start(){
    if(!ready()){stop();return;}
    const c=context(),verifiedAt=Number(revalidateAndSyncAfterReconnect.verifiedContext?.at||0);
    if(blocked&&blocked.key===c.key&&verifiedAt<=blocked.at)return;
    if(active?.key===c.key||Date.now()<retryAt)return;
    stop();const s={...c,unsubscribe:null};active=s;notice('Connecting grade updates…');
    const fail=error=>{if(active!==s)return;stop();if(/permission-denied|unauthenticated/.test(String(error?.code||'')))blocked={key:s.key,at:verifiedAt};else retryAt=Date.now()+10000;notice('Grade updates paused. Saved scores remain available.');};
    try{const unsubscribe=gradeRef(s.recordKey).onSnapshot({includeMetadataChanges:true},snapshot=>{try{receive(s,snapshot);}catch(error){fail(error);}},fail);if(active===s)s.unsubscribe=unsubscribe;else unsubscribe();}catch(error){fail(error);}
  }
  window.captureLiveGradeBaseline=capture;window.startLiveGradeSync=start;window.stopLiveGradeSync=stop;
  window.canSaveLiveGrades=()=>{
    const current=inputs();
    conflicts=new Set([...conflicts].filter(key=>{const e=current.find(e=>cellKey(e)===key);return e&&String(e.value)!==baseline.get(key);}));
    if(!conflicts.size)return true;
    alert('A score you are editing changed on another device. Your entries are preserved. Reopen this grade sheet to review the latest saved scores before entering your change again.');return false;
  };
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')stop();else start();});
  window.addEventListener('offline',stop);window.addEventListener('online',start);
  setInterval(start,10000);
  capture();
})();
