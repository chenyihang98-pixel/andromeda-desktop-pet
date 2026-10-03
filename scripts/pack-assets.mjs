import {mkdirSync,cpSync,writeFileSync} from 'node:fs';
const target='dist/Andromeda-0.1.0-asset-pack';
mkdirSync(target,{recursive:true});
for(const file of ['andromeda.png','manifest.json','neutral.png']) cpSync('assets/'+file,target+'/'+file);
cpSync('docs/ASSET-FORMAT.md',target+'/ASSET-FORMAT.md');cpSync('NOTICE.md',target+'/NOTICE.md');
writeFileSync(target+'/README.txt','星璇（Andromeda）角色素材包\n透明 2D 图集、动画帧数据与 16 向注视姿态。\n\n请先阅读 ASSET-FORMAT.md 和 NOTICE.md。此包不包含 3D 模型；适配其他平台需要支持精灵裁切、透明显示与播放。公开下载不代表授予开源或再分发许可。\n');
console.log('Asset pack prepared: '+target);
