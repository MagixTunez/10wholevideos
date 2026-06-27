// @ts-nocheck
// This wouldn't have been done without the help of globcom at https://github.com/globocom/m3u8/blob/master/tests/playlists/simple-playlist.m3u8
// and liek some other people who have written m3u8 parsers. Love, the Rec Room Archive! [(=|]
const fs = require('node:fs');
const path = require('node:path');
const { VidsDir, OutputDir, PlaylistSegments, SegmentDuration, MinSegmentBytes } = require('./config.ts');
const { state } = require('./state.ts');

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

function listVideoFiles(playlistName = state.activePlaylistName) {
  const dir = mediaDirForPlaylist(playlistName);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return [];
  }

  return fs.readdirSync(dir).filter((file) => file.toLowerCase().endsWith('.mp4'));
}

function activatePlaylist(playlistName, onActivate) {
  const next = playlistName || '';
  if (state.activePlaylistName === next) {
    return;
  }

  state.isRunning = false;
  state.cachedTotalDuration = 0;
  state.cachedVideoTimeline = [];
  state.inFlightSegments.clear();
  state.segmentDurationCache.clear();
  state.segmentSourceCache.clear();
  state.liveHeadSegmentIndex = -1;
  state.activePlaylistName = next;
  if (typeof onActivate === 'function') {
    onActivate();
  }
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
    .map((file) => `file '${path.join(mediaDirForPlaylist(state.activePlaylistName), file).replace(/\\/g, '/')}'`)
    .join('\n');

  fs.writeFileSync(concatPath, lines, 'utf8');
  return concatPath;
}
function segmentFilePath(segmentIndex, playlistName = state.activePlaylistName) {
  return path.join(liveDirForPlaylist(playlistName), `segment-${segmentIndex}.ts`);
}
function isSegmentReady(segmentIndex, playlistName = state.activePlaylistName) {
  const file = segmentFilePath(segmentIndex, playlistName);
  return fs.existsSync(file) && fs.statSync(file).size > 0;
}
function isSegmentHealthy(segmentIndex, playlistName = state.activePlaylistName) {
  const file = segmentFilePath(segmentIndex, playlistName);
  return fs.existsSync(file) && fs.statSync(file).size >= MinSegmentBytes;
}
function clearLiveSegments(playlistName = state.activePlaylistName) {
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

  state.segmentDurationCache.clear();
  state.segmentSourceCache.clear();
  state.liveHeadSegmentIndex = -1;
}

function findLatestReadyWindowStart(playlistName = state.activePlaylistName) {
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

function contiguousReadyCount(segmentIndex) {
  let contiguousCount = 0;
  for (let i = 0; i < PlaylistSegments; i++) {
    if (!isSegmentReady(segmentIndex + i, state.activePlaylistName)) {
      break;
    }

    contiguousCount++;
  }

  return contiguousCount;
}

function getLiveWindowStartSegment() {
  if (state.liveHeadSegmentIndex >= 0) {
    return Math.max(0, state.liveHeadSegmentIndex - (PlaylistSegments - 1));
  }

  return findLatestReadyWindowStart(state.activePlaylistName);
}

function getPrefetchStartSegment() {
  if (state.liveHeadSegmentIndex >= 0) {
    return state.liveHeadSegmentIndex + 1;
  }

  const latestWindowStart = findLatestReadyWindowStart(state.activePlaylistName);
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
    const cached = state.segmentDurationCache.get(idx);
    return Number.isFinite(cached) && cached > 0 ? cached : SegmentDuration;
  });
  const maxDuration = durations.reduce((max, value) => Math.max(max, value), SegmentDuration);
  const targetDuration = Math.max(1, Math.ceil(maxDuration));
  const startOffset = Math.max(1, SegmentDuration * 1.25).toFixed(3);
  let playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-ALLOW-CACHE:NO\n#EXT-X-TARGETDURATION:${targetDuration}\n#EXT-X-MEDIA-SEQUENCE:${segmentIndex}\n#EXT-X-START:TIME-OFFSET=-${startOffset},PRECISE=YES\n`;

  for (let i = 0; i < contiguousCount; i++) {
    const idx = segmentIndex + i;

    const segmentPath = state.activePlaylistName
      ? `/live/${state.activePlaylistName}/segment-${idx}.ts`
      : `/live/segment-${idx}.ts`;
    const extinf = durations[i];
    playlist += `#EXTINF:${extinf.toFixed(3)},\n${segmentPath}\n`;
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

module.exports = {
  mediaDirForPlaylist,
  liveDirForPlaylist,
  listVideoFiles,
  activatePlaylist,
  discoverPlaylistNames,
  playlistExists,
  writeConcatFile,
  segmentFilePath,
  isSegmentReady,
  isSegmentHealthy,
  clearLiveSegments,
  findLatestReadyWindowStart,
  contiguousReadyCount,
  getLiveWindowStartSegment,
  getPrefetchStartSegment,
  m3u8,
  masterM3u8,
  isVariantPath,
  playlistNameFromVariantPath,
  playlistNameFromSegmentPath,
};

export {};
