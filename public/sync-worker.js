/* Executes durable SchoolHub jobs without requiring an open PWA window. */
(function(root){
  'use strict';
  let services;
  async function firebaseServices(){
    if(!services)services=(async()=>{
      root.importScripts('./firebase-config.js',
        'https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js',
        'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth-compat.js',
        'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore-compat.js',
        'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions-compat.js');
      if(!root.FIREBASE_CONFIG?.apiKey||root.FIREBASE_CONFIG.apiKey==='YOUR_API_KEY')return null;
      if(!root.firebase.apps.length)root.firebase.initializeApp(root.FIREBASE_CONFIG);
      const auth=root.firebase.auth();
      await new Promise((resolve,reject)=>{let off;off=auth.onAuthStateChanged(()=>{resolve();if(off)off();},reject);});
      return {auth,db:root.firebase.firestore(),functions:root.firebase.functions()};
    })().catch(e=>{services=null;throw e;});return services;
  }
  function permanent(error){return /(?:^|\/)(invalid-argument|failed-precondition|aborted|permission-denied|unauthenticated|not-found|already-exists)$/.test(String(error?.code||''));}
  async function execute(job,api){
    if(job.kind==='call'){
      if(!['saveSchoolRecord','saveSchoolProfile','updateSchoolFees','updateSchoolOperations'].includes(job.name))throw Error('Unknown background operation.');
      await api.functions.httpsCallable(job.name)({...job.data,expectedSchoolId:job.schoolId});return;
    }
    if(job.kind!=='upsert'||!['classes','subjects','students','staff','schoolCalendar'].includes(job.field)||!job.recordId||job.recordId.includes('/'))throw Error('Invalid background upsert.');
    const data={...job.data};
    if(['classes','subjects','schoolCalendar'].includes(job.field))data.updatedAt=root.firebase.firestore.FieldValue.serverTimestamp();
    await api.db.collection('schools').doc(job.schoolId).collection(job.field).doc(job.recordId).set(data,{merge:true});
  }
  async function run(options={}){
    const queue=root.SchoolHubSyncQueue;
    if(!queue||!root.indexedDB||!root.navigator?.locks)return false;
    const active=await queue.get('meta','active');if(!active?.enabled)return false;
    const pending=(await queue.all('jobs')).filter(x=>x.uid===active.uid&&x.schoolId===active.schoolId).sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
    if(!pending.some(x=>!x.error))return true;
    const api=options.api||await firebaseServices();if(!api?.auth.currentUser||api.auth.currentUser.uid!==active.uid)return false;
    const started=Date.now();let count=0,retry=false;const stoppedFeeLocks=new Set();
    for(const candidate of pending){
      if(['fees','operations'].includes(candidate.field)&&candidate.error)stoppedFeeLocks.add(candidate.lockKey);
      if(candidate.error||stoppedFeeLocks.has(candidate.lockKey))continue;
      if(++count>20||Date.now()-started>18000){retry=true;break;}
      await queue.withLock(candidate.lockKey,async()=>{
        const context=await queue.get('meta','active'),job=await queue.get('jobs',candidate.id);
        if(!context?.enabled||context.uid!==active.uid||context.schoolId!==active.schoolId||api.auth.currentUser?.uid!==active.uid||!job||job.error||job.signature!==candidate.signature)return;
        try{
          // A fresh server membership read precedes each write, even after offline use.
          await api.auth.currentUser.getIdToken();
          const membership=await api.db.collection('users').doc(active.uid).get({source:'server'}),member=membership.exists?membership.data():null;
          if(!member||member.status!=='active'||member.schoolId!==job.schoolId){const e=Error('Your school membership must be reverified before this save.');e.code='failed-precondition';throw e;}
          const latest=await queue.get('meta','active');
          if(api.auth.currentUser?.uid!==active.uid||!latest?.enabled||latest.uid!==active.uid||latest.schoolId!==active.schoolId)return;
          await execute(job,api);await queue.acknowledge(job);
        }catch(error){
          if(permanent(error)){await queue.acknowledge(job,error.message||String(error));if(['fees','operations'].includes(job.field))stoppedFeeLocks.add(job.lockKey);}
          else {retry=true;if(['fees','operations'].includes(job.field))stoppedFeeLocks.add(job.lockKey);}
        }
      });
    }
    const windows=await root.clients.matchAll({type:'window',includeUncontrolled:true});
    windows.forEach(client=>client.postMessage({type:'SCHOOLHUB_WORKER_SYNC_COMPLETE'}));
    if(retry)throw Error('Some background saves remain pending and will be retried.');
    return true;
  }
  root.SchoolHubSyncWorker={run,execute,permanent};
})(self);
