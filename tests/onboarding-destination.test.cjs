const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app-4.js','utf8'),html=fs.readFileSync('index.html','utf8'),css=fs.readFileSync('ui-polish.css','utf8');
test('onboarding class choices start empty, preserve independent selections and discard revoked classes',()=>{
 const nodes=Object.fromEntries(['newStudentClassSelect','bulkStudentClassSelect','studentImportClassSelect'].map(id=>[id,{value:''}]));let classes=[{id:'a',name:'One'},{id:'b',name:'Two'}];
 const c={document:{getElementById:id=>nodes[id]},getAccessibleClasses:()=>classes,escapeHtml:x=>x};vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function fillStudentOnboardingClasses()'),source.indexOf('function studentClassSelectionKey()')),c);
 c.fillStudentOnboardingClasses();assert(Object.values(nodes).every(n=>n.value===''));nodes.newStudentClassSelect.value='a';nodes.bulkStudentClassSelect.value='b';c.fillStudentOnboardingClasses();assert.equal(nodes.newStudentClassSelect.value,'a');assert.equal(nodes.bulkStudentClassSelect.value,'b');assert.equal(nodes.studentImportClassSelect.value,'');classes=classes.slice(0,1);c.fillStudentOnboardingClasses();assert.equal(nodes.bulkStudentClassSelect.value,'');
 for(const id of Object.keys(nodes))assert(html.includes('id="'+id+'" required'));
});
test('Excel destination is explicit, rejects mixed classes and preserves identity on class moves',()=>{
 const c={DB:{get:()=>[{id:'same',admissionId:'001',classId:'a',photo:'kept'}]},KEYS:{students:'students'},getAccessibleClasses:()=>[{id:'a'},{id:'b'}],canAccessClass:()=>true,studentClassIdByName:x=>({One:'a',Two:'b'})[x],uid:()=> 'new'};vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function planStudentImport('),source.indexOf('function showStudentImportPreview(')),c);
 const rows=[{row:2,values:{name:'Ama',admissionId:'001',gender:'F',dob:'2015-01-01',className:'Two'}}];
 assert(c.planStudentImport(rows,'').errors.length);assert(c.planStudentImport(rows,'a').errors.length);const p=c.planStudentImport(rows,'b');assert.equal(p.errors.length,0);assert.equal(p.changes[0].record.classId,'b');assert.equal(p.changes[0].record.id,'same');assert.equal(p.changes[0].record.photo,'kept');c.canAccessClass=()=>false;assert(c.planStudentImport(rows,'b').errors.length);
 assert(source.includes('planStudentImport(p.rows, p.destinationClassId)'));assert(source.includes("value !== p.destinationClassId"));
});
test('mobile onboarding Close controls have bounded flex sizing and remain non-submit dismiss controls',()=>{
 const override=css.slice(css.indexOf('/* Dismiss controls must fit'));
 for(const id of ['closeBulkStaffBtn','closeStaffExcelBtn','closeBulkStudentsBtn','closeStudentExcelBtn'])assert.match(html,new RegExp('<button type="button" id="'+id+'"[^>]*data-dismiss-ui>Close</button>'));
 assert(override.includes('flex:0 0 auto!important'));assert(override.includes('display:block!important'));assert(override.includes('min-height:44px!important'));assert(override.includes('@media(max-width:600px)'));assert(override.includes('flex-wrap:wrap'));assert(override.includes('width:100%!important'));
});
