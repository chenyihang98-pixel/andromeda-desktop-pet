'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseDeepLink}=require('../src/deep-link.cjs');
test('desktop deep link only selects the two fixed local surfaces',()=>{
  assert.equal(parseDeepLink('andromeda-pet://open?target=companion'),'companion');
  assert.equal(parseDeepLink('andromeda-pet://open/?target=home'),'home');
  for(const value of ['https://open?target=home','andromeda-pet://open?target=https://evil.test','andromeda-pet://open?target=home&command=rm','andromeda-pet://open?target=home&target=companion','andromeda-pet://open/file?target=home','andromeda-pet://user@open?target=home','andromeda-pet://open?target=home#fragment','andromeda-pet://open?target=','andromeda-pet://open:123?target=home',null])assert.equal(parseDeepLink(value),null);
});
