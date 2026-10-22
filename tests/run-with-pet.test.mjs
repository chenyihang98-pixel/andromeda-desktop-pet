import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname, resolve, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {bridgeCredentials, executableCommand, parseRunArguments, runWithPet} from '../scripts/run-with-pet.mjs';
import {createCompanionEngine} from '../src/shared/companion.mjs';
const {createTaskBridge} = createRequire(import.meta.url)('../src/services/task-bridge.cjs');
const script = fileURLToPath(new URL('../scripts/run-with-pet.mjs', import.meta.url));
const delay = ms => new Promise(done => setTimeout(done, ms));

async function bridge(t, statusCode = 202) {
  const events = [], headers = [], token = randomBytes(32).toString('base64url');
  const server = createServer(async (req, res) => {
    let data = '';for await (const chunk of req) data += chunk;
    events.push(JSON.parse(data));headers.push(req.headers);
    res.writeHead(statusCode, {Connection: 'close', ...(statusCode === 302 ? {Location: 'https://example.invalid/never-follow'} : {})}).end('{}');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  return {events, headers, token, env: {...process.env, ANDROMEDA_BRIDGE_PORT: String(server.address().port), ANDROMEDA_BRIDGE_TOKEN: token}};
}
async function cli(args, env) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [script, ...args], {env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';child.stdout.on('data', chunk => {stdout += chunk;});child.stderr.on('data', chunk => {stderr += chunk;});
    child.once('error', reject);child.once('close', (code, signal) => done({code, signal, stdout, stderr}));
  });
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'andromeda-command-test-'));
  t.after(async () => {assert.equal(dirname(resolve(directory)), resolve(tmpdir()));assert.ok(basename(directory).startsWith('andromeda-command-test-'));await rm(directory, {recursive: true, force: true});});
  return directory;
}

test('CLI parser requires explicit argv delimiter and bridge address cannot be supplied as an option', () => {
  assert.deepEqual(parseRunArguments(['--title', '构建', '--', 'node', '-e', 'literal && value']), {title: '构建', command: 'node', args: ['-e', 'literal && value']});
  assert.throws(() => parseRunArguments(['--url', 'https://example.test', '--', 'node']));
  assert.throws(() => parseRunArguments(['node', '-e', '']));assert.throws(() => parseRunArguments(['--title', '\n', '--', 'node']));
  assert.equal(bridgeCredentials({}).available, false);
  assert.equal(bridgeCredentials({ANDROMEDA_BRIDGE_PORT: 'https://remote.test', ANDROMEDA_BRIDGE_TOKEN: 'a'.repeat(43)}).available, false);
  assert.equal(bridgeCredentials({ANDROMEDA_BRIDGE_PORT: '65536', ANDROMEDA_BRIDGE_TOKEN: 'a'.repeat(43)}).available, false);
});

test('Windows npm is resolved to Node CLI without a shell or argument interpolation', () => {
  const node = 'C:\\Node\\node.exe', npm = 'C:\\Node\\node_modules\\npm\\bin\\npm-cli.js', args = ['run', 'build', '--', '&', 'two words', '$(secret)'];
  assert.deepEqual(executableCommand('npm.cmd', args, {platform: 'win32', env: {Path: 'C:\\Node'}, execPath: node, fileExists: value => value === npm}), {file: node, args: [npm, ...args]});
  assert.throws(() => executableCommand('something.cmd', [], {platform: 'win32'}), /不通过 shell/);
  assert.throws(() => executableCommand('npm', [], {platform: 'win32', env: {}, execPath: node, fileExists: () => false}), /JavaScript 入口/);
});

test('actual CLI preserves failure exit code and terminal output while sending only two small status records', async t => {
  const receiver = await bridge(t), source = 'process.stdout.write("PRIVATE-OUTPUT|"+(process.env.ANDROMEDA_BRIDGE_TOKEN?"LEAK":"CLEAN"));process.stderr.write("PRIVATE-ERROR");process.exit(7)';
  const result = await cli(['--title', '构建测试', '--', process.execPath, '-e', source], receiver.env);
  assert.equal(result.code, 7);assert.equal(result.stdout, 'PRIVATE-OUTPUT|CLEAN');assert.match(result.stderr, /PRIVATE-ERROR/);
  assert.deepEqual(receiver.events.map(event => event.status), ['working', 'failed']);assert.equal(receiver.events[0].taskId, receiver.events[1].taskId);
  assert.notEqual(receiver.events[0].eventId, receiver.events[1].eventId);assert.match(receiver.events[1].text, /退出码 7/);
  for (const event of receiver.events) assert.deepEqual(Object.keys(event).sort(), ['eventId', 'taskId', 'status', 'title', 'text'].sort());
  const serialized = JSON.stringify(receiver.events);for (const value of ['PRIVATE-OUTPUT', 'PRIVATE-ERROR', source, process.execPath, receiver.token]) assert.equal(serialized.includes(value), false);
  assert.ok(receiver.headers.every(header => header.authorization === `Bearer ${receiver.token}` && header.host.startsWith('127.0.0.1:')));
  assert.equal(result.stderr.includes(receiver.token), false);
});

test('successful command keeps metacharacters literal and emits one completed terminal status', async t => {
  const receiver = await bridge(t), literal = ['&&', ';', 'two words', '$(not-executed)'];
  const result = await cli(['--', process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...literal], receiver.env);
  assert.equal(result.code, 0);assert.deepEqual(JSON.parse(result.stdout), literal);assert.deepEqual(receiver.events.map(event => event.status), ['working', 'completed']);
});

test('missing, rejected and redirecting bridge credentials never change the real command result', async t => {
  const missing = {...process.env};delete missing.ANDROMEDA_BRIDGE_PORT;delete missing.ANDROMEDA_BRIDGE_TOKEN;
  const offline = await cli(['--', process.execPath, '-e', 'process.exit(3)'], missing);assert.equal(offline.code, 3);assert.match(offline.stderr, /命令继续运行/);
  const receiver = await bridge(t, 302), diagnostics = [];
  const result = await runWithPet({command: process.execPath, args: ['-e', 'process.exit(4)'], env: receiver.env, stdio: 'ignore', diagnostic: value => diagnostics.push(value)});
  assert.equal(result.exitCode, 4);assert.equal(diagnostics.length, 1);assert.equal(diagnostics.join('').includes(receiver.token), false);
  assert.deepEqual(receiver.events.map(event => event.status), ['working', 'failed']);
});

test('spawn failure emits one terminal failure and a conventional exit code without revealing argv', async t => {
  const receiver = await bridge(t), diagnostics = [];
  const result = await runWithPet({command: 'andromeda-no-such-executable-246851', args: ['PRIVATE-ARG'], env: receiver.env, stdio: 'ignore', diagnostic: value => diagnostics.push(value)});
  assert.equal(result.exitCode, 127);assert.deepEqual(receiver.events.map(event => event.status), ['working', 'failed']);
  assert.equal(JSON.stringify(receiver.events).includes('PRIVATE-ARG'), false);assert.equal(diagnostics.join('').includes('PRIVATE-ARG'), false);
});

test('explicit cancellation kills the real child tree and emits cancelled exactly once', {timeout: 15000}, async t => {
  const receiver = await bridge(t), directory = await temporary(t), filename = join(directory, 'pids.json'), controller = new AbortController();
  const source = 'const{spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("node:fs").writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);';
  const pending = runWithPet({command: process.execPath, args: ['-e', source, filename], env: receiver.env, signal: controller.signal, stdio: 'ignore', diagnostic: () => {}});
  let pids;
  for (let i = 0; i < 200; i++) {try {pids = JSON.parse(await readFile(filename, 'utf8'));break;} catch {await delay(10);}}
  try {assert.ok(pids?.length === 2);controller.abort('SIGINT');const result = await pending;assert.equal(result.exitCode, 130);assert.equal(result.status, 'cancelled');}
  finally {controller.abort('SIGINT');await pending;}
  assert.deepEqual(receiver.events.map(event => event.status), ['working', 'cancelled']);
  for (const pid of pids) {
    let alive = true;for (let i = 0; i < 100 && alive; i++) {try {process.kill(pid, 0);await delay(10);} catch {alive = false;}}
    assert.equal(alive, false, 'adapter-owned child must no longer be running');
  }
  assert.equal(JSON.stringify(receiver.events).includes(filename), false);
});

test('real npm version command uses compatible direct execution when npm is installed', async t => {
  try {executableCommand('npm', ['--version']);} catch (error) {t.skip(error.message);return;}
  const env = {...process.env};delete env.ANDROMEDA_BRIDGE_PORT;delete env.ANDROMEDA_BRIDGE_TOKEN;
  const result = await runWithPet({command: 'npm', args: ['--version'], env, stdio: 'ignore', diagnostic: () => {}});
  assert.equal(result.exitCode, 0);
});

test('real task bridge accepts adapter events and updates the shared companion task', async t => {
  const engine = createCompanionEngine(), events = [];
  const actualBridge = createTaskBridge({onEvent: event => {events.push(event);engine.dispatch(event);}});
  const connection = await actualBridge.start();t.after(() => actualBridge.stop());
  const result = await runWithPet({title: '真实桥接验收', command: process.execPath, args: ['-e', 'process.exit(0)'],
    env: {...process.env, ANDROMEDA_BRIDGE_PORT: String(connection.port), ANDROMEDA_BRIDGE_TOKEN: connection.token}, stdio: 'ignore', diagnostic: () => {}});
  assert.equal(result.exitCode, 0);assert.deepEqual(events.map(event => event.status), ['working', 'completed']);
  const task = engine.snapshot().tasks.find(task => task.id === result.taskId);
  assert.equal(task.title, '真实桥接验收');assert.equal(task.status, 'completed');
});
