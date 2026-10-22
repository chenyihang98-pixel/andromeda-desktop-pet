'use strict';
const {createHash}=require('node:crypto');
const MAX_BYTES=12*1024*1024;
const table=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=table[(crc^byte)&255]^(crc>>>8);return(crc^0xffffffff)>>>0;}
// Stored ZIP entries keep export deterministic and avoid external archiver/runtime dependencies.
function zip(entries){
  let offset=0;const parts=[],central=[];
  for(const[name,bytes]of entries){const filename=Buffer.from(name),local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt32LE(crc32(bytes),14);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(filename.length,26);
    parts.push(local,filename,bytes);const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50,0);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x800,8);record.writeUInt32LE(crc32(bytes),16);record.writeUInt32LE(bytes.length,20);record.writeUInt32LE(bytes.length,24);record.writeUInt16LE(filename.length,28);record.writeUInt32LE(offset,42);central.push(record,filename);offset+=local.length+filename.length+bytes.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...parts,directory,end]);
}
async function checked(pack,bytes,{verifyHash=false}={}){
  const [{validateCharacterPack},{inspectImageBytes}]=await Promise.all([import('../shared/character.mjs'),import('../character-editor.mjs')]);
  const clean=validateCharacterPack(pack),info=inspectImageBytes(bytes);
  if(info.width!==clean.atlas.width||info.height!==clean.atlas.height)throw new Error('图片尺寸与角色包不一致');
  const hash=createHash('sha256').update(bytes).digest('hex');
  if(verifyHash&&clean.sha256!==undefined&&clean.sha256!==hash)throw new TypeError('角色图片哈希校验失败');
  const filename=info.mime==='image/png'?'atlas.png':'atlas.webp';clean.atlas.image=filename;clean.quality=[{id:'shared',image:filename,scale:1}];clean.sha256=hash;
  return{pack:clean,image:Buffer.from(bytes),mime:info.mime,filename};
}
async function createCharacterArchive(input,{originalImage}={}){
  if(!input||typeof input!=='object'||Object.keys(input).some(key=>!['pack','imageDataURL'].includes(key))||JSON.stringify(input.pack).length>65536)throw new TypeError('角色包输入无效');
  let bytes=originalImage;
  if(input.imageDataURL!==undefined){if(typeof input.imageDataURL!=='string'||input.imageDataURL.length>11_200_000||!/^data:image\/(png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(input.imageDataURL))throw new TypeError('仅接受本地 PNG/WebP 图像');bytes=Buffer.from(input.imageDataURL.slice(input.imageDataURL.indexOf(',')+1),'base64');}
  if(!Buffer.isBuffer(bytes))throw new TypeError('请先导入角色图片');
  const result=await checked(input.pack,bytes),manifest=Buffer.from(JSON.stringify(result.pack,null,2)+'\n');
  const archive=zip([['manifest.json',manifest],[result.filename,result.image],['README.txt',Buffer.from('Andromeda character pack v1\nIncludes validated metadata and original PNG/WebP artwork.\nImport this ZIP in the desktop Appearance panel or unzip for the website SDK assetBase.\nRights and provenance are recorded in manifest.json. No executable code.\n')]]);
  return{...result,archive};
}
async function readCharacterArchive(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length<22||bytes.length>MAX_BYTES)throw new TypeError('角色 ZIP 过大或不完整');
  let offset=0;const entries=new Map(),records=[];
  while(offset+30<=bytes.length&&bytes.readUInt32LE(offset)===0x04034b50){
    const flags=bytes.readUInt16LE(offset+6),method=bytes.readUInt16LE(offset+8),crc=bytes.readUInt32LE(offset+14),size=bytes.readUInt32LE(offset+18),raw=bytes.readUInt32LE(offset+22),nameSize=bytes.readUInt16LE(offset+26),extra=bytes.readUInt16LE(offset+28);
    if(flags!==0x800||method!==0||size!==raw||size>8*1024*1024||extra!==0)throw new TypeError('仅接受编辑器导出的无脚本角色 ZIP');
    const begin=offset+30+nameSize,end=begin+size;if(end>bytes.length)throw new TypeError('角色 ZIP 不完整');
    const name=bytes.subarray(offset+30,begin).toString('utf8');
    if(!['manifest.json','atlas.png','atlas.webp','README.txt'].includes(name)||entries.has(name)||entries.size>=3)throw new TypeError('角色 ZIP 包含不支持的文件');
    const content=bytes.subarray(begin,end);if(crc32(content)!==crc)throw new TypeError('角色 ZIP 校验失败');
    records.push({name,offset,crc,size,flags,method,version:bytes.readUInt16LE(offset+4),time:bytes.readUInt32LE(offset+10)});
    entries.set(name,content);offset=end;
  }
  const eocd=bytes.length-22;
  if(entries.size!==3||!entries.has('manifest.json')||entries.get('manifest.json').length>65536||!entries.has('README.txt')||bytes.readUInt32LE(eocd)!==0x06054b50||bytes.readUInt32LE(eocd+16)!==offset||bytes.readUInt16LE(eocd+10)!==3
    ||bytes.readUInt16LE(eocd+4)!==0||bytes.readUInt16LE(eocd+6)!==0||bytes.readUInt16LE(eocd+8)!==3||bytes.readUInt16LE(eocd+20)!==0)throw new TypeError('角色 ZIP 目录无效');
  if(offset+bytes.readUInt32LE(eocd+12)!==eocd)throw new TypeError('角色 ZIP 目录不完整');
  // Standard unzip tools use this directory, so it must describe exactly the same
  // bounded files as the local headers we read. Never accept a second interpretation.
  for(const local of records){
    if(offset+46>eocd||bytes.readUInt32LE(offset)!==0x02014b50)throw new TypeError('角色 ZIP 中央目录无效');
    const nameSize=bytes.readUInt16LE(offset+28),extra=bytes.readUInt16LE(offset+30),comment=bytes.readUInt16LE(offset+32),end=offset+46+nameSize;
    if(end>eocd||extra!==0||comment!==0||bytes.readUInt16LE(offset+4)!==20||bytes.readUInt16LE(offset+6)!==local.version||local.version!==20
      ||bytes.readUInt16LE(offset+8)!==local.flags||bytes.readUInt16LE(offset+10)!==local.method||bytes.readUInt32LE(offset+12)!==local.time
      ||bytes.readUInt32LE(offset+16)!==local.crc||bytes.readUInt32LE(offset+20)!==local.size||bytes.readUInt32LE(offset+24)!==local.size
      ||bytes.readUInt16LE(offset+34)!==0||bytes.readUInt16LE(offset+36)!==0||bytes.readUInt32LE(offset+38)!==0||bytes.readUInt32LE(offset+42)!==local.offset
      ||!bytes.subarray(offset+46,end).equals(Buffer.from(local.name)))throw new TypeError('角色 ZIP 中央目录与文件不一致');
    offset=end;
  }
  if(offset!==eocd)throw new TypeError('角色 ZIP 中央目录包含额外内容');
  return checked(JSON.parse(entries.get('manifest.json').toString('utf8')),entries.get('atlas.png')||entries.get('atlas.webp'),{verifyHash:true});
}
module.exports={createCharacterArchive,readCharacterArchive};
