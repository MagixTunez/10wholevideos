const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

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

function commandAvailable(command) {
  const check = spawnSync(command, ['-version'], { stdio: 'ignore', env: RuntimeEnv });
  return !check.error && check.status === 0;
}

const ServePort = 5181;
const VidsDir = path.join(process.cwd(), 'media');
const OutputDir = path.join(process.cwd(), 'live');
const SegmentDuration = 10;
const PlaylistSegments = 6;
const NativeHlsListSize = 12;
const PrebufferSegments = 6;
const StartupWarmupSegments = 10;
const RetainBackSegments = 20;
const MinSegmentBytes = 4096;
const ManifestStepMax = 2;
const UseNativeHls = false;
const UseMasterPlaylist = true;
const PublicBaseUrl = process.env.basehost?.replace(/\/+$/, '');
const HasFfmpeg = commandAvailable('ffmpeg');
const HasFfprobe = commandAvailable('ffprobe');
let playbackTime = 0;
let isRunning = false;
const inFlightSegments = new Map();
let prebufferTimer;
let cachedTotalDuration = 0;
let cachedVideoTimeline = Array();
let manifestBaseSegment = 0;
let highestRequestedSegment = -1;
const segmentDurationCache = new Map();
const segmentSourceCache = new Map();
let nativeHlsProcess = null;
let activePlaylistName = '';

function log(level, message, ...meta) {
  const stamp = new Date().toISOString();
  if (meta.length > 0) {
    console[level](`[stream ${stamp}] ${message}`, meta[0]);
    return;
  }

  console[level](`[stream ${stamp}] ${message}`);
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
  return fs.readdirSync(dir).filter((file) => file.endsWith('.mp4'));
}

function activatePlaylist(playlistName) {
  const next = playlistName || '';
  if (activePlaylistName === next) {
    return;
  }

  stopPrebufferLoop();
  isRunning = false;
  playbackTime = 0;
  cachedTotalDuration = 0;
  cachedVideoTimeline = Array();
  manifestBaseSegment = 0;
  highestRequestedSegment = -1;
  inFlightSegments.clear();
  segmentDurationCache.clear();
  segmentSourceCache.clear();
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

function clearLiveSegments() {
  if (!fs.existsSync(OutputDir)) {
    return;
  }

  for (const file of fs.readdirSync(OutputDir)) {
    if (!/^segment-\d+\.ts$/.test(file)) {
      if (file === 'stream.m3u8' || file === 'concat.txt') {
        fs.rmSync(path.join(OutputDir, file), { force: true });
      }
      continue;
    }

    fs.rmSync(path.join(OutputDir, file), { force: true });
  }

  segmentDurationCache.clear();
  segmentSourceCache.clear();
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

  const proc = spawn('ffmpeg', [
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
    'append_list+independent_segments+program_date_time',
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

  log('info', 'Native HLS pipeline started', { videos: videos.length, playlistPath });
}

function getSegmentDurationSeconds(segmentIndex) {
  const cached = segmentDurationCache.get(segmentIndex);
  if (typeof cached === 'number' && Number.isFinite(cached) && cached > 0) {
    return cached;
  }

  const file = segmentFilePath(segmentIndex);
  if (!fs.existsSync(file)) {
    return 0;
  }

  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nokey=1:noprint_wrappers=1', file],
    { encoding: 'utf8', env: RuntimeEnv }
  );
  const duration = Number.parseFloat((probe.stdout || '').trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    // MPEG-TS probing can intermittently fail; keep manifest stable with configured duration.
    return SegmentDuration;
  }

  segmentDurationCache.set(segmentIndex, duration);
  return duration;
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
      'ffprobe',
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
    const ffmpeg = spawn('ffmpeg', [
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

function generateSegment(segmentIndex) {
  const segmentFile = segmentFilePath(segmentIndex);
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
  const remaining = target.sourceDuration - safeOffset;
  if (remaining < SegmentDuration && target.timelineIndex + 1 < timeline.length) {
    const next = timeline[target.timelineIndex + 1];
    selectedPath = next.filePath;
    selectedName = next.fileName;
    safeOffset = 0;
  }

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

  const job = generateSegment(segmentIndex).finally(() => {
    inFlightSegments.delete(segmentIndex);
  });

  inFlightSegments.set(segmentIndex, job);
  return job;
}

function cleanupOldSegments(currentIndex) {
  const minKeep = Math.max(0, currentIndex - RetainBackSegments);
  for (const file of fs.readdirSync(OutputDir)) {
    const match = file.match(/^segment-(\d+)\.ts$/);
    if (!match) {
      continue;
    }

    const idx = Number.parseInt(match[1], 10);
    if (idx < minKeep) {
      fs.rmSync(path.join(OutputDir, file), { force: true });
      segmentDurationCache.delete(idx);
      segmentSourceCache.delete(idx);
    }
  }
}

async function prebufferAroundCurrent() {
  // Request-driven mode: prebuffer is intentionally disabled to avoid drift.
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

function startPrebufferLoop() {
  // Request-driven mode: no background prebuffer loop.
}

function stopPrebufferLoop() {
  if (!prebufferTimer) {
    return;
  }

  clearInterval(prebufferTimer);
  prebufferTimer = undefined;
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

function getLiveWindowStartSegment() {
  const nowSegment = Math.floor(Date.now() / (SegmentDuration * 1000));
  return Math.max(0, nowSegment - (PlaylistSegments - 1));
}

function m3u8(baseUrl, segmentIndex) {
  let contiguousCount = 0;
  for (let i = 0; i < PlaylistSegments; i++) {
    if (!isSegmentReady(segmentIndex + i, activePlaylistName)) {
      break;
    }

    contiguousCount++;
  }

  if (contiguousCount === 0) {
    return '';
  }

  const targetDuration = SegmentDuration + 1;
  let playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-ALLOW-CACHE:NO\n#EXT-X-TARGETDURATION:${targetDuration}\n#EXT-X-MEDIA-SEQUENCE:${segmentIndex}\n`;

  for (let i = 0; i < contiguousCount; i++) {
    const idx = segmentIndex + i;
    if (i > 0) {
      playlist += '#EXT-X-DISCONTINUITY\n';
    }

    const segmentPath = activePlaylistName
      ? `/live/${activePlaylistName}/segment-${idx}.ts`
      : `/live/segment-${idx}.ts`;
    playlist += `#EXTINF:${SegmentDuration.toFixed(3)},\n${baseUrl}${segmentPath}\n`;
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
  // Request-driven mode: synthetic playback clock disabled.
}

function startPlayback(resetTime = false) {
  if (resetTime) {
    playbackTime = 0;
    cachedTotalDuration = 0;
    cachedVideoTimeline = Array();
  }

  manifestBaseSegment = 0;
  highestRequestedSegment = -1;

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
  log('info', 'Incoming request', { method: req.method, pathname });

  if (pathname === '/live/stream.m3u8' || pathname === '/live/master.m3u8') {
    if (UseNativeHls) {
      startNativeHlsPipeline();
      const playlistPath = path.join(OutputDir, 'stream.m3u8');
      if (!fs.existsSync(playlistPath) || fs.statSync(playlistPath).size === 0) {
        res.statusCode = 503;
        res.end('Warming up HLS pipeline, retry in a moment');
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
      });
      res.end(fs.readFileSync(playlistPath));
      return;
    }

    if (UseMasterPlaylist) {
      const playlistNames = discoverPlaylistNames();
      if (playlistNames.length === 0) {
        activatePlaylist('');
        const segmentIndex = getLiveWindowStartSegment();
        manifestBaseSegment = segmentIndex;
        if (HasFfmpeg && HasFfprobe) {
          await ensureContiguousWindow(segmentIndex, PlaylistSegments + 2);
        }

        const playlist = m3u8(getBaseUrl(req), segmentIndex);
        if (!playlist) {
          res.statusCode = 503;
          res.end('Warming up segments, retry in a moment');
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          Pragma: 'no-cache',
          Expires: '0',
        });
        res.end(playlist);
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
      });
      res.end(masterM3u8(getBaseUrl(req)));
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
    log('info', 'Requested playlist', { pathname, playlistName, videoCount, videos, ffmpegAvailable: HasFfmpeg, playbackTime });
    if (videoCount === 0) {
      res.statusCode = 404;
      res.end('No videos available');
      return;
    }

    const segmentIndex = getLiveWindowStartSegment();
    manifestBaseSegment = segmentIndex;
    if (HasFfmpeg && HasFfprobe) {
      await ensureContiguousWindow(segmentIndex, PlaylistSegments + 2);
    }

    const playlist = m3u8(getBaseUrl(req), segmentIndex);
    if (!playlist) {
      res.statusCode = 503;
      res.end('Warming up segments, retry in a moment');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
    });
    res.end(playlist);
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

      res.writeHead(200, {
        'Content-Type': 'video/mp2t',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      });
      res.end(fs.readFileSync(segmentFile));
      return;
    }
    if (!HasFfmpeg || !HasFfprobe) {
      log('warn', 'Segment requested but ffmpeg/ffprobe is not installed', {
        ffmpegAvailable: HasFfmpeg,
        ffprobeAvailable: HasFfprobe,
      });
      res.statusCode = 503;
      res.end('FFmpeg/ffprobe is not installed on this server');
      return;
    }
    const match = pathname.match(/\d+/);
    const segmentIndex = Number.parseInt(match ? match[0] : '0', 10);
    const segmentFile = segmentFilePath(segmentIndex, activePlaylistName);
    highestRequestedSegment = Math.max(highestRequestedSegment, segmentIndex);
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
    res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    });
    res.end(fs.readFileSync(segmentFile));
    return;
  }
  res.statusCode = 404;
  res.end('Not found');
});
server.listen(ServePort, () => {
  clearLiveSegments();
  log('info', 'Server started', {
    port: ServePort,
    basehost: process.env.basehost || '(not set)',
    ffmpegAvailable: HasFfmpeg,
    ffprobeAvailable: HasFfprobe,
    mediaDir: VidsDir,
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
  log('info', 'hi');
});
server.on('error', (err) => {
  log('error', 'Server error', { message: err.message, code: err.code });
});
