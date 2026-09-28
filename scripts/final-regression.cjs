// Dependency-free release check; run from any directory with Node 22+.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
process.chdir(root);
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?(['node_modules','.git','.firebase','outputs'].includes(e.name)?[]:walk(path.join(dir,e.name))):[path.join(dir,e.name)]);}
let checked=0;
for(const file of walk('.')){
 if(/\.(?:js|cjs)$/.test(file)){
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  if(result.status!==0){process.stderr.write(result.stderr||String(result.error));process.exit(1);}checked++;
 }
 if(/\.html$/.test(file)){
  const html=fs.readFileSync(file,'utf8');let index=0;
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)){
   if(/\bsrc\s*=|\btype\s*=\s*["'](?:application\/ld\+json|importmap|module)/i.test(match[1])||!match[2].trim())continue;
   new vm.Script(match[2],{filename:`${file}:inline-${++index}`});checked++;
  }
 }
}
console.log(`Syntax checks passed: ${checked} JavaScript files / inline scripts.`);
const tests=[...fs.readdirSync('tests').filter(x=>x.endsWith('.test.cjs')).map(x=>`tests/${x}`),...fs.readdirSync('functions').filter(x=>x.endsWith('.test.js')).map(x=>`functions/${x}`)].sort();
const result=spawnSync(process.execPath,['--test',...tests],{stdio:'inherit'});
if(result.error)console.error(result.error);
process.exit(result.status??1);
