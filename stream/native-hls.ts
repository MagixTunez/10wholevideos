// @ts-nocheck
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  RuntimeEnv,
  OutputDir,
  SegmentDuration,
  NativeHlsListSize,
  UseNativeHls,
  Checkff,
  FfmpegCommand,
  EnableProgramDateTime,
  SyncLiveWindowSegments,
  HardSyncStartOffsetSeconds,
} = require('./config.ts');
const { state } = require('./state.ts');
const { log } = require('./logger.ts');
const { listVideoFiles, clearLiveSegments, writeConcatFile } = require('./media.ts');

function startNativeHlsPipeline() {
  if (!UseNativeHls || state.nativeHlsProcess || !Checkff) {
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

  state.nativeHlsProcess = proc;

  proc.stderr.on('data', () => {
    // Keep ffmpeg stderr drained to avoid blocking.
  });

  proc.on('close', (code) => {
    log('warn', 'Native HLS pipeline exited', { code });
    state.nativeHlsProcess = null;
  });

  proc.on('error', (err) => {
    log('error', 'Native HLS pipeline failed to start', { error: err.message });
    state.nativeHlsProcess = null;
  });

  log('info', 'Native HLS pipeline started', {
    videos: videos.length,
    playlistPath,
    nativeHlsFlags,
  });
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

module.exports = {
  startNativeHlsPipeline,
  normalizeNativePlaylistForSync,
};

export {};
