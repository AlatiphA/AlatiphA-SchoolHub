const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('fees.js','utf8');
test('Fees sections start collapsed on a fresh page',()=>{assert.doesNotMatch(source,/<details\s+open[\s>]/);});
test('refresh restores the user section choices, including closed sections',()=>{
 const rows=[['Financial dashboard & reports',true],['Arrears management',true],['Fee categories',false]].map(([text,open])=>({open,querySelector:()=>({textContent:text})}));
 const c={};vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function feeRestoreDetails('),source.indexOf('async function flushPendingSchoolFeeWrites(')),c);
 c.feeRestoreDetails({querySelectorAll:()=>rows},{detailState:{'Financial dashboard & reports':false,'Arrears management':true,'Fee categories':false}});
 assert.deepEqual(rows.map(x=>x.open),[false,true,false]);
 const refreshCapture=source.indexOf('if(silent)viewState=feeCaptureViewState(host);');assert.ok(refreshCapture>source.indexOf("await safetyCall('getSchoolFees'"));assert.ok(refreshCapture<source.indexOf('  host.innerHTML=`',refreshCapture));
});
