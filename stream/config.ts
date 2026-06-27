// @ts-nocheck
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

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

function commandAvailable(command, runtimeEnv) {
  const check = spawnSync(command, ['-version'], { stdio: 'ignore', env: runtimeEnv });
  return !check.error && check.status === 0;
}

loadEnvFile();
const RuntimeEnv = buildRuntimeEnv();

const ServePort = 5181;
const VidsDir = path.join(process.cwd(), 'media');
const OutputDir = path.join(process.cwd(), 'live');
const SegmentDuration = Math.max(1, Number.parseInt(process.env.segmentDuration || '4', 10) || 4);
const PlaylistSegments = Math.max(6, Number.parseInt(process.env.playlistSegments || '12', 10) || 12);
const NativeHlsListSize = Math.max(8, Number.parseInt(process.env.nativeHlsListSize || `${PlaylistSegments + 6}`, 10) || (PlaylistSegments + 6));
const StartupWarmupSegments = 10;
const MinSegmentBytes = 4096;
const UseNativeHls = (process.env.useNativeHls || '0') !== '0';
const EnableProgramDateTime = (process.env.hlsProgramDateTime || '0') === '1';
const EnableNativePlaylistSyncRewrite = (process.env.enableNativePlaylistSyncRewrite || '0') === '1';
const UseMasterPlaylist = true;
const PubUrl = process.env.basehost?.replace(/\/+$/, '');
const FfmpegCommand = process.env.ffmpegPath || ffmpegStaticPath || 'ffmpeg';
const FfprobeCommand = process.env.ffprobePath || ffprobeStaticPath || 'ffprobe';
const Checkff = commandAvailable(FfmpegCommand, RuntimeEnv);
const Checkprobe = commandAvailable(FfprobeCommand, RuntimeEnv);
const SegmentQueueConcurrency = Math.max(1, Number.parseInt(process.env.segmentQueueConcurrency || '2', 10) || 2);
const SyncLiveWindowSegments = Math.max(3, Number.parseInt(process.env.syncLiveWindowSegments || '5', 10) || 5);
const HardSyncStartOffsetSeconds = Math.max(
  0.5,
  Number.parseFloat(process.env.hardSyncStartOffsetSeconds || `${Math.max(2, SegmentDuration * 2)}`) || Math.max(2, SegmentDuration * 2)
);

module.exports = {
  RuntimeEnv,
  ServePort,
  VidsDir,
  OutputDir,
  SegmentDuration,
  PlaylistSegments,
  NativeHlsListSize,
  StartupWarmupSegments,
  MinSegmentBytes,
  UseNativeHls,
  EnableProgramDateTime,
  EnableNativePlaylistSyncRewrite,
  UseMasterPlaylist,
  PubUrl,
  FfmpegCommand,
  FfprobeCommand,
  Checkff,
  Checkprobe,
  SegmentQueueConcurrency,
  SyncLiveWindowSegments,
  HardSyncStartOffsetSeconds,
};

export {};
