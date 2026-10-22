import {readdirSync,createReadStream,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const files = readdirSync('dist').filter(f=>/\.(zip|exe)$/.test(f)).sort();
if(!files.length)throw Error('No release archives found');
const lines=[];
for(const file of files){
  const hash=createHash('sha256');
  for await(const chunk of createReadStream('dist/'+file))hash.update(chunk);
  lines.push(hash.digest('hex')+'  '+file);
}
const text=lines.join('\n')+'\n';writeFileSync('dist/SHA256SUMS.txt',text);console.log(text);
