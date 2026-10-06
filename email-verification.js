/* Verification protects new memberships; existing active members keep their workspace. */
(()=>{
 const gate=document.getElementById('emailVerificationGate'),email=document.getElementById('verificationEmail'),status=document.getElementById('verificationStatus'),resend=document.getElementById('verificationResendBtn'),check=document.getElementById('verificationCheckBtn');
 let owner=null,timer=null,busy=false,sending=null,lastMessage=null;
 const same=user=>user&&firebase.auth().currentUser?.uid===user.uid;
 const cooldownKey=user=>'schoolhub_verification_sent_'+user.uid;
 const required=(user,data)=>!!user&&!user.emailVerified&&(!data||!data.schoolId||['pending','rejected','removed'].includes(data.status));
 function deadline(p){let timeout;return Promise.race([p,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('The request timed out. Reconnect and retry.')),15000);})]).finally(()=>clearTimeout(timeout));}
 function cooldown(){let at=0;try{at=Number(localStorage.getItem(cooldownKey(owner))||0);}catch(_){}const left=Math.max(0,60-Math.floor((Date.now()-at)/1000));resend.disabled=busy||left>0;resend.textContent=left?'Resend email ('+left+'s)':'Resend verification email';}
 function hide(){document.documentElement.classList.remove('emailVerification');gate.classList.add('hidden');owner=null;clearInterval(timer);timer=null;busy=false;}
 function show(user){hide();owner=user;email.textContent=user.email||'';status.textContent=lastMessage?.uid===user.uid?lastMessage.text:'Open the verification link in your inbox, then return here. Check Spam or Junk if needed.';gate.classList.remove('hidden');document.documentElement.classList.add('emailVerification');cooldown();timer=setInterval(cooldown,1000);check.disabled=false;check.focus();}
 async function send(user){if(!same(user))return false;if(sending?.uid===user.uid)return sending.promise;
  const task={uid:user.uid};task.promise=(async()=>{try{await deadline(user.sendEmailVerification());if(!same(user))return false;try{localStorage.setItem(cooldownKey(user),String(Date.now()));}catch(_){}lastMessage={uid:user.uid,text:'Verification email sent. Open the link, then choose I have verified my email.'};return true;}catch(e){if(same(user))lastMessage={uid:user.uid,text:'Your account was created, but the verification email could not be sent. Use Resend verification email when connected. '+(e.message||e)};return false;}finally{if(owner?.uid===user.uid){status.textContent=lastMessage?.text||'';cooldown();}if(sending===task)sending=null;}})();sending=task;return task.promise;
 }
 resend.onclick=async()=>{const user=owner;if(!same(user)||resend.disabled)return;busy=true;cooldown();await send(user);busy=false;if(owner?.uid===user.uid)cooldown();};
 check.onclick=async()=>{const user=owner;if(busy||!same(user))return;busy=true;check.disabled=true;cooldown();status.textContent='Checking your email verification…';try{await deadline(user.reload());if(!same(user)||owner?.uid!==user.uid)return;if(!user.emailVerified){status.textContent='Your email is not verified yet. Open the link in the email and try again.';return;}await deadline(user.getIdToken(true));if(!same(user)||owner?.uid!==user.uid)return;status.textContent='Email verified. Opening SchoolHub…';window.location.reload();}catch(e){if(owner?.uid===user.uid)status.textContent='Could not check verification. Keep this page open and retry while online. '+(e.message||e);}finally{busy=false;if(owner?.uid===user.uid){check.disabled=false;cooldown();}}};
 document.getElementById('verificationLogoutBtn').onclick=()=>signOutAndReset();
 const reset=resetWorkspaceState;resetWorkspaceState=function(...args){hide();return reset(...args);};
 window.SchoolHubEmailVerification={required,show,hide,send};
 if(typeof window.dispatchEvent==='function')window.dispatchEvent(new Event('schoolhub-email-verification-ready'));
})();
