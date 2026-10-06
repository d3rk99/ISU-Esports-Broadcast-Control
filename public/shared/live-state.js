// Live controller state for overlay pages. WebSocket first (/ws): OBS browser sources share
// one Chromium that allows only 6 open HTTP connections per server, so SSE (/events) stalls
// the 7th page. Falls back to SSE if the WebSocket can't connect. Reconnects on its own.
window.isuLiveState = function isuLiveState(onState) {
  let fallback = null; let opened = false; let retry = 1000;
  const parse = (text) => { try { onState(JSON.parse(text)); } catch {} };
  function useSse() {
    if (fallback) return;
    fallback = new EventSource('/events');
    fallback.onmessage = (event) => parse(event.data);
  }
  function connect() {
    let ws;
    try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`); }
    catch { useSse(); return; }
    ws.onopen = () => { opened = true; retry = 1000; if (fallback) { fallback.close(); fallback = null; } };
    ws.onmessage = (event) => parse(event.data);
    ws.onclose = () => {
      if (!opened) useSse(); // server without /ws (older controller): stay on SSE
      setTimeout(connect, retry);
      retry = Math.min(10000, retry * 2);
    };
  }
  connect();
};
