const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('fees.js','utf8');
test('parent document header escapes school contacts and shares the receipt logo',()=>{
 const c={escapeHtml:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),isDataImage:s=>typeof s==='string'&&s.startsWith('data:image/')};vm.createContext(c);
 vm.runInContext(source.slice(source.indexOf('function feeParentHeader('),source.indexOf('async function loadFeeParentLogos(')),c);
 const html=c.feeParentHeader({logo:'data:image/png;base64,test',schoolName:'A <School>',address:'Road & Town',phone:'012345',email:'school@example.com'});
 for(const value of ['data:image/png;base64,test','A &lt;School>','Road &amp; Town','012345','school@example.com'])assert.ok(html.includes(value));
 assert.ok(c.feeParentHeader({}).includes('hidden'));assert.match(c.feeParentFooter(),/Generated from AlatiphA SchoolHub/);
});
test('statements and every reminder have branding and footer; print waits for all logos',()=>{
 for(const name of ['feeReminderHtml','feeStatementHtml']){const start=source.indexOf('function '+name+'('),end=source.indexOf('\nfunction ',start+1);const body=source.slice(start,end);assert.ok(body.includes('feeParentHeader('));assert.ok(body.includes('feeParentFooter()'));}
 assert.ok(source.includes('await logoReady;if(overlay.isConnected&&isHeadTeacher())window.print()'));
 assert.ok(source.includes('parentDocument:true'));assert.ok(source.includes("querySelectorAll('.fee-parent-logo')"));
 const css=fs.readFileSync('ui-polish.css','utf8');assert.ok(css.includes('overflow-wrap:anywhere;padding:8px 4px'));assert.ok(css.includes('display:table-header-group'));
});
test('batch recipients filter current class and inactive learners without changing source order',()=>{
 const c={};vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function feeParentBatchStudents('),source.indexOf('function feeParentHeader(')),c);
 const students=[{id:'b',name:'Zoe',classId:'1'},{id:'a',name:'Amy',classId:'2'},{id:'c',classId:'1',active:false},{id:'d',classId:'1',deleted:true}];
 assert.deepEqual(Array.from(c.feeParentBatchStudents(students),s=>s.id),['a','b']);
 assert.deepEqual(Array.from(c.feeParentBatchStudents(students,'1'),s=>s.id),['b']);assert.equal(students[0].id,'b');
 assert.ok(source.includes('buildStatement(student.id,false)'));assert.ok(source.includes("if(scope==='all')return all"));
});
test('reminder recipients expose only the relevant selector and retain previous choices',()=>{
 const labels={feeReminderPupil:{},feeReminderClass:{}},controls={feeReminderPupil:{value:'pupil-1',closest:()=>labels.feeReminderPupil},feeReminderClass:{value:'class-1',closest:()=>labels.feeReminderClass},feeReminderScope:{value:'single'}};
 const c={};vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function feeReminderRecipientFields('),source.indexOf('function feeParentBatchStudents(')),c);
 const host={querySelector:id=>controls[id.slice(1)]};
 for(const scope of ['single','class','all','selected','single']){controls.feeReminderScope.value=scope;c.feeReminderRecipientFields(host);for(const [id,visible] of [['feeReminderPupil',scope==='single'],['feeReminderClass',scope==='class']]){assert.equal(labels[id].hidden,!visible);assert.equal(controls[id].disabled,!visible);}}
 assert.equal(controls.feeReminderPupil.value,'pupil-1');assert.equal(controls.feeReminderClass.value,'class-1');
});
