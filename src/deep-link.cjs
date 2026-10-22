'use strict';
const SCHEME='andromeda-pet';
function parseDeepLink(value){
  if(typeof value!=='string'||value.length>200)return null;
  try{const url=new URL(value);if(url.protocol!==SCHEME+':'||url.hostname!=='open'||!['','/'].includes(url.pathname)||url.username||url.password||url.port||url.hash)return null;
    const entries=[...url.searchParams];if(entries.length!==1||entries[0][0]!=='target'||!['companion','home'].includes(entries[0][1]))return null;return entries[0][1];
  }catch{return null;}
}
module.exports={SCHEME,parseDeepLink};
