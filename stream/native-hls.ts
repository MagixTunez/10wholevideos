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
const { listVideoFiles, mediaDirForPlaylist } = require('./media.ts');

let nativeHlsNextSegmentNumber = 0;

function updateNextSegmentNumber(playlistPath) {
  try {
    if (!fs.existsSync(playlistPath)) return;
    const content = fs.readFileSync(playlistPath, 'utf8');
    const seqMatch = content.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
    if (!seqMatch) return;
    const mediaSeq = Number.parseInt(seqMatch[1], 10);
    const segCount = (content.match(/#EXTINF:/g) || []).length;
    nativeHlsNextSegmentNumber = mediaSeq + segCount;
  } catch {
  }
}

function startNativeHlsPipeline() {
  if (!UseNativeHls || state.nativeHlsProcess || !Checkff) {
    return;
  }

  const videos = listVideoFiles().sort();
  if (videos.length === 0) {
    log('warn', 'Native HLS pipeline not started because no videos were found');
    return;
  }

  const videoFilePaths = videos.map((f) =>
    path.join(mediaDirForPlaylist(state.activePlaylistName), f)
  );

  const playlistPath = path.join(OutputDir, 'stream.m3u8');
  const segmentPattern = path.join(OutputDir, 'segment-%d.ts');
  const fps = 30;
  const gop = Math.max(1, SegmentDuration * fps);
  const nativeHlsFlags = EnableProgramDateTime
    ? 'independent_segments+program_date_time+omit_endlist'
    : 'independent_segments+omit_endlist';

  // Each file is passed as a direct -i input (not through the concat demuxer) so
  // that each gets its own MP4 demuxer which correctly handles AVCC h264 and
  // non-standard AAC. We repeat the playlist repeatCount times then auto-restart.
  const repeatCount = 20;
  const nFiles = videoFilePaths.length;
  const totalSegments = nFiles * repeatCount;

  const inputArgs = [];
  for (let r = 0; r < repeatCount; r++) {
    for (const fp of videoFilePaths) {
      inputArgs.push('-i', fp);
    }
  }

  // Scale each input to the same size BEFORE concat (concat requires uniform dimensions).
  const perInputFilters = [];
  let concatInputs = '';
  for (let i = 0; i < totalSegments; i++) {
    perInputFilters.push(
      `[${i}:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,fps=fps=${fps}[v${i}]`
    );
    perInputFilters.push(
      `[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${i}]`
    );
    concatInputs += `[v${i}][a${i}]`;
  }
  const filterComplex = [
    ...perInputFilters,
    `${concatInputs}concat=n=${totalSegments}:v=1:a=1[v][a]`,
  ].join(';');

  const proc = spawn(FfmpegCommand, [
    '-y',
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '[v]',
    '-map', '[a]',
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-profile:v', 'baseline',
    '-level', '3.1',
    '-g', `${gop}`,
    '-keyint_min', `${gop}`,
    '-sc_threshold', '0',
    '-force_key_frames', `expr:gte(t,n_forced*${SegmentDuration})`,
    '-c:a', 'aac',
    '-b:a', '128k',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'hls',
    '-hls_time', `${SegmentDuration}`,
    '-hls_list_size', `${NativeHlsListSize}`,
    '-hls_flags', nativeHlsFlags,
    '-start_number', `${nativeHlsNextSegmentNumber}`,
    '-hls_delete_threshold', '10',
    '-hls_segment_filename', segmentPattern,
    playlistPath,
  ], { env: RuntimeEnv });

  state.nativeHlsProcess = proc;
  let lastNativeStderr = '';

  proc.stderr.on('data', (chunk) => {
    const text = String(chunk || '');
    if (!text) {
      return;
    }

    const merged = (lastNativeStderr + text).split(/\r?\n/);
    lastNativeStderr = merged.slice(-6).join('\n');

    const lowered = text.toLowerCase();
    if (lowered.includes('error') || lowered.includes('failed') || lowered.includes('invalid') || lowered.includes('could not') || lowered.includes('no such file')) {
      log('warn', 'ffmpeg native hls stderr', { message: text.trim() });
    }
  });

  proc.on('close', (code) => {
    if (code !== 0 && lastNativeStderr) {
      log('warn', 'Native HLS pipeline stderr before exit', { code, stderr: lastNativeStderr });
    }
    log('info', 'Native HLS pipeline exited, restarting', { code });
    updateNextSegmentNumber(playlistPath);
    state.nativeHlsProcess = null;
    setTimeout(() => startNativeHlsPipeline(), 500);
  });

  proc.on('error', (err) => {
    log('error', 'Native HLS pipeline failed to start', { error: err.message });
    state.nativeHlsProcess = null;
  });

  log('info', 'Native HLS pipeline started', {
    videos: videos.length,
    repeatCount,
    totalSegments,
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
