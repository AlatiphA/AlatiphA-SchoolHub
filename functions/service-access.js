'use strict';
const blocked = p => ['suspended','disabled'].includes(p?.status);
const {AsyncLocalStorage}=require('node:async_hooks');
const actors=new AsyncLocalStorage();
// Central callable gate also protects read-only endpoints that bypass client rules.
function wrapOnCall(onCall,{db,admin,HttpsError}) {
 return (options,handler)=>onCall(options,async request=>{
  let owner=false;
  async function check(){if(request.auth){
   const u=(await db.doc('users/'+request.auth.uid).get()).data()||{};
   if(request.auth.token?.schoolhubOwner===true){const a=await admin.auth().getUser(request.auth.uid);owner=!a.disabled&&a.emailVerified&&a.customClaims?.schoolhubOwner===true;}
   if(!owner){
    if(blocked(u.ownerAccess))throw new HttpsError('permission-denied','Your account access is '+u.ownerAccess.status+'. Contact the SchoolHub owner.');
    if(u.schoolId){const s=(await db.doc('schoolAdministration/'+u.schoolId).get()).data()||{};
     if(blocked({status:s.accessStatus})||['deleting','deleted'].includes(s.state))throw new HttpsError('permission-denied','This school is unavailable. Contact the SchoolHub owner.');
    }
   }
  }}
  await check();
  return actors.run({uid:request.auth?.uid,owner},async()=>{const result=await handler(request);await check();return result;});
 });
}
module.exports={blocked,wrapOnCall,actor:()=>actors.getStore()};
