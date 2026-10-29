// Writes the server address used by the offline page before `cap sync android`.
import fs from 'node:fs';
const url = (process.env.QUICKGRADE_SERVER_URL || '').trim().replace(/\/+$/, '');
fs.writeFileSync('android-shell/server.js', `window.QG_SERVER = ${JSON.stringify(url)};\n`);
console.log(url ? `QuickGrade Android: server ${url}` : 'QuickGrade Android: no QUICKGRADE_SERVER_URL set (app will show a setup notice)');
