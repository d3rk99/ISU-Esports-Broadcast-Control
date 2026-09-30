// In-place DOM patcher for the controller UI.
//
// render() used to replace root.innerHTML on every update, which destroyed the
// element being typed in, dropped focus and cursor position, reset scroll inside
// panels, and could eat a click that landed mid-rebuild. patchChildren() walks the
// new markup and only touches what changed, so live telemetry (Rocket League at up
// to ~30 updates/s) no longer fights the operator.
//
// Rules that keep user state intact:
// - Elements are matched by tag + a stable key (id, data-key, data-action+index,
//   name, data-view, ...), so a list growing or shrinking doesn't shift every row.
// - The focused form control keeps the user's value, selection and caret. Every
//   other control is updated to the rendered value.
// - <details open> keeps what the user toggled; <iframe>/<video>/<canvas> are never
//   rebuilt unless their src actually changes.
// - Anything marked data-preserve is left entirely alone after first render.

// data-* attributes that identify *which* row/item an element belongs to.
const IDENTITY_ATTRIBUTES = [
  'index', 'side', 'row', 'field', 'station', 'preset', 'team', 'player', 'mapIndex', 'overlay',
  'url', 'imageType', 'character', 'vetoPick', 'vetoBan', 'stageMode', 'wallTotal',
  'voRoi', 'voRoiBox', 'voAxis', 'voTimelineBox', 'voTimelineRound', 'updateTarget', 'winner',
  'prop', 'playerProp', 'rlProp', 'voProp', 'mapProp', 'vetoProp', 'companionProp', 'outputDisplayProp',
  'voTimelineProp', 'voManualName', 'voTimerDataset', 'voObserverCell'
];

function nodeKey(node) {
  if (node.nodeType !== 1) return `#${node.nodeType}`;
  const d = node.dataset || {};
  if (node.id) return `${node.tagName}#${node.id}`;
  if (d.key) return `${node.tagName}~${d.key}`;
  if (d.stationCard) return `${node.tagName}@${d.stationCard}`;
  const identity = IDENTITY_ATTRIBUTES.filter((name) => d[name] !== undefined).map((name) => `${name}=${d[name]}`).join('|');
  const stable = [d.action, d.view, d.game, node.getAttribute('name'), identity].filter(Boolean).join('|');
  // Plain structural elements fall back to tag + first class, matched in order.
  return `${node.tagName}:${stable || node.classList?.[0] || ''}`;
}

const FORM_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const STATEFUL_TAGS = new Set(['IFRAME', 'VIDEO', 'CANVAS', 'DIALOG']);

function syncAttributes(target, source) {
  for (const attribute of [...target.attributes]) {
    if (!source.hasAttribute(attribute.name)) {
      // <details open> is user-controlled after first render.
      if (target.tagName === 'DETAILS' && attribute.name === 'open') continue;
      target.removeAttribute(attribute.name);
    }
  }
  for (const attribute of source.attributes) {
    if (target.tagName === 'DETAILS' && attribute.name === 'open') continue;
    if (target.getAttribute(attribute.name) !== attribute.value) target.setAttribute(attribute.name, attribute.value);
  }
}

function syncFormControl(target, source, activeElement) {
  if (target === activeElement) return; // never overwrite what the operator is typing/choosing
  if (target.tagName === 'SELECT') {
    // Options were already patched; restore the rendered selection.
    const selected = [...source.options].find((option) => option.hasAttribute('selected'));
    const value = selected ? selected.value : (source.options[0]?.value ?? '');
    if (target.value !== value) target.value = value;
    return;
  }
  if (target.type === 'checkbox' || target.type === 'radio') {
    const checked = source.hasAttribute('checked');
    if (target.checked !== checked) target.checked = checked;
    return;
  }
  if (target.type === 'file') return;
  const value = target.tagName === 'TEXTAREA' ? source.textContent : (source.getAttribute('value') ?? '');
  if (target.value !== value) target.value = value;
}

function patchElement(target, source, activeElement) {
  if (target.hasAttribute('data-preserve')) return;
  if (STATEFUL_TAGS.has(target.tagName)) {
    // Only replace media/frames when what they point at changes.
    if (target.getAttribute('src') !== source.getAttribute('src')) {
      target.replaceWith(source.cloneNode(true));
      return;
    }
    syncAttributes(target, source);
    if (target.tagName !== 'DIALOG') return;
  } else {
    syncAttributes(target, source);
  }
  if (target.tagName === 'TEXTAREA') {
    syncFormControl(target, source, activeElement);
    return;
  }
  patchChildren(target, source, activeElement);
  if (FORM_TAGS.has(target.tagName)) syncFormControl(target, source, activeElement);
}

// Make target's children match source's children, reusing existing nodes by key.
export function patchChildren(target, source, activeElement = target.ownerDocument?.activeElement) {
  const sourceNodes = [...source.childNodes];
  const existingByKey = new Map();
  for (const child of target.childNodes) {
    const key = nodeKey(child);
    if (!existingByKey.has(key)) existingByKey.set(key, []);
    existingByKey.get(key).push(child);
  }
  let cursor = target.firstChild;
  for (const sourceChild of sourceNodes) {
    const key = nodeKey(sourceChild);
    const candidates = existingByKey.get(key);
    const match = candidates?.shift();
    if (!match) {
      target.insertBefore(sourceChild.cloneNode(true), cursor);
      continue;
    }
    if (match !== cursor) target.insertBefore(match, cursor);
    if (match.nodeType === 1) patchElement(match, sourceChild, activeElement);
    else if (match.nodeValue !== sourceChild.nodeValue) match.nodeValue = sourceChild.nodeValue;
    cursor = match.nextSibling;
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
}

// Patch `root` so its content matches `markup` (an HTML string).
export function patchHtml(root, markup) {
  const template = root.ownerDocument.createElement('template');
  template.innerHTML = markup;
  patchChildren(root, template.content);
}
