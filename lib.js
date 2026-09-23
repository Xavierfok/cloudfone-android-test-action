// Shared pieces for main.js and post.js. No npm dependencies on purpose:
// the action runs straight from the repo with nothing to build or vendor.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function input(name, env = process.env) {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  return (env[key] || '').trim();
}

function parseInputs(env = process.env) {
  const i = (n) => input(n, env);
  const inputs = {
    token: i('token'),
    serial: i('serial'),
    carrier: i('carrier'),
    waitTimeout: Number(i('wait-timeout') || 300),
    lockMinutes: Number(i('lock-minutes') || 30),
    keepLock: i('keep-lock') === 'true',
    cliSpec: i('cli-spec') || 'git+https://github.com/Xavierfok/cloudfone-cli@v0.1.0',
    wireguardConfig: i('wireguard-config'),
    adbHost: i('adb-host'),
    adbKey: i('adb-key'),
    apk: i('apk'),
    package: i('package'),
    launchWait: Number(i('launch-wait') || 5),
    testCommand: i('test-command'),
    screenshot: i('screenshot') || 'cloudfone-screenshot.png',
    baseUrl: i('base-url'),
  };
  if (!inputs.token) throw new Error('input "token" is required (a cloudf.one access token)');
  for (const k of ['waitTimeout', 'lockMinutes', 'launchWait']) {
    if (!Number.isFinite(inputs[k]) || inputs[k] < 0) throw new Error(`invalid number for ${k}`);
  }
  inputs.mode = inputs.wireguardConfig ? 'adb' : 'reserve';
  if (inputs.mode === 'adb' && !inputs.adbHost) {
    throw new Error('"adb-host" is required with "wireguard-config" (the tunnel address)');
  }
  if (inputs.mode === 'reserve' && (inputs.apk || inputs.package || inputs.testCommand)) {
    throw new Error('"apk", "package" and "test-command" need adb, which needs the ' +
      'WireGuard tunnel: set "wireguard-config" and "adb-host". The cloudf.one REST API ' +
      'cannot install apps or take screenshots on its own.');
  }
  return inputs;
}

// STF's `operator` is whatever the SIM reports, e.g. "Singtel" or "M1". Match loosely.
function carrierMatches(device, wanted) {
  if (!wanted) return true;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return norm(device.operator).includes(norm(wanted));
}

function appendFile(file, name, value) {
  if (!file) return;
  const v = String(value);
  if (v.includes('\n')) {
    const delim = `ghadelim_${Math.random().toString(36).slice(2)}`;
    fs.appendFileSync(file, `${name}<<${delim}${os.EOL}${v}${os.EOL}${delim}${os.EOL}`);
  } else {
    fs.appendFileSync(file, `${name}=${v}${os.EOL}`);
  }
}

const setOutput = (n, v, env = process.env) => appendFile(env.GITHUB_OUTPUT, n, v);
const saveState = (n, v, env = process.env) => appendFile(env.GITHUB_STATE, n, v);
const getState = (n, env = process.env) => env[`STATE_${n}`] || '';

// Runs a command, streams nothing, returns {status, stdout, stderr}. Never throws.
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    status: r.error ? 127 : r.status,
    stdout: r.stdout || '',
    stderr: (r.stderr || '') + (r.error ? String(r.error) : ''),
  };
}

function mustRun(cmd, args, opts = {}, runner = run) {
  const r = runner(cmd, args, opts);
  if (r.status !== 0) {
    const shown = [cmd, ...args].join(' ');
    throw new Error(`${shown} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim()}`);
  }
  return r;
}

function venvBin(venv, name) {
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', `${name}.exe`)
    : path.join(venv, 'bin', name);
}

function cliEnv(inputs, env = process.env) {
  const e = { ...env, CLOUDFONE_TOKEN: inputs.token };
  if (inputs.baseUrl) e.CLOUDFONE_BASE_URL = inputs.baseUrl;
  return e;
}

module.exports = {
  input, parseInputs, carrierMatches, setOutput, saveState, getState,
  run, mustRun, venvBin, cliEnv,
};
