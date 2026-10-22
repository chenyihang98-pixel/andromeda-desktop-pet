import {spawn, spawnSync} from 'node:child_process';
import {request} from 'node:http';
import {randomUUID} from 'node:crypto';
import {statSync} from 'node:fs';
import {join, resolve, win32} from 'node:path';
import {fileURLToPath} from 'node:url';

const USAGE = `用法：node scripts/run-with-pet.mjs [--title "构建"] -- 命令 [参数...]
示例：node scripts/run-with-pet.mjs --title "构建网页" -- npm run build:web
桥接凭据只读取 ANDROMEDA_BRIDGE_PORT / ANDROMEDA_BRIDGE_TOKEN 环境变量。
没有任务桥也会执行命令；这里只发送任务状态，不转发命令输出。`;

export function parseRunArguments(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw new TypeError('命令参数无效。');
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return {help: true};
  let title = '终端任务', index = 0;
  if (argv[index] === '--title') {title = argv[index + 1];index += 2;}
  if (typeof title !== 'string' || !title.trim() || title.length > 200 || /[\u0000-\u001f\u007f]/.test(title)) throw new TypeError('任务名称需要是 1–200 字符的短标题。');
  if (argv[index] !== '--' || !argv[index + 1]) throw new TypeError('请用 -- 分隔适配器选项和要运行的命令。');
  const [command, ...args] = argv.slice(index + 1);
  if ([command, ...args].some(value => value.includes('\0'))) throw new TypeError('命令参数不能包含空字符。');
  return {title: title.trim(), command, args};
}

export function bridgeCredentials(env = process.env) {
  const portText = env.ANDROMEDA_BRIDGE_PORT, token = env.ANDROMEDA_BRIDGE_TOKEN;
  if (!portText && !token) return {available: false, reason: 'missing'};
  if (typeof portText !== 'string' || !/^[1-9]\d{0,4}$/.test(portText) || Number(portText) > 65535
    || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return {available: false, reason: 'invalid'};
  return {available: true, port: Number(portText), token};
}

function isFile(filename) {try {return statSync(filename).isFile();} catch {return false;}}
/** Windows .cmd files need a shell. Resolve npm's actual JS CLI instead of constructing a shell command. */
export function executableCommand(command, args, {platform = process.platform, env = process.env, execPath = process.execPath, fileExists = isFile} = {}) {
  if (platform !== 'win32') return {file: command, args: [...args]};
  const name = win32.basename(command).toLowerCase();
  if (name === 'npm' || name === 'npm.cmd') {
    const explicit = command.includes('/') || command.includes('\\');
    const roots = explicit ? [win32.dirname(win32.resolve(command))] : [...String(env.Path || env.PATH || '').split(';').filter(Boolean), win32.dirname(execPath)];
    const candidates = [];
    if (!explicit && typeof env.npm_execpath === 'string' && win32.isAbsolute(env.npm_execpath) && win32.basename(env.npm_execpath).toLowerCase() === 'npm-cli.js') candidates.push(env.npm_execpath);
    for (const root of roots) candidates.push(win32.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    const cli = candidates.find(fileExists);
    if (!cli) {const error = new Error('未找到 npm 的 JavaScript 入口；请使用 node 加 npm-cli.js 的完整路径。不会通过 shell 执行 npm.cmd。');error.exitCode = 126;throw error;}
    return {file: execPath, args: [cli, ...args]};
  }
  if (/\.(cmd|bat)$/i.test(name)) {const error = new Error('此适配器不通过 shell 执行 .cmd/.bat。请使用程序的 .exe，或 node 加工具的 JavaScript 入口。');error.exitCode = 126;throw error;}
  return {file: command, args: [...args]};
}

function sendStatus(credentials, event) {
  if (!credentials.available) return Promise.resolve(false);
  return new Promise(resolveResult => {
    let settled = false, timer, outgoing;
    const finish = accepted => {if (settled) return;settled = true;clearTimeout(timer);outgoing?.destroy();resolveResult(accepted);};
    const body = Buffer.from(JSON.stringify(event));
    // No URL, proxy environment, redirect, DNS lookup or remote host can enter this request.
    outgoing = request({hostname: '127.0.0.1', port: credentials.port, path: '/events', method: 'POST', agent: false,
      headers: {'Authorization': `Bearer ${credentials.token}`, 'Content-Type': 'application/json', 'Content-Length': body.length}}, response => {
      const accepted = response.statusCode === 202;response.resume();response.once('end', () => finish(accepted));response.once('error', () => finish(false));
    });
    outgoing.once('error', () => finish(false));timer = setTimeout(() => finish(false), 750);outgoing.end(body);
  });
}

const signalExitCode = signal => ({SIGINT: 130, SIGTERM: 143, SIGKILL: 137, SIGHUP: 129}[signal] || 1);
function withoutBridgeCredentials(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !['ANDROMEDA_BRIDGE_PORT', 'ANDROMEDA_BRIDGE_TOKEN'].includes(key.toUpperCase())));
}
function stopChildTree(child, env) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0 || child.exitCode !== null || child.signalCode) return () => {};
  if (process.platform === 'win32') {
    const executable = join(env.SystemRoot || process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    const helperEnv = withoutBridgeCredentials(env);
    const result = spawnSync(executable, ['/PID', String(child.pid), '/T', '/F'], {shell: false, windowsHide: true, stdio: 'ignore', timeout: 2000, env: helperEnv});
    if (result.status !== 0) try {child.kill('SIGKILL');} catch {}
    return () => {};
  }
  try {process.kill(-child.pid, 'SIGTERM');} catch {try {child.kill('SIGTERM');} catch {}}
  let forced = false;
  const force = () => {if (forced) return;forced = true;try {process.kill(-child.pid, 'SIGKILL');} catch {try {child.kill('SIGKILL');} catch {}}};
  const timer = setTimeout(force, 1500);
  timer.unref?.();return () => {clearTimeout(timer);force();};
}

/** Runs exactly the user's argv. No stdout/stderr is captured or included in task events. */
export async function runWithPet({title = '终端任务', command, args = [], env = process.env, signal, stdio = 'inherit',
  diagnostic = message => process.stderr.write('[星璇] ' + message + '\n')} = {}) {
  // Reuse the CLI validation for programmatic callers; credentials cannot be passed as CLI flags.
  const parsed = parseRunArguments(['--title', title, '--', command, ...args]);
  if (!['inherit', 'ignore'].includes(stdio)) throw new TypeError('只支持继承或忽略输出，不捕获命令输出。');
  const credentials = bridgeCredentials(env), taskId = 'cli-' + randomUUID();
  let warned = false, terminalSent = false, child, finished = false, cancelled, cleanupKill = () => {};
  const warn = text => {if (!warned) {warned = true;try {diagnostic(text);} catch {}}};
  const report = async (status, text) => {
    if (status !== 'working') {if (terminalSent) return;terminalSent = true;}
    if (!credentials.available) return;
    if (!await sendStatus(credentials, {eventId: `${taskId}-${status}`, taskId, status, title: parsed.title, text})) warn('未能送达本机任务桥；命令的执行和退出码不受影响。');
  };
  const onAbort = () => {if (finished || cancelled) return;cancelled = signal?.reason === 'SIGTERM' ? 'SIGTERM' : 'SIGINT';cleanupKill = stopChildTree(child, env);};
  if (signal?.aborted) onAbort();else signal?.addEventListener('abort', onAbort, {once: true});
  if (!credentials.available) warn(credentials.reason === 'missing' ? '未连接本机任务桥，命令继续运行。' : '本机任务桥凭据无效，命令继续运行。');
  try {
    if (cancelled) {await report('cancelled', `命令已取消，退出码 ${signalExitCode(cancelled)}。`);return {exitCode: signalExitCode(cancelled), taskId, status: 'cancelled'};}
    await report('working', '命令开始运行。');
    if (cancelled) {await report('cancelled', `命令已取消，退出码 ${signalExitCode(cancelled)}。`);return {exitCode: signalExitCode(cancelled), taskId, status: 'cancelled'};}
    let resolved;
    try {resolved = executableCommand(parsed.command, parsed.args, {env});}
    catch (error) {diagnostic(error.message);await report('failed', '命令未能启动，退出码 126。');return {exitCode: 126, taskId, status: 'failed'};}
    const childEnv = withoutBridgeCredentials(env);
    const outcome = await new Promise(done => {
      let completed = false;
      const complete = result => {if (!completed) {completed = true;finished = true;done(result);}};
      try {
        child = spawn(resolved.file, resolved.args, {shell: false, windowsHide: true, detached: process.platform !== 'win32', env: childEnv, stdio});
        child.once('error', () => complete({spawnError: true, code: 127}));
        child.once('close', (code, closedSignal) => complete({code, signal: closedSignal}));
        if (cancelled) cleanupKill = stopChildTree(child, env);
      } catch {complete({spawnError: true, code: 127});}
    });
    cleanupKill();
    const exitCode = cancelled ? signalExitCode(cancelled) : typeof outcome.code === 'number' ? outcome.code : signalExitCode(outcome.signal);
    const status = cancelled || outcome.signal ? 'cancelled' : exitCode === 0 ? 'completed' : 'failed';
    if (outcome.spawnError) try {diagnostic('命令未能启动；请检查程序是否存在。');} catch {}
    await report(status, `命令${status === 'completed' ? '完成' : status === 'cancelled' ? '已取消' : '失败'}，退出码 ${exitCode}。`);
    return {exitCode, taskId, status};
  } finally {finished = true;cleanupKill();signal?.removeEventListener('abort', onAbort);}
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {parsed = parseRunArguments(argv);} catch (error) {process.stderr.write(error.message + '\n' + USAGE + '\n');return 2;}
  if (parsed.help) {process.stdout.write(USAGE + '\n');return 0;}
  const controller = new AbortController(), interrupt = () => controller.abort('SIGINT'), terminate = () => controller.abort('SIGTERM');
  process.once('SIGINT', interrupt);process.once('SIGTERM', terminate);
  try {return (await runWithPet({...parsed, signal: controller.signal})).exitCode;}
  finally {process.removeListener('SIGINT', interrupt);process.removeListener('SIGTERM', terminate);}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {process.exitCode = await main();} catch {process.stderr.write('[星璇] 任务适配器未能完成，本次退出码为 1。\n');process.exitCode = 1;}
}
