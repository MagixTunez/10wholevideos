// @ts-nocheck
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  RuntimeEnv,
  SegmentDuration,
  PlaylistSegments,
  SegmentQueueConcurrency,
  FfmpegCommand,
  FfprobeCommand,
  Checkprobe,
} = require('./config.ts');
const { state } = require('./state.ts');
const { log } = require('./logger.ts');
const {
  mediaDirForPlaylist,
  liveDirForPlaylist,
  listVideoFiles,
  segmentFilePath,
  isSegmentReady,
} = require('./media.ts');

function getField(value, key, fallback) {
  if (!value || typeof value !== 'object') {
    return fallback;
  }

  const field = Reflect.get(value, key);
  return field === undefined ? fallback : field;
}

function getVideoTimeline() {
  if (state.cachedVideoTimeline.length > 0) {
    return state.cachedVideoTimeline;
  }

  const files = listVideoFiles().sort().map((fileName) => ({
    fileName,
    filePath: path.join(mediaDirForPlaylist(state.activePlaylistName), fileName),
  }));

  const timeline = [];
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

  state.cachedVideoTimeline = timeline;
  return state.cachedVideoTimeline;
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

function getTotalDurationSeconds() {
  if (state.cachedTotalDuration > 0) {
    return state.cachedTotalDuration;
  }

  const timeline = getVideoTimeline();
  state.cachedTotalDuration = timeline.length > 0 ? timeline[timeline.length - 1].end : 0;
  log('info', 'Computed total media duration (seconds)', {
    totalDuration: state.cachedTotalDuration,
    files: timeline.length,
  });
  return state.cachedTotalDuration;
}

function runFfmpegToSegment(sourcePath, sourceOffset, segmentFile) {
  return new Promise((resolve) => {
    const tempSegmentFile = `${segmentFile}.part`;
    try {
      if (fs.existsSync(tempSegmentFile)) {
        fs.rmSync(tempSegmentFile, { force: true });
      }
    } catch {
    }

    const ffmpeg = spawn(FfmpegCommand, [
      '-y',
      '-fflags',
      '+genpts',
      '-ss',
      `${sourceOffset}`,
      '-i',
      sourcePath,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-sn',
      '-dn',
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
      '-af',
      'aresample=async=1:first_pts=0',
      '-muxpreload',
      '0',
      '-muxdelay',
      '0',
      '-f',
      'mpegts',
      tempSegmentFile,
    ], { env: RuntimeEnv });

    let stderr = '';
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on('error', (err) => {
      resolve({ ok: false, code: -1, stderr, spawnError: err.message });
    });

    ffmpeg.on('close', (code) => {
      let ok = false;
      if (code === 0 && fs.existsSync(tempSegmentFile) && fs.statSync(tempSegmentFile).size > 0) {
        try {
          if (fs.existsSync(segmentFile)) {
            fs.rmSync(segmentFile, { force: true });
          }
          fs.renameSync(tempSegmentFile, segmentFile);
          ok = fs.existsSync(segmentFile) && fs.statSync(segmentFile).size > 0;
        } catch (err) {
          stderr += `\nrename failed: ${err && typeof err === 'object' ? Reflect.get(err, 'message') : String(err)}`;
          ok = false;
        }
      }

      if (fs.existsSync(tempSegmentFile)) {
        try {
          fs.rmSync(tempSegmentFile, { force: true });
        } catch {
        }
      }

      resolve({ ok, code, stderr });
    });
  });
}

function probeDurationSeconds(filePath) {
  if (!Checkprobe || !fs.existsSync(filePath)) {
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

function generateSegment(segmentIndex) {
  const segmentFile = segmentFilePath(segmentIndex);
  const liveDir = liveDirForPlaylist(state.activePlaylistName);
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

  const remainingInSource = target.sourceDuration - safeOffset;
  const minimumUsefulSlice = Math.max(1, SegmentDuration * 0.75);
  if (remainingInSource < minimumUsefulSlice && timeline.length > 1) {
    const nextIndex = (target.timelineIndex + 1) % timeline.length;
    const next = timeline[nextIndex];
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
      state.segmentSourceCache.set(segmentIndex, selectedName);
      const generatedDuration = probeDurationSeconds(segmentFile);
      if (generatedDuration > 0) {
        state.segmentDurationCache.set(segmentIndex, generatedDuration);
      }
      const maxForwardJump = PlaylistSegments + 8;
      if (state.liveHeadSegmentIndex < 0 || segmentIndex <= state.liveHeadSegmentIndex + maxForwardJump) {
        state.liveHeadSegmentIndex = Math.max(state.liveHeadSegmentIndex, segmentIndex);
      }
      log('info', 'Segment generated', { segmentIndex, segmentFile });
      resolve(segmentFile);
      return;
    }

    if (primarySpawnError) {
      log('error', 'ffp spawn failed', { segmentIndex, error: primarySpawnError });
      reject(new Error(`ffp spawn failed: ${primarySpawnError}`));
      return;
    }

    const nearEnd = target.sourceDuration - safeOffset < SegmentDuration;
    if (nearEnd && timeline.length > 1) {
      const nextIndex = (target.timelineIndex + 1) % timeline.length;
      const next = timeline[nextIndex];
      log('warn', 'Retrying segment from next source file after near-end failure', {
        segmentIndex,
        failedFile: target.fileName,
        nextFile: next.fileName,
      });

      const fallback = await runFfmpegToSegment(next.filePath, 0, segmentFile);
      if (getField(fallback, 'ok', false) === true) {
        state.segmentSourceCache.set(segmentIndex, next.fileName);
        const generatedDuration = probeDurationSeconds(segmentFile);
        if (generatedDuration > 0) {
          state.segmentDurationCache.set(segmentIndex, generatedDuration);
        }
        const maxForwardJump = PlaylistSegments + 8;
        if (state.liveHeadSegmentIndex < 0 || segmentIndex <= state.liveHeadSegmentIndex + maxForwardJump) {
          state.liveHeadSegmentIndex = Math.max(state.liveHeadSegmentIndex, segmentIndex);
        }
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

async function getSegmentQueue() {
  if (state.pQueueInstancePromise) {
    return state.pQueueInstancePromise;
  }

  state.pQueueInstancePromise = Promise.resolve()
    .then(() => {
      const dynamicImport = (specifier) => eval('import(specifier)');
      return dynamicImport('p-queue');
    })
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

  return state.pQueueInstancePromise;
}

function runFallbackQueued(task) {
  return new Promise((resolve, reject) => {
    state.fallbackSegmentQueue.pending.push({ task, resolve, reject });

    const pump = () => {
      while (
        state.fallbackSegmentQueue.active < SegmentQueueConcurrency
        && state.fallbackSegmentQueue.pending.length > 0
      ) {
        const next = state.fallbackSegmentQueue.pending.shift();
        if (!next) {
          continue;
        }

        state.fallbackSegmentQueue.active += 1;
        Promise.resolve()
          .then(next.task)
          .then(next.resolve, next.reject)
          .finally(() => {
            state.fallbackSegmentQueue.active -= 1;
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

function ensureSegment(segmentIndex) {
  if (segmentIndex < 0) {
    return Promise.reject(new Error('Invalid segment index'));
  }

  const current = state.inFlightSegments.get(segmentIndex);
  if (current) {
    return current;
  }

  const segmentFile = segmentFilePath(segmentIndex);
  if (isSegmentReady(segmentIndex)) {
    return Promise.resolve(segmentFile);
  }

  const job = enqueueSegmentTask(() => generateSegment(segmentIndex)).finally(() => {
    state.inFlightSegments.delete(segmentIndex);
  });

  state.inFlightSegments.set(segmentIndex, job);
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

module.exports = {
  getVideoTimeline,
  resolveTimelineTarget,
  getTotalDurationSeconds,
  ensureSegment,
  preGenerateFromIndex,
  prefetchContiguousWindow,
};

export {};
