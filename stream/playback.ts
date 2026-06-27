// @ts-nocheck
const { state } = require('./state.ts');

function tick() {
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
}

module.exports = {
  tick,
  startPlayback,
};

export {};
