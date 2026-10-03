const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const code=fs.readFileSync('school-operations.js','utf8');
function fixture(){const c={operationsQty:n=>String(n/1000),operationsCash:n=>'GH₵ '+(Number(n||0)/100).toFixed(2)};vm.createContext(c);vm.runInContext(code.slice(code.indexOf('function operationsRecordDetails('),code.indexOf('function operationsViewRecord(')),c);return c;}
test('head stock details retain exact quantities and financial values',()=>{
 const c=fixture(),rows=c.operationsRecordDetails('viewItem',{code:'BOOK',name:'Registers',quantityMilli:1125,minimumMilli:500,unit:'pieces',unitCost:1234,active:true},true);
 assert.equal(rows.find(x=>x[0]==='On hand')[1],'1.125 pieces');assert.equal(rows.find(x=>x[0]==='Unit cost')[1],'GH₵ 12.34');assert.equal(rows.find(x=>x[0]==='Low-stock threshold')[1],'0.5 pieces');
});
test('teacher stock details never include financial or internal fields',()=>{
 const c=fixture(),rows=c.operationsRecordDetails('viewItem',{code:'BOOK',quantityMilli:0,unit:'pieces',unitCost:987654,minimumMilli:999,private:'secret',createdBy:'head',active:true},false);
 assert(!rows.some(x=>['Unit cost','Low-stock threshold','createdBy','private'].includes(x[0])));assert(!JSON.stringify(rows).includes('secret'));
 for(const kind of ['viewAsset','viewLiability','viewHistory'])assert.equal(c.operationsRecordDetails(kind,{cost:1234,amount:1234},false).length,0);
});
test('liability and asset details display omitted register fields',()=>{
 const c=fixture(),asset=c.operationsRecordDetails('viewAsset',{code:'A1',purchasedOn:'2026-10-03',cost:10050,value:9025,status:'in_use'},true),bill=c.operationsRecordDetails('viewLiability',{amount:10000,paid:1234,reference:'INV-1'},true);
 assert.equal(asset.find(x=>x[0]==='Acquisition cost')[1],'GH₵ 100.50');assert.equal(asset.find(x=>x[0]==='Purchase date')[1],'2026-10-03');assert.equal(bill.find(x=>x[0]==='Balance')[1],'GH₵ 87.66');assert.equal(bill.find(x=>x[0]==='Invoice reference')[1],'INV-1');
});
test('history details preserve zero quantities and amounts',()=>{
 const c=fixture(),rows=c.operationsRecordDetails('viewHistory',{quantityMilli:0,amount:0,reason:'Count correction'},true);
 assert.equal(rows.find(x=>x[0]==='Quantity')[1],'0');assert.equal(rows.find(x=>x[0]==='Amount')[1],'GH₵ 0.00');
});
