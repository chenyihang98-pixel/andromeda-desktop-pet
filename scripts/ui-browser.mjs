import {statSync} from 'node:fs';
import {join, win32} from 'node:path';

function isFile(filename) {
  try { return statSync(filename).isFile(); }
  catch { return false; }
}

// Use an installed browser without downloading one or changing its sandbox.
export function findChromium({platform = process.platform, env = process.env, fileExists = isFile} = {}) {
  if (env.CHROMIUM_PATH) {
    if (fileExists(env.CHROMIUM_PATH)) return env.CHROMIUM_PATH;
    throw new Error(`CHROMIUM_PATH is not a browser executable file: ${env.CHROMIUM_PATH}`);
  }

  let candidates;
  if (platform === 'win32') {
    const roots = [...new Set([env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean))];
    candidates = roots.flatMap(root => [
      win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      win32.join(root, 'Chromium', 'Application', 'chrome.exe'),
    ]);
  } else if (platform === 'darwin') {
    const roots = ['/Applications', ...(env.HOME ? [join(env.HOME, 'Applications')] : [])];
    candidates = roots.flatMap(root => [
      join(root, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      join(root, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
      join(root, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ]);
  } else {
    candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  }

  const executable = candidates.find(fileExists);
  if (executable) return executable;
  throw new Error(`No installed Chromium browser found on ${platform}. Set CHROMIUM_PATH to the full path of an installed Chrome, Edge or Chromium executable. Browser and OS sandbox protections must remain enabled.`);
}
