// @ts-nocheck
const { state } = require('./state.ts');
const { PlaylistSegments } = require('./config.ts');
const { log } = require('./logger.ts');
const { getPrefetchStartSegment } = require('./media.ts');
const { prefetchContiguousWindow } = require('./segments.ts');

function tick() {
  if (!state.isRunning) {
    return;
  }

  const prefetchStart = getPrefetchStartSegment();
  prefetchContiguousWindow(prefetchStart, PlaylistSegments + 4);

  setTimeout(tick, 500);
}

function startPlayback(resetTime = false) {
  if (resetTime) {
    state.cachedTotalDuration = 0;
    state.cachedVideoTimeline = [];
  }

  if (state.isRunning) {
    return;
  }

  state.isRunning = true;
  tick();
}

module.exports = {
  tick,
  startPlayback,
};

export {};
