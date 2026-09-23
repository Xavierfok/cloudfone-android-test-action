'use strict';

// Runs after the job (post-if: always()), including when main failed part-way.
// Best effort: it only undoes what main.js recorded, and never fails the job.
const L = require('./lib');

function post({ env = process.env, runner = L.run } = {}) {
  const done = [];
  const token = L.input('token', env);
  const keepLock = L.input('keep-lock', env) === 'true';
  const venv = L.getState('venv', env);
  const serial = L.getState('serial', env);
  const target = L.getState('adb', env);
  const wg = L.getState('wg', env);
  const cli = venv ? L.venvBin(venv, 'cloudfone') : '';
  const cenv = { ...env, CLOUDFONE_TOKEN: token };
  const baseUrl = L.input('base-url', env);
  if (baseUrl) cenv.CLOUDFONE_BASE_URL = baseUrl;

  const step = (label, cmd, args, opts) => {
    const r = runner(cmd, args, opts);
    if (r.status === 0) done.push(label);
    else console.log(`::warning::cleanup: ${label} failed: ${(r.stderr || r.stdout).trim()}`);
    return r.status === 0;
  };
  const adb = L.getState('adbBin', env) || 'adb';

  if (target) step('adb disconnect', adb, ['disconnect', target], { env });
  let released = false;
  if (cli && serial && target) {
    const args = ['adb-disconnect', serial];
    if (keepLock) args.push('--keep-lock');
    released = step('close adb port', cli, args, { env: cenv });
  }
  if (cli && serial && !keepLock && !released) {
    step('release lock', cli, ['unlock', serial], { env: cenv });
  }
  if (wg) step('tunnel down', 'sudo', ['wg-quick', 'down', wg], { env });
  return done;
}

module.exports = { post };

if (require.main === module) {
  try {
    const done = post();
    if (done.length) console.log(`cleanup: ${done.join(', ')}`);
  } catch (err) {
    console.log(`::warning::cleanup error: ${err.message}`);
  }
}
