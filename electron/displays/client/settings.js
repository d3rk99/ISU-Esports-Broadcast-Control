const form = document.getElementById('form');
const option = (value, label, selected) => Object.assign(document.createElement('option'), { value, textContent: label, selected });
async function load() {
  const c = await window.display.getConfig();
  document.getElementById('meta').textContent = `${c.hostname} · v${c.version}`;
  form.station.replaceChildren(...Array.from({ length: 10 }, (_v, i) => option(i + 1, `Station ${String(i + 1).padStart(2, '0')}`, c.station === i + 1)));
  for (const name of ['playerDisplay', 'stageDisplay']) {
    form[name].replaceChildren(...c.displays.map((d) => option(d.index, `Monitor ${d.index}: ${d.width}×${d.height}${d.primary ? ' (main)' : ''}`, c[name] === d.index)));
  }
  form.controller.value = c.controller; form.port.value = c.port; form.key.value = c.key; form.ndiHost.value = c.ndiHost;
  form.noiseMaxVolume.value = c.noiseMaxVolume;
  let outputs = [];
  try { outputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications'); } catch {}
  form.noiseDevice.replaceChildren(option('', 'Windows default output', !c.noiseDevice),
    ...outputs.map((d, i) => option(d.deviceId, d.label || `Output ${i + 1}`, d.deviceId === c.noiseDevice)));
  if (c.noiseDevice && !outputs.some((d) => d.deviceId === c.noiseDevice)) form.noiseDevice.append(option(c.noiseDevice, `${c.noiseDeviceLabel || 'Saved headset'} (not plugged in)`, true));
  form.cursorLock.checked = c.cursorLock; form.startWithWindows.checked = c.startWithWindows;
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await window.display.saveConfig({
    station: Number(form.station.value), controller: form.controller.value, port: Number(form.port.value), key: form.key.value,
    ndiHost: form.ndiHost.value, playerDisplay: Number(form.playerDisplay.value), stageDisplay: Number(form.stageDisplay.value),
    noiseDevice: form.noiseDevice.value, noiseDeviceLabel: form.noiseDevice.selectedOptions[0]?.textContent.replace(/ \(not plugged in\)$/, '') || '',
    noiseMaxVolume: Number(form.noiseMaxVolume.value),
    cursorLock: form.cursorLock.checked, startWithWindows: form.startWithWindows.checked
  });
  document.getElementById('saved').textContent = 'Saved · reconnecting';
  setTimeout(() => { document.getElementById('saved').textContent = ''; }, 2500);
});
// Plays the noise on the selected headset at the cap for 3 s, so the setup can be checked by ear.
document.getElementById('noise-test').addEventListener('click', async () => {
  const label = form.noiseDevice.selectedOptions[0]?.textContent || '';
  await window.pinkNoise.setDevice({ id: form.noiseDevice.value, label, maxVolume: Number(form.noiseMaxVolume.value) });
  await window.pinkNoise.set({ on: true, volume: 100 });
  setTimeout(() => window.pinkNoise.set({ on: false }), 3000);
});
load();
