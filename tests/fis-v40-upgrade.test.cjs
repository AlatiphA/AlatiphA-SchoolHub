const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const fees=fs.readFileSync('fees.js','utf8');
const rules=fs.readFileSync('firestore.rules','utf8');
const sw=fs.readFileSync('sw.js','utf8');
function helperContext(){const context={navigator:{},localStorage:{getItem:()=>null,setItem:()=>{}},Map,Promise};vm.createContext(context);vm.runInContext(fees.split("window.addEventListener")[0],context);return context;}

test('FIS UI exposes categories, all fee scopes, manual allocation, arrears and test cleanup',()=>{
 for(const token of ['Fee categories','createCategory','createFeeItem','value="class"','value="classes"','value="allClasses"','value="pupil"','Manual, selected fee items','Arrears by category and term','CLEAN TEST DATA','voidPayment'])assert.ok(fees.includes(token),token);
 assert.equal(fees.includes('Set a standard class fee'),false);
});

test('receipt UI renders allocation lines and retains void status',()=>{
 for(const token of ['Allocation','fee-receipt-allocation','VOIDED RECEIPT','Balance after this payment'])assert.ok(fees.includes(token),token);
});

test('client balance helpers keep cancelled charges at zero and calculate due paid balance separately',()=>{
 const c=helperContext();
 assert.equal(c.feeChargeDue({baseAmount:30000,adjustment:-5000,paid:10000}),25000);
 assert.equal(c.feeChargeBalance({baseAmount:30000,adjustment:-5000,paid:10000}),15000);
 assert.equal(c.feeChargeDue({baseAmount:30000,adjustment:0,paid:0,cancelled:true}),0);
 const s=c.feePupilSummary([{baseAmount:30000,adjustment:-5000,paid:10000},{baseAmount:20000,adjustment:0,paid:5000}]);assert.deepEqual(JSON.parse(JSON.stringify(s)),{due:45000,paid:15000,balance:30000});
});

test('Firestore denies direct access to every FIS financial collection',()=>{
 for(const name of ['feeCategories','feeItems','pupilCharges','feeAccounts','feePayments','feeEvents','feeMeta'])assert.match(rules,new RegExp(`match /${name}/\\{[^}]+\\} \\{ allow read, write: if false; \\}`));
});


test('FIS mutations refresh confirmed data in place without showing the full loading screen',()=>{
 assert.ok(fees.includes("renderSchoolFees({silent:true"));
 assert.ok(fees.includes("const silent=options.silent===true&&host.children.length>0"));
 assert.ok(fees.includes("if(silent){host.setAttribute('aria-busy','true')"));
 assert.ok(fees.includes("else if(!cacheFirst)host.textContent='Loading Fees & Receipts…'"));
 assert.ok(fees.includes("pane.dataset.studentId=studentId"));
 assert.ok(fees.includes("window.scrollTo({top:viewState.scrollY,behavior:'auto'})"));
});


test('opening Fees & Receipts reuses the rendered view and uses confirmed cache before network refresh',()=>{
 const app=fs.readFileSync('app-4.js','utf8');
 assert.ok(app.includes("feeHost.dataset.feeContext !== feeContext"));
 assert.ok(app.includes("renderSchoolFees({ cacheFirst: true })"));
 assert.ok(fees.includes("const cachedData=feeReadCompatibleCache(cacheKey),cacheFirst=options.cacheFirst===true&&!silent&&!!cachedData"));
 assert.ok(fees.includes("else if(!cacheFirst)host.textContent='Loading Fees & Receipts…'"));
 assert.ok(fees.includes("host.dataset.feeContext=`${school}|${user}|${session}`"));
 assert.ok(fees.includes("if(refreshAfterCachedRender&&active())setTimeout"));
});


test('old v40 fee cache is discarded so Chrome can fetch the upgraded FIS ledger',()=>{
 const store=new Map();
 const context={navigator:{},localStorage:{getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},Map,Promise};
 vm.createContext(context);vm.runInContext(fees.split("window.addEventListener")[0],context);
 store.set('fee-cache',JSON.stringify({accounts:[{id:'legacy'}]}));
 assert.equal(context.feeReadCompatibleCache('fee-cache'),null);
 assert.equal(store.has('fee-cache'),false);
 store.set('fee-cache',JSON.stringify({schemaVersion:2,categories:[]}));
 assert.equal(context.feeReadCompatibleCache('fee-cache').schemaVersion,2);
});


test('FIS spacing and controls follow the shared SchoolHub screen rhythm on desktop and mobile',()=>{
 const css=fs.readFileSync('ui-polish.css','utf8');
 for(const token of [
  '#app #view-fees #feesWrap label {\n  display:block; width:100%; margin:0; font-weight:500;',
  'margin:8px 0 0; min-height:44px;',
  'background:var(--surface-alt); padding:18px; border-radius:14px;',
  '#app #view-fees .fee-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:12px 0 16px; }',
  '#app #view-fees #feesWrap details, #app #view-fees #feePupil { margin:12px 0; padding:14px; }'
 ]) assert.ok(css.includes(token),token);
});

test('service worker cache is bumped for the FIS build and caches fees.js',()=>{
 assert.match(sw,/schoolhub-cache-v40-closed-sync-1/);assert.match(sw,/\.\/fees\.js/);
});
