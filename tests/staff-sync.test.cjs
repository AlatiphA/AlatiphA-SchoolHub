const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('app-4.js', 'utf8');
test('cloud staff without embedded IDs survive merging as distinct records', () => {
  const ctx = vm.createContext({ DB: {get: () => []}, KEYS: {staff:'staff'}, getCachedLocalImage:()=>'', imageCacheKey:()=>'', isDataImage:()=>false });
  vm.runInContext(source.slice(source.indexOf('function mergeLocalImage('),source.indexOf('function classIdsForCloudSync(')) + source.slice(source.indexOf('function mergeRecordsById('),source.indexOf('function mergeKeyedData(')),ctx);
  const records = Array.from({length:11}, (_,i) => ctx.mergeLocalImage('staff', {name:'Staff '+i, ...(i < 7 ? {id:'id'+i} : {})}, 'id'+i));
  assert.equal(ctx.mergeRecordsById([],records).length,11);
  assert.equal(ctx.mergeLocalImage('staff',{id:'stale',name:'Person'},'real').id,'real');
});
test('partial staff sync never deletes cloud staff, including an empty local list', async () => {
  for (const count of [0,7]) {
    const writes=[], deletes=[];
    const ctx = vm.createContext({commitChunks: async ops => {for(const op of ops) op({set:(...args)=>writes.push(args),delete:ref=>deletes.push(ref)});}});
    vm.runInContext(source.slice(source.indexOf('function syncCollectionArray('),source.indexOf('function syncKeyedCollection(')),ctx);
    const ref={get:async()=>({size:11,forEach:fn=>Array.from({length:11},(_,i)=>fn({id:'id'+i,ref:'id'+i}))}),doc:id=>id};
    await ctx.syncCollectionArray(ref,Array.from({length:count},(_,i)=>({id:'id'+i})),s=>s,{preserveMissing:true});
    assert.equal(writes.length,count); assert.equal(deletes.length,0);
  }
});
test('staff push opts out of deletion by omission', () => {
  const staffBranch=source.slice(source.indexOf("if (field === 'staff') {",source.indexOf('function pushFieldToCloud(')),source.indexOf("if (field === 'students') {",source.indexOf('function pushFieldToCloud(')));
  assert.match(staffBranch,/preserveMissing: true/);
});
