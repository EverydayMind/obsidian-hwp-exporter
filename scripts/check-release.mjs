import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateRelease({ manifest, pkg, versions, tracked }, tag) {
    const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
    if (!semver.test(manifest.version) || !semver.test(manifest.minAppVersion)) throw new Error('Manifest versions must use x.y.z');
    if (manifest.version !== pkg.version || versions[manifest.version] !== manifest.minAppVersion) throw new Error('Package, manifest and versions metadata disagree');
    if (tag !== undefined && tag !== manifest.version) throw new Error('Release tag does not match manifest version');
    if (manifest.id !== 'hwpx-exporter' || pkg.name !== 'hwpx-exporter') throw new Error('Unexpected plugin identity');
    if (manifest.isDesktopOnly !== true || !manifest.description?.endsWith('.') || !manifest.author) throw new Error('Incomplete manifest metadata');
    const forbidden = tracked.filter(path => /(^|\/)(AGENTS|CLAUDE)\.md$|(^|\/)[^/]*(PLAN|REVIEW)[^/]*\.md$|^(\.claude|\.codex|\.cursor|docs|node_modules)\/|(^|\/)data\.json$|^main\.js$|\.map$/i.test(path)
        || (/\.hwpx$/i.test(path) && !path.startsWith('templates/')));
    if (forbidden.length) throw new Error(`Forbidden tracked files: ${forbidden.join(', ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [manifest, pkg, versions] = await Promise.all(['manifest.json', 'package.json', 'versions.json'].map(async path => JSON.parse(await readFile(path, 'utf8'))));
    const tracked = execFileSync('git', ['-c', 'core.quotepath=off', 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
    validateRelease({ manifest, pkg, versions, tracked }, process.argv[2]);
    console.log('Release metadata and tracked-file checks passed.');
}
