const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('release preparation advances once per changed app, stays stable on redeploy, and rejects stale or mismatched sources',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'schoolhub-release-test-'));
 for(const dir of ['scripts','public','functions'])fs.mkdirSync(path.join(temp,dir));
 fs.copyFileSync('scripts/prepare-release.cjs',path.join(temp,'scripts/prepare-release.cjs'));
 for(const [name,text]of Object.entries({'app-4.js':"const APP_VERSION = '40.1.0';\n",'sw.js':"const RELEASE_VERSION = '40.1.0';\n",'index.html':'<strong id="aboutVersion">40.1.0</strong>','style.css':'body{color:green}'}))for(const prefix of ['', 'public/'])fs.writeFileSync(path.join(temp,prefix+name),text);
 for(const name of ['firestore.rules','storage.rules','firebase.json'])fs.writeFileSync(path.join(temp,name),'{}');
 fs.writeFileSync(path.join(temp,'functions/index.js'),'// backend');
 const run=(...args)=>spawnSync(process.execPath,[path.join(temp,'scripts/prepare-release.cjs'),...args],{encoding:'utf8'});
 const version=()=>JSON.parse(fs.readFileSync(path.join(temp,'release.json'),'utf8')).version;
 try{
  assert.equal(run().status,0);assert.equal(version(),'40.1.0');assert.equal(run().status,0);assert.equal(version(),'40.1.0');assert.equal(run('--check').status,0);
  fs.appendFileSync(path.join(temp,'public/style.css'),'\nbody{background:white}');assert.notEqual(run('--check').status,0);assert.equal(run().status,0);assert.equal(version(),'40.1.1');assert.equal(run().status,0);assert.equal(version(),'40.1.1');
  fs.appendFileSync(path.join(temp,'functions/index.js'),'\n// backend fix');assert.equal(run().status,0);assert.equal(version(),'40.1.2');
  fs.appendFileSync(path.join(temp,'app-4.js'),'\n// unmatched root edit');assert.notEqual(run().status,0);
 }finally{const resolved=path.resolve(temp),prefix=path.join(path.resolve(os.tmpdir()),'schoolhub-release-test-');if(!resolved.startsWith(prefix))throw Error('Unexpected temporary test path');fs.rmSync(resolved,{recursive:true,force:true});}
});
