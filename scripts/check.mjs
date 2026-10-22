import {readdirSync,readFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
function* files(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())yield* files(file);else yield file;}}
for(const dir of ['src','scripts','tests','web']) for(const name of files(dir)) {
  if(!/\.(cjs|mjs|js)$/.test(name)) continue;
  const result=spawnSync(process.execPath,['--check',name],{stdio:'inherit'});
  if(result.status!==0)process.exit(1);
}
for(const p of ['src/main.cjs','src/preload.cjs','src/pet.html','src/settings.html','assets/andromeda.png','assets/manifest.json','README.md','NOTICE.md','package-lock.json']) if(!existsSync(p))throw Error('Missing '+p);
for(const html of ['src/pet.html','src/settings.html','src/companion.html']) {
  const value=readFileSync(html,'utf8');
  if(!value.includes('Content-Security-Policy') || /<script(?![^>]*src=)/.test(value))throw Error('CSP or external script gate failed: '+html);
}
console.log('Syntax, required files and HTML CSP checks passed');
