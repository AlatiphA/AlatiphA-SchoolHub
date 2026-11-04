/* Recheck owner restrictions without deleting locally saved school work. */
(function(){
 const blocked=s=>['suspended','disabled'].includes(s);
 let subscriptions=[],identity='';
 function stop(){subscriptions.forEach(fn=>fn());subscriptions=[];identity='';}
 async function verify(data){
  if(!data)return data;
  if(blocked(data.ownerAccess?.status))return {...data,status:data.ownerAccess.status};
  if(!data.schoolId)return data;
  const snap=await firebase.firestore().collection('schoolAdministration').doc(data.schoolId).get({source:'server'}),state=snap.data()||{};
  if(blocked(state.accessStatus)||['deleting','deleted'].includes(state.state))return {...data,status:state.accessStatus==='suspended'?'suspended':'disabled'};
  return data;
 }
 function watch(data,token,userId){
  const school=data?.schoolId,key=userId+'|'+school+'|'+token;if(!school||key===identity)return;stop();identity=key;
  const active=()=>identity===key&&isCurrentSession(token,userId,school);
  const deny=message=>{if(active()){stop();restrictSchoolHubOwnerSession(message);}};
  subscriptions.push(firebase.firestore().collection('schoolAdministration').doc(school).onSnapshot(s=>{if(!active()||s.metadata?.fromCache)return;const p=s.data()||{};if(blocked(p.accessStatus)||['deleting','deleted'].includes(p.state))deny('This school’s access is restricted. Contact the SchoolHub owner.');},()=>{}));
  subscriptions.push(firebase.firestore().collection('users').doc(userId).onSnapshot(s=>{if(!active()||s.metadata?.fromCache)return;if(blocked(s.data()?.ownerAccess?.status))deny('Your account access is restricted by the SchoolHub owner.');},()=>{}));
 }
 window.SchoolHubServiceAccess={verify,watch,stop};
})();
