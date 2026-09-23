const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app-4.js','utf8');
function context(values,failKey){
 const ctx={console:{warn(){},error(){}},localStorage:{getItem:k=>values.get(k)||null,setItem(k,v){if(k===failKey)throw Error('quota');values.set(k,v);},removeItem:k=>values.delete(k)},stripImagesForLocalStorage:(_,v)=>v,restoreLocalImagesForDbKey:(_,v)=>v,updateOfflineModeBanner(){},scheduleCloudPush(){}};
 vm.createContext(ctx);
 vm.runInContext(source.slice(source.indexOf('const SYNC_OUTBOX_KEY'),source.indexOf('// currentUid'))+'\nglobalThis.db=DB;',ctx);
 return ctx;
}
test('interrupted local write replays both its data and sync queue on restart',()=>{
 const values=new Map([['grades','{}']]);
 const first=context(values,'grades');
 assert.throws(()=>first.db.set('grades',{class1:{p1:{math:{e:50}}}}),/quota/);
 assert(values.has('arc_sync_journal_v2'));
 const second=context(values);
 assert.equal(second.db.get('grades',{}).class1.p1.math.e,50);
 assert.deepEqual(JSON.parse(values.get('arc_sync_outbox_v1')).dirty.grades,['class1']);
 assert.equal(values.has('arc_sync_journal_v2'),false);
});
test('malformed pending journal does not crash startup or allow subsequent overwrite',()=>{
 const values=new Map([['grades','{"old":1}'],['arc_sync_journal_v2','invalid json']]);
 const ctx=context(values);
 assert.equal(ctx.db.get('grades',{}).old,1);
 assert.throws(()=>ctx.db.set('grades',{replacement:2}));
 assert.equal(values.get('grades'),'{"old":1}');
 assert.equal(values.get('arc_sync_journal_v2'),'invalid json');
});
test('a partial service-worker install does not activate the new cache',async()=>{
 const listeners={};let installed,activated=false;
 const ctx={self:{addEventListener:(event,handler)=>listeners[event]=handler,skipWaiting(){activated=true;}},caches:{open:async()=>({put:async()=>{}})},fetch:async url=>({ok:!url.endsWith('app-4.js')})};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync('sw.js','utf8'),ctx);
 listeners.install({waitUntil:p=>installed=p});
 await assert.rejects(installed,/Incomplete app shell/);
 assert.equal(activated,false);
});
