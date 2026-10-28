const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const isolatedConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'MyYoutubeRecord-fresh-'));
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

console.log(`Using isolated first-launch config: ${isolatedConfigDir}`);
console.log('Project .env is still used for API configuration; the existing Windows profile data is untouched.');

const child = spawn(npmCommand, ['run', 'electron:dev'], {
  cwd: projectRoot,
  env: { ...process.env, APP_CONFIG_DIR: isolatedConfigDir, MY_YOUTUBE_DEV_FRESH_SETUP: '1' },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('error', (error) => {
  console.error('Unable to start the isolated first-launch development app:', error.message);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`The isolated development app exited after signal ${signal}.`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
