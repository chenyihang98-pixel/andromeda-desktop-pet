'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {readCharacterArchive}=require('./character-archive.cjs');
function createCharacterStore(directory,{validateImage=()=>{}}={}){
  const file=path.join(directory,'custom-character.zip');let current=null,lifecycle=Promise.resolve();
  const snapshot=()=>current?{pack:structuredClone(current.pack),imageDataURL:`data:${current.mime};base64,${current.image.toString('base64')}`} : null;
  const enqueue=operation=>{const result=lifecycle.then(operation,operation);lifecycle=result.catch(()=>{});return result;};
  async function install(bytes){
    const candidate=await readCharacterArchive(bytes);await validateImage(candidate);const temporary=file+'.'+randomUUID()+'.tmp';await fs.mkdir(directory,{recursive:true});
    try{await fs.writeFile(temporary,bytes,{flag:'wx',mode:0o600});await fs.rename(temporary,file);}catch(error){await fs.unlink(temporary).catch(()=>{});throw error;}current=candidate;return snapshot();
  }
  return{
    snapshot,
    load(){return enqueue(async()=>{try{if((await fs.stat(file)).size>12*1024*1024)throw new Error('oversized');const candidate=await readCharacterArchive(await fs.readFile(file));await validateImage(candidate);current=candidate;}catch{current=null;}return snapshot();});},
    install(bytes){const source=Buffer.isBuffer(bytes)?Buffer.from(bytes):bytes;return enqueue(()=>install(source));},
    // Queue the user's intent before opening a picker or awaiting its file read.
    installFrom(loadBytes){return enqueue(async()=>{if(typeof loadBytes!=='function')throw new TypeError('需要角色文件读取函数');const bytes=await loadBytes();if(bytes===null)return{cancelled:true,character:snapshot()};return{cancelled:false,character:await install(bytes)};});},
    clear(){return enqueue(async()=>{await fs.unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});current=null;return null;});},
  };
}
module.exports={createCharacterStore};
