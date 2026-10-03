const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('stock category choices contain the fourteen agreed categories and retain saved values',()=>{
 const source=fs.readFileSync('school-operations.js','utf8');
 const snippet=source.slice(source.indexOf('const OPERATIONS_CATEGORIES='),source.indexOf('function operationsSession'));
 const c={};vm.createContext(c);vm.runInContext(snippet,c);
 const options=c.operationsCategoryOptions();assert.equal(options.length,15);assert.equal(new Set(options.map(x=>x[0])).size,15);
 for(const value of ['Teaching & Learning Materials','Furniture','Health/SHEP & First Aid','Consumables/General Supplies'])assert(options.some(x=>x[0]===value));
 const saved=c.operationsCategoryOptions('Old school category');assert.equal(saved.at(-1)[0],'Old school category');
 assert.equal(c.operationsCategoryOptions('Furniture').length,15);assert.equal(c.operationsCategoryOptions('').length,15);
});
test('Stores follows Reports in both Home and the full quick-access menu',()=>{
 const source=fs.readFileSync('app-4.js','utf8');
 const home=source.match(/const homeOrder=(\[[^;]+\])/)[1];const order=vm.runInNewContext(home);
 assert.equal(order.indexOf('operations'),order.indexOf('reports')+1);
 const cards=source.slice(source.indexOf('const QUICK_ACCESS_CARDS = ['),source.indexOf('function renderHomeQuickAccess'));
 const views=[...cards.matchAll(/\bview:\s*'([^']+)'/g)].map(x=>x[1]);assert.equal(views.indexOf('operations'),views.indexOf('reports')+1);
});
