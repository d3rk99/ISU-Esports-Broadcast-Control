const CLIENT_VERSION = '0.1.5';

function isOlderVersion(installed, available) {
  const parse = (value) => /^\d+\.\d+\.\d+$/.test(String(value)) ? String(value).split('.').map(Number) : null;
  const a = parse(installed);
  const b = parse(available);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

module.exports = { CLIENT_VERSION, isOlderVersion };
