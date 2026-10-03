const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync('app-4.js','utf8'),html=fs.readFileSync('index.html','utf8');
test('Close on add forms collapses the form without clearing entered values',()=>{
 const calls=[],form={classList:{add:name=>calls.push(name)}},toggle={setAttribute:(k,v)=>calls.push([k,v]),focus:()=>calls.push('focus')};
 const c={document:{getElementById:id=>id==='form'?form:toggle}};vm.createContext(c);vm.runInContext(app.slice(app.indexOf('function closeSchoolHubAddForm('),app.indexOf("document.querySelectorAll('[data-close-form]')")),c);
 c.closeSchoolHubAddForm('form','toggle');assert.equal(toggle.textContent,'Expand');assert.deepEqual(calls,['hidden',['aria-expanded','false'],'focus']);
});
test('Staff Class and Student add forms have explicit non-submit close buttons',()=>{
 for(const kind of ['Staff','Class','Student'])assert.match(html,new RegExp('<button type="button" id="closeAdd'+kind+'Btn" data-close-form="add'+kind+'Form" data-form-toggle="toggleAdd'+kind+'Btn" data-dismiss-ui>Close</button>'));
});
test('dismiss styling is explicitly marked and does not alter cancellation actions',()=>{
 const fees=fs.readFileSync('fees.js','utf8');assert.match(fees, /id="feeCancelItemSave" type="button" class="fee-danger-text">Cancel fee item/);assert(!fees.includes('class="fee-danger-text" data-dismiss-ui'));
 for(const file of ['index.html','app-4.js','fees.js','account-security.js','school-operations.js'])assert(fs.readFileSync(file,'utf8').includes('data-dismiss-ui'));
});
