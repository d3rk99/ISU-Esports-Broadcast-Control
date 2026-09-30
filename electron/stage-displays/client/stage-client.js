const video = document.querySelector('#gameplay');
const presetShell = document.querySelector('#preset-shell');
const presetFrame = document.querySelector('#preset-frame');
const preloadFrame = document.querySelector('#preload-frame');
const eyebrow = document.querySelector('#eyebrow');
const headline = document.querySelector('#headline');
const subhead = document.querySelector('#subhead');
const configOpen = document.querySelector('#config-open');
const configClose = document.querySelector('#config-close');
const configForm = document.querySelector('#config-form');
const configStatus = document.querySelector('#config-status');
const settingsOnly = new URLSearchParams(window.location.search).get('settings') === '1';

let config = null;
let activeStream = null;
let pendingTimer = null;
let cursorHideTimer = null;
let currentMode = 'hold';
let activePreset = '';
let preparedPreset = null;

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function stopGameplayStream() {
  if (activeStream) {
    for (const track of activeStream.getTracks()) track.stop();
    activeStream = null;
  }
  video.srcObject = null;
}

function reportStatus(error = '') {
  window.stageClient?.reportStatus({
    mode: currentMode,
    ready: !error,
    preset: error ? '' : activePreset,
    error
  });
}

async function startGameplayMirror() {
  const source = await window.stageClient.getPlayerSource();
  if (!source?.id) throw new Error('Player display capture source not found');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: source.id,
        maxFrameRate: 60
      }
    }
  });
  stopGameplayStream();
  activeStream = stream;
  video.srcObject = stream;
  await video.play();
}

function setSceneText(mode, details = {}) {
  const station = details.stationId || config?.stationId || 1;
  const card = document.querySelector('.scene-card');
  card?.style.removeProperty('--team-color');
  card?.style.removeProperty('--team-secondary');
  card?.classList.remove('individual-card');
  eyebrow.textContent = mode === 'graphic' ? 'MIRROR GRAPHIC' : 'IDAHO STATE ESPORTS';
  if (mode === 'wall') {
    headline.textContent = `WALL ${station}`;
    subhead.textContent = `Virtual canvas segment ${details.wallPosition || station} of 10`;
    return;
  }
  if (mode === 'individual') {
    const content = details.individualContent || {};
    card?.classList.add('individual-card');
    card?.style.setProperty('--team-color', content.teamColor || '#f47920');
    card?.style.setProperty('--team-secondary', content.teamSecondaryColor || '#101012');
    const media = String(content.portrait || content.characterImage || content.teamLogo || '');
    eyebrow.textContent = content.teamName || `STATION ${String(station).padStart(2, '0')}`;
    headline.innerHTML = media ? `<img src="${escapeHtml(media)}" alt="">` : '';
    subhead.innerHTML = `
      <strong>${escapeHtml(content.handle || `Station ${String(station).padStart(2, '0')}`)}</strong>
      <span>${escapeHtml(content.name || content.role || content.character ? [content.name, content.role, content.character].filter(Boolean).join(' / ') : 'No roster player assigned')}</span>
    `;
    return;
  }
  if (mode === 'graphic') {
    headline.textContent = details.preset ? details.preset.replaceAll('-', ' ') : 'MIRROR GRAPHIC';
    subhead.textContent = 'Mirror graphic mode';
    return;
  }
  headline.textContent = 'HOLD';
  subhead.textContent = 'Safe stage graphic';
}

function clearPresetFrame() {
  document.body.classList.remove('using-preset');
  document.body.classList.remove('using-preloaded-preset');
  presetFrame.removeAttribute('src');
  presetFrame.style.width = '100%';
  presetFrame.style.transform = 'none';
  preloadFrame.style.width = '100%';
  preloadFrame.style.transform = 'none';
  activePreset = '';
}

function presetInfo(mode, details = {}) {
  const preset = String(details.preset || '').trim();
  const assetPath = String(details.assetPath || (preset ? `/stage-assets/${encodeURIComponent(preset)}/index.html` : '')).trim();
  if (!assetPath || !config?.controller) return null;
  const url = new URL(assetPath, config.controller);
  const stationId = Number(details.stationId || config.stationId || 1);
  const wallPosition = Number(details.wallPosition || config.wallPosition || stationId) || stationId;
  const wallTotal = Math.max(1, Math.min(10, Number(details.wallTotal) || 10));
  url.searchParams.set('mode', mode);
  url.searchParams.set('preset', preset);
  url.searchParams.set('station', stationId);
  url.searchParams.set('wallPosition', wallPosition);
  url.searchParams.set('wallTotal', wallTotal);
  return {
    preset,
    url: url.toString(),
    wallPosition,
    wallTotal
  };
}

function applyPresetGeometry(frame, mode, info) {
  if (mode === 'wall') {
    frame.style.width = `${info.wallTotal * 100}%`;
    frame.style.transform = `translateX(-${(Math.max(1, info.wallPosition) - 1) * (100 / info.wallTotal)}%)`;
  } else {
    frame.style.width = '100%';
    frame.style.transform = 'none';
  }
}

function loadPresetFrame(mode, details = {}) {
  const info = presetInfo(mode, details);
  if (!info) return false;
  applyPresetGeometry(presetFrame, mode, info);
  presetFrame.src = info.url;
  activePreset = info.preset;
  document.body.classList.add('using-preset');
  document.body.classList.remove('using-preloaded-preset');
  return true;
}

function showPreparedPreset(details = {}) {
  const info = presetInfo(preparedPreset?.mode || details.mode || 'graphic', preparedPreset?.details || details);
  if (!info) return false;
  applyPresetGeometry(preloadFrame, preparedPreset?.mode || details.mode || 'graphic', info);
  document.body.classList.remove('using-preset');
  document.body.classList.add('using-preloaded-preset');
  activePreset = preparedPreset?.preset || info.preset;
  return true;
}

function preparePreset(details = {}) {
  const mode = ['graphic', 'wall', 'individual'].includes(details.mode) ? details.mode : 'graphic';
  const playId = String(details.playId || '');
  const preset = String(details.preset || '');
  const info = presetInfo(mode, details);
  if (!info) {
    window.stageClient?.reportStatus({
      type: 'prepared',
      playId,
      preset,
      ready: false,
      error: 'Preset URL unavailable'
    });
    return;
  }

  let settled = false;
  const finish = (error = '') => {
    if (settled) return;
    settled = true;
    preparedPreset = error ? null : {
      playId,
      mode,
      preset,
      details: { ...details },
      url: info.url
    };
    window.stageClient?.reportStatus({
      type: 'prepared',
      playId,
      preset,
      ready: !error,
      error
    });
  };

  const timeout = setTimeout(() => finish('Preset preload timed out'), 8000);
  preloadFrame.onload = () => {
    clearTimeout(timeout);
    finish('');
  };
  preloadFrame.onerror = () => {
    clearTimeout(timeout);
    finish('Preset preload failed');
  };
  applyPresetGeometry(preloadFrame, mode, info);
  preloadFrame.src = info.url;
}

async function applyMode(mode = 'hold', details = {}) {
  currentMode = mode;
  document.body.className = `mode-${mode}`;
  try {
    if (mode === 'gameplay') {
      clearPresetFrame();
      await startGameplayMirror();
    } else {
      stopGameplayStream();
      const prepared = preparedPreset?.playId && preparedPreset.playId === details.playId;
      const usesPreset = ['graphic', 'wall', 'individual'].includes(mode) && (prepared ? showPreparedPreset(details) : loadPresetFrame(mode, details));
      if (!usesPreset) {
        clearPresetFrame();
        setSceneText(mode, details);
      }
    }
    reportStatus('');
  } catch (error) {
    currentMode = 'hold';
    document.body.className = 'mode-hold';
    stopGameplayStream();
    clearPresetFrame();
    setSceneText('hold', details);
    reportStatus(error?.message || String(error));
  }
}

function scheduleMode(payload = {}) {
  clearTimeout(pendingTimer);
  const executeAt = Number(payload.executeAt);
  const delayMs = Number.isFinite(executeAt)
    ? Math.max(0, Math.round((executeAt * 1000) - Date.now()))
    : 0;
  pendingTimer = setTimeout(() => applyMode(payload.mode || 'hold', payload), delayMs);
}

function setOptions(select, values, currentValue) {
  select.innerHTML = values.map((item) => {
    const value = typeof item === 'object' ? item.value : item;
    const label = typeof item === 'object' ? item.label : item;
    return `<option value="${String(value)}" ${String(value) === String(currentValue) ? 'selected' : ''}>${String(label)}</option>`;
  }).join('');
}

function displayLabel(display) {
  const primary = display.primary ? ' - Primary' : '';
  return `Display ${display.index}: ${display.width}x${display.height}${primary}`;
}

function populateConfigForm() {
  if (!configForm || !config) return;
  setOptions(configForm.elements.stationId, [...Array.from({ length: 10 }, (_item, index) => index + 1), { value: 11, label: '11 - TEST ONLY' }], config.stationId);
  setOptions(configForm.elements.wallPosition, Array.from({ length: 10 }, (_item, index) => index + 1), config.wallPosition);
  const displayOptions = (config.displays || []).map((display) => ({ value: display.index, label: displayLabel(display) }));
  setOptions(configForm.elements.playerDisplay, displayOptions, config.playerDisplay);
  setOptions(configForm.elements.stageDisplay, displayOptions, config.stageDisplay);
  configForm.elements.controller.value = config.controller || '';
  configForm.elements.cursorLockEnabled.checked = Boolean(config.cursorLockEnabled);
  configForm.elements.startWithWindows.checked = Boolean(config.startWithWindows);
  configForm.elements.startWithWindows.disabled = !config.startupSupported;
  const lockText = config.cursorLockEnabled ? 'Cursor lock enabled' : 'Cursor lock disabled';
  configStatus.textContent = `Station ${config.stationId} on ${config.hostname || 'this PC'} - ${lockText}`;
}

function openConfigPanel() {
  if (!settingsOnly) {
    window.stageClient.openSettings();
    return;
  }
  populateConfigForm();
  document.body.classList.add('config-open');
  document.querySelector('#config-panel')?.setAttribute('aria-hidden', 'false');
}

function closeConfigPanel() {
  if (settingsOnly) {
    window.stageClient.closeSettings();
    return;
  }
  document.body.classList.remove('config-open');
  document.querySelector('#config-panel')?.setAttribute('aria-hidden', 'true');
}

function showCursorControls() {
  if (document.body.classList.contains('config-open')) return;
  document.body.classList.add('cursor-active');
  clearTimeout(cursorHideTimer);
  cursorHideTimer = setTimeout(() => {
    document.body.classList.remove('cursor-active');
  }, 1600);
}

function hideCursorControls() {
  clearTimeout(cursorHideTimer);
  if (!document.body.classList.contains('config-open')) {
    document.body.classList.remove('cursor-active');
  }
}

async function saveClientConfig(event) {
  event.preventDefault();
  if (!configForm) return;
  configStatus.textContent = 'Saving and reconnecting...';
  try {
    config = await window.stageClient.saveConfig({
      stationId: Number(configForm.elements.stationId.value),
      controller: configForm.elements.controller.value.trim(),
      playerDisplay: Number(configForm.elements.playerDisplay.value),
      stageDisplay: Number(configForm.elements.stageDisplay.value),
      wallPosition: Number(configForm.elements.wallPosition.value),
      cursorLockEnabled: Boolean(configForm.elements.cursorLockEnabled.checked),
      startWithWindows: Boolean(configForm.elements.startWithWindows.checked)
    });
    populateConfigForm();
    setSceneText(currentMode, { stationId: config.stationId, wallPosition: config.wallPosition });
    configStatus.textContent = 'Saved. Reconnecting to controller.';
    setTimeout(closeConfigPanel, 700);
  } catch (error) {
    configStatus.textContent = error?.message || 'Could not save settings.';
  }
}

async function initialize() {
  config = await window.stageClient.getConfig();
  setSceneText('hold', { stationId: config.stationId, wallPosition: config.wallPosition });
  if (!settingsOnly) reportStatus('');
  populateConfigForm();
  configOpen?.addEventListener('click', openConfigPanel);
  configClose?.addEventListener('click', closeConfigPanel);
  configForm?.addEventListener('submit', saveClientConfig);
  configForm?.elements.cursorLockEnabled?.addEventListener('change', async (event) => {
    const result = await window.stageClient.setCursorLock({ enabled: event.target.checked });
    config.cursorLockEnabled = Boolean(result?.enabled);
    config.cursorLockActive = Boolean(result?.active);
    populateConfigForm();
  });
  window.addEventListener('mousemove', showCursorControls);
  window.addEventListener('mouseenter', showCursorControls);
  window.addEventListener('mouseleave', hideCursorControls);
  window.addEventListener('blur', hideCursorControls);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.classList.contains('config-open')) closeConfigPanel();
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 's') openConfigPanel();
  });
  window.stageClient.onConfigChanged(async () => {
    config = await window.stageClient.getConfig();
    if (settingsOnly) populateConfigForm();
  });
  if (settingsOnly) {
    document.body.classList.add('settings-only');
    openConfigPanel();
    return;
  }
  window.stageClient.onPrepare(preparePreset);
  window.stageClient.onMode(scheduleMode);
  window.stageClient.onOpenSettings(openConfigPanel);
  window.stageClient.onCursorLock((state = {}) => {
    config.cursorLockEnabled = Boolean(state.enabled);
    config.cursorLockActive = Boolean(state.active);
    populateConfigForm();
  });
}

initialize();
