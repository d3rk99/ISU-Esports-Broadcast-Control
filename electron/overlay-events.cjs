'use strict';

// Server-Sent Events hub for OBS overlays (/events).
// - Backpressure: a viewer that stops reading (background tab, sleeping laptop, frozen
//   browser source) would otherwise buffer every full-state message forever. Once a
//   client has more than MAX_BUFFERED_BYTES waiting, it is dropped; EventSource
//   reconnects on its own and gets the fresh state on connect.
// - Heartbeat: an SSE comment every HEARTBEAT_MS keeps quiet streams from being cut by
//   idle timeouts. Comments (lines starting with ':') are ignored by EventSource.
const MAX_BUFFERED_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 15000;

class OverlayEventHub {
  constructor({ maxBufferedBytes = MAX_BUFFERED_BYTES, heartbeatMs = HEARTBEAT_MS, onDrop = () => {} } = {}) {
    this.maxBufferedBytes = maxBufferedBytes;
    this.heartbeatMs = heartbeatMs;
    this.onDrop = onDrop;
    this.clients = new Set();
    this.dropped = 0;
    this.heartbeatTimer = null;
  }

  get size() {
    return this.clients.size;
  }

  // Takes over an HTTP response as an SSE stream and sends the initial state.
  add(request, response, initialState) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    // Reconnect quickly if we drop this client for being too far behind.
    response.write(`retry: 1000\ndata: ${JSON.stringify(initialState)}\n\n`);
    this.clients.add(response);
    const remove = () => this.clients.delete(response);
    request.on('close', remove);
    response.on('close', remove);
    response.on('error', remove);
    this.ensureHeartbeat();
  }

  send(chunk) {
    for (const client of this.clients) {
      if (client.destroyed || client.writableEnded) {
        this.clients.delete(client);
        continue;
      }
      if (client.writableLength > this.maxBufferedBytes) {
        this.drop(client);
        continue;
      }
      client.write(chunk);
    }
  }

  publish(state) {
    this.send(`data: ${JSON.stringify(state)}\n\n`);
  }

  heartbeat() {
    this.send(': ping\n\n');
  }

  drop(client) {
    this.clients.delete(client);
    this.dropped += 1;
    this.onDrop({ buffered: client.writableLength, dropped: this.dropped });
    try { client.destroy(); } catch {}
  }

  ensureHeartbeat() {
    if (this.heartbeatTimer || !this.heartbeatMs) return;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  close() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const client of this.clients) {
      try { client.end(); } catch {}
    }
    this.clients.clear();
  }
}

module.exports = { OverlayEventHub, MAX_BUFFERED_BYTES, HEARTBEAT_MS };
