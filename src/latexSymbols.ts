/**
 * LLMs frequently write mathematical/special characters using LaTeX escape
 * syntax (e.g. "$\rightarrow$", "\alpha", "x^2") instead of the actual
 * Unicode character. HWPX has no LaTeX renderer, so left as-is these show up
 * as literal backslash-letter text in the exported document. This module
 * rewrites recognized LaTeX macros and math-mode delimiters into their
 * Unicode equivalents before the Markdown is parsed.
 *
 * Fenced code blocks and inline code spans are left untouched, matching the
 * convention used by rewriteObsidianImageEmbeds.
 */

const MACROS: Record<string, string> = {
    // Arrows
    to: '→', rightarrow: '→', longrightarrow: '→',
    gets: '←', leftarrow: '←', longleftarrow: '←',
    Rightarrow: '⇒', Longrightarrow: '⇒',
    Leftarrow: '⇐', Longleftarrow: '⇐',
    leftrightarrow: '↔', longleftrightarrow: '↔', Leftrightarrow: '⇔', Longleftrightarrow: '⇔',
    uparrow: '↑', downarrow: '↓', updownarrow: '↕', mapsto: '↦',
    // Relations
    leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠',
    approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝',
    ll: '≪', gg: '≫',
    // Operators
    times: '×', div: '÷', pm: '±', mp: '∓', cdot: '·', ast: '∗',
    circ: '∘', bullet: '•', star: '⋆', oplus: '⊕', otimes: '⊗',
    // Sets / logic
    in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆',
    supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩',
    emptyset: '∅', varnothing: '∅', setminus: '∖',
    forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬',
    land: '∧', wedge: '∧', lor: '∨', vee: '∨',
    // Calculus / analysis
    partial: '∂', nabla: '∇', infty: '∞',
    int: '∫', iint: '∬', iiint: '∭', oint: '∮',
    sum: '∑', prod: '∏', sqrt: '√',
    therefore: '∴', because: '∵',
    // Dots
    ldots: '…', dots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
    // Greek (lowercase)
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ',
    epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
    theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
    lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
    pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ',
    sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ',
    phi: 'φ', varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
    // Greek (uppercase)
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ',
    Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    // Misc symbols
    deg: '°', prime: '′', dagger: '†', ddagger: '‡',
    S: '§', P: '¶', copyright: '©', checkmark: '✓',
};

// Single non-letter escapes, e.g. "\%" -> "%". These are unambiguous LaTeX
// escapes of the character itself, so no math-context guard is needed.
const LITERAL_ESCAPES: Record<string, string> = {
    '%': '%', '&': '&', '#': '#', '$': '$', '_': '_', '{': '{', '}': '}',
};

const SUPERSCRIPT: Record<string, string> = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵',
    '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻',
    '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ',
};

const SUBSCRIPT: Record<string, string> = {
    '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅',
    '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋',
    '=': '₌', '(': '₍', ')': '₍', a: 'ₐ', e: 'ₑ', i: 'ᵢ', n: 'ₙ',
    o: 'ₒ', x: 'ₓ',
};

/** Replace `\macroName` occurrences with their Unicode equivalent. */
function replaceMacros(text: string, preserveMarkdownEscapes = false): string {
    const macros = text
        .replace(/\\([A-Za-z]+)/g, (original, name: string) => (
            Object.prototype.hasOwnProperty.call(MACROS, name) ? MACROS[name] : original
        ));
    return preserveMarkdownEscapes ? macros
        : macros.replace(/\\([%&#$_{}])/g, (_original, ch: string) => LITERAL_ESCAPES[ch]);
}

/** Replace `^x` / `^{xy}` and `_x` / `_{xy}` with Unicode super/subscript where every character has a mapping. */
function replaceScripts(text: string): string {
    return text.replace(/([\^_])(\{[^{}]+\}|.)/g, (original, marker: string, rawArg: string) => {
        const arg = rawArg.startsWith('{') ? rawArg.slice(1, -1) : rawArg;
        const table = marker === '^' ? SUPERSCRIPT : SUBSCRIPT;
        let out = '';
        for (const ch of arg) {
            const mapped = table[ch];
            if (!mapped) {
                return original;
            }
            out += mapped;
        }
        return out;
    });
}

/** Heuristic: does this math-mode span actually contain LaTeX syntax (as opposed to plain currency-like text)? */
function looksLikeLatex(inner: string): boolean {
    return /\\[A-Za-z%&#$_{}]/.test(inner) || /[\^_]\{?[^\s{}$]/.test(inner);
}

/** Convert `$...$` and `$$...$$` math spans that contain recognizable LaTeX syntax into plain Unicode text. */
function convertMathDelimited(text: string): string {
    let out = text.replace(/\$\$([\s\S]+?)\$\$/g, (original, inner: string) => {
        if (!looksLikeLatex(inner)) return original;
        return replaceScripts(replaceMacros(inner)).trim();
    });
    out = out.replace(/(?<!\\)\$([^$\n]+?)(?<!\\)\$/g, (original, inner: string) => {
        if (!looksLikeLatex(inner)) return original;
        return replaceScripts(replaceMacros(inner));
    });
    return out;
}

/** The inside of a display-math block (`$$ … $$`) as plain Unicode text. */
export function latexMathToUnicode(inner: string): string {
    return replaceScripts(replaceMacros(inner)).trim();
}

/** Dollar math without surrounding whitespace; excludes escaped dollars and currency pairs. */
export const INLINE_MATH_PATTERN = /(?<![\\$])\$(?![$\s])((?:\\.|[^$\\\n])+?)(?<![\\\s])\$(?![$\d])/;

function convertPlainText(text: string, preserveMath = false): string {
    if (preserveMath) {
        let result = '';
        let start = 0;
        for (const match of text.matchAll(new RegExp(INLINE_MATH_PATTERN.source, 'g'))) {
            result += replaceMacros(text.slice(start, match.index), true) + match[0];
            start = match.index + match[0].length;
        }
        return result + replaceMacros(text.slice(start), true);
    }
    return replaceMacros(convertMathDelimited(text));
}

/** Rewrite text outside inline code spans (backtick-delimited) on a single line. */
function rewriteOutsideInlineCode(line: string, preserveMath = false): string {
    let result = '';
    let plainStart = 0;
    let index = 0;

    while (index < line.length) {
        if (line[index] !== '`') {
            index++;
            continue;
        }

        let runEnd = index;
        while (line[runEnd] === '`') runEnd++;
        const delimiter = line.slice(index, runEnd);
        const closeIndex = line.indexOf(delimiter, runEnd);
        if (closeIndex < 0) {
            break;
        }

        result += convertPlainText(line.slice(plainStart, index), preserveMath);
        const codeEnd = closeIndex + delimiter.length;
        result += line.slice(index, codeEnd);
        index = codeEnd;
        plainStart = codeEnd;
    }

    return result + convertPlainText(line.slice(plainStart), preserveMath);
}

/**
 * Rewrite LaTeX-style escape sequences (macros, math delimiters, sub/superscripts)
 * into their Unicode equivalents throughout `markdown`, leaving fenced code
 * blocks and inline code spans untouched.
 */
export function rewriteLatexSymbols(markdown: string, options: { preserveMath?: boolean } = {}): string {
    const lines = markdown.split(/(\r?\n)/);
    let fence: { marker: '`' | '~'; length: number } | null = null;
    let mathBlock = false;

    return lines.map((part) => {
        if (/^\r?\n$/.test(part)) {
            return part;
        }

        const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(part);
        if (fenceMatch) {
            const marker = fenceMatch[1][0] as '`' | '~';
            if (!fence) {
                fence = { marker, length: fenceMatch[1].length };
            } else if (fence.marker === marker && fenceMatch[1].length >= fence.length) {
                fence = null;
            }
            return part;
        }
        if (fence) {
            return part;
        }

        if (options.preserveMath && (mathBlock || /^(?:[ \t]*>[ \t]*)*[ \t]*\$\$/.test(part))) {
            if ((part.match(/(?<!\\)\$\$/g) ?? []).length % 2) mathBlock = !mathBlock;
            return part;
        }

        return rewriteOutsideInlineCode(part, options.preserveMath);
    }).join('');
}
