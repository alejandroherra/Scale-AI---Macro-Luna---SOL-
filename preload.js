const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  ipcRenderer.on(channel, (_, data) => callback(data));
}

contextBridge.exposeInMainWorld('api', {
  onRecordingStatus: (callback) => subscribe('recording-status', callback),
  onPlaybackStatus: (callback) => subscribe('playback-status', callback),
  onMacroRecorded: (callback) => subscribe('macro-recorded', callback),
  onError: (callback) => subscribe('operation-error', callback),
  onCallPauseHotkey: (callback) => subscribe('call-pause-hotkey', callback),
  onVoiceRecognitionStart: (callback) => subscribe('voice-recognition-start', callback),
  onVoiceRecognitionEvent: (callback) => subscribe('voice-recognition-event', callback),
  onVoiceRecognitionWorkerEvent: (callback) => subscribe('voice-recognition-worker-event', callback),

  startRecording: () => ipcRenderer.send('start-recording'),
  stopRecording: () => ipcRenderer.send('stop-recording'),
  startPlayback: (count) => ipcRenderer.send('start-playback', count),
  setRepeatCount: (count) => ipcRenderer.send('set-repeat-count', count),
  stopPlayback: () => ipcRenderer.send('stop-playback'),
  clearMacro: () => ipcRenderer.send('clear-macro'),
  saveMacro: () => ipcRenderer.send('save-macro'),
  loadMacro: () => ipcRenderer.send('load-macro'),
  clickAtCoordinates: (x, y) => ipcRenderer.invoke('click-at-coordinates', x, y),
  requestMicrophoneAccess: () => ipcRenderer.invoke('request-microphone-access'),
  startVoiceRecognition: (deviceId) => ipcRenderer.invoke('start-voice-recognition', deviceId),
  stopVoiceRecognition: () => ipcRenderer.send('stop-voice-recognition'),
  sendVoiceRecognitionEvent: (data) => ipcRenderer.send('voice-recognition-event', data),
  sendVoiceAudioChunk: (samples) => ipcRenderer.send('voice-recognition-audio', samples),
  logDiagnostic: (stage, details) => ipcRenderer.sendSync('renderer-diagnostic', stage, details),
  setCallAutomationActive: (active) => ipcRenderer.send('set-call-automation-active', active),
  selectCallLocation: () => ipcRenderer.invoke('select-call-location'),
  setCallPauseHotkey: (accelerator) => ipcRenderer.send('set-call-pause-hotkey', accelerator),

  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close')
});
