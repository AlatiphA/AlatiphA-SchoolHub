/* Native Firebase Auth verification/password flow, using only a demo emulator. */
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const {initializeApp,deleteApp}=require('firebase/app');
const {getAuth,connectAuthEmulator,createUserWithEmailAndPassword,verifyBeforeUpdateEmail,applyActionCode,signInWithEmailAndPassword,reauthenticateWithCredential,EmailAuthProvider,updatePassword,signOut}=require('firebase/auth');
const host=process.env.FIREBASE_AUTH_EMULATOR_HOST;
if(!host)throw Error('Run this test through the demo Auth emulator; production Auth is forbidden.');
const app=initializeApp({projectId:'demo-schoolhub-audit',apiKey:'demo-api-key',authDomain:'localhost'},'account-security-test');
const auth=getAuth(app);connectAuthEmulator(auth,'http://'+host,{disableWarnings:true});
after(()=>deleteApp(app));
test('verified native email change and password change preserve one Firebase UID',async()=>{
 const suffix=Date.now(),oldEmail='old-'+suffix+'@example.test',newEmail='new-'+suffix+'@example.test',oldPassword='Old-password-123',newPassword='New-password-456';
 const user=(await createUserWithEmailAndPassword(auth,oldEmail,oldPassword)).user,uid=user.uid;
 await reauthenticateWithCredential(user,EmailAuthProvider.credential(oldEmail,oldPassword));
 await verifyBeforeUpdateEmail(user,newEmail);
 assert.equal(user.email,oldEmail,'request alone must not change login email');
 const response=await fetch('http://'+host+'/emulator/v1/projects/demo-schoolhub-audit/oobCodes');assert(response.ok);
 const codes=(await response.json()).oobCodes||[],code=codes.find(code=>code.requestType==='VERIFY_AND_CHANGE_EMAIL'&&(code.newEmail===newEmail||code.email===newEmail));assert(code,'verification action code');
 await applyActionCode(auth,code.oobCode);await signOut(auth);
 const changed=(await signInWithEmailAndPassword(auth,newEmail,oldPassword)).user;assert.equal(changed.uid,uid);assert.equal(changed.emailVerified,true);
 await reauthenticateWithCredential(changed,EmailAuthProvider.credential(newEmail,oldPassword));await updatePassword(changed,newPassword);await signOut(auth);
 await assert.rejects(signInWithEmailAndPassword(auth,newEmail,oldPassword));
 assert.equal((await signInWithEmailAndPassword(auth,newEmail,newPassword)).user.uid,uid);
 await assert.rejects(applyActionCode(auth,code.oobCode),'verification link cannot be reused');
});
