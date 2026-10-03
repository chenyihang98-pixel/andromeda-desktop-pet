import {mkdirSync,cpSync,writeFileSync} from 'node:fs';
const target='dist/Andromeda-0.1.0-asset-pack';
mkdirSync(target,{recursive:true});
for(const file of ['andromeda.png','manifest.json','neutral.png']) cpSync('assets/'+file,target+'/'+file);
cpSync('docs/ASSET-FORMAT.md',target+'/ASSET-FORMAT.md');cpSync('NOTICE.md',target+'/NOTICE.md');
writeFileSync(target+'/README.txt','星璇（Andromeda）桌宠\n一款开发中的桌宠\n\n请先阅读 ASSET-FORMAT.md。此包为精灵图素材与元数据，不是3D模型，也不保证任意平台直接导入。\n');
console.log('Asset pack prepared: '+target);
