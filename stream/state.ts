// @ts-nocheck
const state = {
  isRunning: false,
  inFlightSegments: new Map(),
  cachedTotalDuration: 0,
  cachedVideoTimeline: [],
  segmentDurationCache: new Map(),
  segmentSourceCache: new Map(),
  pQueueInstancePromise: null,
  fallbackSegmentQueue: {
    active: 0,
    pending: [],
  },
  nativeHlsProcess: null,
  activePlaylistName: '',
  liveHeadSegmentIndex: -1,
  streamPlaylistPollCount: 0,
  lastStreamPlaylistPollLogAt: Date.now(),
};

module.exports = {
  state,
};

export {};
