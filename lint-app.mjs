// Extracts the inline app script from index.html so eslint can check it like any other file.
import fs from 'fs';
const html = fs.readFileSync('index.html', 'utf8');
const m = html.match(/<script>\n([\s\S]*?)<\/script>/);
fs.writeFileSync('.app-inline.js', '/* global firebase */\n' + m[1]);
