'use strict';

const crypto = require('node:crypto');

// Shared liveness + auth helpers for the Game PC <-> Graphics PC bridge sockets.
// A cable pull or Wi-Fi drop doesn't close a TCP socket, so both sides ping and
// terminate a link that stops answering; the normal reconnect logic then takes over.
const BRIDGE_PING_INTERVAL_MS = 5000;
const BRIDGE_MAX_PAYLOAD = 8 * 1024 * 1024; // bridge packets are small JSON; the ws default is 100 MB

function bridgeKeyMatches(expected = '', provided = '') {
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(provided || ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Pings `socket` every interval; if a pong hasn't come back since the previous ping,
// the socket is terminated (fires 'close', so existing reconnect/cleanup code runs).
// Returns a stop() function. Safe to call on either end of the link.
function keepAlive(socket, { intervalMs = BRIDGE_PING_INTERVAL_MS, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  let alive = true;
  const onPong = () => { alive = true; };
  socket.on?.('pong', onPong);
  const timer = setIntervalImpl(() => {
    if (!alive) {
      stop();
      try { socket.terminate?.(); } catch {}
      return;
    }
    alive = false;
    try { socket.ping?.(); } catch {}
  }, intervalMs);
  timer?.unref?.();
  function stop() {
    clearIntervalImpl(timer);
    socket.off?.('pong', onPong);
  }
  socket.on?.('close', stop);
  return stop;
}

module.exports = { BRIDGE_MAX_PAYLOAD, BRIDGE_PING_INTERVAL_MS, bridgeKeyMatches, keepAlive };
