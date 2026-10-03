/* Mirrors the existing local save queues; localStorage remains the reopening fallback. */
function workerQueueAvailable(){return typeof SchoolHubSyncQueue!=='undefined'&&typeof indexedDB!=='undefined';}
async function reconcileWorkerSyncAcks(lockKey){
  if(!workerQueueAvailable()||!currentUid||!currentSchoolId)return;
  const uid=currentUid,school=currentSchoolId,acks=await SchoolHubSyncQueue.all('acks');
  for(const ack of acks){
    const job=ack.job;if(job.uid!==uid||job.schoolId!==school||job.lockKey!==lockKey)continue;
    if(currentUid!==uid||currentSchoolId!==school)return;
    if(job.field==='fees'){
      const queue=feeQueueRead(lockKey);
      if(ack.error){const item=queue.find(x=>x.request.requestId===job.data.requestId);if(item)item.error=ack.error;}
      const next=ack.error?queue:queue.filter(x=>x.request.requestId!==job.data.requestId);
      localStorage.setItem(lockKey,JSON.stringify(next));
    }else{
      const match=syncableFields().find(x=>x.key===job.rawKey);if(!match)continue;
      if(ack.error){syncErrors.set(job.rawKey,true);}
      else{
        const value=DB.get(job.rawKey,fieldDefault(job.field)),cleared=[],bases=syncBaseValues.get(job.rawKey)||{};
        for(const [id,sent]of Object.entries(job.sentValues)){
          if(!dirtyIdsFor(job.rawKey).includes(id))continue;
          const current=Array.isArray(value)?value.find(x=>String(x.id)===id):value?.[id];
          if(stableSyncJson(current)===stableSyncJson(sent))cleared.push(id);
          else bases[id]=sent; // Rebase only the confirmed snapshot, retaining a newer local edit.
        }
        syncBaseValues.set(job.rawKey,bases);clearSyncDirty(job.rawKey,cleared);
        if(cleared.length)syncErrors.delete(job.rawKey);
      }
    }
    // Delete the acknowledgement only after the local queue update was persisted.
    await SchoolHubSyncQueue.remove('acks',ack.id);
  }
}
function workerJob(match,id,data,kind,name,recordId,sentValues,order){
  const job={id:SchoolHubSyncQueue.id(currentUid,currentSchoolId,match.field,id),uid:currentUid,schoolId:currentSchoolId,field:match.field,rawKey:match.key,lockKey:SchoolHubSyncQueue.fieldLock(match.key),kind,name:name||'',recordId:recordId||'',data,sentValues,order};
  job.signature=JSON.stringify({data,sentValues});return job;
}
async function stageWorkerField(match,alreadyLocked=false){
  if(!workerQueueAvailable())return;
  const lockKey=SchoolHubSyncQueue.fieldLock(match.key);
  const work=async()=>{
    await reconcileWorkerSyncAcks(lockKey);
    if(!currentUid||!currentSchoolId||currentStatus!=='active'||!sessionReady||!syncableFields().some(x=>x.field===match.field&&x.key===match.key))return;
    const uid=currentUid,school=currentSchoolId,field=match.field,value=DB.get(match.key,fieldDefault(field)),bases=syncBaseValues.get(match.key)||{},order=syncableFields().findIndex(x=>x.field===field)*10000,jobs=[];
    if(['grades','attendance','teacherAttendance','remarks'].includes(field)){
      const records=dirtyKeyedRecords(match.key,value,isHeadTeacher()?null:classIdsForCloudSync());
      if(field!=='teacherAttendance'||isHeadTeacher())for(const [id,record]of Object.entries(records))jobs.push(workerJob(match,id,{field,key:id,base:bases[id]||{},value:record,deletionVersion:recordDeletionVersion(field,id)},'call','saveSchoolRecord','',{[id]:record},order));
    }else if(field==='settings'&&isHeadTeacher()){
      discardUneditedSetupDefaults();const clean=stripImagesForCloud('settings',value),ids=dirtyIdsFor(match.key).filter(id=>Object.hasOwn(clean,id)&&id!=='teacherName');
      if(ids.length)jobs.push(workerJob(match,'__profile__',{changes:Object.fromEntries(ids.map(id=>[id,clean[id]])),base:Object.fromEntries(ids.map(id=>[id,bases[id]??null]))},'call','saveSchoolProfile','',Object.fromEntries(ids.map(id=>[id,value[id]])),order));
    }else if(['classes','subjects','staff','students'].includes(field)){
      if(field==='students'||isHeadTeacher())for(const record of dirtyArrayRecords(match.key,value,field==='students'?classIdsForCloudSync():null)){
        const id=String(record.id);jobs.push(workerJob(match,id,stripImagesForCloud(field,record),'upsert','',id,{[id]:record},order));
      }
    }else if(field==='schoolCalendar'&&isHeadTeacher()){
      for(const [id,record]of Object.entries(dirtyKeyedRecords(match.key,value,null)))jobs.push(workerJob(match,id,record,'upsert','',cloudKey(id),{[id]:record},order));
    }
    if(currentUid!==uid||currentSchoolId!==school)return;
    await SchoolHubSyncQueue.replace(uid,school,lockKey,jobs);
  };
  return alreadyLocked?work():SchoolHubSyncQueue.withLock(lockKey,work);
}
async function stageWorkerFeeQueue(alreadyLocked=false){
  if(!workerQueueAvailable()||!currentUid||!currentSchoolId||!isHeadTeacher()||!sessionReady||typeof feeQueueRead!=='function')return;
  const uid=currentUid,school=currentSchoolId,key='schoolhub_fee_queue_'+school+'_'+uid;
  const work=async()=>{
    await reconcileWorkerSyncAcks(key);if(currentUid!==uid||currentSchoolId!==school)return;
    const jobs=feeQueueRead(key).map((item,index)=>{
      const job={id:SchoolHubSyncQueue.id(uid,school,'fees',item.request.requestId),uid,schoolId:school,field:'fees',lockKey:key,kind:'call',name:'updateSchoolFees',data:item.request,error:item.error||'',order:100000+index};job.signature=JSON.stringify(item.request);return job;
    });
    await SchoolHubSyncQueue.replace(uid,school,key,jobs);
  };
  return alreadyLocked?work():SchoolHubSyncQueue.withLock(key,work);
}
async function stagePendingWorkerSync(){
  if(!workerQueueAvailable()||!currentUid||!currentSchoolId||currentStatus!=='active'||!sessionReady)return false;
  const uid=currentUid,school=currentSchoolId;
  for(const match of syncableFields()){
    if(currentUid!==uid||currentSchoolId!==school)return false;
    await stageWorkerField(match);
  }
  await stageWorkerFeeQueue();
  if(currentUid!==uid||currentSchoolId!==school)return false;
  await SchoolHubSyncQueue.activate(uid,school);
  return true;
}
async function runWithWorkerFieldLock(match,work){
  if(!workerQueueAvailable())return work();
  return SchoolHubSyncQueue.withLock(SchoolHubSyncQueue.fieldLock(match.key),async()=>{
    try{await reconcileWorkerSyncAcks(SchoolHubSyncQueue.fieldLock(match.key));}catch(e){console.warn('Background acknowledgements remain saved:',e);}
    try{return await work();}finally{try{await stageWorkerField(match,true);}catch(e){console.warn('Local saves remain queued for reopening:',e);}}
  });
}
function preserveSyncOnHide(){
  if(typeof requestSchoolHubBackgroundSync==='function')requestSchoolHubBackgroundSync('app-hidden');
  if(typeof runSchoolHubBackgroundSync==='function'&&navigator.onLine!==false)runSchoolHubBackgroundSync('app-hidden').catch(()=>{});
}
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='hidden')preserveSyncOnHide();
  else if(typeof runSchoolHubBackgroundSync==='function'&&currentUid&&sessionReady)runSchoolHubBackgroundSync('app-visible').catch(()=>{});
});
window.addEventListener('pagehide',preserveSyncOnHide);
function recoverVisibleSession(source){
  if(document.visibilityState==='visible'&&navigator.onLine!==false&&typeof runSchoolHubBackgroundSync==='function'&&currentUid&&sessionReady)runSchoolHubBackgroundSync(source).catch(()=>{});
}
// Focus and back/forward restoration cover devices that suspend visibility or
// connectivity events. Retry transient failures while open without relying on
// native Background Sync support or a second online event.
window.addEventListener('focus',()=>recoverVisibleSession('app-focus'));
window.addEventListener('pageshow',event=>{if(event.persisted)recoverVisibleSession('app-resume');});
setInterval(()=>{
  if(typeof hasPendingSchoolHubSync==='function'&&(offlineAuthenticatedMode||hasPendingSchoolHubSync()))recoverVisibleSession('foreground-retry');
},60000);
