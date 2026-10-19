let model = null;
let recognizer = null;
let failed = false;

function sendError(error) {
  if (failed) return;
  failed = true;
  process.parentPort.postMessage({
    type: 'error',
    message: error && error.message ? error.message : String(error)
  });
}

function releaseRecognizer() {
  if (recognizer) {
    recognizer.free();
    recognizer = null;
  }
  if (model) {
    model.free();
    model = null;
  }
}

process.parentPort.on('message', ({ data }) => {
  if (!data || typeof data !== 'object') return;

  if (data.type === 'initialize') {
    try {
      if (typeof data.modelPath !== 'string' || !data.modelPath) {
        throw new Error('No se recibió una ruta válida para el modelo de voz.');
      }
      const vosk = require('vosk');
      vosk.setLogLevel(-1);
      model = new vosk.Model(data.modelPath);
      recognizer = new vosk.Recognizer({ model, sampleRate: 16000 });
      process.parentPort.postMessage({ type: 'ready' });
    } catch (error) {
      releaseRecognizer();
      sendError(error);
    }
  } else if (data.type === 'audio') {
    if (failed) return;
    if (!recognizer || !(data.samples instanceof Int16Array)) {
      sendError(new Error('El proceso de voz recibió audio PCM no válido.'));
      releaseRecognizer();
      return;
    }

    try {
      const buffer = Buffer.from(data.samples.buffer, data.samples.byteOffset, data.samples.byteLength);
      if (recognizer.acceptWaveform(buffer)) {
        const text = recognizer.result().text;
        if (text) process.parentPort.postMessage({ type: 'result', text });
      } else {
        const text = recognizer.partialResult().partial;
        if (text) process.parentPort.postMessage({ type: 'partial', text });
      }
    } catch (error) {
      sendError(error);
      releaseRecognizer();
    }
  } else if (data.type === 'stop') {
    releaseRecognizer();
    process.exit(0);
  }
});
