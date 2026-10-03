/* Login credentials stay in Firebase Auth; they are never saved in local queues. */
function accountSecurityError(error){
  const code=String(error?.code||'');
  if(/wrong-password|invalid-credential/.test(code))return 'The current password was not accepted. Check it and retry.';
  if(/requires-recent-login|user-token-expired|invalid-user-token/.test(code))return 'Sign in again, then reopen Account Security. If you verified a new email, sign in with that address.';
  if(/email-already-in-use|already-exists/.test(code))return error.message||'That email is already used by another account.';
  if(/weak-password/.test(code))return 'The new password does not meet the account password requirements.';
  if(/network-request-failed|unavailable/.test(code))return 'Connect to the internet and retry. Credential changes are not queued offline.';
  return error?.message||'The change could not be completed. Retry while online.';
}
function passwordLoginAvailable(user){return user?.providerData?.some(provider=>provider.providerId==='password')===true;}
async function confirmAccountPassword(user,password){
  if(!passwordLoginAvailable(user))throw Error('Manage Google-only credentials in your Google account.');
  if(!password)throw Error('Enter your current password.');
  await user.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(user.email,password));
  await user.getIdToken(true);
}
async function changeSchoolHubPassword(user,currentPassword,newPassword,confirmation){
  if(!newPassword||newPassword!==confirmation)throw Error('Enter the same new password in both fields.');
  if(newPassword.length<6)throw Error('Use at least 6 characters; any stricter account requirements also apply.');
  if(newPassword===currentPassword)throw Error('Choose a password different from your current password.');
  await confirmAccountPassword(user,currentPassword);
  if(firebase.auth().currentUser?.uid!==user.uid)throw Error('Your account changed. Sign in again.');
  await user.updatePassword(newPassword);
}
async function requestSchoolHubLoginEmail(user,currentPassword,newEmail){
  newEmail=String(newEmail||'').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)||newEmail.length>254)throw Error('Enter a valid new login email.');
  if(newEmail===String(user.email||'').trim().toLowerCase())throw Error('Enter a different login email.');
  await confirmAccountPassword(user,currentPassword);
  if(firebase.auth().currentUser?.uid!==user.uid)throw Error('Your account changed. Sign in again.');
  const result=await safetyCall('prepareLoginEmailChange',{newEmail});
  if(firebase.auth().currentUser?.uid!==user.uid)throw Error('Your account changed. Sign in again.');
  await user.verifyBeforeUpdateEmail(result.newEmail,{url:location.origin+'/?account-security=1'});
  return result.newEmail;
}
async function refreshSchoolHubLoginEmail(user){
  await user.reload();await user.getIdToken(true);
  if(firebase.auth().currentUser?.uid!==user.uid)throw Error('Your account changed. Sign in again.');
  const result=await safetyCall('synchronizeLoginEmail',{});
  if(user.uid===currentUid&&result.schoolId===currentSchoolId){
    currentUserData={...(currentUserData||{}),email:result.email,pendingLoginEmail:result.pendingEmail};
    saveVerifiedLocalSession(user,currentUserData);refreshProfileMenu();
  }
  return result;
}
async function openAccountSecurity(){
  document.getElementById('profileDropdown')?.classList.add('hidden');
  const user=FIREBASE_ENABLED?firebase.auth().currentUser:null;
  if(!user||user.uid!==currentUid||currentStatus!=='active')return;
  const previous=document.getElementById('accountSecurityDialog');
  if(previous?.dataset.busy==='true')return;
  if(previous){previous.close();previous.remove();}
  const dialog=document.createElement('dialog');dialog.id='accountSecurityDialog';dialog.className='my-staff-profile account-security';dialog.setAttribute('aria-labelledby','accountSecurityTitle');
  dialog.innerHTML='<h2 id="accountSecurityTitle">Account Security</h2><p>Login email: <strong id="accountSecurityEmail"></strong></p><p class="hint">Your login email is separate from the contact email in My Details. Your school records and Staff link stay attached to the same account.</p><p id="accountSecurityStatus" role="status" aria-live="polite"></p>'+
    (passwordLoginAvailable(user)?'<form id="accountPasswordForm" class="stack"><h3>Change password</h3><label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>New password<input name="newPassword" type="password" autocomplete="new-password" minlength="6" required></label><label>Confirm new password<input name="confirmPassword" type="password" autocomplete="new-password" minlength="6" required></label><button type="submit" class="btn-primary">Change password</button></form><hr><form id="accountEmailForm" class="stack"><h3>Change login email</h3><label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>New login email<input name="newEmail" type="email" autocomplete="email" maxlength="254" required></label><p class="hint">We will send a verification link to the new address. Your login email changes only after verification. Requested addresses stay reserved for your account to protect verification and recovery links.</p><button type="submit" class="btn-primary">Send verification link</button></form>':'<p>You sign in with Google. Change your Google email or password in your Google account.</p><a href="https://myaccount.google.com/security" target="_blank" rel="noopener noreferrer">Open Google Account Security</a>')+
    '<p><button type="button" id="accountEmailRefresh" class="btn-secondary">I have verified my email — refresh</button></p><button type="button" id="accountSecurityClose" class="btn-secondary" data-dismiss-ui>Close</button>';
  document.body.append(dialog);dialog.showModal();
  const status=dialog.querySelector('#accountSecurityStatus'),token=sessionGeneration,school=currentSchoolId;
  const valid=()=>dialog.isConnected&&isCurrentSession(token,user.uid,school);
  const display=()=>{dialog.querySelector('#accountSecurityEmail').textContent=user.email||'';};display();
  const pending=currentUserData?.pendingLoginEmail;
  if(pending){const field=dialog.querySelector('[name="newEmail"]');if(field)field.value=pending;status.textContent='Verification requested for '+pending+'. If the email did not arrive, resend the link.';}
  let busy=false;
  const perform=async(operation)=>{
    if(busy||!valid())return;busy=true;dialog.dataset.busy='true';dialog.querySelectorAll('button,input').forEach(element=>element.disabled=true);status.textContent='Working…';
    try{if(navigator.onLine===false)throw Error('Connect to the internet. Credential changes cannot be saved offline.');const message=await operation();if(valid()){display();status.textContent=message;}}
    catch(error){if(valid())status.textContent=accountSecurityError(error);}
    finally{dialog.querySelectorAll('input[type="password"]').forEach(input=>input.value='');busy=false;delete dialog.dataset.busy;if(valid())dialog.querySelectorAll('button,input').forEach(element=>element.disabled=false);}
  };
  dialog.querySelector('#accountSecurityClose').onclick=()=>dialog.close();
  // Do not allow Escape to hide an in-flight credential change.
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  dialog.addEventListener('close',()=>{dialog.querySelectorAll('input').forEach(input=>input.value='');dialog.remove();});
  const passwordForm=dialog.querySelector('#accountPasswordForm');
  if(passwordForm)passwordForm.onsubmit=event=>{event.preventDefault();perform(async()=>{const fields=passwordForm.elements;await changeSchoolHubPassword(user,fields.currentPassword.value,fields.newPassword.value,fields.confirmPassword.value);return 'Password changed. Use your new password next time you sign in.';});};
  const emailForm=dialog.querySelector('#accountEmailForm');
  if(emailForm)emailForm.onsubmit=event=>{event.preventDefault();perform(async()=>{const email=await requestSchoolHubLoginEmail(user,emailForm.elements.currentPassword.value,emailForm.elements.newEmail.value);if(valid())currentUserData={...(currentUserData||{}),pendingLoginEmail:email};return 'Verification link sent to '+email+'. Open it, then return here and refresh. If asked to sign in again, use the verified address.';});};
  dialog.querySelector('#accountEmailRefresh').onclick=()=>perform(async()=>{const result=await refreshSchoolHubLoginEmail(user);return result.pendingEmail?'The email change is still awaiting verification for '+result.pendingEmail+'.':'Your verified login email is up to date.';});
}
document.getElementById('profileAccountSecurityBtn')?.addEventListener('click',openAccountSecurity);

let accountSecurityLaunchRequested=new URLSearchParams(location.search).get('account-security')==='1';
function maybeOpenAccountSecurity(){if(accountSecurityLaunchRequested&&currentUid&&currentStatus==='active'&&sessionReady){accountSecurityLaunchRequested=false;openAccountSecurity();}}
