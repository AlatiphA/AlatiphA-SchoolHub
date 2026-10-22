// One release number for the displayed app, downloaded shell and deployment metadata.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),publicRoot=path.join(root,'public'),check=process.argv.includes('--check');
const canonical=(name,bytes)=>{
 if(!/\.(?:js|css|html|json|rules|cjs|md)$/.test(name))return bytes;
 let text=bytes.toString('utf8').replace(/\r\n/g,'\n');
 if(name==='app-4.js')text=text.replace(/^const APP_VERSION = '[^']+';/m,"const APP_VERSION = '@VERSION@';");
 if(name==='sw.js')text=text.replace(/^const RELEASE_VERSION = '[^']+';/m,"const RELEASE_VERSION = '@VERSION@';");
 if(name==='index.html')text=text.replace(/(id="aboutVersion">)[^<]+/,'$1@VERSION@');
 return Buffer.from(text);
};
function walk(dir,prefix=''){return fs.readdirSync(dir,{withFileTypes:true}).filter(e=>!['node_modules','.git','.firebase'].includes(e.name)&&!e.name.endsWith('.log')).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name),prefix+e.name+'/'):[prefix+e.name]);}
const hash=crypto.createHash('sha256');
for(const name of walk(publicRoot).filter(n=>n!=='release.json').sort())hash.update(name+'\0').update(canonical(name,fs.readFileSync(path.join(publicRoot,name)))).update('\0');
for(const name of walk(path.join(root,'functions')).filter(n=>/\.(?:js|json)$/.test(n)).sort())hash.update('functions/'+name+'\0').update(canonical(name,fs.readFileSync(path.join(root,'functions',name)))).update('\0');
for(const name of ['firestore.rules','storage.rules','firebase.json'])hash.update(name+'\0').update(canonical(name,fs.readFileSync(path.join(root,name)))).update('\0');
const fingerprint=hash.digest('hex'),releasePath=path.join(root,'release.json');
const previous=fs.existsSync(releasePath)?JSON.parse(fs.readFileSync(releasePath,'utf8')):{version:'40.1.0',fingerprint:''};
if(!/^\d+\.\d+\.\d+$/.test(previous.version))throw Error('Invalid SchoolHub release version');
let version=previous.version;
if(previous.fingerprint&&previous.fingerprint!==fingerprint){const parts=version.split('.').map(Number);parts[2]++;version=parts.join('.');}
const targets={
 'app-4.js':s=>s.replace(/^const APP_VERSION = '[^']+';/m,"const APP_VERSION = '"+version+"';"),
 'sw.js':s=>s.replace(/^const RELEASE_VERSION = '[^']+';/m,"const RELEASE_VERSION = '"+version+"';"),
 'index.html':s=>s.replace(/(id="aboutVersion">)[^<]+/,'$1'+version)
};
let mismatch=previous.fingerprint!==fingerprint;
const prepared=[];
for(const [name,stamp]of Object.entries(targets)){
 const source=fs.readFileSync(path.join(publicRoot,name)),local=fs.readFileSync(path.join(root,name));
 if(!canonical(name,source).equals(canonical(name,local)))throw Error('Root/public differ: '+name+'. Mirror the app files before deployment.');
 const next=stamp(source.toString('utf8').replace(/\r\n/g,'\n'));
 if(!source.equals(Buffer.from(next))||!local.equals(Buffer.from(next)))mismatch=true;
 prepared.push([name,next]);
}
const metadata=JSON.stringify({version,fingerprint},null,2)+'\n';
if(!fs.existsSync(path.join(publicRoot,'release.json'))||fs.readFileSync(path.join(publicRoot,'release.json'),'utf8')!==metadata)mismatch=true;
if(check){if(mismatch)throw Error('Release metadata is stale. Run node scripts/prepare-release.cjs before checks/deployment.');console.log('Unified SchoolHub release verified: '+version);}
else{
 for(const [name,text]of prepared)for(const dir of [root,publicRoot])fs.writeFileSync(path.join(dir,name),text);
 for(const dir of [root,publicRoot])fs.writeFileSync(path.join(dir,'release.json'),metadata);
 console.log('SchoolHub release '+version+(version!==previous.version?' prepared for changed app content.':' is ready.'));
}
