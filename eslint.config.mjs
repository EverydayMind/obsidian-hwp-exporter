import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import { DEFAULT_ACRONYMS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js';

export default defineConfig([
    { ignores: ['node_modules/**', 'main.js', '*.mjs', 'scripts/**'] },
    ...obsidianmd.configs.recommended,
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // File-format and unit names stay upper case in UI text.
            'obsidianmd/ui/sentence-case': ['warn', { acronyms: [...DEFAULT_ACRONYMS, 'HWP', 'HWPX', 'H1', 'MB'] }],
        },
    },
]);
