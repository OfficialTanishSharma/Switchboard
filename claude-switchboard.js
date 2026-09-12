#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function discoverClaude() {
  const home = os.homedir();
  const directCandidates = process.platform === 'win32'
    ? [
        path.join(home, '.local', 'bin', 'claude.exe'),
        path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
        path.join(home, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe')
      ]
    : [
        path.join(home, '.local', 'bin', 'claude'),
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude'
      ];

  const direct = directCandidates.find(candidate => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
  if (direct) return direct;

  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  for (const name of process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude']) {
    const result = spawnSync(locator, [name], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0) {
      const found = String(result.stdout || '').split(/\r?\n/).map(value => value.trim()).find(Boolean);
      if (found) return found;
    }
  }
  return null;
}

const executable = discoverClaude();
if (!executable) {
  console.error('[Switchboard] Claude Code CLI was not found.');
  console.error('Checked PATH and the native installer location: ' + path.join(os.homedir(), '.local', 'bin'));
  process.exit(1);
}

const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:3141',
  ANTHROPIC_API_KEY: 'sk-ant-dummy'
};
delete env.ANTHROPIC_AUTH_TOKEN;

const child = spawn(executable, process.argv.slice(2), {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32' && /\.cmd$/i.test(executable),
  windowsHide: false
});

child.on('error', error => {
  console.error('[Switchboard] Unable to launch Claude Code from: ' + executable);
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) console.error('[Switchboard] Claude Code ended with signal ' + signal);
  process.exitCode = Number.isInteger(code) ? code : 1;
});
