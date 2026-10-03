import {readdirSync,readFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
for(const dir of ['src','scripts','tests']) for(const name of readdirSync(dir)) {
  if(!/\.(cjs|mjs|js)$/.test(name)) continue;
  const result=spawnSync(process.execPath,['--check',path.join(dir,name)],{stdio:'inherit'});
  if(result.status!==0)process.exit(1);
}
for(const p of ['src/main.cjs','src/preload.cjs','src/pet.html','src/settings.html','assets/andromeda.png','assets/manifest.json','README.md','NOTICE.md','package-lock.json']) if(!existsSync(p))throw Error('Missing '+p);
for(const html of ['src/pet.html','src/settings.html']) {
  const value=readFileSync(html,'utf8');
  if(!value.includes('Content-Security-Policy') || /<script(?![^>]*src=)/.test(value))throw Error('CSP or external script gate failed: '+html);
}
console.log('Syntax, required files and HTML CSP checks passed');
