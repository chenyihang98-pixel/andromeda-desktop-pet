'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function compilerCandidates(systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows') {
  return ['Framework64', 'Framework'].map(directory => path.win32.join(systemRoot,
    'Microsoft.NET', directory, 'v4.0.30319', 'csc.exe'));
}

function buildWindowsHelper({ root = ROOT, outputDirectory = path.join(root, 'dist', 'native'),
  platform = process.platform, arch = 'x64', exists = fs.existsSync, run = spawnSync } = {}) {
  if (platform !== 'win32') throw new Error('The fullscreen helper must be built on Windows with the inbox .NET Framework C# compiler; Windows cross-builds are not supported.');
  if (arch !== 'x64') throw new Error('The fullscreen helper currently supports Windows x64 builds only.');
  const compiler = compilerCandidates().find(candidate => exists(candidate));
  if (!compiler) throw new Error('Windows .NET Framework C# compiler (csc.exe) is unavailable. Build on a supported Windows 10/11 machine; the app never downloads or compiles a helper at runtime.');
  const source = path.join(root, 'native', 'windows-fullscreen.cs');
  const manifest = path.join(root, 'native', 'windows-fullscreen.manifest');
  if (!exists(source) || !exists(manifest)) throw new Error('Fullscreen helper source or manifest is missing.');
  const output = path.join(outputDirectory, 'windows-fullscreen.exe');
  fs.mkdirSync(outputDirectory, { recursive: true });
  // Remove only this generated file, so a failed compilation cannot reuse stale output.
  fs.rmSync(output, { force: true });
  const result = run(compiler, ['/nologo', '/noconfig', '/optimize+', '/target:exe', '/platform:x64',
    '/reference:' + path.join(path.dirname(compiler), 'System.dll'),
    '/win32manifest:' + manifest, '/out:' + output, source], {
    cwd: root, encoding: 'utf8', shell: false, windowsHide: true, timeout: 60000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !exists(output)) {
    fs.rmSync(output, { force: true });
    throw new Error('Fullscreen helper compilation failed. ' + (result.error?.code || result.stdout?.trim() || result.stderr?.trim() || 'No executable was produced.'));
  }
  return output;
}

if (require.main === module) {
  try {
    if (process.platform !== 'win32') console.log('Skipping the Windows fullscreen helper on this platform; fullscreen auto-hide is unavailable.');
    else console.log('Built ' + path.relative(ROOT, buildWindowsHelper()));
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { buildWindowsHelper, compilerCandidates };
