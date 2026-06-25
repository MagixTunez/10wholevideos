const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
let ffmpegStaticPath = '';
let ffprobeStaticPath = '';
try {
  ffmpegStaticPath = require('ffmpeg-static') || '';
} catch {
  ffmpegStaticPath = '';
}
try {
  const ffprobeStatic = require('ffprobe-static');
  ffprobeStaticPath = ffprobeStatic && ffprobeStatic.path ? ffprobeStatic.path : '';
} catch {
  ffprobeStaticPath = '';
}
function loadEnvFile() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
loadEnvFile();
function buildRuntimeEnv() {
  const runtimeEnv = { ...process.env };
  const existingPath = runtimeEnv.Path || runtimeEnv.PATH || '';

  if (process.platform === 'win32') {
    const userProfile = process.env.USERPROFILE || '';
    const wingetLinks = path.join(userProfile, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links');
    const windowsApps = path.join(userProfile, 'AppData', 'Local', 'Microsoft', 'WindowsApps');
    const mergedPath = [existingPath, wingetLinks, windowsApps].filter(Boolean).join(';');
    runtimeEnv.Path = mergedPath;
    runtimeEnv.PATH = mergedPath;
    return runtimeEnv;
  }
  runtimeEnv.PATH = existingPath;
  return runtimeEnv;
}
const RuntimeEnv = buildRuntimeEnv();
const FfmpegCommand = process.env.ffmpegPath || ffmpegStaticPath || 'ffmpeg';
const FfprobeCommand = process.env.ffprobePath || ffprobeStaticPath || 'ffprobe';

function commandAvailable(command) {
  const check = spawnSync(command, ['-version'], { stdio: 'ignore', env: RuntimeEnv });
  return !check.error && check.status === 0;
}
const ServePort = 5181;
const VidsDir = path.join(process.cwd(), 'media');
const OutputDir = path.join(process.cwd(), 'live');
const SegmentDuration = Math.max(1, Number.parseInt(process.env.segmentDuration || '4', 10) || 4);
const PlaylistSegments = 6;
const NativeHlsListSize = Math.max(3, Number.parseInt(process.env.nativeHlsListSize || `${PlaylistSegments + 3}`, 10) || (PlaylistSegments + 3));
const StartupWarmupSegments = 10;
const MinSegmentBytes = 4096;
const UseNativeHls = (process.env.useNativeHls || '1') !== '0';
const EnableProgramDateTime = (process.env.hlsProgramDateTime || '0') === '1';
const EnableNativePlaylistSyncRewrite = (process.env.enableNativePlaylistSyncRewrite || '0') === '1';
const UseMasterPlaylist = true;
const PublicBaseUrl = process.env.basehost?.replace(/\/+$/, '');
const HasFfmpeg = commandAvailable(FfmpegCommand);
const HasFfprobe = commandAvailable(FfprobeCommand);
const SegmentQueueConcurrency = Math.max(1, Number.parseInt(process.env.segmentQueueConcurrency || '2', 10) || 2);
const SyncLiveWindowSegments = Math.max(2, Number.parseInt(process.env.syncLiveWindowSegments || '3', 10) || 3);
const HardSyncStartOffsetSeconds = Math.max(
  0.5,
  Number.parseFloat(process.env.hardSyncStartOffsetSeconds || `${Math.max(1, SegmentDuration * 1.25)}`) || Math.max(1, SegmentDuration * 1.25)
);
let isRunning = false;
const inFlightSegments = new Map();
let cachedTotalDuration = 0;
let cachedVideoTimeline = Array();
const segmentDurationCache = new Map();
const segmentSourceCache = new Map();
let pQueueInstancePromise = null;
const fallbackSegmentQueue = {
  active: 0,
  pending: [],
};
let nativeHlsProcess = null;
let activePlaylistName = '';
let liveHeadSegmentIndex = -1;
let streamPlaylistPollCount = 0;
let lastStreamPlaylistPollLogAt = Date.now();

function log(level, message, ...meta) {
  const stamp = new Date().toISOString();
  const sink = typeof console[level] === 'function' ? console[level] : console.log;
  if (meta.length > 0) {
    sink(`[stream ${stamp}] ${message}`, meta[0]);
    return;
  }

  sink(`[stream ${stamp}] ${message}`);
}
async function getSegmentQueue() {
  if (pQueueInstancePromise) {
    return pQueueInstancePromise;
  }
  pQueueInstancePromise = import('p-queue')
    .then((mod) => {
      const PQueue = mod.default;
      return new PQueue({ concurrency: SegmentQueueConcurrency });
    })
    .catch((err) => {
      log('warn', 'p-queue unavailable, using fallback queue', {
        error: err && typeof err === 'object' ? Reflect.get(err, 'message') : String(err),
      });
      return null;
    });

  return pQueueInstancePromise;
}

function runFallbackQueued(task) {
  return new Promise((resolve, reject) => {
    fallbackSegmentQueue.pending.push({ task, resolve, reject });

    const pump = () => {
      while (
        fallbackSegmentQueue.active < SegmentQueueConcurrency
        && fallbackSegmentQueue.pending.length > 0
      ) {
        const next = fallbackSegmentQueue.pending.shift();
        if (!next) {
          continue;
        }

        fallbackSegmentQueue.active += 1;
        Promise.resolve()
          .then(next.task)
          .then(next.resolve, next.reject)
          .finally(() => {
            fallbackSegmentQueue.active -= 1;
            pump();
          });
      }
    };

    pump();
  });
}

async function enqueueSegmentTask(task) {
  const queue = await getSegmentQueue();
  if (queue) {
    return queue.add(task);
  }

  return runFallbackQueued(task);
}

function mediaDirForPlaylist(playlistName) {
  if (!playlistName) {
    return VidsDir;
  }

  const nested = path.join(VidsDir, playlistName);
  if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
    return nested;
  }

  return VidsDir;
}

function liveDirForPlaylist(playlistName) {
  if (!playlistName) {
    return OutputDir;
  }

  return path.join(OutputDir, playlistName);
}

function listVideoFiles(playlistName = activePlaylistName) {
  const dir = mediaDirForPlaylist(playlistName);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return [];
  }

  return fs.readdirSync(dir).filter((file) => file.toLowerCase().endsWith('.mp4'));
}

function activatePlaylist(playlistName) {
  const next = playlistName || '';
  if (activePlaylistName === next) {
    return;
  }

  isRunning = false;
  cachedTotalDuration = 0;
  cachedVideoTimeline = Array();
  inFlightSegments.clear();
  segmentDurationCache.clear();
  segmentSourceCache.clear();
  liveHeadSegmentIndex = -1;
  activePlaylistName = next;
  startPlayback(true);
}

function listSubdirs(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function discoverPlaylistNames() {
  const media = new Set(listSubdirs(VidsDir));
  const live = new Set(listSubdirs(OutputDir));
  const shared = Array.from(media).filter((name) => live.has(name));
  return shared.sort();
}

function playlistExists(name) {
  if (!name) {
    return true;
  }

  const media = path.join(VidsDir, name);
  const live = path.join(OutputDir, name);
  return fs.existsSync(media) && fs.statSync(media).isDirectory()
    && fs.existsSync(live) && fs.statSync(live).isDirectory();
}

function writeConcatFile() {
  const concatPath = path.join(OutputDir, 'concat.txt');
  const lines = listVideoFiles()
    .sort()
    .map((file) => `file '${path.join(mediaDirForPlaylist(activePlaylistName), file).replace(/\\/g, '/')}'`)
    .join('\n');

  fs.writeFileSync(concatPath, lines, 'utf8');
  return concatPath;
}

function segmentFilePath(segmentIndex, playlistName = activePlaylistName) {
  return path.join(liveDirForPlaylist(playlistName), `segment-${segmentIndex}.ts`);
}

function isSegmentReady(segmentIndex, playlistName = activePlaylistName) {
  const file = segmentFilePath(segmentIndex, playlistName);
  return fs.existsSync(file) && fs.statSync(file).size > 0;
}

function isSegmentHealthy(segmentIndex, playlistName = activePlaylistName) {
  const file = segmentFilePath(segmentIndex, playlistName);
  return fs.existsSync(file) && fs.statSync(file).size >= MinSegmentBytes;
}

function clearLiveSegments(playlistName = activePlaylistName) {
  const liveDir = liveDirForPlaylist(playlistName);
  if (!fs.existsSync(liveDir)) {
    return;
  }

  for (const file of fs.readdirSync(liveDir)) {
    if (!/^segment-\d+\.ts$/.test(file)) {
      if (file === 'stream.m3u8' || file === 'concat.txt') {
        fs.rmSync(path.join(liveDir, file), { force: true });
      }
      continue;
    }

    fs.rmSync(path.join(liveDir, file), { force: true });
  }

  segmentDurationCache.clear();
  segmentSourceCache.clear();
  liveHeadSegmentIndex = -1;
}

function startNativeHlsPipeline() {
  if (!UseNativeHls || nativeHlsProcess || !HasFfmpeg) {
    return;
  }

  const videos = listVideoFiles();
  if (videos.length === 0) {
    log('warn', 'Native HLS pipeline not started because no videos were found');
    return;
  }

  clearLiveSegments();
  const concatPath = writeConcatFile();
  const playlistPath = path.join(OutputDir, 'stream.m3u8');
  const segmentPattern = path.join(OutputDir, 'segment-%d.ts');
  const nativeHlsFlags = EnableProgramDateTime
    ? 'delete_segments+append_list+independent_segments+program_date_time'
    : 'delete_segments+append_list+independent_segments';

  const proc = spawn(FfmpegCommand, [
    '-y',
    '-re',
    '-stream_loop',
    '-1',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatPath,
    '-vf',
    'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2',
    '-r',
    '30',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-profile:v',
    'baseline',
    '-level',
    '3.1',
    '-g',
    '60',
    '-keyint_min',
    '60',
    '-sc_threshold',
    '0',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-b:a',
    '128k',
    '-f',
    'hls',
    '-hls_time',
    `${SegmentDuration}`,
    '-hls_list_size',
    `${NativeHlsListSize}`,
    '-hls_flags',
    nativeHlsFlags,
    '-hls_delete_threshold',
    '2',
    '-hls_segment_filename',
    segmentPattern,
    playlistPath,
  ], { env: RuntimeEnv });
  nativeHlsProcess = proc;

  proc.stderr.on('data', () => {
    // Keep ffmpeg stderr drained to avoid blocking.
  });

  proc.on('close', (code) => {
    log('warn', 'Native HLS pipeline exited', { code });
    nativeHlsProcess = null;
  });

  proc.on('error', (err) => {
    log('error', 'Native HLS pipeline failed to start', { error: err.message });
    nativeHlsProcess = null;
  });

  log('info', 'Native HLS pipeline started', {
    videos: videos.length,
    playlistPath,
    nativeHlsFlags,
  });
}

function tryRemoveFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return true;
  }

  try {
    fs.rmSync(filePath, { force: true });
    return true;
  } catch (err) {
    const errorCode = err && typeof err === 'object' ? Reflect.get(err, 'code') : undefined;
    if (errorCode === 'EBUSY') {
      return false;
    }

    throw err;
  }
}

function getField(value, key, fallback) {
  if (!value || typeof value !== 'object') {
    return fallback;
  }

  const field = Reflect.get(value, key);
  return field === undefined ? fallback : field;
}

function getVideoTimeline() {
  if (cachedVideoTimeline.length > 0) {
    return cachedVideoTimeline;
  }

  const files = listVideoFiles().map((fileName) => ({
    fileName,
    filePath: path.join(mediaDirForPlaylist(activePlaylistName), fileName),
  }));

  const timeline = Array();
  let cursor = 0;
  for (const file of files) {
    const probe = spawnSync(
      FfprobeCommand,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nokey=1:noprint_wrappers=1', file.filePath],
      { encoding: 'utf8', env: RuntimeEnv }
    );

    const duration = Number.parseFloat((probe.stdout || '').trim());
    if (!Number.isFinite(duration) || duration <= 0) {
      log('warn', 'Skipping file with invalid duration', { file: file.fileName, duration });
      continue;
    }

    timeline.push({
      fileName: file.fileName,
      filePath: file.filePath,
      start: cursor,
      end: cursor + duration,
      duration,
    });
    cursor += duration;
  }

  cachedVideoTimeline = timeline;
  return cachedVideoTimeline;
}

function resolveTimelineTarget(globalTimeSeconds) {
  const timeline = getVideoTimeline();
  if (timeline.length === 0) {
    return null;
  }

  const totalDuration = timeline[timeline.length - 1].end;
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    return null;
  }

  const wrapped = ((globalTimeSeconds % totalDuration) + totalDuration) % totalDuration;
  for (let i = 0; i < timeline.length; i++) {
    const segment = timeline[i];
    if (wrapped >= segment.start && wrapped < segment.end) {
      return {
        timelineIndex: i,
        fileName: segment.fileName,
        filePath: segment.filePath,
        localOffset: wrapped - segment.start,
        sourceDuration: segment.duration,
        totalDuration,
      };
    }
  }

  const fallback = timeline[timeline.length - 1];
  return {
    timelineIndex: timeline.length - 1,
    fileName: fallback.fileName,
    filePath: fallback.filePath,
    localOffset: 0,
    sourceDuration: fallback.duration,
    totalDuration,
  };
}

if (!fs.existsSync(OutputDir)) {
  fs.mkdirSync(OutputDir, { recursive: true });
}

if (!fs.existsSync(VidsDir)) {
  fs.mkdirSync(VidsDir, { recursive: true });
}

function getTotalDurationSeconds() {
  if (cachedTotalDuration > 0) {
    return cachedTotalDuration;
  }

  const timeline = getVideoTimeline();
  cachedTotalDuration = timeline.length > 0 ? timeline[timeline.length - 1].end : 0;
  log('info', 'Computed total media duration (seconds)', {
    totalDuration: cachedTotalDuration,
    files: timeline.length,
  });
  return cachedTotalDuration;
}

function runFfmpegToSegment(sourcePath, sourceOffset, segmentFile) {
  return new Promise((resolve) => {
    const ffmpeg = spawn(FfmpegCommand, [
      '-y',
      '-fflags',
      '+genpts',
      '-ss',
      `${sourceOffset}`,
      '-i',
      sourcePath,
      '-t',
      `${SegmentDuration}`,
      '-avoid_negative_ts',
      'make_zero',
      '-vf',
      'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2',
      '-r',
      '30',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-profile:v',
      'baseline',
      '-level',
      '3.1',
      '-g',
      '60',
      '-keyint_min',
      '60',
      '-sc_threshold',
      '0',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-b:a',
      '128k',
      '-muxpreload',
      '0',
      '-muxdelay',
      '0',
      '-mpegts_flags',
      '+initial_discontinuity',
      '-reset_timestamps',
      '1',
      '-f',
      'mpegts',
      segmentFile,
    ], { env: RuntimeEnv });

    let stderr = '';
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on('error', (err) => {
      resolve({ ok: false, code: -1, stderr, spawnError: err.message });
    });

    ffmpeg.on('close', (code) => {
      const ok = code === 0 && fs.existsSync(segmentFile) && fs.statSync(segmentFile).size > 0;
      resolve({ ok, code, stderr });
    });
  });
}

function probeDurationSeconds(filePath) {
  if (!HasFfprobe || !fs.existsSync(filePath)) {
    return 0;
  }

  const probe = spawnSync(
    FfprobeCommand,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nokey=1:noprint_wrappers=1', filePath],
    { encoding: 'utf8', env: RuntimeEnv }
  );

  const duration = Number.parseFloat((probe.stdout || '').trim());
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function generateSegment(segmentIndex) {
  const segmentFile = segmentFilePath(segmentIndex);
  const liveDir = liveDirForPlaylist(activePlaylistName);
  if (!fs.existsSync(liveDir)) {
    fs.mkdirSync(liveDir, { recursive: true });
  }

  if (isSegmentReady(segmentIndex)) {
    return Promise.resolve(segmentFile);
  }

  if (!tryRemoveFile(segmentFile)) {
    return Promise.reject(new Error(`Segment file is busy: ${segmentFile}`));
  }

  const totalDuration = getTotalDurationSeconds();
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    log('warn', 'Cannot generate segment because total video duration is invalid', {
      segmentIndex,
      totalDuration,
      videoFiles: listVideoFiles(),
    });
    return Promise.reject(new Error('No probeable video duration found'));
  }

  const startTime = (segmentIndex * SegmentDuration) % totalDuration;
  const target = resolveTimelineTarget(startTime);
  if (!target) {
    return Promise.reject(new Error('No playable video timeline available'));
  }

  const timeline = getVideoTimeline();
  const maxOffset = Math.max(0, target.sourceDuration - 0.25);
  let selectedPath = target.filePath;
  let selectedName = target.fileName;
  let safeOffset = Math.min(target.localOffset, maxOffset);

  return new Promise(async (resolve, reject) => {
    log('info', 'Generating segment', {
      segmentIndex,
      startTime,
      sourceFile: selectedName,
      sourceOffset: safeOffset,
      segmentFile,
    });
    const primary = await runFfmpegToSegment(selectedPath, safeOffset, segmentFile);
    const primaryOk = getField(primary, 'ok', false) === true;
    const primaryCode = getField(primary, 'code', -1);
    const primaryStderr = String(getField(primary, 'stderr', ''));
    const primarySpawnError = getField(primary, 'spawnError', '');

    if (primaryOk) {
      segmentSourceCache.set(segmentIndex, selectedName);
      const generatedDuration = probeDurationSeconds(segmentFile);
      if (generatedDuration > 0) {
        segmentDurationCache.set(segmentIndex, generatedDuration);
      }
      liveHeadSegmentIndex = Math.max(liveHeadSegmentIndex, segmentIndex);
      log('info', 'Segment generated', { segmentIndex, segmentFile });
      resolve(segmentFile);
      return;
    }

    if (primarySpawnError) {
      log('error', 'FFmpeg spawn failed', { segmentIndex, error: primarySpawnError });
      reject(new Error(`FFmpeg spawn failed: ${primarySpawnError}`));
      return;
    }

    const nearEnd = target.sourceDuration - safeOffset < 0.75;
    if (nearEnd && target.timelineIndex + 1 < timeline.length) {
      const next = timeline[target.timelineIndex + 1];
      log('warn', 'Retrying segment from next source file after near-end failure', {
        segmentIndex,
        failedFile: target.fileName,
        nextFile: next.fileName,
      });

      const fallback = await runFfmpegToSegment(next.filePath, 0, segmentFile);
      if (getField(fallback, 'ok', false) === true) {
        segmentSourceCache.set(segmentIndex, next.fileName);
        const generatedDuration = probeDurationSeconds(segmentFile);
        if (generatedDuration > 0) {
          segmentDurationCache.set(segmentIndex, generatedDuration);
        }
        liveHeadSegmentIndex = Math.max(liveHeadSegmentIndex, segmentIndex);
        log('info', 'Segment generated from fallback source file', { segmentIndex, segmentFile });
        resolve(segmentFile);
        return;
      }
    }

    log('error', 'FFmpeg segment generation failed', {
      segmentIndex,
      code: primaryCode,
      stderrTail: primaryStderr.slice(-1000),
    });
    reject(new Error(`FFmpeg exit ${primaryCode}`));
  });
}

function ensureSegment(segmentIndex) {
  if (segmentIndex < 0) {
    return Promise.reject(new Error('Invalid segment index'));
  }

  const current = inFlightSegments.get(segmentIndex);
  if (current) {
    return current;
  }

  const segmentFile = segmentFilePath(segmentIndex);
  if (isSegmentReady(segmentIndex)) {
    return Promise.resolve(segmentFile);
  }

  const job = enqueueSegmentTask(() => generateSegment(segmentIndex)).finally(() => {
    inFlightSegments.delete(segmentIndex);
  });

  inFlightSegments.set(segmentIndex, job);
  return job;
}

async function preGenerateFromIndex(startIndex, count) {
  const jobs = Array.from({ length: count }, (_, i) => ensureSegment(startIndex + i));
  await Promise.allSettled(jobs);
}

async function ensureContiguousWindow(startIndex, count) {
  for (let i = 0; i < count; i++) {
    const idx = startIndex + i;
    if (isSegmentReady(idx)) {
      continue;
    }

    try {
      await ensureSegment(idx);
    } catch {
      break;
    }
  }
}

function prefetchContiguousWindow(startIndex, count) {
  void ensureContiguousWindow(startIndex, count).catch((err) => {
    log('warn', 'Background segment prefetch failed', {
      startIndex,
      count,
      error: err && typeof err === 'object' ? Reflect.get(err, 'message') : String(err),
    });
  });
}

function contiguousReadyCount(segmentIndex) {
  let contiguousCount = 0;
  for (let i = 0; i < PlaylistSegments; i++) {
    if (!isSegmentReady(segmentIndex + i, activePlaylistName)) {
      break;
    }

    contiguousCount++;
  }

  return contiguousCount;
}

function findLatestReadyWindowStart(playlistName = activePlaylistName) {
  const liveDir = liveDirForPlaylist(playlistName);
  if (!fs.existsSync(liveDir) || !fs.statSync(liveDir).isDirectory()) {
    return -1;
  }

  const indexes = fs.readdirSync(liveDir)
    .map((name) => {
      const match = name.match(/^segment-(\d+)\.ts$/);
      return match ? Number.parseInt(match[1], 10) : -1;
    })
    .filter((idx) => Number.isInteger(idx) && idx >= 0)
    .sort((a, b) => a - b);

  if (indexes.length === 0) {
    return -1;
  }

  let runStart = indexes[0];
  let runEnd = indexes[0];
  let bestStart = -1;

  const flushRun = () => {
    const runLength = runEnd - runStart + 1;
    if (runLength <= 0) {
      return;
    }

    const latestStartInRun = Math.max(runStart, runEnd - (PlaylistSegments - 1));
    if (latestStartInRun > bestStart) {
      bestStart = latestStartInRun;
    }
  };

  for (let i = 1; i < indexes.length; i++) {
    if (indexes[i] === runEnd + 1) {
      runEnd = indexes[i];
      continue;
    }

    flushRun();
    runStart = indexes[i];
    runEnd = indexes[i];
  }

  flushRun();
  return bestStart;
}

function firstHeaderValue(value) {
  if (!value) {
    return '';
  }

  return (Array.isArray(value) ? value[0] : value).split(',')[0].trim();
}

function getBaseUrl(req) {
  if (PublicBaseUrl) {
    return PublicBaseUrl;
  }

  const proto = firstHeaderValue(req.headers['x-forwarded-proto']) || 'http';
  const host = firstHeaderValue(req.headers['x-forwarded-host']) || req.headers.host;

  return `${proto}://${host}`;
}

function writeM3u8(res, body) {
  res.writeHead(200, {
    'Content-Type': 'application/vnd.apple.mpegurl',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.end(body);
}

function writeTs(res, body) {
  res.writeHead(200, {
    'Content-Type': 'video/mp2t',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  });
  res.end(body);
}

function normalizeNativePlaylistForSync(playlistBuffer) {
  const source = String(playlistBuffer || '').trim();
  if (!source) {
    return '';
  }

  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const mediaSeqLine = lines.find((line) => line.startsWith('#EXT-X-MEDIA-SEQUENCE:'));
  const mediaSequence = mediaSeqLine
    ? Number.parseInt(mediaSeqLine.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10)
    : 0;
  const targetDurationLine = lines.find((line) => line.startsWith('#EXT-X-TARGETDURATION:')) || `#EXT-X-TARGETDURATION:${SegmentDuration}`;
  const versionLine = lines.find((line) => line.startsWith('#EXT-X-VERSION:')) || '#EXT-X-VERSION:3';
  const hasIndependent = lines.includes('#EXT-X-INDEPENDENT-SEGMENTS');

  const segments = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#EXTINF:')) {
      continue;
    }

    const extinf = line;
    let programDateTime = '';
    let uri = '';
    let cursor = i + 1;

    while (cursor < lines.length) {
      const candidate = lines[cursor];
      if (candidate.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
        programDateTime = candidate;
        cursor += 1;
        continue;
      }

      if (candidate.startsWith('#')) {
        break;
      }

      uri = candidate;
      break;
    }

    if (uri) {
      segments.push({ extinf, programDateTime, uri });
    }
  }

  if (segments.length === 0) {
    return source;
  }

  const keepCount = Math.max(2, SyncLiveWindowSegments);
  const startIndex = Math.max(0, segments.length - keepCount);
  const selected = segments.slice(startIndex);
  const adjustedMediaSequence = mediaSequence + startIndex;

  const output = [
    '#EXTM3U',
    versionLine,
    targetDurationLine,
    `#EXT-X-MEDIA-SEQUENCE:${adjustedMediaSequence}`,
    '#EXT-X-START:TIME-OFFSET=-' + HardSyncStartOffsetSeconds.toFixed(3) + ',PRECISE=YES',
  ];

  if (hasIndependent) {
    output.push('#EXT-X-INDEPENDENT-SEGMENTS');
  }

  for (const segment of selected) {
    output.push(segment.extinf);
    if (segment.programDateTime) {
      output.push(segment.programDateTime);
    }
    output.push(segment.uri);
  }

  return `${output.join('\n')}\n`;
}

function getLiveWindowStartSegment() {
  if (liveHeadSegmentIndex >= 0) {
    return Math.max(0, liveHeadSegmentIndex - (PlaylistSegments - 1));
  }

  return findLatestReadyWindowStart(activePlaylistName);
}

function getPrefetchStartSegment() {
  if (liveHeadSegmentIndex >= 0) {
    return liveHeadSegmentIndex + 1;
  }

  const latestWindowStart = findLatestReadyWindowStart(activePlaylistName);
  if (latestWindowStart >= 0) {
    return latestWindowStart + PlaylistSegments;
  }

  return 0;
}

function m3u8(baseUrl, segmentIndex) {
  const contiguousCount = contiguousReadyCount(segmentIndex);

  if (contiguousCount === 0) {
    return '';
  }

  const durations = Array.from({ length: contiguousCount }, (_, i) => {
    const idx = segmentIndex + i;
    const cached = segmentDurationCache.get(idx);
    return Number.isFinite(cached) && cached > 0 ? cached : SegmentDuration;
  });
  const maxDuration = durations.reduce((max, value) => Math.max(max, value), SegmentDuration);
  const targetDuration = Math.max(1, Math.ceil(maxDuration));
  let playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-ALLOW-CACHE:NO\n#EXT-X-TARGETDURATION:${targetDuration}\n#EXT-X-MEDIA-SEQUENCE:${segmentIndex}\n`;

  for (let i = 0; i < contiguousCount; i++) {
    const idx = segmentIndex + i;
    if (i > 0) {
      playlist += '#EXT-X-DISCONTINUITY\n';
    }

    const segmentPath = activePlaylistName
      ? `/live/${activePlaylistName}/segment-${idx}.ts`
      : `/live/segment-${idx}.ts`;
    const extinf = durations[i];
    playlist += `#EXTINF:${extinf.toFixed(3)},\n${baseUrl}${segmentPath}\n`;
  }

  return playlist;
}

function masterM3u8(baseUrl) {
  let playlist = '#EXTM3U\n#EXT-X-VERSION:3\n';

  const playlistNames = discoverPlaylistNames();
  for (let i = 0; i < playlistNames.length; i++) {
    const name = playlistNames[i];
    const bandwidth = 800000 + i * 500000;
    playlist += `#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=${bandwidth},RESOLUTION=640x360\n`;
    playlist += `${baseUrl}/live/${name}/${name}.m3u8\n`;
  }

  return playlist;
}

function isVariantPath(pathname) {
  const match = pathname.match(/^\/live\/([^/]+)\/([^/]+)\.m3u8$/);
  return !!match && match[1] === match[2];
}

function playlistNameFromVariantPath(pathname) {
  const match = pathname.match(/^\/live\/([^/]+)\/\1\.m3u8$/);
  return match ? match[1] : '';
}

function playlistNameFromSegmentPath(pathname) {
  const nested = pathname.match(/^\/live\/([^/]+)\/segment-\d+\.ts$/);
  if (nested) {
    return nested[1];
  }

  return '';
}

function tick() {
}

function startPlayback(resetTime = false) {
  if (resetTime) {
    cachedTotalDuration = 0;
    cachedVideoTimeline = Array();
  }

  if (isRunning) {
    return;
  }

  isRunning = true;
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.headers.host) {
    res.statusCode = 400;
    res.end('Bad Request');
    return;
  }

  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname === '/live/stream.m3u8') {
    streamPlaylistPollCount += 1;
    const now = Date.now();
    if (now - lastStreamPlaylistPollLogAt >= 2000) {
      log('info', 'Incoming stream playlist poll summary', {
        polls: streamPlaylistPollCount,
        windowMs: now - lastStreamPlaylistPollLogAt,
      });
      streamPlaylistPollCount = 0;
      lastStreamPlaylistPollLogAt = now;
    }
  } else {
    log('info', 'Incoming request', { method: req.method, pathname });
  }

  if (pathname === '/live/stream.m3u8' || pathname === '/live/master.m3u8') {
    if (UseNativeHls) {
      startNativeHlsPipeline();
      const playlistPath = path.join(OutputDir, 'stream.m3u8');
      if (!fs.existsSync(playlistPath) || fs.statSync(playlistPath).size === 0) {
        res.statusCode = 503;
        res.end('Warming up HLS pipeline, retry in a moment');
        return;
      }

      const nativePlaylist = fs.readFileSync(playlistPath, 'utf8');
      const responsePlaylist = EnableNativePlaylistSyncRewrite
        ? normalizeNativePlaylistForSync(nativePlaylist)
        : nativePlaylist;
      writeM3u8(res, responsePlaylist);
      return;
    }

    if (UseMasterPlaylist) {
      const playlistNames = discoverPlaylistNames();
      if (playlistNames.length === 0) {
        activatePlaylist('');
        const desiredSegmentIndex = getLiveWindowStartSegment();
        const prefetchStart = getPrefetchStartSegment();
        if (HasFfmpeg && HasFfprobe) {
          prefetchContiguousWindow(prefetchStart, PlaylistSegments + 2);
        }

        let playlist = m3u8(getBaseUrl(req), desiredSegmentIndex);
        if (!playlist) {
          const fallbackStart = findLatestReadyWindowStart();
          if (fallbackStart >= 0) {
            playlist = m3u8(getBaseUrl(req), fallbackStart);
          }
        }
        if (!playlist) {
          res.statusCode = 503;
          res.end('Warming up segments, retry in a moment');
          return;
        }

        writeM3u8(res, playlist);
        return;
      }

      writeM3u8(res, masterM3u8(getBaseUrl(req)));
      return;
    }
  }

  if (pathname === '/live/media.m3u8' || (UseMasterPlaylist && isVariantPath(pathname))) {
    const playlistName = pathname === '/live/media.m3u8' ? '' : playlistNameFromVariantPath(pathname);
    if (!playlistExists(playlistName)) {
      res.statusCode = 404;
      res.end('Playlist not found');
      return;
    }

    activatePlaylist(playlistName);
    const videos = listVideoFiles();
    const videoCount = videos.length;
    log('info', 'Requested playlist', { pathname, playlistName, videoCount, videos, ffmpegAvailable: HasFfmpeg });
    if (videoCount === 0) {
      res.statusCode = 404;
      res.end('No videos available');
      return;
    }

    const segmentIndex = getLiveWindowStartSegment();
    const prefetchStart = getPrefetchStartSegment();
    if (HasFfmpeg && HasFfprobe) {
      prefetchContiguousWindow(prefetchStart, PlaylistSegments + 2);
    }

    let playlist = m3u8(getBaseUrl(req), segmentIndex);
    if (!playlist) {
      const fallbackStart = findLatestReadyWindowStart(activePlaylistName);
      if (fallbackStart >= 0) {
        playlist = m3u8(getBaseUrl(req), fallbackStart);
      }
    }
    if (!playlist) {
      res.statusCode = 503;
      res.end('Warming up segments');
      return;
    }

    writeM3u8(res, playlist);
    return;
  }

  if (/^\/live\/(?:[^/]+\/)?segment-\d+\.ts$/.test(pathname)) {
    const playlistName = playlistNameFromSegmentPath(pathname);
    activatePlaylist(playlistName);
    if (UseNativeHls) {
      const segmentFile = path.join(OutputDir, pathname.slice('/live/'.length));
      if (!fs.existsSync(segmentFile)) {
        res.statusCode = 404;
        res.end('Segment not found');
        return;
      }

      writeTs(res, fs.readFileSync(segmentFile));
      return;
    }
    if (!HasFfmpeg || !HasFfprobe) {
      log('warn', 'Segment requested but ffmpeg/ffprobe is not installed', {
        ffmpegAvailable: HasFfmpeg,
        ffprobeAvailable: HasFfprobe,
      });
      res.statusCode = 503;
      res.end('FFmpeg/ffprobe is not installed! Please install it.');
      return;
    }
    const match = pathname.match(/\d+/);
    const segmentIndex = Number.parseInt(match ? match[0] : '0', 10);
    const segmentFile = segmentFilePath(segmentIndex, activePlaylistName);
    const exists = fs.existsSync(segmentFile);
    const healthy = isSegmentHealthy(segmentIndex, activePlaylistName);
    if (!exists || !healthy) {
      log('info', 'Segment requested but missing/unhealthy; generating', {
        segmentIndex,
        segmentFile,
        exists,
        bytes: exists ? fs.statSync(segmentFile).size : 0,
      });
      try {
        await ensureSegment(segmentIndex);
      } catch {
        log('warn', 'Segment generation failed for request', { segmentIndex, segmentFile });
        res.statusCode = 404;
        res.end('Segment not found');
        return;
      }
    }
    writeTs(res, fs.readFileSync(segmentFile));
    return;
  }
  res.statusCode = 404;
  res.end('Not found!');
});
server.listen(ServePort, () => {
  clearLiveSegments();
  log('info', '[(=|]', {
    videoFiles: listVideoFiles(),
  });
  if (UseNativeHls) {
    startNativeHlsPipeline();
  } else {
    startPlayback();
    if (HasFfmpeg && HasFfprobe) {
      void preGenerateFromIndex(0, StartupWarmupSegments);
    }
  }
  log('info', 'started');
});
server.on('error', (err) => {
  log('error', 'internal error', { message: err.message, code: err.code });
});