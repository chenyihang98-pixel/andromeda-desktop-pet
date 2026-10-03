import {readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const files = readdirSync('dist').filter(f=>/\.(zip|exe)$/.test(f)).sort();
if(!files.length)throw Error('No release archives found');
writeFileSync('dist/SHA256SUMS.txt',files.map(f=>createHash('sha256').update(readFileSync('dist/'+f)).digest('hex')+'  '+f).join('\n')+'\n');
console.log(readFileSync('dist/SHA256SUMS.txt','utf8'));
