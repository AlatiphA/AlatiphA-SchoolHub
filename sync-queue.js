/* Durable queue shared by SchoolHub windows and its service worker.
   Firebase credentials are owned by Firebase Auth, never copied into this queue. */
(function(root){
  'use strict';
  const locks=new Map();let database;
  function open(){
    if(!root.indexedDB)return Promise.reject(Error('Background queue storage is unavailable.'));
    if(!database)database=new Promise((resolve,reject)=>{
      const r=root.indexedDB.open('schoolhub_background_queue_v1',1);
      r.onupgradeneeded=()=>{for(const name of ['jobs','acks','meta'])if(!r.result.objectStoreNames.contains(name))r.result.createObjectStore(name,{keyPath:'id'});};
      r.onsuccess=()=>{r.result.onversionchange=()=>{r.result.close();database=null;};resolve(r.result);};r.onerror=()=>{database=null;reject(r.error);};
    });return database;
  }
  async function transaction(names,mode,work){
    const db=await open();return new Promise((resolve,reject)=>{
      const tx=db.transaction(names,mode);let result;
      tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Background queue transaction aborted.'));
      try{work(tx,value=>{result=value;});}catch(e){tx.abort();reject(e);}
    });
  }
  const all=store=>transaction([store],'readonly',(tx,done)=>{tx.objectStore(store).getAll().onsuccess=e=>done(e.target.result);});
  const get=(store,id)=>transaction([store],'readonly',(tx,done)=>{tx.objectStore(store).get(id).onsuccess=e=>done(e.target.result);});
  const put=(store,value)=>transaction([store],'readwrite',tx=>tx.objectStore(store).put(value));
  const remove=(store,id)=>transaction([store],'readwrite',tx=>tx.objectStore(store).delete(id));
  function withLock(key,work){
    if(root.navigator?.locks)return root.navigator.locks.request(key,work);
    const next=(locks.get(key)||Promise.resolve()).catch(()=>{}).then(work);locks.set(key,next);
    next.finally(()=>{if(locks.get(key)===next)locks.delete(key);}).catch(()=>{});return next;
  }
  async function replace(uid,schoolId,lockKey,jobs){
    return transaction(['jobs'],'readwrite',tx=>{
      const store=tx.objectStore('jobs');store.getAll().onsuccess=e=>{
        const prior=e.target.result.filter(x=>x.uid===uid&&x.schoolId===schoolId&&x.lockKey===lockKey),wanted=new Set(jobs.map(x=>x.id));
        for(const old of prior)if(!wanted.has(old.id))store.delete(old.id);
        for(const job of jobs){const old=prior.find(x=>x.id===job.id);store.put(old&&old.signature===job.signature?{...old,error:job.error||old.error||''}:job);}
      };
    });
  }
  async function acknowledge(job,error){
    return transaction(['jobs','acks'],'readwrite',tx=>{
      const store=tx.objectStore('jobs');store.get(job.id).onsuccess=e=>{
        const current=e.target.result;if(!current||current.signature!==job.signature)return;
        if(error)store.put({...current,error});else store.delete(job.id);
        tx.objectStore('acks').put({id:job.id,job,error:error||'',at:Date.now()});
      };
    });
  }
  root.SchoolHubSyncQueue={all,get,put,remove,replace,acknowledge,withLock,
    id:(uid,schoolId,field,key)=>JSON.stringify([uid,schoolId,field,key]),
    fieldLock:key=>'schoolhub-sync-field:'+key,
    async activate(uid,schoolId){await put('meta',{id:'active',uid,schoolId,enabled:true});},
    async disable(){await put('meta',{id:'active',enabled:false});}
  };
})(typeof self!=='undefined'?self:globalThis);
