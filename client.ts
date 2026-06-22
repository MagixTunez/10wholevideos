import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
const ServePort = 5181;
const VidsDir = path.join(process.cwd(), 'media');
const OutputDir = path.join(process.cwd(), 'live');
const SegmentDuration = 10;
const PrebufferSegments = 4;
const RetainBackSegments = 2;
const PublicBaseUrl = process.env.basehost?.replace(/\/+$/, '');
const ffmpegCheck = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
const HasFfmpeg = !ffmpegCheck.error && ffmpegCheck.status === 0;
let playbackTime = 0;
let isRunning = false;
const inFlightSegments = new Map<number, Promise<string>>();
let prebufferTimer: NodeJS.Timeout | null = null;
let cachedTotalDuration = 0;

if (!fs.existsSync(OutputDir)) {
  fs.mkdirSync(OutputDir, { recursive: true });
}

if (!fs.existsSync(VidsDir)) {
  fs.mkdirSync(VidsDir, { recursive: true });
}

function concat() {
  const concatPath = path.join(OutputDir, 'concat.txt');
  const files = fs
    .readdirSync(VidsDir)
    .filter((file) => file.endsWith('.mp4'))
    .map((file) => `file '${path.join(VidsDir, file)}'`)
    .join('\n');

  fs.writeFileSync(concatPath, files);
  return concatPath;
}

function getTotalDurationSeconds() {
  if (cachedTotalDuration > 0) {
    return cachedTotalDuration;
  }

  const files = fs
    .readdirSync(VidsDir)
    .filter((file) => file.endsWith('.mp4'))
    .map((file) => path.join(VidsDir, file));

  let total = 0;
  for (const file of files) {
    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nokey=1:noprint_wrappers=1', file],
      { encoding: 'utf8' }
    );
    const duration = Number.parseFloat((probe.stdout || '').trim());
    if (Number.isFinite(duration) && duration > 0) {
      total += duration;
    }
  }

  cachedTotalDuration = total;
  return cachedTotalDuration;
}

function generateSegment(segmentIndex: number): Promise<string> {
  const segmentFile = path.join(OutputDir, `segment-${segmentIndex}.ts`);
  if (fs.existsSync(segmentFile) && fs.statSync(segmentFile).size > 0) {
    return Promise.resolve(segmentFile);
  }

  if (fs.existsSync(segmentFile)) {
    fs.rmSync(segmentFile, { force: true });
  }

  const totalDuration = getTotalDurationSeconds();
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    return Promise.reject(new Error('No probeable video duration found'));
  }

  const startTime = (segmentIndex * SegmentDuration) % totalDuration;

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-ss',
      `${startTime}`,
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concat(),
      '-t',
      `${SegmentDuration}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-f',
      'mpegts',
      segmentFile,
    ]);

    ffmpeg.on('error', (err) => {
      reject(new Error(`FFmpeg spawn failed: ${err.message}`));
    });

    ffmpeg.on('close', (code) => {
      if (code === 0 && fs.existsSync(segmentFile) && fs.statSync(segmentFile).size > 0) {
        resolve(segmentFile);
      } else {
        reject(new Error(`FFmpeg exit ${code}`));
      }
    });
  });
}

function ensureSegment(segmentIndex: number): Promise<string> {
  if (segmentIndex < 0) {
    return Promise.reject(new Error('Invalid segment index'));
  }

  const segmentFile = path.join(OutputDir, `segment-${segmentIndex}.ts`);
  if (fs.existsSync(segmentFile) && fs.statSync(segmentFile).size > 0) {
    return Promise.resolve(segmentFile);
  }

  if (fs.existsSync(segmentFile)) {
    fs.rmSync(segmentFile, { force: true });
  }

  const current = inFlightSegments.get(segmentIndex);
  if (current) {
    return current;
  }

  const job = generateSegment(segmentIndex).finally(() => {
    inFlightSegments.delete(segmentIndex);
  });

  inFlightSegments.set(segmentIndex, job);
  return job;
}

function cleanupOldSegments(currentIndex: number) {
  const minKeep = Math.max(0, currentIndex - RetainBackSegments);
  for (const file of fs.readdirSync(OutputDir)) {
    const match = file.match(/^segment-(\d+)\.ts$/);
    if (!match) {
      continue;
    }

    const idx = Number.parseInt(match[1], 10);
    if (idx < minKeep) {
      fs.rmSync(path.join(OutputDir, file), { force: true });
    }
  }
}

async function prebufferAroundCurrent() {
  if (!isRunning || !HasFfmpeg) {
    return;
  }

  const baseIndex = Math.floor(playbackTime / SegmentDuration);
  for (let i = 0; i < PrebufferSegments; i++) {
    try {
      await ensureSegment(baseIndex + i);
    } catch {
      break;
    }
  }

  cleanupOldSegments(baseIndex);
}

function startPrebufferLoop() {
  if (prebufferTimer) {
    return;
  }

  void prebufferAroundCurrent();
  prebufferTimer = setInterval(() => {
    void prebufferAroundCurrent();
  }, 1000);
}

function stopPrebufferLoop() {
  if (!prebufferTimer) {
    return;
  }

  clearInterval(prebufferTimer);
  prebufferTimer = null;
}

function firstHeaderValue(value: string | string[] | undefined) {
  if (!value) {
    return '';
  }

  return (Array.isArray(value) ? value[0] : value).split(',')[0].trim();
}

function getBaseUrl(req: http.IncomingMessage) {
  if (PublicBaseUrl) {
    return PublicBaseUrl;
  }

  const proto = firstHeaderValue(req.headers['x-forwarded-proto']) || 'http';
  const host = firstHeaderValue(req.headers['x-forwarded-host']) || req.headers.host;

  return `${proto}://${host}`;
}

function m3u8(baseUrl: string) {
  const segmentIndex = Math.floor(playbackTime / SegmentDuration);
  const targetDuration = SegmentDuration + 1;
  let playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${targetDuration}\n#EXT-X-MEDIA-SEQUENCE:${segmentIndex}\n`;

  for (let i = 0; i < 3; i++) {
    playlist += `#EXTINF:${SegmentDuration},\n${baseUrl}/live/segment-${segmentIndex + i}.ts\n`;
  }

  return playlist;
}

function tick() {
  if (!isRunning) {
    return;
  }

  playbackTime += 0.1;
  setTimeout(tick, 100);
}

function startPlayback(resetTime = false) {
  if (resetTime) {
    playbackTime = 0;
    cachedTotalDuration = 0;
  }

  if (isRunning) {
    return;
  }

  isRunning = true;
  tick();
  startPrebufferLoop();
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.headers.host) {
    res.statusCode = 400;
    res.end('Bad Request');
    return;
  }

  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname === '/live/stream.m3u8') {
    const videoCount = fs.readdirSync(VidsDir).filter((f) => f.endsWith('.mp4')).length;
    if (videoCount === 0) {
      res.statusCode = 404;
      res.end('No videos available');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(m3u8(getBaseUrl(req)));
    return;
  }

  if (/^\/live\/segment-\d+\.ts$/.test(pathname)) {
    if (!HasFfmpeg) {
      res.statusCode = 503;
      res.end('FFmpeg is not installed on this server');
      return;
    }

    const segmentFile = path.join(OutputDir, pathname.slice('/live/'.length));

    if (!fs.existsSync(segmentFile)) {
      const match = pathname.match(/\d+/);
      const segmentIndex = Number.parseInt(match ? match[0] : '0', 10);

      try {
        await ensureSegment(segmentIndex);
      } catch {
        res.statusCode = 404;
        res.end('Segment not found');
        return;
      }
    }

    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    res.end(fs.readFileSync(segmentFile));
    return;
  }

  res.statusCode = 404;
  res.end('Not found');
});

server.listen(ServePort, () => {
  startPlayback();
  console.log(`awaken`);
});
