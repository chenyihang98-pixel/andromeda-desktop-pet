'use strict';

const { buildWindowsHelper } = require('./build-windows-helper.cjs');

// electron-builder's Arch enum uses 1 for x64. Other targets must not silently
// receive an incompatible helper binary. Non-Windows packs do not use it.
module.exports = async function beforePack(context) {
  if (context.electronPlatformName !== 'win32') return;
  if (context.arch !== 1 && context.arch !== 'x64') throw new Error('Windows fullscreen helper packaging currently supports x64 only.');
  buildWindowsHelper({ root: context.packager.projectDir, arch: 'x64' });
};
