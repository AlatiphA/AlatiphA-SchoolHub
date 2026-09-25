const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app-4.js','utf8');
function section(start,end){return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));}
function fixture(){
  const calls=[],alerts=[];
  const button={dataset:{id:'pupil'},textContent:'Generate PDF',disabled:false,addEventListener(_,fn){this.click=fn;}};
  const batch={textContent:'Generate class PDF',addEventListener(_,fn){this.click=()=>fn({currentTarget:this});}};
  const list={innerHTML:'',appendChild(){},querySelectorAll:selector=>selector==='.gen'?[button]:[]};
  const settings={currentYear:'2026/2027',currentTerm:'Term 1'};
  const result={student:{id:'pupil',name:'Example Pupil'},entries:[{}],avg:70};
  const ctx={hasSchoolBillingAccount:()=>false,console,alert:msg=>alerts.push(msg),renderReportCreditStatus(){},isHeadTeacher:()=>false,canAccessClass:()=>true,
    DB:{get:key=>key==='settings'?settings:key==='classes'?[{id:'class1'}]:{}},KEYS:{settings:'settings',classes:'classes',remarks:'remarks'},
    document:{getElementById:id=>id==='reportsClassSelect'?{value:'class1'}:id==='generateAllBtn'?batch:list,createElement:()=>({})},
    escapeHtml:x=>x,computeClassResults:()=>[result],computeSubjectPositions:()=>({}),gradeKey:()=> 'term',
    studentsForClassYear:(id,year)=>{assert.equal(id,'class1');assert.equal(year,'2026/2027');return [result.student];},
    generateSinglePDF:async(...args)=>calls.push(['single',...args]),generateBatchPDF:async(...args)=>calls.push(['batch',...args])};
  vm.createContext(ctx);
  vm.runInContext(section('async function runReportAction(', 'function reportUsesCredits('),ctx);
  vm.runInContext(section('function renderReportsStudentList()', '// Opens a WhatsApp'),ctx);
  vm.runInContext(section("document.getElementById('generateAllBtn').addEventListener", '/* ---------- CSV export'),ctx);
  return {ctx,button,batch,calls,alerts};
}
test('individual report button passes the current academic year and reaches PDF generation',async()=>{
  const f=fixture();f.ctx.renderReportsStudentList();await f.button.click();
  assert.equal(f.calls[0][0],'single');assert.equal(f.calls[0][3],1);assert.deepEqual(f.alerts,[]);
  assert.equal(f.button.disabled,false);assert.equal(f.button.textContent,'Generate PDF');
});
test('class batch button passes the current academic year and reaches PDF generation',async()=>{
  const f=fixture();await f.batch.click();assert.equal(f.calls[0][0],'batch');assert.equal(f.calls[0][3],1);assert.deepEqual(f.alerts,[]);
});
test('report failures are visible and the button becomes usable again',async()=>{
  const f=fixture();f.ctx.generateSinglePDF=async()=>{throw Error('PDF library unavailable');};
  f.ctx.renderReportsStudentList();await f.button.click();assert.match(f.alerts[0],/PDF library unavailable/);assert.equal(f.button.disabled,false);
});
test('report button displays progress until generation finishes',async()=>{
  const f=fixture();let finish;f.ctx.generateSinglePDF=()=>new Promise(resolve=>finish=resolve);
  f.ctx.renderReportsStudentList();const pending=f.button.click();assert.equal(f.button.disabled,true);assert.equal(f.button.textContent,'Preparing PDF…');
  finish();await pending;assert.equal(f.button.disabled,false);
});
test('missing PDF library produces an actionable error',()=>{
  const f=fixture();f.ctx.window={};assert.throws(()=>f.ctx.reportPdfConstructor(),/Reconnect to the internet/);
});
