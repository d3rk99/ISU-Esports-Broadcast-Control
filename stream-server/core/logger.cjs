const fs = require('node:fs');
const path = require('node:path');
class Logger {
  constructor(directory) { fs.mkdirSync(directory, { recursive: true }); this.file = path.join(directory, 'stream-server.jsonl'); }
  write(event, fields = {}) {
    // Strict allowlist: never serialize errors, URLs, names, config or credentials.
    const allowed = {};
    for (const key of ['state', 'seconds', 'count', 'code', 'destinationIndex']) if (typeof fields[key] === 'number' || /^[A-Z_0-9-]{1,80}$/.test(fields[key] || '')) allowed[key] = fields[key];
    const row = JSON.stringify({ time: new Date().toISOString(), event, ...allowed });
    if (fs.existsSync(this.file) && fs.statSync(this.file).size > 5 * 1024 * 1024) fs.renameSync(this.file, `${this.file}.1`);
    fs.appendFileSync(this.file, row + '\n');
  }
}
module.exports = { Logger };
