const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const s=fs.readFileSync('fees.js','utf8');
function fixture(logo='data:image/png;base64,logo'){
 const image={hidden:true,decode:async()=>{}},overlay={isConnected:true,querySelector:()=>image};let calls=0;
 const c={sessionGeneration:1,currentUid:'head',currentSchoolId:'school',DB:{get:()=>({logo})},KEYS:{settings:'settings'},isDataImage:x=>typeof x==='string'&&x.startsWith('data:image/'),getOrSyncReportImage:async()=>{calls++;return 'data:image/png;base64,cloud';},isCurrentSession:()=>true,isHeadTeacher:()=>true,console};vm.createContext(c);vm.runInContext(s.slice(s.indexOf('async function loadFeeReceiptLogo('),s.indexOf('function showFeeReceipt(p)')),c);return {c,image,overlay,calls:()=>calls};
}
test('receipt uses the saved logo offline and waits for it to decode',async()=>{const f=fixture();await f.c.loadFeeReceiptLogo(f.overlay);assert.equal(f.calls(),0);assert.equal(f.image.hidden,false);assert.equal(f.image.src,'data:image/png;base64,logo');});
test('receipt resolves cloud logo and never reveals an image after account change',async()=>{const f=fixture('');await f.c.loadFeeReceiptLogo(f.overlay);assert.equal(f.calls(),1);assert.equal(f.image.hidden,false);const revoked=fixture();revoked.c.isCurrentSession=()=>false;await revoked.c.loadFeeReceiptLogo(revoked.overlay);assert.equal(revoked.image.hidden,true);});
test('missing or broken logo leaves receipt usable without a broken image',async()=>{for(const missing of [true,false]){const f=fixture('');if(missing)f.c.getOrSyncReportImage=async()=>'';else f.image.decode=async()=>{throw Error('broken')};await f.c.loadFeeReceiptLogo(f.overlay);assert.equal(f.image.hidden,true);}});
