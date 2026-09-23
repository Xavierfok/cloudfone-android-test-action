'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../lib');
const { main } = require('../main');
const { post } = require('../post');

const PHONE = {
  serial: 'R5CT1', model: 'SM-G981B', operator: 'Singtel', version: '16',
  present: true, ready: true, network: { subtype: 'LTE' },
};

function sandbox(inputs = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfaction-'));
  const env = {
    RUNNER_TEMP: dir, HOME: dir, PATH: process.env.PATH,
    GITHUB_OUTPUT: path.join(dir, 'out'), GITHUB_STATE: path.join(dir, 'state'),
  };
  fs.writeFileSync(env.GITHUB_OUTPUT, '');
  fs.writeFileSync(env.GITHUB_STATE, '');
  for (const [k, v] of Object.entries({ token: 'tok', ...inputs })) {
    env[`INPUT_${k.toUpperCase()}`] = v;
  }
  return { dir, env };
}

function readKV(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

// A runner that answers by the subcommand it sees, and records every call.
function fakeRunner(answers = {}) {
  const calls = [];
  const runner = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, env: opts.env });
    const key = path.basename(cmd).replace(/\.exe$/, '') === 'cloudfone' ? args[0] : cmd;
    const a = answers[key] || answers[`${cmd} ${args[0]}`];
    if (typeof a === 'function') return a(cmd, args);
    return a || { status: 0, stdout: '', stderr: '' };
  };
  runner.calls = calls;
  runner.cli = (sub) => calls.filter((c) => path.basename(c.cmd).startsWith('cloudfone') && c.args[0] === sub);
  return runner;
}

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });

test('token is required', () => {
  assert.throws(() => L.parseInputs({}), /token/);
});

test('reserve mode refuses adb-only inputs with a clear reason', () => {
  assert.throws(() => L.parseInputs({ INPUT_TOKEN: 't', INPUT_APK: 'app.apk' }),
    /cannot install apps/);
});

test('adb mode needs adb-host', () => {
  assert.throws(() => L.parseInputs({ INPUT_TOKEN: 't', 'INPUT_WIREGUARD-CONFIG': '[Interface]' }),
    /adb-host/);
  const i = L.parseInputs({ INPUT_TOKEN: 't', 'INPUT_WIREGUARD-CONFIG': 'x', 'INPUT_ADB-HOST': '10.77.0.1' });
  assert.strictEqual(i.mode, 'adb');
});

test('carrier match is loose on case and punctuation', () => {
  assert.ok(L.carrierMatches({ operator: 'SingTel' }, 'singtel'));
  assert.ok(L.carrierMatches({ operator: 'M1' }, 'm1'));
  assert.ok(!L.carrierMatches({ operator: 'M1' }, 'singtel'));
  assert.ok(L.carrierMatches({ operator: 'M1' }, ''));
});

test('multi-line outputs use a heredoc delimiter', () => {
  const { env } = sandbox();
  L.setOutput('x', 'a\nb', env);
  assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), /^x<<ghadelim_\w+\r?\na\nb\r?\nghadelim_\w+/);
});

test('reserve mode: installs the CLI, waits, locks, writes outputs', () => {
  const { env } = sandbox({ 'lock-minutes': '45', carrier: 'singtel' });
  const runner = fakeRunner({ wait: () => ok(JSON.stringify(PHONE)) });
  const r = main({ env, runner });
  assert.deepStrictEqual(r, { serial: 'R5CT1', mode: 'reserve' });
  assert.ok(runner.calls.some((c) => c.args.includes('venv')));
  assert.ok(runner.calls.some((c) => c.args.includes('install') && c.args.some((a) => a.includes('cloudfone-cli'))));
  assert.deepStrictEqual(runner.cli('lock')[0].args, ['lock', 'R5CT1', '--minutes', '45']);
  assert.strictEqual(runner.cli('lock')[0].env.CLOUDFONE_TOKEN, 'tok');
  const out = readKV(env.GITHUB_OUTPUT);
  assert.strictEqual(out.serial, 'R5CT1');
  assert.strictEqual(out.carrier, 'Singtel');
  assert.strictEqual(out['android-version'], '16');
  assert.strictEqual(out.mode, 'reserve');
  assert.strictEqual(readKV(env.GITHUB_STATE).serial, 'R5CT1');
  assert.ok(!runner.calls.some((c) => c.args.includes('wg-quick')));
});

test('wait passes serial and timeout', () => {
  const { env } = sandbox({ serial: 'R5CT1', 'wait-timeout': '120' });
  const runner = fakeRunner({ wait: () => ok(JSON.stringify(PHONE)) });
  main({ env, runner });
  assert.deepStrictEqual(runner.cli('wait')[0].args,
    ['wait', '--json', '--timeout', '120', '--serial', 'R5CT1']);
});

test('wrong carrier fails before taking the lock', () => {
  const { env } = sandbox({ carrier: 'M1' });
  const runner = fakeRunner({ wait: () => ok(JSON.stringify(PHONE)) });
  assert.throws(() => main({ env, runner }), /"Singtel", not "M1"/);
  assert.strictEqual(runner.cli('lock').length, 0);
});

test('a CLI failure surfaces its message', () => {
  const { env } = sandbox();
  const runner = fakeRunner({ wait: () => ({ status: 1, stdout: '', stderr: 'cloudfone: HTTP 401 Bad Credentials' }) });
  assert.throws(() => main({ env, runner }), /401 Bad Credentials/);
});

function postEnv(state, inputs = {}) {
  const { env } = sandbox(inputs);
  for (const [k, v] of Object.entries(state)) env[`STATE_${k}`] = v;
  return env;
}

test('post releases the lock in reserve mode', () => {
  const runner = fakeRunner();
  const done = post({ env: postEnv({ venv: '/v', serial: 'R5CT1' }), runner });
  assert.deepStrictEqual(runner.cli('unlock')[0].args, ['unlock', 'R5CT1']);
  assert.deepStrictEqual(done, ['release lock']);
});

test('post keeps the lock when asked', () => {
  const runner = fakeRunner();
  post({ env: postEnv({ venv: '/v', serial: 'R5CT1' }, { 'keep-lock': 'true' }), runner });
  assert.strictEqual(runner.calls.length, 0);
});

test('post does nothing if main never got a phone', () => {
  const runner = fakeRunner();
  post({ env: postEnv({ venv: '/v' }), runner });
  assert.strictEqual(runner.calls.length, 0);
});

test('post in adb mode disconnects, closes the port, drops the tunnel', () => {
  const runner = fakeRunner();
  const done = post({
    env: postEnv({ venv: '/v', serial: 'R5CT1', adb: '10.77.0.1:7597', wg: '/t/cfwg0.conf', adbBin: '/sdk/adb' }),
    runner,
  });
  assert.deepStrictEqual(done, ['adb disconnect', 'close adb port', 'tunnel down']);
  assert.strictEqual(runner.calls[0].cmd, '/sdk/adb');
  assert.strictEqual(runner.cli('unlock').length, 0);
});

test('post still releases the lock if closing the adb port fails', () => {
  const runner = fakeRunner({ 'adb-disconnect': () => ({ status: 1, stdout: '', stderr: 'boom' }) });
  post({ env: postEnv({ venv: '/v', serial: 'R5CT1', adb: '10.77.0.1:7597' }), runner });
  assert.strictEqual(runner.cli('unlock').length, 1);
});

test('adb mode: tunnel without DNS, key, connect, install, launch, test', { skip: process.platform !== 'linux' }, () => {
  const wg = '[Interface]\nPrivateKey = secret\nAddress = 10.77.0.9/32\nDNS = 1.1.1.1\n[Peer]\nEndpoint = wg.cloudf.one:51820\n';
  const { dir, env } = sandbox({
    'wireguard-config': wg, 'adb-host': '10.77.0.1', 'adb-key': 'PRIVATE',
    apk: 'app.apk', package: 'com.example', 'launch-wait': '0', 'test-command': 'exit 0',
    screenshot: path.join(os.tmpdir(), 'cf-shot.png'),
  });
  const runner = fakeRunner({
    wait: () => ok(JSON.stringify(PHONE)),
    'adb-connect': () => ok('10.77.0.1:7597\n'),
    bash: (cmd, args) => (args[1] === 'command -v adb' ? ok('/sdk/adb\n') : ok('/usr/bin/wg-quick')),
    '/sdk/adb pubkey': () => ok('PUBKEY user@host\n'),
    '/sdk/adb -s': (cmd, args) => (args[2] === 'get-state' ? ok('device\n') : ok()),
  });
  const r = main({ env, runner });
  assert.strictEqual(r.target, '10.77.0.1:7597');
  const conf = fs.readFileSync(path.join(dir, 'cfwg0.conf'), 'utf8');
  assert.ok(!/DNS/.test(conf) && /PrivateKey/.test(conf));
  assert.strictEqual(fs.readFileSync(path.join(dir, '.android', 'adbkey'), 'utf8'), 'PRIVATE\n');
  assert.ok(runner.calls.some((c) => c.cmd === 'sudo' && c.args[0] === 'wg-quick' && c.args[1] === 'up'));
  assert.deepStrictEqual(runner.cli('adb-connect')[0].args,
    ['adb-connect', 'R5CT1', '--no-lock', '--via', '10.77.0.1', '--connect']);
  assert.ok(runner.calls.some((c) => c.args.includes('install') && c.args.includes('app.apk')));
  assert.ok(runner.calls.some((c) => c.args.includes('monkey') && c.args.includes('com.example')));
  const out = readKV(env.GITHUB_OUTPUT);
  assert.strictEqual(out['test-result'], 'passed');
  assert.strictEqual(out['adb-serial'], '10.77.0.1:7597');
  assert.strictEqual(readKV(env.GITHUB_STATE).wg, path.join(dir, 'cfwg0.conf'));
});

test('adb mode: unauthorized key explains the fix', { skip: process.platform !== 'linux' }, () => {
  const { env } = sandbox({ 'wireguard-config': '[Interface]', 'adb-host': '10.77.0.1' });
  const runner = fakeRunner({
    wait: () => ok(JSON.stringify(PHONE)),
    'adb-connect': () => ok('10.77.0.1:7597'),
    bash: (cmd, args) => (args[1] === 'command -v adb' ? ok('/sdk/adb') : ok('/usr/bin/wg-quick')),
    '/sdk/adb -s': () => ({ status: 1, stdout: '', stderr: 'error: device unauthorized.' }),
  });
  assert.throws(() => main({ env, runner }), /Allow USB debugging/);
});

test('adb mode: failing test-command fails the step', { skip: process.platform !== 'linux' }, () => {
  const { env } = sandbox({
    'wireguard-config': '[Interface]', 'adb-host': '10.77.0.1', 'test-command': 'exit 3',
  });
  const runner = fakeRunner({
    wait: () => ok(JSON.stringify(PHONE)),
    'adb-connect': () => ok('10.77.0.1:7597'),
    bash: (cmd, args) => (args[1] === 'command -v adb' ? ok('/sdk/adb') : ok('/usr/bin/wg-quick')),
    '/sdk/adb -s': (cmd, args) => (args[2] === 'get-state' ? ok('device') : ok()),
  });
  assert.throws(() => main({ env, runner }), /exited 3/);
  assert.strictEqual(readKV(env.GITHUB_OUTPUT)['test-result'], 'failed');
});
