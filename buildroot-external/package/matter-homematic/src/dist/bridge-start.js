'use strict';
// CCU discovery can take several minutes after a power interruption. Never
// publish an incomplete topology; retry with fresh instances after cleanup.
async function start(ref, create, {
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  windowMs = 600000,
  onError = () => {}
} = {}) {
  const deadline = now() + windowMs;
  for (;;) {
    try {
      await ref.bridge.start();
      return;
    } catch (error) {
      onError(error);
      // Cleanup failure must abort: another instance could collide with sockets.
      await ref.bridge.stop();
      if (now() >= deadline) throw error;
      await sleep(Math.min(3000, Math.max(0, deadline - now())));
      if (now() >= deadline) throw error;
      ref.bridge = create();
    }
  }
}
module.exports={start};
