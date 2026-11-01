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
