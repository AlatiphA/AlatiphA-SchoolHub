(function(root){
  'use strict';
  let installed='',registration=null,remote=null,checking=false,installing=false,sequence=0;
  const element=id=>root.document.getElementById(id);
  function display(message,ready=false){
    const status=element('aboutUpdateStatus'),check=element('aboutCheckUpdateBtn'),install=element('aboutInstallUpdateBtn');
    if(status)status.textContent=message;
    if(check)check.disabled=checking||installing;
    if(install){install.hidden=!ready&&!installing;install.disabled=!ready||checking||installing;install.textContent=installing?'Installing…':'Install update';}
  }
  function versionOf(worker){
    if(!worker||typeof root.MessageChannel!=='function')return Promise.resolve('');
    return new Promise(resolve=>{
      const channel=new root.MessageChannel();let done=false;
      const finish=value=>{if(done)return;done=true;root.clearTimeout(timer);channel.port1.close();channel.port2.close();resolve(value);};
      const timer=root.setTimeout(()=>finish(''),1500);
      channel.port1.onmessage=event=>{if(event.data?.type==='SCHOOLHUB_WORKER_VERSION')finish(/^\d+\.\d+\.\d+$/.test(event.data.version||'')?event.data.version:'');};
      try{worker.postMessage({type:'GET_WORKER_VERSION'},[channel.port2]);}catch(_){finish('');}
    });
  }
  function observe(reg){
    if(!reg||reg.__schoolHubUpdateUiObserved)return;
    reg.__schoolHubUpdateUiObserved=true;
    const watch=worker=>{if(!worker||worker.__schoolHubUpdateUiObserved)return;worker.__schoolHubUpdateUiObserved=true;worker.addEventListener('statechange',()=>{
      if(worker.state==='redundant'){display('The update could not be installed. Your current version is still available. Check again.');return;}
      refresh();
    });};
    watch(reg.installing);
    reg.addEventListener('updatefound',()=>{watch(reg.installing);refresh();});
  }
  async function refresh(){
    if(!installed||installing)return;
    const request=++sequence;
    try{
      if(!('serviceWorker' in root.navigator)){display('Updates are unavailable in this browser.');return;}
      const reg=await root.navigator.serviceWorker.getRegistration('./');
      if(request!==sequence||installing)return;
      registration=reg;observe(reg);
      if(!reg){display('SchoolHub is setting up offline support. Reload once, then check again.');return;}
      if(reg.waiting){const version=await versionOf(reg.waiting);if(request===sequence&&!installing)display('Version '+(version||remote?.version||'update')+' is ready to install.',true);return;}
      if(reg.installing){display('Downloading the SchoolHub update…');return;}
      const active=await versionOf(root.navigator.serviceWorker.controller||reg.active);
      if(request!==sequence||installing)return;
      if(active&&active!==installed){display('Version '+active+' is ready. Install to reload SchoolHub with it.',true);return;}
      if(remote?.version===installed)display('You’re up to date. Version '+installed+'.');
      else if(remote)display('Version '+remote.version+' is available. Waiting for the download to finish; check again if needed.');
      else display('Version '+installed+'. Check for updates when online.');
    }catch(_){if(request===sequence)display('Could not read update status. Check again when online.');}
  }
  async function check(){
    if(checking||installing)return;
    if(root.navigator.onLine===false){display('You’re offline. Connect to check for updates.');return;}
    checking=true;sequence++;display('Checking for updates…');
    try{
      const controller=new root.AbortController(),timer=root.setTimeout(()=>controller.abort(),15000);
      let response;
      try{response=await root.fetch('./release.json',{cache:'no-store',signal:controller.signal});}finally{root.clearTimeout(timer);}
      if(!response.ok)throw Error('Release information is unavailable.');
      const data=await response.json();
      if(!/^\d+\.\d+\.\d+$/.test(data.version||''))throw Error('Invalid release information.');
      remote=data;
      if(!('serviceWorker' in root.navigator))throw Error('Updates are unavailable in this browser.');
      const reg=await root.navigator.serviceWorker.getRegistration('./');
      if(!reg)throw Error('Offline support is still starting. Reload once and try again.');
      registration=reg;observe(reg);await reg.update();
      checking=false;await refresh();
    }catch(error){checking=false;display('Update check failed. '+(error.message||'Try again when online.'),!!registration?.waiting);}
  }
  async function install(){
    if(installing||checking)return;
    try{
      const reg=await root.navigator.serviceWorker.getRegistration('./');
      if(!reg)throw Error('No downloaded update is available. Check again.');
      const worker=reg.waiting;
      if(!worker){
        const active=await versionOf(root.navigator.serviceWorker.controller||reg.active);
        if(!active||active===installed){await refresh();return;}
        installing=true;display('Reloading SchoolHub…');root.location.reload();return;
      }
      installing=true;sequence++;display('Installing the update…');
      await new Promise((resolve,reject)=>{
        const changed=()=>{cleanup();resolve();};
        const timer=root.setTimeout(()=>{cleanup();reject(Error('Activation is taking longer than expected. Check again.'));},20000);
        const cleanup=()=>{root.clearTimeout(timer);root.navigator.serviceWorker.removeEventListener('controllerchange',changed);};
        root.navigator.serviceWorker.addEventListener('controllerchange',changed);
        try{worker.postMessage({type:'SKIP_WAITING'});}catch(error){cleanup();reject(error);}
      });
      root.location.reload();
    }catch(error){installing=false;display('Update not completed. '+(error.message||'Try again.'),true);}
  }
  function init(version){
    if(installed)return;installed=version;
    element('aboutInstallUpdateBtn')?.addEventListener('click',install);
    root.addEventListener('schoolhub-sw-update-ready',()=>refresh());
    root.navigator.serviceWorker?.addEventListener('controllerchange',()=>{if(!installing)refresh();});
    display('Version '+installed+'. Check for updates when online.');
  }
  root.SchoolHubUpdates={init,check,install,refresh};
})(window);
