(() => {
  const query = new URLSearchParams(location.search);
  const allowedOutputs = new Set(['fill', 'key', 'pair']);
  const outputMode = allowedOutputs.has((query.get('output') || '').toLowerCase())
    ? query.get('output').toLowerCase()
    : 'fill';
  const allowedOverlays = new Set(['scoreboard', 'roster', 'map-pool', 'clean']);
  const root = document.querySelector('#program-root');
  let lastSignature = '';
  let currentState = {};

  document.body.dataset.output = outputMode;

  function selectedOverlay(state = {}) {
    return allowedOverlays.has(state.activeOutputOverlay) ? state.activeOutputOverlay : 'scoreboard';
  }

  function overlayUrl(name, mode, state = {}) {
    const url = new URL(`./${name}.html`, location.href);
    url.searchParams.set('output', mode);
    if (name === 'roster') url.searchParams.set('program', state.activeRoster || 'varsity');
    return url.toString();
  }

  function createFrame(name, mode, state) {
    const frame = document.createElement('iframe');
    frame.className = 'program-frame';
    frame.dataset.output = mode;
    frame.allowTransparency = 'true';
    frame.src = overlayUrl(name, mode, state);
    return frame;
  }

  function createCleanPanel(mode) {
    const panel = document.createElement('section');
    panel.className = `program-clean program-clean-${mode}`;
    panel.dataset.output = mode;
    return panel;
  }

  function render(state = {}) {
    currentState = state;
    const name = selectedOverlay(state);
    const rosterProgram = name === 'roster' ? state.activeRoster || 'varsity' : '';
    const signature = `${outputMode}:${name}:${rosterProgram}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    root.replaceChildren();
    if (name === 'clean') {
      if (outputMode === 'pair') root.append(createCleanPanel('fill'), createCleanPanel('key'));
      else root.append(createCleanPanel(outputMode));
      return;
    }
    if (outputMode === 'pair') {
      root.append(createFrame(name, 'fill', state), createFrame(name, 'key', state));
      return;
    }
    root.append(createFrame(name, outputMode, state));
  }

  window.setProgramOutputOverlay = (name) => {
    if (!allowedOverlays.has(name)) return false;
    render({ ...currentState, activeOutputOverlay: name });
    return true;
  };

  async function start() {
    try {
      const state = await fetch('/api/state', { cache: 'no-store' }).then((response) => response.json());
      render(state);
    } catch {
      render({});
    }
    const events = new EventSource('/events');
    events.onmessage = (event) => {
      try { render(JSON.parse(event.data)); } catch {}
    };
  }

  document.addEventListener('DOMContentLoaded', start);
})();
