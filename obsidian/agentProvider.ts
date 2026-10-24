import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { parseMarkdownStringWithFrontmatter } from '../src/frontmatterParser';
import { MarkoToPandocAdapter } from '../src/markoAdapter';
import { rewriteObsidianImageEmbeds } from '../src/obsidianImageEmbeds';
import type { ConversionReport } from '../src/conversionReport';
import type { TemplateInspection } from '../src/templateInspector';

/**
 * Agent facade (agentinterop v1). An agent host discovers this object on the
 * plugin instance under AGENT_CAPABILITY_PROVIDER and calls describe()/callTool().
 * It knows nothing about any particular host. get_export_options and check_export
 * only report. export_note creates a new .hwpx in the Vault, so it is a commit-effect
 * tool: the host fixes the target (resolveTarget), lets this provider prepare the exact
 * bytes in memory (commit.prepare), asks a person, checkpoints, and only then lets it
 * write (commit.execute). It never replaces an existing file and never writes under a
 * hidden folder (.obsidian, .trash, ...).
 */
export const AGENT_CAPABILITY_PROVIDER = Symbol.for('dev.agentinterop.capability-provider');
export const PROVIDERS_CHANGED_EVENT = 'agentinterop:providers-changed';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export interface AgentToolResult {
    content: Array<{ type: 'text'; text: string }>;
    structuredContent?: JsonObject;
    isError?: boolean;
    _meta?: JsonObject;
}

export interface AgentCapabilityProvider {
    readonly protocol: 'agentinterop';
    readonly protocolVersion: 1;
    describe(): Promise<JsonObject>;
    callTool(name: string, args: JsonObject, ctx?: { signal?: AbortSignal }): Promise<AgentToolResult>;
    /** Fixes the file a commit tool would create, without changing anything. */
    resolveTarget(name: string, args: JsonObject, ctx?: CommitContext): Promise<ExportTarget>;
    readonly commit: {
        prepare(request: { tool: string; args: JsonObject; target: unknown }, ctx?: CommitContext): Promise<CommitPreparation>;
        execute(ticket: CommitTicket, ctx?: CommitContext): Promise<CommitReceipt>;
        status(preparationId: string, ctx?: CommitContext): Promise<CommitReceipt | { state: 'unknown_preparation' }>;
    };
    dispose(): void;
}

// agentinterop v1 commit effect (the host's commitProtocol.ts is the reference).
export interface Caller { pluginId?: string; conversationId?: string; runId?: string; turnId?: string }
export interface CommitContext { caller?: Caller; signal?: AbortSignal }
export interface ExportTarget { kind: 'new'; destination: string; template: { path: string; sha256: string } }
type FileEntry = {
    kind: 'file'; path: string; op: 'create'; role: 'primary';
    sha256Before: null; sha256Expected: string; sizeBytes: number;
};
type FolderEntry = { kind: 'folder'; path: string; op: 'create'; role: 'folder'; existedBefore: false };
type WriteEntry = FileEntry | FolderEntry;
export interface CommitPreparation {
    preparationId: string;
    mode: 'create';
    template: { path: string; sha256: string };
    destination: string;
    format: string;
    saveOptions: JsonObject;
    writeSet: WriteEntry[];
    preparationDigest: string;
    providerInternalWrites: string[];
    report: JsonObject;
    expiresAt: string;
}
export interface CommitTicket {
    ticketId: string;
    preparationId: string;
    preparationDigest: string;
    caller?: Caller;
    destination: string;
    writeSet: WriteEntry[];
    expiresAt: string;
}
export interface CommitReceipt {
    preparationId: string;
    ticketId: string;
    preparationDigest: string;
    state: 'written' | 'not_written' | 'partial' | 'unknown';
    entries: Array<{ path: string; kind: 'file' | 'folder'; state: 'written' | 'unchanged' | 'not_written' | 'unknown'; sha256After?: string }>;
    warnings: string[];
    error?: { code: string; message: string };
}

export interface ExportOptionsSnapshot {
    templateFolderPath: string;
    outputMode: 'same_as_source' | 'fixed_folder';
    fixedOutputFolder: string;
    namingPattern: string;
    appendSequenceOnConflict: boolean;
    pageBreakBeforeH1: boolean;
    captureRenderedBlocks: boolean;
    captureMermaid: boolean;
    captureSvgFiles: boolean;
    captureThirdPartyRenderers: boolean;
    thirdPartyLanguages: string[];
}

/** What the provider needs from the plugin. Kept free of Obsidian types so it runs in tests. */
export interface ExportProviderHost {
    id: string;
    name: string;
    version: string;
    options(): ExportOptionsSnapshot;
    /** Vault paths of the .hwpx templates offered during export. */
    templates(): string[];
    /** The Markdown note at this Vault path, or null when there is none. */
    readNote(notePath: string): Promise<{ markdown: string } | null>;
    /** Where exporting this note would write, by the current settings. */
    outputPath(notePath: string): string;
    /** Whether an image link of the note resolves to an embeddable Vault file. */
    resolvesImage(source: string, notePath: string): boolean;
    /** Runs the converter with the export settings, without rendered-block capture, writing to an absolute path. */
    convert(markdown: string, notePath: string, templatePath: string, outputAbsolutePath: string): Promise<ConversionReport | void>;
    /** Markers the template defines or mistypes (src/templateInspector.ts). */
    inspectTemplate?(templatePath: string): Promise<TemplateInspection>;
    /** Whether a file or folder already exists at this Vault path. */
    exists(vaultPath: string): boolean;
    /** Exports a markdown note to a real .hwpx file in the Vault and returns its relative path. */
    /** sha256 (hex) of the template file: binds the approved template to the one converted. */
    templateHash(templatePath: string): Promise<string>;
    /** The full export (render capture + conversion) into memory. Writes no Vault file. */
    render(notePath: string, templatePath: string): Promise<{ bytes: Uint8Array; report: ConversionReport }>;
    /** Ancestor folders of a Vault path that do not exist yet, outermost first. */
    missingFolders(vaultPath: string): string[];
    /** Creates the folders, then the new file. Fails rather than overwriting. */
    writeNew(vaultPath: string, bytes: Uint8Array, folders: string[]): Promise<void>;
    /** Current bytes of a Vault file, or null when there is none. */
    readBytes(vaultPath: string): Promise<Uint8Array | null>;
}

class ToolError extends Error {
    constructor(readonly code: string, message: string, readonly retryable = false) {
        super(message);
    }
}

const MAX_RESULT_CHARS = 8000;
const COMMIT_TTL_MS = 10 * 60_000;
const MAX_PREPARED = 16;
const MAX_LISTED = 20;
const RESOURCE_TYPES = ['.md'];
// Notes are .md, like most of a Vault, so neither tool is in the core group:
// a host shows them only when the request mentions one of these.
const KEYWORDS = ['hwpx', 'hwp', '한글', '내보내', '내보낼', 'export', '템플릿'];
const meta = (): JsonObject => ({
    'dev.agentinterop/effect': 'read',
    'dev.agentinterop/group': 'export',
    'dev.agentinterop/resourceTypes': RESOURCE_TYPES,
    'dev.agentinterop/keywords': KEYWORDS,
    'dev.agentinterop/maxResultChars': MAX_RESULT_CHARS,
});

const TOOLS: JsonObject[] = [
    {
        name: 'get_export_options',
        title: 'HWPX 내보내기 설정',
        description: 'HWPX Exporter의 현재 설정을 돌려준다: 쓸 수 있는 한글 템플릿(.hwpx) 목록, 결과를 저장할 위치와 파일 이름 규칙, 그림 캡처 설정.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        annotations: { readOnlyHint: true },
        _meta: meta(),
    },
    {
        name: 'check_export',
        title: 'HWPX 내보내기 점검',
        description: 'Markdown 노트를 한글(HWPX)로 내보내면 어떻게 되는지 미리 점검한다. 변환을 시험 실행해 성공 여부를 확인하고, 저장될 경로, 노트 구성(제목·표·목록·코드·그림 수), 찾지 못해 글자로 대체될 그림, 그림으로 캡처될 코드 블록을 알려 준다. Vault에는 파일을 만들지 않는다.',
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['path'],
            properties: {
                path: { type: 'string', minLength: 1, maxLength: 4096, description: '점검할 Markdown 노트의 Vault 기준 상대 경로.' },
                template: { type: 'string', minLength: 1, maxLength: 4096, description: 'get_export_options가 준 템플릿 경로 중 하나. 생략하면 목록의 첫 템플릿으로 시험한다.' },
            },
        },
        annotations: { readOnlyHint: true },
        _meta: meta(),
    },
    {
        name: 'export_note',
        title: 'HWPX 내보내기 실행',
        description: 'Markdown 노트를 한글(HWPX) 문서로 내보내어 Vault에 새 .hwpx 파일을 생성한다. 템플릿(template)을 지정하면 해당 서식으로 작성되며, 생략 시 템플릿 폴더의 첫 번째 템플릿을 적용한다. outputPath로 저장 위치를 지정할 수 있다.',
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['path'],
            properties: {
                path: { type: 'string', minLength: 1, maxLength: 4096, description: '내보낼 Markdown 노트의 Vault 기준 상대 경로 (예: "노트.md", "100.내용/보고서.md").' },
                template: { type: 'string', minLength: 1, maxLength: 4096, description: 'get_export_options로 확인한 템플릿 경로 중 하나. 생략하면 목록의 첫 번째 템플릿을 사용한다.' },
                outputPath: { type: 'string', minLength: 1, maxLength: 4096, description: '결과 .hwpx 파일의 Vault 기준 상대 경로. 생략하면 플러그인 설정의 위치/이름 규칙을 따른다.' },
            },
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
        // Creates a Vault file: the host asks a person about every export and checkpoints it.
        _meta: { ...meta(), 'dev.agentinterop/effect': 'commit' },
    },
];

const INSTRUCTIONS = 'Markdown 노트를 한글(HWPX) 문서로 내보내는 HWPX Exporter 도구다. get_export_options로 사용 가능한 템플릿 목록과 설정을 확인하고, 필요 시 check_export로 사전 점검을 수행하며, export_note로 Markdown 노트를 .hwpx 파일로 실제 내보내기/생성한다. export_note는 사람이 승인해야 새 파일을 만들고, 이미 있는 파일은 덮어쓰지 않는다.';

/** Sorted-key JSON: equal to RFC 8785 for the strings, integers and arrays used here, so the host recomputes the same digest. */
function canonicalJson(value: unknown): string {
    const normalize = (item: unknown): unknown => Array.isArray(item)
        ? item.map(normalize)
        : item && typeof item === 'object'
            ? Object.fromEntries(Object.entries(item)
                .filter(([, entry]) => entry !== undefined)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([key, entry]) => [key, normalize(entry)]))
            : item;
    return JSON.stringify(normalize(value));
}

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const ownerOf = (caller: Caller): string => JSON.stringify([caller.pluginId ?? '', caller.conversationId ?? '', caller.runId ?? '']);

interface NoteShape {
    headings: number[];
    paragraphs: number;
    tables: number;
    lists: number;
    quotes: number;
    rawHtml: number;
    codeLanguages: Map<string, number>;
    images: string[];
}

/** Counts what the converter will see. Walks the Pandoc-like AST without depending on each node's layout. */
function shapeOf(ast: unknown): NoteShape {
    const shape: NoteShape = {
        headings: [0, 0, 0, 0, 0, 0, 0, 0, 0],
        paragraphs: 0,
        tables: 0,
        lists: 0,
        quotes: 0,
        rawHtml: 0,
        codeLanguages: new Map(),
        images: [],
    };
    const visit = (node: unknown, depth: number): void => {
        if (!node || typeof node !== 'object' || depth > 200) return;
        if (Array.isArray(node)) {
            for (const item of node) visit(item, depth + 1);
            return;
        }
        const { t, c } = node as { t?: unknown; c?: unknown };
        switch (t) {
            case 'Header': {
                const level = Array.isArray(c) && typeof c[0] === 'number' ? c[0] : 1;
                shape.headings[Math.min(9, Math.max(1, level)) - 1] += 1;
                break;
            }
            case 'Para': shape.paragraphs += 1; break;
            case 'Table': shape.tables += 1; break;
            case 'BulletList':
            case 'OrderedList': shape.lists += 1; break;
            case 'BlockQuote': shape.quotes += 1; break;
            case 'Div': {
                // Obsidian callouts arrive as Div.callout; report them as quotes.
                const classes = Array.isArray(c) && Array.isArray(c[0]) && Array.isArray(c[0][1]) ? c[0][1] : [];
                if (classes.includes('callout')) shape.quotes += 1;
                break;
            }
            case 'RawBlock': shape.rawHtml += 1; break;
            case 'CodeBlock': {
                const classes = Array.isArray(c) && Array.isArray(c[0]) && Array.isArray(c[0][1]) ? c[0][1] : [];
                const language = typeof classes[0] === 'string' && classes[0] ? classes[0].toLowerCase() : '';
                shape.codeLanguages.set(language, (shape.codeLanguages.get(language) ?? 0) + 1);
                return;
            }
            case 'Image': {
                const target: unknown = Array.isArray(c) && Array.isArray(c[2]) ? c[2][0] : undefined;
                if (typeof target === 'string') shape.images.push(target);
                return;
            }
            default: break;
        }
        for (const value of Object.values(node)) visit(value, depth + 1);
    };
    visit(ast, 0);
    return shape;
}

/** Conversion warnings as pure JSON (DECISIONS 6: no undefined, no class instances). */
const warningsJson = (report: ConversionReport | undefined): Json[] =>
    (report?.warnings ?? []).map((warning) => ({
        code: warning.code,
        message: warning.message,
        count: warning.count,
        examples: [...warning.examples],
    }));

const warningLines = (report: ConversionReport | undefined, skip: string[] = []): string[] =>
    (report?.warnings ?? [])
        .filter((warning) => !skip.includes(warning.code))
        .map((warning) => `- ${warning.message}${warning.count > 1 ? ` ${warning.count}건` : ''}${warning.examples.length ? `: ${listed(warning.examples)}` : ''}`);

/** Image links arrive percent-encoded from the Markdown parser; show them as written in the note. */
const readable = (source: string): string => {
    try {
        return decodeURIComponent(source);
    } catch {
        return source;
    }
};

const listed = (items: string[]): string =>
    items.slice(0, MAX_LISTED).map(readable).join(', ') + (items.length > MAX_LISTED ? ` 외 ${items.length - MAX_LISTED}개` : '');

function normalizeNotePath(value: unknown): string {
    if (typeof value !== 'string') throw new ToolError('INVALID_ARGUMENT', 'path는 문자열이어야 한다.', true);
    const raw = value.trim().replace(/\\/g, '/');
    const parts = raw.split('/');
    // eslint-disable-next-line no-control-regex -- control characters are exactly what this check rejects
    if (!raw || /^(?:[A-Za-z]:|\/)/.test(raw) || /[\u0000-\u001F]/.test(raw) || parts.includes('..')) {
        throw new ToolError('INVALID_ARGUMENT', 'path는 Vault 기준 상대 경로여야 한다.', true);
    }
    return parts.filter((part) => part && part !== '.').join('/');
}

export function createAgentProvider(host: ExportProviderHost): AgentCapabilityProvider {
    const descriptor: JsonObject = {
        provider: { id: host.id, name: host.name, version: host.version, description: 'Markdown 노트의 HWPX 내보내기 설정과 사전 점검' },
        instructions: INSTRUCTIONS,
        tools: TOOLS,
    };
    let disposed = false;

    /** Validates export_note arguments; the destination checked here is the one written. */
    const resolveExport = async (args: JsonObject): Promise<{ notePath: string; template: string; destination: string }> => {
        const notePath = normalizeNotePath(args.path);
        if (!/\.md$/i.test(notePath)) throw new ToolError('UNSUPPORTED_FORMAT', 'Markdown 노트(.md)만 내보낼 수 있다.');
        const note = await host.readNote(notePath);
        if (!note) throw new ToolError('NOT_FOUND', `Vault에 이 노트가 없다: ${notePath}`, true);
        const templates = host.templates();
        if (templates.length === 0) {
            throw new ToolError('NO_TEMPLATE', '템플릿 폴더에 .hwpx 템플릿이 없어 내보낼 수 없다. 사람이 플러그인 설정에서 템플릿 폴더를 정해야 한다.');
        }
        const template = args.template === undefined ? templates[0] : args.template;
        if (typeof template !== 'string' || !templates.includes(template)) {
            throw new ToolError('INVALID_ARGUMENT', `template은 다음 중 하나여야 한다: ${listed(templates)}`, true);
        }

        let customOutputPath: string | undefined;
        if (args.outputPath !== undefined) {
            if (typeof args.outputPath !== 'string' || !args.outputPath.trim()) {
                throw new ToolError('INVALID_ARGUMENT', 'outputPath는 비어있지 않은 문자열이어야 한다.', true);
            }
            customOutputPath = normalizeNotePath(args.outputPath);
            if (!/\.hwpx$/i.test(customOutputPath)) {
                customOutputPath += '.hwpx';
            }
        }

        // The path checked here is the path written, so settings cannot move the write elsewhere.
        const target = customOutputPath ?? host.outputPath(notePath);
        if (target.split('/').some((part) => part.startsWith('.'))) {
            throw new ToolError('INVALID_ARGUMENT', `숨김 폴더나 숨김 파일에는 내보낼 수 없다: ${target}`, true);
        }
        if (host.exists(target)) {
            throw new ToolError('ALREADY_EXISTS', `이미 있는 파일은 덮어쓰지 않는다: ${target}. 다른 outputPath를 지정하라.`, true);
        }

        return { notePath, template, destination: target };
    };

    const prepared = new Map<string, {
        shown: CommitPreparation;
        bytes: Uint8Array;
        owner: string;
        state: 'open' | 'executed' | 'dropped';
        receipt?: CommitReceipt;
    }>();

    const resolveTarget = async (name: string, args: JsonObject, ctx?: CommitContext): Promise<ExportTarget> => {
        if (disposed) throw new ToolError('DISPOSED', '플러그인이 종료됐다.');
        if (ctx?.signal?.aborted) throw new ToolError('CANCELLED', '대상 확인이 취소됐다.');
        if (name !== 'export_note') throw new ToolError('UNKNOWN_TOOL', `저장 도구가 아니다: ${name}`);
        const { template, destination } = await resolveExport(args ?? {});
        return { kind: 'new', destination, template: { path: template, sha256: await host.templateHash(template) } };
    };

    const notWritten = (record: { shown: CommitPreparation }, ticketId: string, code: string, message: string): CommitReceipt => ({
        preparationId: record.shown.preparationId,
        ticketId,
        preparationDigest: record.shown.preparationDigest,
        state: 'not_written',
        entries: record.shown.writeSet.map((entry) => ({ path: entry.path, kind: entry.kind, state: 'not_written' as const })),
        warnings: [],
        error: { code, message: message.slice(0, 1000) },
    });

    const commit: AgentCapabilityProvider['commit'] = {
        /** Fixes the exact bytes of the new file in memory. Writes no Vault file. */
        async prepare(request, ctx) {
            if (disposed) throw new ToolError('DISPOSED', '플러그인이 종료됐다.');
            if (request?.tool !== 'export_note') throw new ToolError('UNKNOWN_TOOL', `저장 도구가 아니다: ${String(request?.tool)}`);
            if (!ctx?.caller) throw new ToolError('INVALID_ARGUMENT', '저장을 요청한 호출을 확인할 수 없다.');
            const target = await resolveTarget(request.tool, request.args, ctx);
            if (canonicalJson(target) !== canonicalJson(request.target)) {
                throw new ToolError('TARGET_MISMATCH', '확정한 노트·템플릿·저장 경로가 지금과 다르다. 다시 준비하라.', true);
            }
            const { notePath, template } = await resolveExport(request.args ?? {});
            const { bytes, report } = await host.render(notePath, template);
            if (ctx.signal?.aborted) throw new ToolError('CANCELLED', '저장 준비가 취소됐다.');
            const owner = ownerOf(ctx.caller);
            for (const record of prepared.values()) {
                if (record.state === 'open' && record.owner === owner && record.shown.destination === target.destination) {
                    record.state = 'dropped';
                }
            }
            const folders: FolderEntry[] = host.missingFolders(target.destination)
                .map((folder) => ({ kind: 'folder', path: folder, op: 'create', role: 'folder', existedBefore: false }));
            const body: Omit<CommitPreparation, 'preparationDigest'> = {
                preparationId: `hwpx-${randomUUID()}`,
                mode: 'create',
                template: target.template,
                destination: target.destination,
                format: 'hwpx',
                saveOptions: { note: notePath },
                writeSet: [
                    ...folders,
                    {
                        kind: 'file', path: target.destination, op: 'create', role: 'primary',
                        sha256Before: null, sha256Expected: sha256(bytes), sizeBytes: bytes.byteLength,
                    },
                ],
                providerInternalWrites: [],
                report: {
                    summary: [`노트 ${notePath}을(를) 템플릿 ${template}로 변환한 새 파일을 만든다.`],
                    warnings: warningLines(report).slice(0, 20).map((line) => line.slice(0, 300)),
                },
                expiresAt: new Date(Date.now() + COMMIT_TTL_MS).toISOString(),
            };
            const shown: CommitPreparation = { ...body, preparationDigest: sha256(canonicalJson(body)) };
            prepared.set(shown.preparationId, { shown, bytes, owner, state: 'open' });
            while (prepared.size > MAX_PREPARED) prepared.delete(prepared.keys().next().value as string);
            return JSON.parse(JSON.stringify(shown)) as CommitPreparation;
        },

        /**
         * Writes exactly the prepared bytes. The host has checkpointed the write set
         * before this call; this side re-checks the binding and never writes twice.
         */
        async execute(ticket, ctx) {
            const record = prepared.get(ticket?.preparationId);
            if (!record) throw new ToolError('NOT_FOUND', '저장 준비를 찾을 수 없다. 다시 실행하지 말고 host의 체크포인트로 확인하라.');
            const ticketId = String(ticket.ticketId);
            if (record.receipt) return JSON.parse(JSON.stringify(record.receipt)) as CommitReceipt;
            if (!ctx?.caller || !ticket.caller || ownerOf(ctx.caller) !== record.owner || ownerOf(ticket.caller) !== record.owner) {
                return notWritten(record, ticketId, 'TARGET_MISMATCH', '저장을 준비한 대화·실행과 다른 호출이다. 저장하지 않았다.');
            }
            if (record.state !== 'open') {
                return notWritten(record, ticketId, 'REVISION_CONFLICT', '이 저장 준비는 새 준비로 대체됐다. 저장하지 않았다.');
            }
            if (ticket.preparationDigest !== record.shown.preparationDigest
                || ticket.destination !== record.shown.destination
                || canonicalJson(ticket.writeSet) !== canonicalJson(record.shown.writeSet)) {
                return notWritten(record, ticketId, 'INVALID_ARGUMENT', '저장 ticket이 승인한 준비와 다르다. 저장하지 않았다.');
            }
            if (Date.parse(record.shown.expiresAt) <= Date.now()) {
                return notWritten(record, ticketId, 'EXPIRED', '저장 준비가 만료됐다. 저장하지 않았다.');
            }
            if (disposed || ctx.signal?.aborted) {
                return notWritten(record, ticketId, 'CANCELLED', '저장이 취소됐다. 저장하지 않았다.');
            }
            const { destination } = record.shown;
            if (await host.readBytes(destination)) {
                return notWritten(record, ticketId, 'ALREADY_EXISTS', `이미 있는 파일은 덮어쓰지 않는다: ${destination}`);
            }

            record.state = 'executed';
            const folders = record.shown.writeSet.filter((entry): entry is FolderEntry => entry.kind === 'folder').map((entry) => entry.path);
            let error: CommitReceipt['error'];
            try {
                await host.writeNew(destination, record.bytes, folders);
            } catch (cause) {
                error = { code: 'WRITE_FAILED', message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 1000) };
            }
            // Report only what can be read back.
            const stillMissing = new Set(host.missingFolders(destination));
            const after = await host.readBytes(destination).catch(() => null);
            const fileHash = after ? sha256(after) : undefined;
            const expected = (record.shown.writeSet.find((entry) => entry.kind === 'file') as FileEntry).sha256Expected;
            const entries: CommitReceipt['entries'] = record.shown.writeSet.map((entry) => entry.kind === 'folder'
                ? { path: entry.path, kind: 'folder' as const, state: stillMissing.has(entry.path) ? 'not_written' as const : 'written' as const }
                : {
                    path: entry.path,
                    kind: 'file' as const,
                    state: !fileHash ? 'not_written' as const : fileHash === expected ? 'written' as const : 'unknown' as const,
                    ...(fileHash ? { sha256After: fileHash } : {}),
                });
            const states = entries.map((entry) => entry.state);
            const state: CommitReceipt['state'] = states.includes('unknown') ? 'unknown'
                : states.every((item) => item === 'written') ? 'written'
                    : states.includes('written') ? 'partial' : 'not_written';
            record.receipt = {
                preparationId: record.shown.preparationId,
                ticketId,
                preparationDigest: record.shown.preparationDigest,
                state,
                entries,
                warnings: [],
                ...(error ? { error } : {}),
            };
            return JSON.parse(JSON.stringify(record.receipt)) as CommitReceipt;
        },

        /** Result of an execution. Never writes. */
        async status(preparationId) {
            const record = prepared.get(preparationId);
            if (!record) return { state: 'unknown_preparation' };
            return JSON.parse(JSON.stringify(record.receipt ?? notWritten(record, 'none', 'NOT_EXECUTED', '저장을 실행하지 않았다.'))) as CommitReceipt;
        },
    };

    const handlers: Record<string, (args: JsonObject) => Promise<AgentToolResult>> = {
        async get_export_options(): Promise<AgentToolResult> {
            const options = host.options();
            const templates = host.templates();
            const capture = !options.captureRenderedBlocks
                ? '끔'
                : [
                    options.captureMermaid ? 'Mermaid' : '',
                    options.captureSvgFiles ? 'SVG 파일' : '',
                    options.captureThirdPartyRenderers ? `서드파티(${options.thirdPartyLanguages.join(', ')})` : '',
                ].filter(Boolean).join(', ') || '대상 없음';
            const lines = [
                `템플릿 폴더: ${options.templateFolderPath || '/ (Vault 최상위)'} · 템플릿 ${templates.length}개${templates.length ? '' : ' (이 폴더 바로 아래에 .hwpx가 없어 내보낼 수 없다)'}`,
                ...templates.slice(0, MAX_LISTED).map((template) => `- ${template}`),
                ...(templates.length > MAX_LISTED ? [`… 템플릿 ${templates.length - MAX_LISTED}개 더 있음`] : []),
                `저장 위치: ${options.outputMode === 'fixed_folder' ? `고정 폴더 ${options.fixedOutputFolder}` : '노트와 같은 폴더'} · 파일 이름: ${options.namingPattern} · 같은 이름이 있으면 ${options.appendSequenceOnConflict ? '-1, -2를 붙인다' : '덮어쓴다'}`,
                `H1 앞 쪽 나눔: ${options.pageBreakBeforeH1 ? '켬' : '끔'} · 그림 캡처: ${capture}`,
            ];
            return {
                content: [{ type: 'text', text: lines.join('\n') }],
                structuredContent: {
                    templates: templates.length,
                    outputMode: options.outputMode,
                    overwritesExisting: !options.appendSequenceOnConflict,
                },
            };
        },
        async check_export(args): Promise<AgentToolResult> {
            const notePath = normalizeNotePath(args.path);
            if (!/\.md$/i.test(notePath)) throw new ToolError('UNSUPPORTED_FORMAT', 'Markdown 노트(.md)만 내보낼 수 있다.');
            const note = await host.readNote(notePath);
            if (!note) throw new ToolError('NOT_FOUND', `Vault에 이 노트가 없다: ${notePath}`, true);
            const templates = host.templates();
            if (templates.length === 0) {
                throw new ToolError('NO_TEMPLATE', '템플릿 폴더에 .hwpx 템플릿이 없어 내보낼 수 없다. 사람이 플러그인 설정에서 템플릿 폴더를 정해야 한다.');
            }
            const template = args.template === undefined ? templates[0] : args.template;
            if (typeof template !== 'string' || !templates.includes(template)) {
                throw new ToolError('INVALID_ARGUMENT', `template은 다음 중 하나여야 한다: ${listed(templates)}`, true);
            }

            const options = host.options();
            const { content } = parseMarkdownStringWithFrontmatter(note.markdown);
            const shape = shapeOf(new MarkoToPandocAdapter().parse(rewriteObsidianImageEmbeds(content)));
            const remote = shape.images.filter((source) => /^[a-z][a-z0-9+.-]*:/i.test(source));
            const local = shape.images.filter((source) => !remote.includes(source));
            const missing = local.filter((source) => !host.resolvesImage(source, notePath));
            const captured: string[] = [];
            const kept: string[] = [];
            const thirdParty = new Set(options.thirdPartyLanguages.map((language) => language.toLowerCase()));
            for (const [language, count] of shape.codeLanguages) {
                const capturable = language === 'mermaid'
                    ? options.captureMermaid
                    : thirdParty.has(language) && options.captureThirdPartyRenderers;
                if (language === 'mermaid' || thirdParty.has(language)) {
                    (options.captureRenderedBlocks && capturable ? captured : kept).push(`${language} ${count}개`);
                }
            }

            // The converter only writes files, so the trial output goes to the OS temp folder and is removed.
            const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-export-check-'));
            let bytes = 0;
            let failure = '';
            let report: ConversionReport | undefined;
            try {
                const outputFile = path.join(workDir, 'check.hwpx');
                report = (await host.convert(note.markdown, notePath, template, outputFile)) ?? undefined;
                bytes = fs.statSync(outputFile).size;
            } catch (error) {
                failure = error instanceof Error ? error.message : String(error);
            } finally {
                fs.rmSync(workDir, { recursive: true, force: true });
            }

            // Template typos silently fall back, so they are worth an agent's attention.
            let inspection: TemplateInspection | undefined;
            try {
                inspection = await host.inspectTemplate?.(template);
            } catch {
                inspection = undefined;
            }
            const typos = (inspection?.unknownMarkers ?? []).filter((item) => item.suggestion);

            const headings = shape.headings.map((count, index) => (count ? `H${index + 1} ${count}` : '')).filter(Boolean).join(', ');
            const codeBlocks = [...shape.codeLanguages.values()].reduce((sum, count) => sum + count, 0);
            const outputPath = host.outputPath(notePath);
            const notes = [
                ...(missing.length ? [`- 그림 ${missing.length}개를 찾지 못했거나 넣을 수 없는 형식이라 글자로 대체된다: ${listed(missing)}`] : []),
                ...(remote.length ? [`- 원격 그림 ${remote.length}개는 넣지 않고 글자로 대체된다: ${listed(remote)}`] : []),
                ...(captured.length ? [`- 내보낼 때 그림으로 캡처된다(이 점검에서는 캡처하지 않았다): ${captured.join(', ')}`] : []),
                ...(kept.length ? [`- 캡처 설정이 꺼져 있어 코드 글자 그대로 들어간다: ${kept.join(', ')}`] : []),
                ...(shape.rawHtml ? [`- HTML 블록 ${shape.rawHtml}개: 표(<table>) 외의 HTML은 그대로 변환되지 않을 수 있다`] : []),
                ...(!options.appendSequenceOnConflict ? ['- 같은 이름의 파일이 있으면 덮어쓰는 설정이다'] : []),
                // Image problems are already listed above from the note itself.
                ...warningLines(report, ['image_missing', 'image_remote']),
                ...(typos.length
                    ? [`- 템플릿에 오타로 보이는 marker가 있어 그 서식이 적용되지 않는다: ${listed(typos.map((item) => `${item.marker}→${item.suggestion}`))}`]
                    : []),
            ];
            const lines = [
                `노트 ${notePath} → 내보내면 ${outputPath} (템플릿 ${template}${args.template === undefined && templates.length > 1 ? `, 템플릿 ${templates.length}개 중 첫 번째로 시험` : ''})`,
                failure
                    ? `변환 시험: 실패 — ${failure}`
                    : `변환 시험: 성공 · HWPX ${bytes.toLocaleString('en-US')}바이트 (Vault에는 아무것도 만들지 않았다)`,
                `구성: 제목 ${shape.headings.reduce((sum, count) => sum + count, 0)}${headings ? `(${headings})` : ''} · 문단 ${shape.paragraphs} · 표 ${shape.tables} · 목록 ${shape.lists} · 인용 ${shape.quotes} · 코드 블록 ${codeBlocks} · 그림 ${shape.images.length}`,
                ...(notes.length ? ['주의:', ...notes] : ['주의할 점을 찾지 못했다.']),
            ];
            return {
                content: [{ type: 'text', text: lines.join('\n') }],
                structuredContent: {
                    converts: !failure,
                    outputPath,
                    template,
                    tables: shape.tables,
                    images: shape.images.length,
                    missingImages: missing.length,
                    remoteImages: remote.length,
                    warnings: warningsJson(report),
                    templateTypos: typos.map((item) => ({ marker: item.marker, suggestion: item.suggestion ?? '' })),
                },
                _meta: { 'dev.agentinterop/resource': { path: notePath } },
            };
        },
        async export_note(): Promise<AgentToolResult> {
            throw new ToolError('INVALID_ARGUMENT', 'export_note는 host의 저장 승인 절차(commit)로만 실행된다.');
        },
    };

    return {
        protocol: 'agentinterop',
        protocolVersion: 1,
        async describe() {
            return descriptor;
        },
        resolveTarget,
        commit,
        async callTool(name, args, ctx) {
            try {
                if (disposed) throw new ToolError('DISPOSED', '플러그인이 종료됐다.');
                const handler = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : undefined;
                if (!handler) throw new ToolError('UNKNOWN_TOOL', `알 수 없는 도구다: ${name}`);
                const result = await handler(args ?? {});
                if (ctx?.signal?.aborted) throw new ToolError('CANCELLED', '호출이 취소됐다.');
                return result;
            } catch (error) {
                const known = error instanceof ToolError;
                const code = known ? error.code : 'INTERNAL';
                const retryable = known && error.retryable;
                return {
                    isError: true,
                    content: [{ type: 'text', text: known ? error.message : `도구 실행 중 오류: ${error instanceof Error ? error.message : String(error)}` }],
                    structuredContent: { code, retryable },
                    _meta: { 'dev.agentinterop/error': { code, retryable } },
                };
            }
        },
        dispose() {
            disposed = true;
            prepared.clear();
        },
    };
}
