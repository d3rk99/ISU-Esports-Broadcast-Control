// Patch status text/images in place so scroll containers, controls and preset
// iframes survive incoming heartbeats. Presets are edited by explicit actions.
export function patchStageStatus(current, markup) {
  const template = document.createElement('template');
  template.innerHTML = markup;
  const key = (node) => node.nodeType === 1
    ? `${node.tagName}:${node.dataset.stationCard || node.dataset.action || node.classList[0] || ''}`
    : String(node.nodeType);
  function patch(target, source) {
    if (target.nodeType !== 1) {
      if (target.nodeValue !== source.nodeValue) target.nodeValue = source.nodeValue;
      return;
    }
    if (target.classList.contains('stage-preset-panel')) return;
    for (const attribute of [...target.attributes]) {
      if (!source.hasAttribute(attribute.name)) target.removeAttribute(attribute.name);
    }
    for (const attribute of source.attributes) {
      if (target.getAttribute(attribute.name) !== attribute.value) target.setAttribute(attribute.name, attribute.value);
    }
    let cursor = target.firstChild;
    const sourceKeys = new Set([...source.childNodes].map(key));
    for (const child of source.childNodes) {
      let match = cursor;
      while (match && key(match) !== key(child)) match = match.nextSibling;
      if (!match) {
        target.insertBefore(child.cloneNode(true), cursor);
      } else {
        // Remove obsolete siblings before moving a surviving node. Moving an
        // iframe or focused input's ancestor would reset its browser state.
        while (cursor !== match && !sourceKeys.has(key(cursor))) {
          const next = cursor.nextSibling;
          cursor.remove();
          cursor = next;
        }
        if (match !== cursor) target.insertBefore(match, cursor);
        patch(match, child);
        cursor = match.nextSibling;
      }
    }
    while (cursor) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
  }
  patch(current, template.content.firstElementChild);
}
