import {readFileSync,writeFileSync} from 'node:fs';
const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
const value={schema:'andromeda.release/v1',version:pkg.version,character:'andromeda',spriteVersion:2,
  desktop:{localCompanion:true,focus:true,todos:true,optionalAI:true,taskBridge:true,staticStudioPoses:true},
  website:{embeddable:true,publicGuide:true,search:true,staticStudioPoses:true},
  updates:{mode:'manual',url:'https://github.com/chenyihang98-pixel/andromeda-desktop-pet/releases'},
  verifiedPlatforms:['windows-x64'],validationScope:'Current Windows single-display native probes and automated tests; not a full device acceptance matrix',unverifiedPlatforms:['macos','linux']};
const filename=new URL('../assets/release.json',import.meta.url),text=JSON.stringify(value,null,2)+'\n';
let old='';try{old=readFileSync(filename,'utf8');}catch{}if(old!==text)writeFileSync(filename,text);
