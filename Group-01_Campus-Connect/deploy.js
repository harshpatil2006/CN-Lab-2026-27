#!/usr/bin/env node
'use strict';
// Campus Connect: one-step deploy to Railway.
//   Windows: double-click deploy.cmd        Mac/Linux: node deploy.js
// Safe to run again. It skips anything that already exists, so running it again is also how you redeploy.
//
// What it does: sign in to Railway (browser) -> create project and service -> set variables
// -> attach a volume at /app/data -> create the public domain -> upload and deploy -> check /health.
// It never asks for a password and it never prints your secrets.
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

process.chdir(__dirname);
const PROJECT = 'campus-connect-project';
const SERVICE = 'campus-connect';
const CLI = process.env.RAILWAY_CLI_PACKAGE || '@railway/cli@5.71.0';
const isWin = process.platform === 'win32';
const paint = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const say = (s = '') => console.log(s);
const step = (n, s) => { say(''); say(paint(36, `[${n}/8] ${s}`)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stop(message) {
  say('');
  say(paint(31, `STOPPED: ${message}`));
  process.exit(1);
}

// Runs the Railway CLI. live = show its output as it runs (login, init, build logs).
function rw(args, { live = false } = {}) {
  const r = spawnSync('npx', ['--yes', CLI, ...args], {
    shell: isWin, encoding: 'utf8', stdio: live ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status === null ? 1 : r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const ask = (question) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
});

async function main() {
  say('Campus Connect: deploying to Railway');

  step(1, 'Checking Node.js');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) stop(`Node.js ${process.versions.node} is too old. Install the current LTS version from https://nodejs.org and run this again.`);
  say(`Node.js ${process.versions.node} found.`);

  step(2, 'Signing in to Railway');
  let who = rw(['whoami']);
  if (who.code !== 0) {
    say('A browser window will open. Sign in to Railway there (or create a free account).');
    say('You do not type anything into this window. Come back here when the browser says you are signed in.');
    rw(['login'], { live: true });
    who = rw(['whoami']);
    if (who.code !== 0) stop('Railway sign-in did not finish. Run this again and complete the browser step.');
  }
  say(`Signed in: ${who.out.trim().split('\n')[0].trim()}`);

  step(3, 'Creating the Railway project');
  if (rw(['status']).code !== 0) {
    const init = rw(['init', '--name', PROJECT], { live: true });
    if (init.code !== 0) stop('Could not create the Railway project. Read the message above, fix it, and run this again.');
  } else {
    say('This folder is already linked to a Railway project. Using it.');
  }

  step(4, 'Creating the service');
  // A service "exists" if the project listing names it, or if Railway lets us link to it by name.
  const listed = new RegExp(`"${SERVICE}"`).test(rw(['status', '--json']).out);
  if (listed || rw(['service', 'link', SERVICE]).code === 0) {
    say('Service already exists.');
  } else {
    const add = rw(['add', '--service', SERVICE]);
    if (add.code !== 0) { say(add.out); stop('Could not create the service.'); }
    say('Service created.');
  }
  if (rw(['service', 'link', SERVICE]).code !== 0) say('Note: could not link the service automatically. Continuing with the default.');

  step(5, 'Setting variables (secrets stay private)');
  const basic = rw(['variable', 'set', 'NODE_ENV=production', 'PORT=3000', 'MAX_UPLOAD_MB=20', '--service', SERVICE, '--skip-deploys']);
  if (basic.code !== 0) { say(basic.out); stop('Could not set the basic variables.'); }
  const existing = rw(['variable', 'list', '--service', SERVICE, '--json']);
  if (existing.code !== 0) {
    say('Could not check the existing variables. Skipping SESSION_SECRET (the app then keeps its own secret on the volume).');
  } else if (!existing.out.includes('"SESSION_SECRET"')) {
    const secret = crypto.randomBytes(32).toString('hex');
    const set = rw(['variable', 'set', `SESSION_SECRET=${secret}`, '--service', SERVICE, '--skip-deploys']);
    if (set.code !== 0) stop('Could not set SESSION_SECRET.');
    say('Created a new random SESSION_SECRET (not shown).');
  } else {
    say('SESSION_SECRET already set. Keeping it, so nobody gets signed out.');
  }

  step(6, 'Attaching the persistent volume at /app/data');
  if (!rw(['volume', 'list']).out.includes('/app/data')) {
    const add = rw(['volume', 'add', '--mount-path', '/app/data']);
    if (add.code !== 0 && !rw(['volume', 'list']).out.includes('/app/data')) {
      say(add.out);
      stop('Could not create the volume. Your Railway plan may not allow it. Without a volume, chats and files are lost on every redeploy.');
    }
    say('Volume created.');
  } else {
    say('Volume already attached.');
  }

  step(7, 'Creating the public web address');
  const domainRx = /[a-z0-9-]+\.up\.railway\.app/i;
  let found = domainRx.exec(rw(['domain', 'list', '--service', SERVICE]).out);
  if (!found) {
    const made = rw(['domain', '--service', SERVICE, '--port', '3000']);
    found = domainRx.exec(made.out) || domainRx.exec(rw(['domain', 'list', '--service', SERVICE]).out);
    if (!found) {
      say(made.out);
      stop('Could not read the public address from Railway. Open your project on railway.com, click the campus-connect service, then Settings, then Networking, and press Generate Domain with port 3000. Then run this again.');
    }
  }
  const url = process.env.CC_DEPLOY_URL_OVERRIDE || `https://${found[0]}`; // the override exists only for testing this script
  say(`Address: ${url}`);

  step(8, 'Uploading and deploying (the first build takes 1 to 3 minutes)');
  const up = rw(['up', '--service', SERVICE, '--ci'], { live: true });
  if (up.code !== 0) {
    say('');
    say('The build or upload failed. Last lines of the build log:');
    say(rw(['logs', '--build', '--lines', '40', '--service', SERVICE]).out);
    stop('Deploy failed. Send me the lines above and I will fix it.');
  }

  say('');
  say('Waiting for the site to answer on /health ...');
  let health = null;
  for (let i = 0; i < 60 && !health; i++) {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) health = await r.json();
    } catch (_) { /* not up yet */ }
    if (!health) await sleep(5000);
  }
  if (!health) {
    say('The site did not answer in 5 minutes. Last lines of the deploy log:');
    say(rw(['logs', '--deployment', '--lines', '40', '--service', SERVICE]).out);
    stop('The site is not answering yet. Send me the lines above.');
  }

  fs.writeFileSync(path.join(__dirname, 'LIVE_URL.txt'), `${url}\n`);
  say('');
  say(paint(32, '=================================================='));
  say(paint(32, `  LIVE:  ${url}`));
  say(paint(32, '=================================================='));
  say(`health: ${health.status}, database: ${health.database}, uptime: ${health.uptimeSec}s`);
  if (health.persistentVolume) say('Persistent volume: attached. Chats and files survive redeploys.');
  else say(paint(33, 'WARNING: the persistent volume is NOT attached. Chats and files will be lost on redeploy. Run this again.'));
  say('');
  say('To redeploy after changing code, run deploy.cmd (or node deploy.js) again, or just:');
  say(`  npx ${CLI} up --service ${SERVICE} --ci`);
  say('');

  if (process.env.CC_DEPLOY_NO_PROMPT) return;
  const answer = await ask('Run the full live test now? It makes two small test accounts on your site. (y/N) ');
  if (/^y(es)?$/i.test(answer)) {
    say('Installing test tools (about 30 seconds) ...');
    spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { shell: isWin, stdio: 'inherit' });
    spawnSync(process.execPath, [path.join(__dirname, 'scripts', 'live-check.js'), url], { stdio: 'inherit' });
  }
}

main().catch((e) => stop(e.message));
