const { app, BrowserWindow, globalShortcut, ipcMain, dialog, session, screen, utilityProcess } = require('electron');
const http = require('http');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const tar = require('tar');
const { mouse, keyboard, Key, Button } = require('@nut-tree-fork/nut-js');
const { uIOhook, UiohookKey, WheelDirection } = require('uiohook-napi');

let mainWindow = null;
let voiceWindow = null;
let voiceProcess = null;
let voiceWorkerReady = false;
let pendingVoiceStart = null;
let isRecording = false;
let isPlaying = false;
let isCallAutomationActive = false;
let recordedEvents = [];
let configuredRepeatCount = 1;
let recordStartTime = 0;
let playbackStopRequested = false;
let lastMousePosition = null;
let lastMouseEventTime = 0;
let lastStatusUpdate = 0;
let recordingHandlers = null;
let callLocationSelection = null;
let callPauseAccelerator = 'F9';
let appServer = null;
let appUrl = null;
let microphonePermissionGranted = false;
let rendererCrashDialogOpen = false;
const openDevToolsAtStartup = process.argv.includes('--devtools');

mouse.config.mouseSpeed = 1000;
mouse.config.autoDelayMs = 0;
keyboard.config.autoDelayMs = 10;

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function notifyError(error) {
  console.error(error);
  logRuntimeEvent('Application error', error.stack || error.message || String(error));
  send('operation-error', { message: error.message || String(error) });
}

function logRuntimeEvent(event, details = '') {
  const logPath = app.isPackaged
    ? path.join(app.getPath('userData'), 'error.log')
    : path.join(__dirname, 'error.log');
  const entry = `[${new Date().toISOString()}] ${event}${details ? `: ${details}` : ''}\n`;
  try {
    fsSync.appendFileSync(logPath, entry, 'utf8');
  } catch (error) {
    console.error(`Could not write runtime log at ${logPath}:`, error);
  }
}

async function requestMicrophoneAccess() {
  if (microphonePermissionGranted) return true;

  const options = {
    type: 'question',
    title: 'Permitir acceso al headset',
    message: 'Macro Panel necesita acceso al micrófono para escuchar las frases durante las llamadas.',
    detail: 'El audio se procesa localmente en este equipo.',
    buttons: ['Permitir micrófono', 'Ahora no'],
    defaultId: 0,
    cancelId: 1
  };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  const { response } = result;
  microphonePermissionGranted = response === 0;
  return microphonePermissionGranted;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 900,
    minHeight: 700,
    resizable: true,
    alwaysOnTop: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      permission === 'media'
      && details?.mediaTypes?.includes('audio')
      && microphonePermissionGranted
      && (webContents === mainWindow?.webContents || webContents === voiceWindow?.webContents)
    );
  });

  mainWindow.webContents.on('console-message', (_, level, message, line, sourceId) => {
    logRuntimeEvent(`Renderer console ${['verbose', 'info', 'warning', 'error'][level] || level}`,
      `${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      event.preventDefault();
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    } else if (input.control && input.shift && input.key.toLowerCase() === 'v'
      && voiceWindow && !voiceWindow.isDestroyed()) {
      event.preventDefault();
      voiceWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });
  mainWindow.webContents.on('did-finish-load', () => {
    if (openDevToolsAtStartup) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });
  mainWindow.webContents.on('did-fail-load', (_, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) {
      logRuntimeEvent('Renderer failed to load', `${errorCode} ${errorDescription} (${validatedURL})`);
    }
  });
  mainWindow.webContents.on('unresponsive', () => {
    logRuntimeEvent('Renderer became unresponsive');
  });
  mainWindow.webContents.on('render-process-gone', (_, details) => {
    isCallAutomationActive = false;
    logRuntimeEvent('Renderer process exited', `reason=${details.reason}, exitCode=${details.exitCode}`);
    if (rendererCrashDialogOpen) return;

    rendererCrashDialogOpen = true;
    void dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Se detuvo la interfaz de Macro Panel',
      message: 'La pantalla de la aplicación se cerró inesperadamente.',
      detail: `Motivo: ${details.reason}. El diagnóstico quedó guardado en ${app.isPackaged ? app.getPath('userData') : __dirname}\\error.log`,
      buttons: ['Reiniciar pantalla', 'Cerrar aplicación'],
      defaultId: 0,
      cancelId: 1
    }).then(({ response }) => {
      rendererCrashDialogOpen = false;
      if (response === 0 && mainWindow && !mainWindow.isDestroyed()) {
        void mainWindow.loadURL(`${appUrl}/`).catch(notifyError);
      } else if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.close();
      }
    }).catch((error) => {
      rendererCrashDialogOpen = false;
      logRuntimeEvent('Could not show renderer crash dialog', error.message || String(error));
    });
  });

  mainWindow.loadURL(`${appUrl}/`);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('request-microphone-access', () => requestMicrophoneAccess());
ipcMain.on('renderer-diagnostic', (event, stage, details) => {
  const safeStage = typeof stage === 'string' ? stage.slice(0, 100) : 'Unknown stage';
  const safeDetails = typeof details === 'string' ? details.slice(0, 500) : '';
  logRuntimeEvent('Call startup diagnostic', `${safeStage}${safeDetails ? ` — ${safeDetails}` : ''}`);
  event.returnValue = true;
});

function settleVoiceStart(error) {
  if (!pendingVoiceStart) return;

  const { resolve, reject, timeout } = pendingVoiceStart;
  pendingVoiceStart = null;
  clearTimeout(timeout);
  if (error) reject(error);
  else resolve(true);
}

function sendVoiceEvent(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('voice-recognition-event', data);
  }
}

function sendVoiceWorkerEvent(data) {
  if (voiceWindow && !voiceWindow.isDestroyed()) {
    voiceWindow.webContents.send('voice-recognition-worker-event', data);
  }
}

async function prepareSpeechModel() {
  const archivePath = app.isPackaged
    ? path.join(process.resourcesPath, 'speech-model.tar.gz')
    : path.join(__dirname, 'resources', 'speech-model.tar.gz');
  const modelRoot = path.join(app.getPath('userData'), 'speech-model');
  const modelPath = path.join(modelRoot, 'model');
  const requiredFiles = [
    path.join(modelPath, 'am', 'final.mdl'),
    path.join(modelPath, 'conf', 'model.conf'),
    path.join(modelPath, 'graph', 'HCLr.fst'),
    path.join(modelPath, 'graph', 'Gr.fst')
  ];

  try {
    await Promise.all(requiredFiles.map((filePath) => fs.access(filePath)));
    return modelPath;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await fs.access(archivePath);
  await fs.mkdir(modelRoot, { recursive: true });
  await tar.x({ file: archivePath, cwd: modelRoot });
  await Promise.all(requiredFiles.map((filePath) => fs.access(filePath)));
  return modelPath;
}

function stopVoiceWorker() {
  const currentVoiceProcess = voiceProcess;
  voiceProcess = null;
  voiceWorkerReady = false;
  if (!currentVoiceProcess) return;
  try {
    currentVoiceProcess.postMessage({ type: 'stop' });
  } catch (error) {
    logRuntimeEvent('Could not stop native voice worker gracefully', error.message || String(error));
    currentVoiceProcess.kill();
  }
}

function startVoiceWorker(modelPath) {
  return new Promise((resolve, reject) => {
    const currentVoiceProcess = utilityProcess.fork(
      path.join(__dirname, 'voice-worker.js'),
      [],
      { serviceName: 'Macro Panel local speech recognition', stdio: 'pipe' }
    );
    let settled = false;
    let workerReportedError = false;
    const timeout = setTimeout(() => {
      finish(new Error('El motor local de voz tardó demasiado en cargar el modelo.'));
      if (voiceProcess === currentVoiceProcess) stopVoiceWorker();
    }, 120000);
    voiceProcess = currentVoiceProcess;
    voiceWorkerReady = false;

    currentVoiceProcess.stderr?.on('data', (chunk) => {
      const details = String(chunk).trim();
      if (details) {
        logRuntimeEvent('Native voice worker stderr', details.slice(0, 1000));
      }
    });

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    }

    currentVoiceProcess.on('spawn', () => {
      if (voiceProcess !== currentVoiceProcess) return;
      try {
        currentVoiceProcess.postMessage({ type: 'initialize', modelPath });
      } catch (error) {
        finish(error);
        stopVoiceWorker();
      }
    });
    currentVoiceProcess.on('message', (message) => {
      if (voiceProcess !== currentVoiceProcess) return;
      if (!message || typeof message !== 'object') return;

      if (message.type === 'ready') {
        voiceWorkerReady = true;
        finish();
        sendVoiceWorkerEvent({ type: 'ready' });
      } else if (message.type === 'error') {
        workerReportedError = true;
        const wasReady = voiceWorkerReady;
        voiceWorkerReady = false;
        const safeMessage = typeof message.message === 'string'
          ? message.message.slice(0, 500)
          : 'Falló el motor nativo local de voz.';
        logRuntimeEvent('Native voice worker error', safeMessage);
        finish(new Error(safeMessage));
        if (wasReady) sendVoiceWorkerEvent({ type: 'error', message: safeMessage });
        stopVoiceWorker();
      } else if (message.type === 'partial' || message.type === 'result') {
        sendVoiceWorkerEvent({
          type: message.type,
          text: typeof message.text === 'string' ? message.text.slice(0, 500) : ''
        });
      }
    });
    currentVoiceProcess.on('exit', (code, signal) => {
      if (voiceProcess !== currentVoiceProcess) return;
      voiceProcess = null;
      voiceWorkerReady = false;
      const errorMessage = `El proceso nativo de voz se cerró inesperadamente (código ${code}, señal ${signal || 'ninguna'}).`;
      logRuntimeEvent('Native voice worker exited', `exitCode=${code}; signal=${signal || 'none'}`);
      finish(new Error(errorMessage));
      if (!workerReportedError) sendVoiceWorkerEvent({ type: 'error', message: errorMessage });
    });
    currentVoiceProcess.on('error', (error) => {
      if (voiceProcess !== currentVoiceProcess) return;
      voiceProcess = null;
      voiceWorkerReady = false;
      logRuntimeEvent('Native voice worker process error', error.stack || error.message || String(error));
      finish(error);
      if (!workerReportedError) {
        sendVoiceWorkerEvent({ type: 'error', message: error.message || String(error) });
      }
    });
  });
}

ipcMain.handle('start-voice-recognition', async (_, deviceId) => {
  if (typeof deviceId !== 'string' || !deviceId) {
    throw new Error('No se recibió un dispositivo de audio válido.');
  }

  if (voiceWindow && !voiceWindow.isDestroyed()) voiceWindow.destroy();
  stopVoiceWorker();

  const modelPath = await prepareSpeechModel();
  await startVoiceWorker(modelPath);

  voiceWindow = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  const currentVoiceWindow = voiceWindow;
  currentVoiceWindow.webContents.on('console-message', (_, level, message, line, sourceId) => {
    logRuntimeEvent(`Voice renderer console ${['verbose', 'info', 'warning', 'error'][level] || level}`,
      `${message} (${sourceId}:${line})`);
  });
  currentVoiceWindow.webContents.on('render-process-gone', (_, details) => {
    if (voiceWindow !== currentVoiceWindow) return;
    logRuntimeEvent('Voice renderer process exited', `reason=${details.reason}, exitCode=${details.exitCode}`);
    if (pendingVoiceStart?.window === currentVoiceWindow) {
      settleVoiceStart(new Error(`Se cerró el proceso de reconocimiento de voz (${details.reason}).`));
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('voice-recognition-event', {
        type: 'error',
        message: `Falló el proceso aislado de voz (${details.reason}). La interfaz principal sigue activa.`
      });
    }
  });
  currentVoiceWindow.on('closed', () => {
    if (voiceWindow === currentVoiceWindow) voiceWindow = null;
    if (pendingVoiceStart?.window === currentVoiceWindow) {
      settleVoiceStart(new Error('Se cerró el proceso de reconocimiento de voz.'));
    }
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      settleVoiceStart(new Error('El reconocedor de voz tardó demasiado en iniciar.'));
    }, 120000);
    pendingVoiceStart = { window: currentVoiceWindow, resolve, reject, timeout };
    currentVoiceWindow.webContents.once('did-finish-load', () => {
      if (!currentVoiceWindow.isDestroyed()) {
        if (voiceWorkerReady) {
          currentVoiceWindow.webContents.send('voice-recognition-worker-event', { type: 'ready' });
        }
        currentVoiceWindow.webContents.send('voice-recognition-start', deviceId);
      }
    });
    currentVoiceWindow.loadURL(`${appUrl}/recognizer.html`).catch((error) => {
      logRuntimeEvent('Could not load voice recognition window', error.stack || error.message || String(error));
      settleVoiceStart(error);
    });
  });
});

ipcMain.on('voice-recognition-event', (event, data) => {
  if (!voiceWindow || event.sender !== voiceWindow.webContents || !data || typeof data !== 'object') return;

  const safeData = {
    type: typeof data.type === 'string' ? data.type.slice(0, 30) : 'unknown',
    message: typeof data.message === 'string' ? data.message.slice(0, 500) : '',
    label: typeof data.label === 'string' ? data.label.slice(0, 200) : '',
    text: typeof data.text === 'string' ? data.text.slice(0, 500) : '',
    sampleRate: Number.isFinite(data.sampleRate) ? data.sampleRate : undefined
  };
  logRuntimeEvent('Voice recognition event', `${safeData.type}${safeData.message ? ` — ${safeData.message}` : ''}`);
  if (safeData.type === 'ready' && pendingVoiceStart?.window === voiceWindow) {
    settleVoiceStart();
  } else if (safeData.type === 'error' && pendingVoiceStart?.window === voiceWindow) {
    settleVoiceStart(new Error(safeData.message || 'No se pudo iniciar el reconocedor de voz.'));
  }
  sendVoiceEvent(safeData);
});

ipcMain.on('voice-recognition-audio', (event, samples) => {
  if (!voiceWindow || event.sender !== voiceWindow.webContents || !voiceWorkerReady || !voiceProcess) return;
  if (!(samples instanceof Int16Array) || samples.length === 0 || samples.length > 4096) {
    logRuntimeEvent('Invalid voice audio payload', 'Expected up to 4096 mono PCM samples.');
    return;
  }
  voiceProcess.postMessage({ type: 'audio', samples });
});

ipcMain.on('stop-voice-recognition', (event) => {
  if (!voiceWindow || event.sender !== mainWindow?.webContents) return;
  settleVoiceStart(new Error('Se detuvo el reconocimiento de voz.'));
  voiceWindow.close();
  stopVoiceWorker();
});

async function startAppServer() {
  const modelPath = app.isPackaged
    ? path.join(process.resourcesPath, 'speech-model.tar.gz')
    : path.join(__dirname, 'resources', 'speech-model.tar.gz');
  await fs.access(modelPath);

  const staticFiles = new Map([
    ['/', path.join(__dirname, 'index.html')],
    ['/index.html', path.join(__dirname, 'index.html')],
    ['/recognizer.html', path.join(__dirname, 'recognizer.html')]
  ]);
  appServer = http.createServer((request, response) => {
    let pathname;
    try {
      pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    } catch (error) {
      response.writeHead(400).end('Invalid request URL');
      return;
    }

    const filePath = staticFiles.get(pathname);
    if (!filePath) {
      response.writeHead(404).end('Not found');
      return;
    }

    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Type', pathname.endsWith('.js')
      ? 'application/javascript; charset=utf-8'
      : pathname.endsWith('.gz')
        ? 'application/gzip'
        : 'text/html; charset=utf-8');
    const stream = fsSync.createReadStream(filePath);
    stream.on('error', (error) => {
      console.error(`Could not serve ${pathname}:`, error);
      if (!response.headersSent) response.writeHead(500);
      response.end('Could not load application resource');
    });
    stream.pipe(response);
  });

  await new Promise((resolve, reject) => {
    appServer.once('error', reject);
    appServer.listen(0, '127.0.0.1', () => {
      appServer.removeListener('error', reject);
      const address = appServer.address();
      if (!address || typeof address === 'string') {
        reject(new Error('No se pudo iniciar el servidor local de la aplicación.'));
        return;
      }
      appUrl = `http://127.0.0.1:${address.port}`;
      console.log(`Macro Panel local server listening at ${appUrl}`);
      resolve();
    });
  });
}

function registerShortcuts() {
  globalShortcut.register('F5', () => {
    if (!isRecording && !isPlaying && !isCallAutomationActive && !callLocationSelection) startRecording();
  });
  globalShortcut.register('F6', () => {
    if (isRecording) stopRecording();
  });
  globalShortcut.register('F7', () => {
    if (!isRecording && !isPlaying && !isCallAutomationActive && !callLocationSelection && recordedEvents.length > 0) {
      startPlayback(configuredRepeatCount);
    }
  });
  globalShortcut.register('F8', () => {
    if (isPlaying) stopPlayback();
  });
  registerCallPauseShortcut(callPauseAccelerator);
}

function registerCallPauseShortcut(accelerator) {
  if (callPauseAccelerator) globalShortcut.unregister(callPauseAccelerator);
  callPauseAccelerator = accelerator;
  if (!globalShortcut.register(accelerator, () => send('call-pause-hotkey'))) {
    notifyError(new Error(`No se pudo registrar el atajo ${accelerator}.`));
  }
}

function sendRecordingStatus(force = false) {
  const now = Date.now();
  if (!force && now - lastStatusUpdate < 100) return;

  lastStatusUpdate = now;
  send('recording-status', {
    recording: isRecording,
    eventCount: recordedEvents.length
  });
}

function recordEvent(event) {
  if (!isRecording) return;

  recordedEvents.push({
    ...event,
    time: Math.max(0, Date.now() - recordStartTime)
  });
  sendRecordingStatus();
}

function stopInputHook() {
  if (!recordingHandlers) return;

  uIOhook.removeListener('mousemove', recordingHandlers.mousemove);
  uIOhook.removeListener('mousedown', recordingHandlers.mousedown);
  uIOhook.removeListener('mouseup', recordingHandlers.mouseup);
  uIOhook.removeListener('wheel', recordingHandlers.wheel);
  uIOhook.removeListener('keydown', recordingHandlers.keydown);
  uIOhook.removeListener('keyup', recordingHandlers.keyup);
  recordingHandlers = null;
  uIOhook.stop();
}

function startRecording() {
  if (isRecording || isPlaying || isCallAutomationActive || callLocationSelection) return;

  recordedEvents = [];
  recordStartTime = Date.now();
  lastMousePosition = null;
  lastMouseEventTime = 0;
  isRecording = true;

  recordingHandlers = {
    mousemove: (event) => {
      const now = Date.now();
      const movedEnough = !lastMousePosition
        || Math.abs(event.x - lastMousePosition.x) >= 3
        || Math.abs(event.y - lastMousePosition.y) >= 3;
      if (!movedEnough && now - lastMouseEventTime < 40) return;

      lastMousePosition = { x: event.x, y: event.y };
      lastMouseEventTime = now;
      recordEvent({ type: 'mousemove', x: event.x, y: event.y });
    },
    mousedown: (event) => {
      const button = event.button === 1 ? 'left' : event.button === 2 ? 'right' : 'middle';
      lastMousePosition = { x: event.x, y: event.y };
      recordEvent({ type: 'mousedown', x: event.x, y: event.y, button });
    },
    mouseup: (event) => {
      const button = event.button === 1 ? 'left' : event.button === 2 ? 'right' : 'middle';
      lastMousePosition = { x: event.x, y: event.y };
      recordEvent({ type: 'mouseup', x: event.x, y: event.y, button });
    },
    wheel: (event) => {
      recordEvent({
        type: 'wheel',
        x: event.x,
        y: event.y,
        direction: event.direction,
        rotation: event.rotation,
        steps: Math.max(1, Math.abs(event.clicks || event.amount || 1))
      });
    },
    keydown: (event) => {
      if ([UiohookKey.F5, UiohookKey.F6, UiohookKey.F7, UiohookKey.F8].includes(event.keycode)) return;
      recordEvent({ type: 'keydown', keycode: event.keycode });
    },
    keyup: (event) => {
      if ([UiohookKey.F5, UiohookKey.F6, UiohookKey.F7, UiohookKey.F8].includes(event.keycode)) return;
      recordEvent({ type: 'keyup', keycode: event.keycode });
    }
  };

  uIOhook.on('mousemove', recordingHandlers.mousemove);
  uIOhook.on('mousedown', recordingHandlers.mousedown);
  uIOhook.on('mouseup', recordingHandlers.mouseup);
  uIOhook.on('wheel', recordingHandlers.wheel);
  uIOhook.on('keydown', recordingHandlers.keydown);
  uIOhook.on('keyup', recordingHandlers.keyup);

  try {
    uIOhook.start();
    sendRecordingStatus(true);
  } catch (error) {
    isRecording = false;
    try {
      stopInputHook();
    } catch (cleanupError) {
      console.error('Could not stop the input hook after startup failed:', cleanupError);
    }
    notifyError(error);
    sendRecordingStatus(true);
  }
}

function stopRecording() {
  if (!isRecording) return;

  isRecording = false;
  try {
    stopInputHook();
  } catch (error) {
    notifyError(error);
  }
  sendRecordingStatus(true);
  send('macro-recorded', { events: recordedEvents });
}

function waitForPlayback(delay) {
  return new Promise((resolve) => {
    const endTime = Date.now() + delay;
    const check = () => {
      if (playbackStopRequested || Date.now() >= endTime) {
        resolve();
      } else {
        setTimeout(check, Math.min(25, endTime - Date.now()));
      }
    };
    check();
  });
}

async function startPlayback(repeatCount) {
  if (isRecording || isPlaying || isCallAutomationActive || callLocationSelection || recordedEvents.length === 0) return;

  const repetitions = Number.parseInt(repeatCount, 10);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 9999) {
    notifyError(new Error('El número de repeticiones debe estar entre 1 y 9999.'));
    return;
  }

  isPlaying = true;
  playbackStopRequested = false;

  try {
    for (let i = 0; i < repetitions; i++) {
      if (playbackStopRequested || !mainWindow || mainWindow.isDestroyed()) break;
      send('playback-status', { playing: true, current: i + 1, total: repetitions });
      await playEvents(recordedEvents);
      if (!playbackStopRequested && i + 1 < repetitions) await waitForPlayback(100);
    }
  } catch (error) {
    notifyError(error);
  } finally {
    isPlaying = false;
    send('playback-status', { playing: false, current: 0, total: repetitions });
  }
}

function stopPlayback() {
  playbackStopRequested = true;
}

function mouseButton(button) {
  switch (button) {
    case 'right': return Button.RIGHT;
    case 'middle': return Button.MIDDLE;
    default: return Button.LEFT;
  }
}

async function playEvents(events) {
  let lastTime = 0;
  const pressedButtons = new Map();
  const pressedKeys = new Set();

  try {
    for (const event of events) {
      if (playbackStopRequested) break;

      const eventTime = Number.isFinite(event.time) ? Math.max(lastTime, event.time) : lastTime;
      await waitForPlayback(eventTime - lastTime);
      if (playbackStopRequested) break;

      switch (event.type) {
        case 'mousemove':
          await mouse.setPosition({ x: event.x, y: event.y });
          break;
        case 'mousedown':
          await mouse.setPosition({ x: event.x, y: event.y });
          await mouse.pressButton(mouseButton(event.button));
          pressedButtons.set(event.button, mouseButton(event.button));
          break;
        case 'mouseup':
          await mouse.setPosition({ x: event.x, y: event.y });
          await mouse.releaseButton(mouseButton(event.button));
          pressedButtons.delete(event.button);
          break;
        case 'click':
          await mouse.setPosition({ x: event.x, y: event.y });
          await mouse.click(mouseButton(event.button));
          break;
        case 'wheel':
          await mouse.setPosition({ x: event.x, y: event.y });
          if (event.direction === WheelDirection.HORIZONTAL) {
            if (event.rotation > 0) await mouse.scrollRight(event.steps || 1);
            else await mouse.scrollLeft(event.steps || 1);
          } else if (event.rotation > 0) {
            await mouse.scrollUp(event.steps || 1);
          } else {
            await mouse.scrollDown(event.steps || 1);
          }
          break;
        case 'keydown':
        case 'keyup':
          if (Number.isInteger(event.keycode)) {
            uIOhook.keyToggle(event.keycode, event.type === 'keydown' ? 'down' : 'up');
            if (event.type === 'keydown') pressedKeys.add(event.keycode);
            else pressedKeys.delete(event.keycode);
          } else if (event.type === 'keydown' && event.key) {
            const key = Key[event.key] || event.key;
            await keyboard.type(key);
          }
          break;
      }

      lastTime = eventTime;
    }
  } finally {
    for (const button of pressedButtons.values()) {
      await mouse.releaseButton(button);
    }
    for (const keycode of pressedKeys) {
      uIOhook.keyToggle(keycode, 'up');
    }
  }
}

function validateMacro(events) {
  return Array.isArray(events) && events.every((event) => (
    event
    && typeof event === 'object'
    && Number.isFinite(event.time)
    && event.time >= 0
    && ['mousemove', 'click', 'mousedown', 'mouseup', 'wheel', 'keydown', 'keyup'].includes(event.type)
    && (
      (event.type.startsWith('key') && (
        (Number.isInteger(event.keycode) && event.keycode > 0)
        || (event.type === 'keydown' && typeof event.key === 'string')
      ))
      || (!event.type.startsWith('key')
        && Number.isFinite(event.x)
        && Number.isFinite(event.y)
        && (
          !['click', 'mousedown', 'mouseup'].includes(event.type)
          || ['left', 'right', 'middle'].includes(event.button)
        ))
    )
  ));
}

ipcMain.on('start-recording', () => startRecording());
ipcMain.on('stop-recording', () => stopRecording());
ipcMain.on('start-playback', (_, count) => startPlayback(count));
ipcMain.on('stop-playback', () => stopPlayback());
ipcMain.on('set-call-automation-active', (_, active) => {
  isCallAutomationActive = active === true;
});
ipcMain.on('set-call-pause-hotkey', (_, accelerator) => {
  if (!['F9', 'F10', 'F11', 'F12', 'Control+Shift+F9', 'Control+Shift+F10'].includes(accelerator)) {
    notifyError(new Error('El atajo de pausa seleccionado no es válido.'));
    return;
  }
  registerCallPauseShortcut(accelerator);
});
ipcMain.handle('select-call-location', () => {
  if (isRecording || isPlaying || isCallAutomationActive || callLocationSelection) {
    throw new Error('No se puede marcar la zona mientras otra acción está activa.');
  }

  return new Promise((resolve, reject) => {
    const finish = (error, point, restoreWindow = true) => {
      if (!callLocationSelection) return;
      uIOhook.removeListener('mousedown', callLocationSelection.handler);
      uIOhook.removeListener('keydown', callLocationSelection.cancelHandler);
      const { overlay } = callLocationSelection;
      callLocationSelection = null;
      try {
        uIOhook.stop();
      } catch (stopError) {
        console.error('No se pudo detener el detector de clic para marcar la zona:', stopError);
      }
      if (!overlay.isDestroyed()) overlay.destroy();
      if (restoreWindow && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
      if (error) reject(error);
      else resolve(point);
    };

    const handler = (event) => finish(null, { x: event.x, y: event.y });
    const cancelHandler = (event) => {
      if (event.keycode === UiohookKey.Escape) {
        finish(new Error('Se canceló la selección de la zona.'));
      }
    };
    const displays = screen.getAllDisplays();
    const bounds = displays.reduce((combined, display) => ({
      left: Math.min(combined.left, display.bounds.x),
      top: Math.min(combined.top, display.bounds.y),
      right: Math.max(combined.right, display.bounds.x + display.bounds.width),
      bottom: Math.max(combined.bottom, display.bounds.y + display.bounds.height)
    }), {
      left: displays[0].bounds.x,
      top: displays[0].bounds.y,
      right: displays[0].bounds.x + displays[0].bounds.width,
      bottom: displays[0].bounds.y + displays[0].bounds.height
    });
    const overlay = new BrowserWindow({
      x: bounds.left,
      y: bounds.top,
      width: bounds.right - bounds.left,
      height: bounds.bottom - bounds.top,
      frame: false,
      transparent: true,
      backgroundColor: '#26000000',
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    callLocationSelection = { handler, cancelHandler, finish, overlay };
    uIOhook.on('mousedown', handler);
    uIOhook.on('keydown', cancelHandler);
    overlay.on('closed', () => {
      if (callLocationSelection?.overlay === overlay) {
        finish(new Error('Se cerró la selección de la zona.'));
      }
    });

    try {
      uIOhook.start();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
      overlay.setAlwaysOnTop(true, 'screen-saver');
      overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
        <!doctype html>
        <html lang="es">
          <head>
            <meta charset="UTF-8">
            <style>
              html, body { width: 100%; height: 100%; margin: 0; }
              body {
                display: grid;
                place-items: center;
                background: rgba(24, 24, 37, 0.28);
                color: white;
                cursor: crosshair;
                font: 600 24px "Segoe UI", sans-serif;
                text-align: center;
              }
              div { padding: 24px 32px; border-radius: 12px; background: rgba(24, 24, 37, 0.92); }
              p { margin: 10px 0 0; font-size: 16px; font-weight: 400; }
            </style>
          </head>
          <body>
            <div>Haz clic en el botón «Llamar» para marcar la zona.<p>Presiona Escape para cancelar.</p></div>
          </body>
        </html>
      `)}`).then(() => overlay.show()).catch(finish);
    } catch (error) {
      finish(error);
    }
  });
});
ipcMain.handle('click-at-coordinates', async (_, x, y) => {
  if (isRecording || isPlaying) {
    throw new Error('Detén la grabación o reproducción antes de hacer clics automáticos.');
  }

  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new Error('Las coordenadas del clic deben ser números enteros.');
  }

  await mouse.setPosition({ x, y });
  await mouse.click(Button.LEFT);
});
ipcMain.on('set-repeat-count', (_, count) => {
  const repetitions = Number.parseInt(count, 10);
  if (Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 9999) {
    configuredRepeatCount = repetitions;
  }
});

ipcMain.on('clear-macro', () => {
  if (isRecording || isPlaying) return;
  recordedEvents = [];
  send('macro-recorded', { events: [] });
  sendRecordingStatus(true);
});

ipcMain.on('save-macro', async () => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: 'macro.json',
      filters: [{ name: 'JSON Files', extensions: ['json'] }]
    });

    if (!result.canceled && result.filePath) {
      await fs.writeFile(result.filePath, JSON.stringify(recordedEvents, null, 2), 'utf8');
    }
  } catch (error) {
    notifyError(error);
  }
});

ipcMain.on('load-macro', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
      properties: ['openFile']
    });

    if (!result.canceled && result.filePaths[0]) {
      const events = JSON.parse(await fs.readFile(result.filePaths[0], 'utf8'));
      if (!validateMacro(events)) {
        throw new Error('El archivo no contiene una macro válida.');
      }
      recordedEvents = events;
      send('macro-recorded', { events: recordedEvents });
      sendRecordingStatus(true);
    }
  } catch (error) {
    notifyError(error);
  }
});

ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

app.whenReady().then(async () => {
  logRuntimeEvent('Application started');
  await requestMicrophoneAccess();
  await startAppServer();
  createWindow();
  registerShortcuts();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(notifyError);

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (appServer) appServer.close();
  if (voiceWindow && !voiceWindow.isDestroyed()) voiceWindow.destroy();
  stopVoiceWorker();
  if (callLocationSelection) {
    callLocationSelection.finish(new Error('La aplicación se está cerrando.'), undefined, false);
  }
  if (isRecording) {
    isRecording = false;
    try {
      stopInputHook();
    } catch (error) {
      console.error('Could not stop the input hook:', error);
    }
  }
});
