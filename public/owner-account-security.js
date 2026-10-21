/* Owner credentials use Firebase Auth and keep the same UID and owner claim. */
async function schoolHubOwnerSecurityAccess(user){
 if(!user||firebase.auth().currentUser?.uid!==user.uid)throw Error('Your account changed. Sign in again.');
 const result=await firebase.app().functions('africa-south1').httpsCallable('getSchoolHubMessagingAccess')({});
 if(firebase.auth().currentUser?.uid!==user.uid)throw Error('Your account changed. Sign in again.');
 if(result.data?.owner!==true)throw Error('Owner Administration access is required.');
 return result.data;
}
async function requestSchoolHubOwnerEmailChange(user,password,email){
 email=String(email||'').trim().toLowerCase();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw Error('Enter a valid new login email.');
 if(email===String(user.email||'').toLowerCase())throw Error('Enter a different login email.');
 const access=await schoolHubOwnerSecurityAccess(user);
 if(access.schoolId)throw Error('This owner account also belongs to a school. Change its email through SchoolHub Profile → Account Security to preserve school identity links.');
 await confirmAccountPassword(user,password);
 if(firebase.auth().currentUser?.uid!==user.uid)throw Error('Your account changed. Sign in again.');
 await user.verifyBeforeUpdateEmail(email,{url:location.origin+'/messaging.html?account-security=1'});
 return 'Verification link sent to '+email+'. Your login email changes only after verification. Your owner permission stays with this account.';
}
async function openSchoolHubOwnerSecurity(){
 const user=firebase.auth().currentUser;if(!user)return;
 const old=document.getElementById('ownerAccountSecurityDialog');if(old){if(old.dataset.busy!=='true')old.showModal();return;}
 await schoolHubOwnerSecurityAccess(user);if(firebase.auth().currentUser?.uid!==user.uid)return;
 const dialog=document.createElement('dialog');dialog.id='ownerAccountSecurityDialog';dialog.className='my-staff-profile account-security dialog-fixed-shell';dialog.setAttribute('aria-labelledby','ownerSecurityTitle');
 dialog.innerHTML='<div class="dialog-fixed-header"><h2 id="ownerSecurityTitle">Account Security</h2><button id="ownerSecurityClose" type="button" class="dialog-close-icon" aria-label="Close Account Security">×</button></div><div class="dialog-scroll-content"><p>Owner login email: <strong id="ownerSecurityEmail"></strong></p><p id="ownerSecurityVerified"></p><p class="hint">Your sign-in account is separate from school membership. Changing its email keeps the same account and owner permission.</p><p id="ownerSecurityStatus" role="status" aria-live="polite"></p>'+
 (passwordLoginAvailable(user)?'<form id="ownerPasswordForm" class="stack"><h3>Change password</h3><label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>New password<input name="newPassword" type="password" autocomplete="new-password" minlength="6" required></label><label>Confirm new password<input name="confirmation" type="password" autocomplete="new-password" minlength="6" required></label><button type="submit" class="btn-primary">Change password</button></form><hr><form id="ownerEmailForm" class="stack"><h3>Change login email</h3><label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>New login email<input name="newEmail" type="email" autocomplete="email" required maxlength="254"></label><p class="hint">Open the verification link sent to your new address before using it to sign in.</p><button type="submit" class="btn-primary">Send verification link</button></form>':'<p>You sign in with Google. Manage your Google password and email in your Google account.</p><a href="https://myaccount.google.com/security" target="_blank" rel="noopener noreferrer">Open Google Account Security</a>')+
 '<p><button id="ownerVerificationCheck" type="button" class="btn-secondary">Refresh account status</button></p></div>';
 document.body.append(dialog);dialog.showModal();const status=dialog.querySelector('#ownerSecurityStatus');let busy=false;
 const valid=()=>dialog.isConnected&&firebase.auth().currentUser?.uid===user.uid;
 const display=()=>{dialog.querySelector('#ownerSecurityEmail').textContent=user.email||'';dialog.querySelector('#ownerSecurityVerified').textContent=user.emailVerified?'Email verified':'Email verification required';};display();
 const perform=async fn=>{if(busy||!valid())return;if(navigator.onLine===false){status.textContent='Connect to the internet to manage account security.';return;}busy=true;dialog.dataset.busy='true';dialog.querySelectorAll('button,input').forEach(n=>n.disabled=true);status.textContent='Working…';try{await schoolHubOwnerSecurityAccess(user);const message=await fn();if(valid()){display();status.textContent=message;}}catch(error){if(valid())status.textContent=accountSecurityError(error);}finally{dialog.querySelectorAll('input[type="password"]').forEach(n=>n.value='');busy=false;delete dialog.dataset.busy;if(valid())dialog.querySelectorAll('button,input').forEach(n=>n.disabled=false);}};
 dialog.querySelector('#ownerSecurityClose').onclick=()=>dialog.close();dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});dialog.addEventListener('close',()=>{dialog.querySelectorAll('input').forEach(n=>n.value='');dialog.remove();});
 const password=dialog.querySelector('#ownerPasswordForm');if(password)password.onsubmit=e=>{e.preventDefault();perform(async()=>{const p=password.elements;await changeSchoolHubPassword(user,p.currentPassword.value,p.newPassword.value,p.confirmation.value);return 'Password changed. Use the new password next time you sign in.';});};
 const email=dialog.querySelector('#ownerEmailForm');if(email)email.onsubmit=e=>{e.preventDefault();perform(()=>requestSchoolHubOwnerEmailChange(user,email.elements.currentPassword.value,email.elements.newEmail.value));};
 dialog.querySelector('#ownerVerificationCheck').onclick=()=>perform(async()=>{await user.reload();if(!valid())throw Error('Your account changed.');await user.getIdToken(true);if(!valid())throw Error('Your account changed.');const label=document.getElementById('shStandaloneAccount');if(label)label.textContent='Signed in as '+user.email;return 'Account status refreshed.';});
}
window.SchoolHubOwnerSecurity={open:openSchoolHubOwnerSecurity};
document.getElementById('shOwnerAccountSecurity')?.addEventListener('click',()=>openSchoolHubOwnerSecurity().catch(error=>{document.getElementById('shStandaloneAccount').textContent=accountSecurityError(error);}));
