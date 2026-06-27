require('ts-node/register/transpile-only');
const fs = require('node:fs');
const { ServePort, VidsDir, OutputDir, UseNativeHls, Checkff, Checkprobe, StartupWarmupSegments } = require('./stream/config.ts');
const { log } = require('./stream/logger.ts');
const { clearLiveSegments, listVideoFiles } = require('./stream/media.ts');
const { startNativeHlsPipeline } = require('./stream/native-hls.ts');
const { startPlayback } = require('./stream/playback.ts');
const { preGenerateFromIndex } = require('./stream/segments.ts');
const { createServer } = require('./stream/http-server.ts');
if (!fs.existsSync(OutputDir)) {
  fs.mkdirSync(OutputDir, { recursive: true });
}
if (!fs.existsSync(VidsDir)) {
  fs.mkdirSync(VidsDir, { recursive: true });
}
const server = createServer();
server.listen(ServePort, () => {
  clearLiveSegments();
  log('info', '[(=|]', {
    videoFiles: listVideoFiles(),
  });
  if (UseNativeHls) {
    startNativeHlsPipeline();
  } else {
    startPlayback();
    if (Checkff && Checkprobe) {
      void preGenerateFromIndex(0, StartupWarmupSegments);
    }
  }
  log('info', 'started');
});
server.on('error', (err) => {
  log('error', 'internal error', { message: err.message, code: err.code });
});
