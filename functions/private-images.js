'use strict';
const crypto=require('node:crypto');
const PRIVATE=/^schools\/([^/]+)\/(student-photos|signatures|logos)\/.+/;
function privatePath(name){return typeof name==='string'&&PRIVATE.test(name);}
function tokens(meta){return String(meta.metadata?.firebaseStorageDownloadTokens||'').split(',').filter(Boolean);}
async function revoke(file){
 const [before]=await file.getMetadata(),old=tokens(before);if(!old.length)return false;
 const tokenHash=crypto.createHash('sha256').update(old.slice().sort().join(',')).digest('hex');
 if(process.env.FIREBASE_STORAGE_EMULATOR_HOST && before.metadata?.schoolhubPrivateTokenHash===tokenHash)return false;
 await file.setMetadata({metadata:{firebaseStorageDownloadTokens:null,schoolhubPrivateImage:'true'}},{ifMetagenerationMatch:Number(before.metageneration)});
 // Storage emulator preserves its token list separately from GCS metadata. Its
 // documented admin token endpoint is used only for loopback demo testing.
 const host=process.env.FIREBASE_STORAGE_EMULATOR_HOST;
 if(host){if(!/^(127\.0\.0\.1|localhost):\d+$/.test(host))throw Error('Refusing non-local emulator token endpoint.');for(const token of old){const response=await fetch('http://'+host+'/v0/b/'+encodeURIComponent(file.bucket.name)+'/o/'+encodeURIComponent(file.name)+'?delete_token='+encodeURIComponent(token),{method:'POST',headers:{Authorization:'Bearer owner'},signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('Emulator token revocation failed.');}}
 const [after]=await file.getMetadata();if(tokens(after).some(token=>old.includes(token)))throw Error('Old image link revocation was not confirmed.');
 if(host){const stamp=crypto.createHash('sha256').update(tokens(after).sort().join(',')).digest('hex');await file.setMetadata({metadata:{schoolhubPrivateTokenHash:stamp}},{ifMetagenerationMatch:Number(after.metageneration)});}
 else if(tokens(after).length)throw Error('Unexpected image download tokens remain.');
 return true;
}
function register({db,admin,HttpsError,onCall,onObjectFinalized,onObjectMetadataUpdated}){
 async function head(request){if(!request.auth)throw new HttpsError('unauthenticated','Sign in first.');const user=(await db.collection('users').doc(request.auth.uid).get()).data();if(!user||user.role!=='headteacher'||user.status!=='active'||!user.schoolId)throw new HttpsError('permission-denied','Active Head Teacher required.');if(request.data?.expectedUid!==request.auth.uid||request.data?.expectedSchoolId!==user.schoolId)throw new HttpsError('failed-precondition','Your account or school changed.');return user.schoolId;}
 const revokeSchoolImageLinks=onCall({invoker:'public',region:'us-central1',timeoutSeconds:120},async request=>{
  const school=await head(request),cursor=request.data?.cursor||'';if(typeof cursor!=='string'||cursor.length>4096)throw new HttpsError('invalid-argument','Invalid maintenance cursor.');
  const bucket=admin.storage().bucket(),[files,next]=await bucket.getFiles({prefix:'schools/'+school+'/',autoPaginate:false,maxResults:25,...(cursor?{pageToken:cursor}:{})});let revoked=0,scanned=0;
  for(const file of files){if(!file.name.startsWith('schools/'+school+'/')||!privatePath(file.name))continue;await head(request);scanned++;if(await revoke(file))revoked++;}
  await head(request);const stamp=new Date().toISOString();await db.collection('schools').doc(school).collection('imageLinkSecurity').doc('latest').set({actor:request.auth.uid,checkedAt:stamp,scanned,revoked,complete:!next?.pageToken},{merge:true});
  return {scanned,revoked,cursor:next?.pageToken||'',complete:!next?.pageToken};
 });
 const protect=async event=>{
  const {name,bucket,generation}=event.data||{};if(!privatePath(name)||!bucket)return;
  const file=admin.storage().bucket(bucket).file(name);try{const [meta]=await file.getMetadata();if(String(meta.generation)!==String(generation))return;await revoke(file);}catch(e){if(Number(e.code)===404)return;throw e;}
 };
 const protectSchoolImageUpload=onObjectFinalized({region:'africa-south1',retry:true},protect);
 const protectSchoolImageMetadata=onObjectMetadataUpdated?onObjectMetadataUpdated({region:'africa-south1',retry:true},protect):undefined;
 return {revokeSchoolImageLinks,protectSchoolImageUpload,...(protectSchoolImageMetadata?{protectSchoolImageMetadata}:{})};
}
module.exports={register,revoke,privatePath};
