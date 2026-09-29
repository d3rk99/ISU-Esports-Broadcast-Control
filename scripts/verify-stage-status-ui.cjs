const { app, BrowserWindow } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

app.whenReady().then(async () => {
  const { patchStageStatus } = await import(pathToFileURL(path.resolve(__dirname, '../src/stage-status-view.js')));
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  window.webContents.on('console-message', (event) => console.log(event.message));
  await window.loadURL('data:text/html,<div id="scroll" style="height:100px;overflow:auto"><section id="view"></section><div style="height:1000px"></div></div>');
  const result = await window.webContents.executeJavaScript(`(() => {
    const patch = ${patchStageStatus.toString()};
    const view = document.querySelector('#view');
    const markup = (warning, value) => '<section id="view">' + (warning ? '<article class="stage-warning-panel">Warning</article>' : '') + '<article class="stage-preset-panel"><iframe src="about:blank"></iframe><input value="draft"></article><article data-station-card="1" class="stage-station-card"><h3>' + value + '</h3><button data-action="play">Play</button></article></section>';
    patch(view, markup(false, 'hold'));
    const frame = view.querySelector('iframe');
    const input = view.querySelector('input');
    const button = view.querySelector('button');
    input.value = 'unsaved text'; input.focus();
    const scroll = document.querySelector('#scroll'); scroll.scrollTop = 50;
    for (let i = 0; i < 100; i++) patch(view, markup(i % 2 === 0, 'gameplay'));
    if (view.querySelector('iframe') !== frame || view.querySelector('button') !== button) throw Error('Stable nodes replaced');
    if (document.activeElement !== input || input.value !== 'unsaved text') throw Error('Focus/edit lost');
    if (scroll.scrollTop !== 50) throw Error('Scroll position changed');
    if (view.querySelector('h3').textContent !== 'gameplay') throw Error('Status not updated');
    return '100 updates: iframe, button, focus, edits and scroll preserved';
  })()`);
  console.log(result);
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
