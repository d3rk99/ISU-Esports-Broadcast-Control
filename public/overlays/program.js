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
  let currentScene = null;
  let transitionTimer = null;
  let pendingRender = null;

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

  function transitionSeconds(state = {}) {
    return Math.max(0.1, Math.min(5, Number(state.programTransitionSeconds) || 1));
  }

  function createScene(name, state = {}) {
    const scene = document.createElement('section');
    scene.className = 'program-scene';
    if (name === 'clean') {
      if (outputMode === 'pair') scene.append(createCleanPanel('fill'), createCleanPanel('key'));
      else scene.append(createCleanPanel(outputMode));
      return scene;
    }
    if (outputMode === 'pair') {
      scene.append(createFrame(name, 'fill', state), createFrame(name, 'key', state));
      return scene;
    }
    scene.append(createFrame(name, outputMode, state));
    return scene;
  }

  function appendScene(name, state) {
    currentScene = createScene(name, state);
    root.append(currentScene);
  }

  function render(state = {}) {
    currentState = state;
    const name = selectedOverlay(state);
    const rosterProgram = name === 'roster' ? state.activeRoster || 'varsity' : '';
    const duration = transitionSeconds(state);
    root.style.setProperty('--program-transition', `${duration}s`);
    const signature = `${outputMode}:${name}:${rosterProgram}:${duration}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    if (!currentScene) {
      appendScene(name, state);
      return;
    }
    pendingRender = { name, state, signature, duration };
    if (transitionTimer) return;
    const previousScene = currentScene;
    currentScene = null;
    previousScene.classList.add('exiting');
    transitionTimer = window.setTimeout(() => {
      previousScene.remove();
      transitionTimer = null;
      const next = pendingRender;
      pendingRender = null;
      if (!next) return;
      root.style.setProperty('--program-transition', `${next.duration}s`);
      appendScene(next.name, next.state);
    }, Math.ceil(duration * 1000) + 80);
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
