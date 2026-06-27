// @ts-nocheck
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {
OutputDir,
UseNativeHls,
UseMasterPlaylist,
EnableNativePlaylistSyncRewrite,
PubUrl,
Checkff,
Checkprobe,
PlaylistSegments,
} = require('./config.ts');
const { state } = require('./state.ts');
const { log } = require('./logger.ts');
const { startPlayback } = require('./playback.ts');
const {
  activatePlaylist,
  discoverPlaylistNames,
  playlistExists,
  listVideoFiles,
  m3u8,
  masterM3u8,
  isVariantPath,
  playlistNameFromVariantPath,
  playlistNameFromSegmentPath,
  getLiveWindowStartSegment,
  getPrefetchStartSegment,
  findLatestReadyWindowStart,
  segmentFilePath,
  isSegmentHealthy,
} = require('./media.ts');
const { prefetchContiguousWindow, ensureSegment } = require('./segments.ts');
const { startNativeHlsPipeline, normalizeNativePlaylistForSync } = require('./native-hls.ts');

function firstHeaderValue(value) {
  if (!value) {
    return '';
  }
  return (Array.isArray(value) ? value[0] : value).split(',')[0].trim();
}
function getBaseUrl(req) {
  if (PubUrl) {
    return PubUrl;
  }
  const proto = firstHeaderValue(req.headers['x-forwarded-proto']) || 'http';
  const host = firstHeaderValue(req.headers['x-forwarded-host']) || req.headers.host;
  return `${proto}://${host}`;
}
function writeM3u8(res, body) {
  res.writeHead(200, {
'Content-Type': 'application/vnd.apple.mpegurl',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
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

function createServer() {
  return http.createServer(async (req, res) => {
    if (!req.url || !req.headers.host) {
      res.statusCode = 400;
      res.end('Bad Request');
      return;
    }

    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    if (pathname === '/live/stream.m3u8') {
      state.streamPlaylistPollCount += 1;
      const now = Date.now();
      if (now - state.lastStreamPlaylistPollLogAt >= 2000) {
        log('info', 'Incoming stream playlist poll summary', {
          polls: state.streamPlaylistPollCount,
          windowMs: now - state.lastStreamPlaylistPollLogAt,
        });
        state.streamPlaylistPollCount = 0;
        state.lastStreamPlaylistPollLogAt = now;
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
          activatePlaylist('', () => startPlayback(true));
          const desiredSegmentIndex = getLiveWindowStartSegment();
          const prefetchStart = getPrefetchStartSegment();
          if (Checkff && Checkprobe) {
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
      activatePlaylist(playlistName, () => startPlayback(true));
      const videos = listVideoFiles();
      const videoCount = videos.length;
      log('info', 'Requested playlist', { pathname, playlistName, videoCount, videos, ffmpegAvailable: Checkff });
      if (videoCount === 0) {
        res.statusCode = 404;
        res.end('No videos available');
        return;
      }
      const segmentIndex = getLiveWindowStartSegment();
      const prefetchStart = getPrefetchStartSegment();
      if (Checkff && Checkprobe) {
        prefetchContiguousWindow(prefetchStart, PlaylistSegments + 2);
      }

      let playlist = m3u8(getBaseUrl(req), segmentIndex);
      if (!playlist) {
        const fallbackStart = findLatestReadyWindowStart(state.activePlaylistName);
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
      activatePlaylist(playlistName, () => startPlayback(true));
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
      if (!Checkff || !Checkprobe) {
        log('warn', 'Segment requested but ffmpeg/ffprobe is not installed', {
          ffmpegAvailable: Checkff,
          ffprobeAvailable: Checkprobe,
        });
        res.statusCode = 503;
        res.end('FFmpeg/ffprobe is not installed! Please install it.');
        return;
      }
      const match = pathname.match(/\d+/);
      const segmentIndex = Number.parseInt(match ? match[0] : '0', 10);
      const segmentFile = segmentFilePath(segmentIndex, state.activePlaylistName);
      const exists = fs.existsSync(segmentFile);
      const healthy = isSegmentHealthy(segmentIndex, state.activePlaylistName);
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
}
module.exports = {
  createServer,
};
export {};
