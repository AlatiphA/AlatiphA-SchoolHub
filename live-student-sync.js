/* Receive verified pupil changes without restarting hydration or replacing forms. */
(() => {
  let active = null, retryAt = 0, blocked = null;
  const scope = () => {
    const head = isHeadTeacher(), ids = head ? null : [...classIdsForCloudSync()].map(String).sort();
    return {generation:sessionGeneration, uid:currentUid, school:currentSchoolId, head, ids,
      key:JSON.stringify([sessionGeneration,currentUid,currentSchoolId,head,ids])};
  };
  const ready = () => FIREBASE_ENABLED && currentUid && currentSchoolId && currentStatus === 'active'
    && sessionReady && sessionDataReady && !cloudHydrationInProgress && !offlineAuthenticatedMode
    && navigator.onLine !== false && document.visibilityState === 'visible';
  const valid = s => active === s && ready() && isCurrentSession(s.generation,s.uid,s.school) && scope().key === s.key;
  const visible = id => {const el=document.getElementById(id);return el && !el.classList.contains('hidden');};
  function notice(text='') {
    const el=document.getElementById('liveStudentUpdateStatus');
    if(el && el.textContent!==text){el.textContent=text;el.classList.toggle('hidden',!text);}
  }
  function editing() {
    return editingStudentId !== null || visible('addStudentForm')
      || !!String(document.getElementById('bulkStudentInput')?.value || '').trim();
  }
  function stop() {
    const previous=active;active=null;
    if(previous)previous.unsubscribers.forEach(fn=>{try{fn();}catch(_){}});
    notice();
  }
  function apply(s) {
    if(!valid(s) || !s.hasStudentSnapshot)return;
    const local=DB.get(KEYS.students,[]), dirty=new Set(dirtyIdsFor(KEYS.students).map(String));
    const cloud=[...s.partitions.values()].flatMap(records=>[...records.values()]);
    const existing=new Set(cloud.map(x=>String(x.id)));
    const pending=new Map(local.filter(x=>dirty.has(String(x.id))).map(x=>[String(x.id),x]));
    const markers=(s.studentsReady && s.deletionsReady ? s.deletions : []).filter(x=>x.collection==='students' && typeof x.id==='string'
      && (s.head || local.some(p=>String(p.id)===localKeyFromCloudId(x.id) && s.ids.includes(String(p.classId))))
      && !existing.has(localKeyFromCloudId(x.id)) && !dirty.has(localKeyFromCloudId(x.id)));
    const deleted=new Set(markers.map(x=>localKeyFromCloudId(x.id)));
    const next=mergeRecordsById(local,cloud).map(x=>pending.get(String(x.id))||x)
      .filter(x=>!deleted.has(String(x.id)) && !(s.outside.has(String(x.id)) && !dirty.has(String(x.id))));
    // Local storage intentionally omits photo bytes, including empty photo
    // placeholders. Compare the persisted records, not restored image fields,
    // or every timer tick would save and rebuild an unchanged pupil list.
    if(stableSyncJson(stripImagesForLocalStorage(KEYS.students,local))!==stableSyncJson(stripImagesForLocalStorage(KEYS.students,next))) {
      if(backupLocalSchoolData('before-live-student-update')===false){notice('Pupil updates received. Local recovery backup could not be saved; existing records remain available.');return;}
      if(markers.length)rememberDeletions(markers);
      DB.set(KEYS.students,next,{skipCloudSync:true});
      s.uiPending=true;
      // The modal retains its input nodes. Its existing baseline check sees
      // any remote record change and prevents an unnoticed overwrite.
      if(visible('view-home'))renderHome();
      if(visible('view-classes') && editingClassId===null && !visible('addClassForm'))renderClasses();
    }
    if(s.uiPending && editing()){notice('Pupil changes received. Finish or close the pupil form to display them.');return;}
    if(s.uiPending && visible('view-students')){renderStudents();s.uiPending=false;}
    notice(s.studentsReady ? 'Pupil updates connected.' : 'Receiving pupil updates; checking remaining classes…');
  }
  function start() {
    if(!ready()){stop();if(navigator.onLine !== false && currentUid && currentSchoolId)notice('Waiting for the school account check before receiving pupil updates.');return;}
    const context=scope(),verifiedAt=Number(revalidateAndSyncAfterReconnect.verifiedContext?.at||0);
    if(blocked && blocked.key===context.key && verifiedAt<=blocked.at)return;
    if(active && active.key===context.key){apply(active);return;}
    if(Date.now()<retryAt)return;
    stop();
    const s={...context,unsubscribers:[],partitions:new Map(),seen:new Set(),outside:new Set(),deletions:[],
      studentsReady:!context.head&&!context.ids.length,hasStudentSnapshot:false,deletionsReady:false,uiPending:false};active=s;
    notice('Checking the pupil-update connection…');
    const fail=error=>{
      if(active!==s)return;
      stop();
      if(/permission-denied|unauthenticated/.test(String(error?.code||'')))blocked={key:s.key,at:verifiedAt};
      else retryAt=Date.now()+10000;
      console.warn('Live pupil updates paused; saved records remain available:',error);
      notice('Live pupil updates are paused. Saved records remain available; verify your account to retry.');
    };
    const listen=(ref,receive)=>{
      const unsubscribe=ref.onSnapshot({includeMetadataChanges:true},snapshot=>{
        if(!valid(s))return;
        if(snapshot.metadata?.fromCache || snapshot.metadata?.hasPendingWrites){if(!s.hasStudentSnapshot)notice('Waiting for confirmed pupil updates from the server.');return;}
        try{receive(snapshot);apply(s);}catch(error){fail(error);}
      },fail);
      if(active===s)s.unsubscribers.push(unsubscribe);else unsubscribe();
    };
    const receiveStudents=(key,snapshot)=>{
      const records=new Map(),previous=s.partitions.get(key)||new Map();
      snapshot.forEach(d=>{
        const record={...d.data(),id:localKeyFromCloudId(d.id)};
        if(!s.head&&!s.ids.includes(String(record.classId)))return;
        records.set(String(record.id),mergeLocalImage('students',record,record.id));
        s.outside.delete(String(record.id));
      });
      // Do not treat an incomplete/initial snapshot as deletion. A confirmed
      // move out of the teacher's scope may hide an already observed pupil.
      if(!s.head && typeof snapshot.docChanges==='function')for(const change of snapshot.docChanges()) {
        const id=localKeyFromCloudId(change.doc.id),record=change.doc.data();
        if(change.type==='removed' && previous.has(id) && record?.classId
          && !s.ids.includes(String(record.classId)))s.outside.add(id);
      }
      s.partitions.set(key,records);s.seen.add(key);s.hasStudentSnapshot=true;
      s.studentsReady=s.head || s.seen.size===s.ids.length;
    };
    try {
      const ref=schoolRef();
      listen(ref.collection('deletedRecords').where('collection','==','students'),snapshot=>{
        s.deletions=[];snapshot.forEach(d=>s.deletions.push(d.data()));s.deletionsReady=true;
      });
      if(s.head)listen(ref.collection('students'),snapshot=>receiveStudents('*',snapshot));
      else s.ids.forEach(id=>listen(ref.collection('students').where('classId','==',id),snapshot=>receiveStudents(id,snapshot)));
    }catch(error){fail(error);}
  }
  window.startLiveStudentSync=start;window.stopLiveStudentSync=stop;
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')stop();else start();});
  window.addEventListener('offline',stop);window.addEventListener('online',start);
  // This retries failed subscriptions or renders buffered updates after forms
  // close. Healthy subscriptions issue no repeated network reads.
  setInterval(start,10000);
  start();
})();
