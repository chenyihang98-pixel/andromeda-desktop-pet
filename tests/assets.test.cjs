const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const {PNG} = require('pngjs');
const base = path.join(__dirname,'..','assets');
const manifest = JSON.parse(fs.readFileSync(path.join(base,'manifest.json')));
const bytes = fs.readFileSync(path.join(base,manifest.image));
const png = PNG.sync.read(bytes);
test('original artwork hash and v2 PNG dimensions match',()=>{
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),manifest.sha256);
  assert.equal(png.width,1536); assert.equal(png.height,2288); assert.equal(manifest.spriteVersionNumber,2);
});
test('all 73 required cells have alpha artwork and all 15 unused cells are transparent',()=>{
  const counts = [6,8,8,4,5,8,6,6,6,8,8]; let populated = 0;
  for(let row=0;row<11;row++) for(let col=0;col<8;col++) {
    let opaque=0,transparent=0;
    for(let y=row*208;y<(row+1)*208;y++) for(let x=col*192;x<(col+1)*192;x++) {
      const alpha=png.data[(y*1536+x)*4+3]; if(alpha)opaque++;else transparent++;
    }
    if(col<counts[row]) {assert.ok(opaque>1000,`row${row}col${col} artwork`);assert.ok(transparent>1000,`row${row}col${col} transparency`);populated++;}
    else assert.equal(opaque,0,`unused row${row}col${col}`);
  }
  assert.equal(populated,73);
});
test('direction list is clockwise 16-pose layout',()=>{
  assert.deepEqual(manifest.lookDirections.degreesClockwise,Array.from({length:16},(_,i)=>i*22.5));
});
