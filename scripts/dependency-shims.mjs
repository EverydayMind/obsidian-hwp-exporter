// Replaces dependency code that the Obsidian community-plugin review rejects (script element
// injection, eval, new Function) with equivalents for Obsidian desktop, where the replaced
// branches never ran anyway. Shared by scripts/build-plugin.mjs and the release repository's
// esbuild.config.mjs; scripts/check-bundle.mjs checks the built main.js.
const SHIMS = [
    {
        // jszip → lie → immediate: falls back to <script onreadystatechange> without MutationObserver.
        filter: /[\\/]node_modules[\\/]immediate[\\/]lib[\\/]index\.js$/,
        contents: 'module.exports = function immediate(task) { queueMicrotask(task); };\n',
    },
    {
        // jszip → setimmediate: polyfill with <script> injection and new Function(string).
        // Obsidian desktop has a native setImmediate; keep a timer fallback only.
        filter: /[\\/]node_modules[\\/]setimmediate[\\/]setImmediate\.js$/,
        contents: [
            "if (typeof globalThis.setImmediate !== 'function') {",
            '    globalThis.setImmediate = function (callback, ...args) { return setTimeout(function () { callback(...args); }, 0); };',
            '}',
            '',
        ].join('\n'),
    },
    {
        // gray-matter evaluates `---js` front matter with eval. Notes are data: never run it;
        // the block is dropped as empty metadata and the rest of the note still converts.
        filter: /[\\/]node_modules[\\/]gray-matter[\\/]lib[\\/]engines\.js$/,
        contents: [
            "'use strict';",
            "const yaml = require('js-yaml');",
            'module.exports = {',
            '    yaml: { parse: yaml.safeLoad.bind(yaml), stringify: yaml.safeDump.bind(yaml) },',
            '    json: {',
            '        parse: JSON.parse.bind(JSON),',
            '        stringify(obj, options) {',
            '            const opts = Object.assign({ replacer: null, space: 2 }, options);',
            '            return JSON.stringify(obj, opts.replacer, opts.space);',
            '        },',
            '    },',
            '    javascript: {',
            '        parse() { return {}; },',
            "        stringify() { throw new Error('stringifying JavaScript is not supported'); },",
            '    },',
            '};',
            '',
        ].join('\n'),
    },
    {
        // js-yaml !!js/function builds functions with new Function. gray-matter loads with the
        // safe schema, which never uses this type; keep the type but never match it.
        filter: /[\\/]node_modules[\\/](?:.+[\\/])?js-yaml[\\/]lib[\\/]js-yaml[\\/]type[\\/]js[\\/]function\.js$/,
        contents: [
            "'use strict';",
            "var Type = require('../../type');",
            "module.exports = new Type('tag:yaml.org,2002:js/function', {",
            "    kind: 'scalar',",
            '    resolve: function () { return false; },',
            "    construct: function () { throw new Error('!!js/function is not supported'); },",
            '    predicate: function () { return false; },',
            "    represent: function () { throw new Error('!!js/function is not supported'); },",
            '});',
            '',
        ].join('\n'),
    },
];

export function dependencyShimsPlugin() {
    return {
        name: 'dependency-shims',
        setup(build) {
            for (const shim of SHIMS) {
                build.onLoad({ filter: shim.filter }, () => ({ contents: shim.contents, loader: 'js' }));
            }
        },
    };
}
