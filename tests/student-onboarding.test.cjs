const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app-4.js','utf8'),html=fs.readFileSync('index.html','utf8');
function fixture(){
 const nodes=new Map(),calls=[];const node=(id,hidden=false)=>{const classes=new Set(hidden?['hidden']:[]),events={};const n={id,value:'',innerHTML:'',textContent:'Expand',dataset:{},attrs:{'aria-expanded':'false'},classList:{toggle:k=>classes.has(k)?(classes.delete(k),false):(classes.add(k),true),add:k=>classes.add(k),contains:k=>classes.has(k)},addEventListener:(name,handler)=>(events[name]??=[]).push(handler),setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k];},focus(){this.focused=true;},click(){for(const fn of events.click||[])fn();},fire:(name,event)=>{for(const fn of events[name]||[])fn(event);},events};nodes.set(id,n);return n;};
 for(const id of ['toggleBulkStudentsBtn','toggleStudentExcelBtn','studentTemplateBtn','importStudentsBtn','studentImportInput'])node(id);
 for(const id of ['bulkStudentForm','studentExcelForm'])node(id,true);
 node('bulkStudentInput');node('studentImportPreview');
 const c={document:{getElementById:id=>nodes.get(id)},exportStudentsWorkbook:v=>calls.push(['download',v]),handleStudentImportFile:e=>calls.push(['import',e]),String};vm.createContext(c);
 vm.runInContext(source.slice(source.indexOf('function installStudentOnboardingControls()'),source.indexOf('function installStudentTabUpgrade()')),c);
 vm.runInContext(source.slice(source.indexOf('function closeSchoolHubAddForm('),source.indexOf("document.querySelectorAll('[data-close-form]')")),c);
 return {c,nodes,calls};
}
test('Bulk add and Excel template expand independently, preserve entries and do not accumulate listeners on rerender',()=>{
 const f=fixture();f.c.installStudentOnboardingControls();f.c.installStudentOnboardingControls();f.nodes.get('bulkStudentInput').value='Ama, F, 001';f.nodes.get('studentImportPreview').innerHTML='Existing import preview';
 const bulk=f.nodes.get('toggleBulkStudentsBtn'),excel=f.nodes.get('toggleStudentExcelBtn');assert.equal(bulk.events.click.length,1);bulk.click();assert(!f.nodes.get('bulkStudentForm').classList.contains('hidden'));assert(f.nodes.get('studentExcelForm').classList.contains('hidden'));assert.equal(bulk.attrs['aria-expanded'],'true');excel.click();bulk.click();assert(f.nodes.get('bulkStudentForm').classList.contains('hidden'));assert(!f.nodes.get('studentExcelForm').classList.contains('hidden'));assert.equal(f.nodes.get('bulkStudentInput').value,'Ama, F, 001');assert.equal(f.nodes.get('studentImportPreview').innerHTML,'Existing import preview');
});
test('Close hides each panel, resets the toggle and returns focus without clearing its contents',()=>{
 const f=fixture();f.c.installStudentOnboardingControls();for(const [panel,toggle]of [['bulkStudentForm','toggleBulkStudentsBtn'],['studentExcelForm','toggleStudentExcelBtn']]){f.nodes.get(toggle).click();f.c.closeSchoolHubAddForm(panel,toggle);assert(f.nodes.get(panel).classList.contains('hidden'));assert.equal(f.nodes.get(toggle).attrs['aria-expanded'],'false');assert.equal(f.nodes.get(toggle).textContent,'Expand');assert(f.nodes.get(toggle).focused);}
});
test('template download and import use the existing workbook handlers exactly once',()=>{
 const f=fixture();f.c.installStudentOnboardingControls();f.c.installStudentOnboardingControls();let chooser=0;f.nodes.get('studentImportInput').addEventListener('click',()=>chooser++);f.nodes.get('studentTemplateBtn').click();f.nodes.get('importStudentsBtn').click();const e={target:{files:[]}};f.nodes.get('studentImportInput').fire('change',e);assert.equal(chooser,1);assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0],['download',true]);assert.equal(f.calls[1][1],e);
});
test('three onboarding methods are ordered and Excel controls are outside the export/print toolbar',()=>{
 const single=html.indexOf('id="addStudentForm"'),bulk=html.indexOf('id="bulkStudentForm"'),excel=html.indexOf('id="studentExcelForm"');assert(single<bulk&&bulk<excel);
 for(const id of ['studentTemplateBtn','importStudentsBtn','studentImportInput','studentImportPreview']){assert.equal([...html.matchAll(new RegExp('id="'+id+'"','g'))].length,1);assert(html.indexOf('id="'+id+'"')>excel);}
 const install=source.slice(source.indexOf('function installStudentTabUpgrade()'),source.indexOf('function studentClassName('));assert(!install.includes('id="studentTemplateBtn"'));assert(!install.includes('id="importStudentsBtn"'));assert(install.includes('id="exportStudentsBtn"'));assert(install.includes('id="printStudentsBtn"'));
 assert(html.includes('id="bulkStudentForm" class="stack student-onboarding-panel hidden"'));assert(html.includes('id="studentExcelForm" class="stack student-onboarding-panel hidden"'));
});
