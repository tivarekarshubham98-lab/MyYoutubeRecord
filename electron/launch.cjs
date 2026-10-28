const { spawn } = require('node:child_process');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const electron = spawn(require('electron'), ['.'], { stdio: 'inherit', env });
electron.on('error', (error) => {
  console.error('Unable to start Electron:', error);
  process.exitCode = 1;
});
electron.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Electron exited after signal ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
