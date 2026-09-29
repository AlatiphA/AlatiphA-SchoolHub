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

test('service worker cache is bumped for the FIS build and caches fees.js',()=>{
 assert.match(sw,/schoolhub-cache-v40-fis-multi-fee-1/);assert.match(sw,/\.\/fees\.js/);
});
