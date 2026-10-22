'use strict';

// Account for structured-clone data without expanding typed audio into a JSON index object.
function assertPayloadBudget(value, maximum = 12_000_000) {
  let bytes = 0, entries = 0;
  const seen = new Set();
  const add = count => {bytes += count;if (bytes > maximum) throw new TypeError('内容过大');};
  function visit(item, depth) {
    if (++entries > 50_000 || depth > 32) throw new TypeError('内容结构过大');
    if (item === null || item === undefined || typeof item === 'boolean') {add(5);return;}
    if (typeof item === 'number') {if (!Number.isFinite(item)) throw new TypeError('内容无效');add(24);return;}
    if (typeof item === 'string') {add(Buffer.byteLength(item, 'utf8') + 2);return;}
    if (typeof item !== 'object' || seen.has(item)) throw new TypeError('内容结构无效');
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) {add(item.byteLength);return;}
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new TypeError('内容结构无效');
    seen.add(item);add(2);
    for (const key of Object.keys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('内容结构无效');
      add(Buffer.byteLength(key, 'utf8') + 3);visit(descriptor.value, depth + 1);
    }
    seen.delete(item);
  }
  visit(value, 0);return bytes;
}
module.exports = {assertPayloadBudget};
