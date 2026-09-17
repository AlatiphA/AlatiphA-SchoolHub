const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const records = new Map();
const ref = path => ({ path, collection: name => ref(`${path}/${name}`), doc: id => ref(`${path}/${id}`), get: async()=>snap(path) });
const snap = path => ({ exists:records.has(path), data:()=>structuredClone(records.get(path)) });
let queue=Promise.resolve();
const db={ collection:name=>ref(name), runTransaction:fn=>{
  const run=queue.then(async()=>{
    const writes=[];
    await fn({get:async r=>snap(r.path),set:(r,value,options)=>writes.push([r.path,value,options])});
    for(const [path,value,options] of writes) records.set(path,options?.merge?{...records.get(path),...value}:value);
  });
  queue=run.catch(()=>{}); return run;
}};
class HttpsError extends Error {constructor(code,message){super(message);this.code=code;}}
const firestore=()=>db;
firestore.FieldValue={serverTimestamp:()=>123};
const context=vm.createContext({exports:{},require:name=>{
  if(name==='firebase-functions/v2/https')return {onCall:(_,fn)=>fn,HttpsError};
  if(name==='firebase-functions/params')return {defineSecret:()=>({value:()=> 'sk_test_fake'})};
  if(name==='firebase-admin')return {initializeApp:()=>{},firestore};
  throw Error(name);
}});
vm.runInContext(fs.readFileSync('functions/index.js','utf8'),context);
const consume=context.exports.consumeReportCredits;
records.set('users/head',{role:'headteacher',status:'active',schoolId:'school'});
records.set('users/teacher',{role:'teacher',status:'active',schoolId:'school'});
records.set('schools/school',{profile:{currentTerm:'Term 1',currentYear:'2026/2027'}});
const bill='schools/school/billing/account';
records.set(bill,{testBalance:4});
const req=(id,uid='head',reportType='bw-single',count=1)=>({auth:{uid},data:{requestId:id.padEnd(16,'_'),mode:'test',reportType,count}});
(async()=>{
  const results=await Promise.all(Array.from({length:11},(_,i)=>consume(req(`generation${i}`,i%2?'teacher':'head'))));
  assert.equal(results.filter(r=>r.consumed===0).length,10);
  assert.equal(results[10].consumed,1);
  assert.equal(records.get(bill).testBalance,3);
  const retry=await consume(req('generation0'));
  assert.equal(retry.consumed,0);
  assert.equal(retry.freeRemaining,0);
  assert.equal(records.get(bill).testBalance,3);
  await assert.rejects(()=>consume(req('generation0','head','paid')),/does not match/);
  await consume(req('batch','head','paid',3));
  assert.equal(records.get(bill).testBalance,0);
  await assert.rejects(()=>consume(req('no-credit')),/Not enough/);
  assert.equal(records.has('schools/school/billingUsage/no-credit_______'),false);
  records.set('schools/school',{profile:{currentTerm:'Term 2',currentYear:'2026/2027'}});
  assert.equal((await consume(req('next-term'))).freeRemaining,9);
  records.set('schools/school',{profile:{currentTerm:'Term 1',currentYear:'2026/2027'}});
  await assert.rejects(()=>consume(req('old-term')),/Not enough/);
  records.set('schools/school',{profile:{currentTerm:'Term 1',currentYear:'2027/2028'}});
  assert.equal((await consume(req('next-year'))).freeRemaining,9);
  await assert.rejects(()=>consume(req('invalid-batch','head','bw-single',5)),/Invalid report type/);
  await assert.rejects(()=>consume({data:{}}),/Please sign in/);
  console.log('Billing allowance checks passed: 10 shared free reports, 11th charged, retries, batches, insufficient balance, term/year reset, old-term protection and authentication.');
})().catch(error=>{console.error(error);process.exitCode=1;});
