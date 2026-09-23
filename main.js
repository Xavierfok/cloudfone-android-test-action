'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('./lib');

function sleepSeconds(s) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(s * 1000));
}

function mask(value) {
  for (const line of String(value).split(/\r?\n/)) {
    const v = line.trim();
    if (v) console.log(`::add-mask::${v}`);
  }
}

function installCli(inputs, env, runner) {
  const venv = path.join(env.RUNNER_TEMP || os.tmpdir(), 'cloudfone-venv');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  if (!fs.existsSync(L.venvBin(venv, 'cloudfone'))) {
    L.mustRun(python, ['-m', 'venv', venv], {}, runner);
    L.mustRun(L.venvBin(venv, 'python'),
      ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', inputs.cliSpec], {}, runner);
  }
  return venv;
}

function findAdb(env, runner) {
  const which = runner('bash', ['-c', 'command -v adb'], { env });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  for (const root of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    const p = root && path.join(root, 'platform-tools', 'adb');
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error('adb not found. Add a step that installs the Android platform-tools first.');
}

function tunnelUp(inputs, env, runner) {
  if (process.platform !== 'linux') throw new Error('adb mode needs a Linux runner (wg-quick)');
  // The tunnel is only for adb. Drop DNS= so it can't take over the runner's resolver
  // (and so wg-quick doesn't need resolvconf).
  const conf = inputs.wireguardConfig.split(/\r?\n/)
    .filter((l) => !/^\s*DNS\s*=/i.test(l)).join('\n') + '\n';
  const file = path.join(env.RUNNER_TEMP || os.tmpdir(), 'cfwg0.conf');
  fs.writeFileSync(file, conf, { mode: 0o600 });
  if (runner('bash', ['-c', 'command -v wg-quick'], { env }).status !== 0) {
    L.mustRun('sudo', ['apt-get', 'update', '-qq'], { env }, runner);
    L.mustRun('sudo', ['apt-get', 'install', '-y', '-qq', 'wireguard-tools'], { env }, runner);
  }
  L.mustRun('sudo', ['wg-quick', 'up', file], { env }, runner);
  L.saveState('wg', file, env);
}

function prepareAdbKey(inputs, adb, env, runner) {
  const dir = path.join(env.HOME || os.homedir(), '.android');
  fs.mkdirSync(dir, { recursive: true });
  const priv = path.join(dir, 'adbkey');
  if (inputs.adbKey) {
    fs.writeFileSync(priv, inputs.adbKey.trim() + '\n', { mode: 0o600 });
    const pub = L.mustRun(adb, ['pubkey', priv], { env }, runner).stdout;
    fs.writeFileSync(`${priv}.pub`, pub);
    runner(adb, ['kill-server'], { env });
  } else {
    console.log('::warning::No "adb-key" given, so this run uses a brand-new adb key. The phone ' +
      'will ask to "Allow USB debugging" for it, and CI cannot tap that. Store one key as a ' +
      'secret and authorise it once from the browser (see README).');
  }
  L.mustRun(adb, ['start-server'], { env }, runner);
  return `${priv}.pub`;
}

function screenshot(adb, target, file, env) {
  const r = spawnSync(adb, ['-s', target, 'exec-out', 'screencap', '-p'], { env, maxBuffer: 64 << 20 });
  const png = r.stdout;
  if (r.status !== 0 || !png || png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) {
    console.log(`::warning::screenshot failed: ${String(r.stderr || '').trim() || 'not a PNG'}`);
    return '';
  }
  fs.writeFileSync(file, png);
  return path.resolve(file);
}

function main({ env = process.env, runner = L.run } = {}) {
  const inputs = L.parseInputs(env);
  mask(inputs.token);
  if (inputs.wireguardConfig) mask(inputs.wireguardConfig);
  if (inputs.adbKey) mask(inputs.adbKey);

  const venv = installCli(inputs, env, runner);
  L.saveState('venv', venv, env);
  const cli = L.venvBin(venv, 'cloudfone');
  const cenv = L.cliEnv(inputs, env);

  const waitArgs = ['wait', '--json', '--timeout', String(inputs.waitTimeout)];
  if (inputs.serial) waitArgs.push('--serial', inputs.serial);
  const device = JSON.parse(L.mustRun(cli, waitArgs, { env: cenv }, runner).stdout);
  if (!L.carrierMatches(device, inputs.carrier)) {
    throw new Error(`phone ${device.serial} is on "${device.operator}", not "${inputs.carrier}"`);
  }
  const serial = device.serial;
  L.setOutput('serial', serial, env);
  L.setOutput('model', device.model || '', env);
  L.setOutput('carrier', device.operator || '', env);
  L.setOutput('android-version', device.version || '', env);
  L.setOutput('network', ((device.network || {}).subtype) || '', env);
  console.log(`phone ${serial}: ${device.model} on ${device.operator}, Android ${device.version}`);

  L.mustRun(cli, ['lock', serial, '--minutes', String(inputs.lockMinutes)], { env: cenv }, runner);
  L.saveState('serial', serial, env);
  console.log(`holding the control lock on ${serial}`);

  if (inputs.mode === 'reserve') {
    L.setOutput('mode', 'reserve', env);
    return { serial, mode: 'reserve' };
  }

  L.setOutput('mode', 'adb', env);
  tunnelUp(inputs, env, runner);
  const adb = findAdb(env, runner);
  L.saveState('adbBin', adb, env);
  const pub = prepareAdbKey(inputs, adb, env, runner);
  const reg = runner(cli, ['add-adb-key', '--key', pub, '--title', 'github-actions'], { env: cenv });
  if (reg.status !== 0) console.log(`::warning::adb key registration: ${reg.stderr.trim()}`);

  const conn = L.mustRun(cli, ['adb-connect', serial, '--no-lock', '--via', inputs.adbHost,
    '--connect'], { env: cenv }, runner);
  const target = conn.stdout.trim().split(/\r?\n/).pop();
  L.saveState('adb', target, env);
  L.setOutput('adb-serial', target, env);

  runner('timeout', ['60', adb, '-s', target, 'wait-for-device'], { env });
  const state = runner(adb, ['-s', target, 'get-state'], { env });
  if (state.stdout.trim() !== 'device') {
    throw new Error(`adb reports "${(state.stdout + state.stderr).trim()}" for ${target}. If it ` +
      'says unauthorized, open the phone in the browser and accept "Allow USB debugging" for ' +
      'this key, ticking "Always allow".');
  }

  if (inputs.apk) {
    L.mustRun(adb, ['-s', target, 'install', '-r', '-g', inputs.apk], { env }, runner);
    console.log(`installed ${inputs.apk}`);
  }
  if (inputs.package) {
    L.mustRun(adb, ['-s', target, 'shell', 'monkey', '-p', inputs.package,
      '-c', 'android.intent.category.LAUNCHER', '1'], { env }, runner);
    console.log(`launched ${inputs.package}, waiting ${inputs.launchWait}s`);
    sleepSeconds(inputs.launchWait);
  }

  let testStatus = null;
  if (inputs.testCommand) {
    const r = spawnSync('bash', ['-c', inputs.testCommand], {
      stdio: 'inherit',
      env: { ...env, ANDROID_SERIAL: target, CLOUDFONE_SERIAL: serial },
    });
    testStatus = r.status;
    L.setOutput('test-result', testStatus === 0 ? 'passed' : 'failed', env);
  }

  const shot = screenshot(adb, target, inputs.screenshot, env);
  L.setOutput('screenshot', shot, env);

  if (testStatus !== null && testStatus !== 0) {
    throw new Error(`test-command exited ${testStatus}`);
  }
  return { serial, mode: 'adb', target, screenshot: shot };
}

module.exports = { main };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.log(`::error::${err.message}`);
    process.exitCode = 1;
  }
}
