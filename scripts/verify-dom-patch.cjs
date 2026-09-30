// Verifies src/dom-patch.js in real Chromium (Electron): typing, focus, caret, scroll,
// <details>, selects, list reordering and click targets survive a re-render.
// Run: npx electron scripts/verify-dom-patch.cjs   (needs a display; use xvfb-run on Linux)
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<!doctype html><div id="root"></div>');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'dom-patch.js'), 'utf8').replace(/^export /gm, '');
  const result = await win.webContents.executeJavaScript(`(() => {
    ${source}
    const root = document.getElementById('root');
    const results = [];
    const check = (name, ok) => results.push({ name, ok: Boolean(ok) });
    const view = (score, rows, typed = '', details = false) => \`
      <div class="scroll" style="height:50px;overflow:auto"><div style="height:500px">tall</div></div>
      <input name="teamName" value="\${typed}">
      <textarea name="notes">server notes \${score}</textarea>
      <select name="map"><option value="a">A</option><option value="b" \${score % 2 ? 'selected' : ''}>B</option></select>
      <details class="adv" \${details ? 'open' : ''}><summary>more</summary><p>inner \${score}</p></details>
      <strong class="score">\${score}</strong>
      <ul>\${rows.map((r) => \`<li data-key="\${r}"><button data-action="remove-player" data-index="\${r}">x</button>\${r}</li>\`).join('')}</ul>\`;

    patchHtml(root, view(1, ['a', 'b', 'c'], 'Bengals'));
    const input = root.querySelector('[name=teamName]');
    const scroller = root.querySelector('.scroll');
    const liB = root.querySelector('[data-key=b]');
    const buttonC = root.querySelector('[data-key=c] button');
    input.focus(); input.value = 'Bengals Blu'; input.setSelectionRange(3, 5);
    scroller.scrollTop = 120;
    root.querySelector('details').open = true;
    const textarea = root.querySelector('textarea');

    // Live update arrives while the operator is typing: server still says "Bengals".
    patchHtml(root, view(2, ['a', 'b', 'c'], 'Bengals'));
    check('same input element survives', root.querySelector('[name=teamName]') === input);
    check('focus kept', document.activeElement === input);
    check('typed text kept', input.value === 'Bengals Blu');
    check('caret/selection kept', input.selectionStart === 3 && input.selectionEnd === 5);
    check('inner panel scroll kept', scroller.scrollTop === 120);
    check('user-opened <details> stays open', root.querySelector('details').open === true);
    check('changed text updates', root.querySelector('.score').textContent === '2');
    check('unfocused textarea updates', textarea.value === 'server notes 2' && root.querySelector('textarea') === textarea);
    check('unfocused select follows state', root.querySelector('select').value === 'a');

    // Row removed from the middle: other rows keep their elements (so a click in flight still lands).
    patchHtml(root, view(3, ['a', 'c'], 'Bengals'));
    check('removed row gone', !root.querySelector('[data-key=b]') && !root.contains(liB));
    check('later row element reused', root.querySelector('[data-key=c] button') === buttonC);
    check('rows in order', [...root.querySelectorAll('li')].map((li) => li.dataset.key).join() === 'a,c');
    check('select follows odd score', root.querySelector('select').value === 'b');

    // Operator finishes typing and blurs; the committed state now matches.
    input.blur();
    patchHtml(root, view(4, ['c', 'a', 'd'], 'Bengals Blu'));
    check('value correct after commit', input.value === 'Bengals Blu');
    check('reordered + added rows', [...root.querySelectorAll('li')].map((li) => li.dataset.key).join() === 'c,a,d');
    check('reordered row element reused', root.querySelector('[data-key=c] button') === buttonC);

    // Unfocused input gets server value.
    patchHtml(root, view(5, ['c'], 'Renamed'));
    check('unfocused input takes new state', input.value === 'Renamed');
    return results;
  })()`);
  const failed = result.filter((r) => !r.ok);
  for (const r of result) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
  console.log(`${result.length - failed.length}/${result.length} passed`);
  app.exit(failed.length ? 1 : 0);
});
