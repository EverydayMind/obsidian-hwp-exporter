// Fails when the built main.js contains code the Obsidian community-plugin review rejects.
// Run after `npm run build`. The dependency code that used these is replaced in
// scripts/dependency-shims.mjs.
import { readFile } from 'node:fs/promises';

const FORBIDDEN = [
    ['script element creation', /createElement\(\s*["'`]script["'`]\s*\)/],
    ['eval', /(?<![\w$.])eval\s*\(/],
    ['new Function', /new\s+Function\s*\(/],
    ['document.write', /document\.write(?:ln)?\s*\(/],
    ['importScripts', /importScripts/],
];

const file = process.argv[2] ?? 'main.js';
const lines = (await readFile(file, 'utf8')).split('\n');
const found = [];
lines.forEach((line, index) => {
    for (const [label, pattern] of FORBIDDEN) {
        if (pattern.test(line)) found.push(`${file}:${index + 1} ${label}: ${line.trim().slice(0, 120)}`);
    }
});
if (found.length) {
    console.error(found.join('\n'));
    process.exit(1);
}
console.log(`${file}: no script injection, eval or new Function.`);
