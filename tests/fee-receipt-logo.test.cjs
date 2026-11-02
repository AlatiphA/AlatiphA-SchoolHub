const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const s=fs.readFileSync('fees.js','utf8');
function fixture(logo='data:image/png;base64,logo'){
 const image={hidden:true,decode:async()=>{}},overlay={isConnected:true,querySelector:()=>image};let calls=0;
 const c={sessionGeneration:1,currentUid:'head',currentSchoolId:'school',DB:{get:()=>({logo})},KEYS:{settings:'settings'},isDataImage:x=>typeof x==='string'&&x.startsWith('data:image/'),getOrSyncReportImage:async()=>{calls++;return 'data:image/png;base64,cloud';},optimizeReportImage:async()=> 'data:image/png;base64,optimized',isCurrentSession:()=>true,isHeadTeacher:()=>true,console};vm.createContext(c);vm.runInContext(s.slice(s.indexOf('async function prepareFeePrintLogo('),s.indexOf('function showFeeReceipt(p)')),c);return {c,image,overlay,calls:()=>calls};
}
test('receipt uses the saved logo offline and waits for it to decode',async()=>{const f=fixture();await f.c.loadFeeReceiptLogo(f.overlay);assert.equal(f.calls(),0);assert.equal(f.image.hidden,false);assert.equal(f.image.src,'data:image/png;base64,optimized');});
test('receipt resolves cloud logo and never reveals an image after account change',async()=>{const f=fixture('');await f.c.loadFeeReceiptLogo(f.overlay);assert.equal(f.calls(),1);assert.equal(f.image.hidden,false);const revoked=fixture();revoked.c.isCurrentSession=()=>false;await revoked.c.loadFeeReceiptLogo(revoked.overlay);assert.equal(revoked.image.hidden,true);});
test('missing or broken logo leaves receipt usable without a broken image',async()=>{for(const missing of [true,false]){const f=fixture('');if(missing)f.c.getOrSyncReportImage=async()=>'';else f.image.decode=async()=>{throw Error('broken')};await f.c.loadFeeReceiptLogo(f.overlay);assert.equal(f.image.hidden,true);}});
test('batch statements and reminders share one optimized logo and keep originals unchanged',async()=>{
 const f=fixture(),original='data:image/png;base64,original';let optimized=0;f.c.DB.get=()=>({logo:original});f.c.optimizeReportImage=async(source,options)=>{assert.equal(source,original);assert.equal(options.maxWidth,384);assert.equal(options.maxHeight,384);optimized++;return 'data:image/png;base64,small';};
 vm.runInContext(s.slice(s.indexOf('async function loadFeeParentLogos('),s.indexOf('function feeReminderHtml(')),f.c);
 const images=Array.from({length:30},()=>({isConnected:true,hidden:true,decode:async()=>{}}));await f.c.loadFeeParentLogos({isConnected:true,querySelectorAll:()=>images});assert.equal(optimized,1);assert(images.every(image=>!image.hidden&&image.src==='data:image/png;base64,small'));assert.equal(f.c.DB.get().logo,original);
});
test('closing or changing account during logo optimization does not reveal the old school logo',async()=>{
 const f=fixture();let finish;f.c.optimizeReportImage=()=>new Promise(resolve=>finish=resolve);const loading=f.c.loadFeeReceiptLogo(f.overlay);await Promise.resolve();f.c.isCurrentSession=()=>false;finish('data:image/png;base64,small');await loading;assert.equal(f.image.hidden,true);assert.equal(f.image.src,undefined);
});
