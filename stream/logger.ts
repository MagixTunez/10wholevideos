// @ts-nocheck
function log(level, message, ...meta) {
  const stamp = new Date().toISOString();
  const sink = typeof console[level] === 'function' ? console[level] : console.log;
  if (meta.length > 0) {
    sink(`[stream ${stamp}] ${message}`, meta[0]);
    return;
  }

  sink(`[stream ${stamp}] ${message}`);
}

module.exports = {
  log,
};

export {};
