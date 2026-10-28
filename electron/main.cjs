const { app, BrowserWindow, net, protocol, shell } = require('electron');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_SCHEME = 'myyoutube';
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

app.setName('MyYoutubeRecord');

const appRoot = path.resolve(__dirname, '..');
let backendPort;
let backendProcess;
let shuttingDown = false;

const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) app.quit();

function startBackend() {
  const backendPath = path.join(process.resourcesPath, 'backend', 'server.cjs');
  const userDataPath = app.getPath('userData');
  fs.mkdirSync(userDataPath, { recursive: true });

  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      PORT: '0',
      APP_CONFIG_DIR: userDataPath,
      CLIENT_DIST_DIR: path.join(process.resourcesPath, 'dist'),
      DOTENV_CONFIG_PATH: path.join(userDataPath, '.env'),
    };
    backendProcess = fork(backendPath, [], {
      cwd: userDataPath,
      env,
      execPath: process.execPath,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    let settled = false;
    const timeout = setTimeout(() => finish(new Error('The local API server did not start within 20 seconds.')), 20_000);
    const finish = (error, port) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(port);
    };

    backendProcess.stdout.on('data', (chunk) => console.log(`[backend] ${chunk.toString().trimEnd()}`));
    backendProcess.stderr.on('data', (chunk) => console.error(`[backend] ${chunk.toString().trimEnd()}`));
    backendProcess.on('message', (message) => {
      if (message && message.type === 'server-ready' && Number.isInteger(message.port)) finish(null, message.port);
    });
    backendProcess.once('error', (error) => finish(error));
    backendProcess.once('exit', (code) => {
      if (!shuttingDown) finish(new Error(`The local API server exited during startup (code ${code}).`));
      if (!shuttingDown && app.isReady()) app.quit();
    });
  });
}

function registerAppProtocol() {
  const frontendDir = app.isPackaged
    ? path.join(app.getAppPath(), 'dist')
    : path.join(appRoot, 'dist');

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });

    if (url.pathname.startsWith('/api/')) {
      if (!backendPort || !['GET', 'HEAD', 'POST'].includes(request.method)) {
        return new Response('Not found', { status: 404 });
      }
      try {
        const headers = {};
        const contentType = request.headers.get('content-type');
        if (contentType) headers['content-type'] = contentType;
        const body = request.method === 'POST' ? Buffer.from(await request.arrayBuffer()) : undefined;
        return await fetch(`http://127.0.0.1:${backendPort}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          ...(body ? { body } : {}),
        });
      } catch {
        return Response.json({ error: 'The local API server is unavailable. Restart MyYoutubeRecord and try again.' }, { status: 502 });
      }
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const filePath = path.resolve(frontendDir, `.${decodedPath}`);
    const relativePath = path.relative(frontendDir, filePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return new Response('Forbidden', { status: 403 });

    try {
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch {
      if (path.extname(filePath)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(path.join(frontendDir, 'index.html')).toString());
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'MyYoutubeRecord',
    autoHideMenuBar: true,
    menuBarVisible: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (app.isPackaged) {
    void win.loadURL(`${APP_SCHEME}://app/index.html`);
  } else {
    void win.loadURL('http://localhost:5173');
  }
}

if (hasSingleInstance) {
  app.whenReady().then(async () => {
    try {
      if (app.isPackaged) {
        backendPort = await startBackend();
        delete process.env.YOUTUBE_API_KEY;
        registerAppProtocol();
      }
      createWindow();
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const { dialog } = require('electron');
      dialog.showErrorBox('MyYoutubeRecord could not start', `${message}\n\nCheck the app settings in ${app.getPath('userData')}.`);
      app.quit();
    }
  });

  app.on('before-quit', () => {
    shuttingDown = true;
    if (backendProcess && backendProcess.connected) {
      backendProcess.send({ type: 'shutdown' });
      const forceStop = setTimeout(() => backendProcess?.kill(), 2500);
      forceStop.unref();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
