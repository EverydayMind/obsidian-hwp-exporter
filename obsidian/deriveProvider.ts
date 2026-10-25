import type { ExportProviderHost, ExportTarget } from './agentProvider';
import { deriveTemplate, getDerivationReport, DERIVATION_MARKERS } from '../src/template-derive/derive';
import { byteDigest } from '../src/template-derive/digest';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
export type InputDependency = { path: string; sha256: string };
export class DeriveProviderError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const pathSchema = { type: 'string', minLength: 1, maxLength: 4096 }, hashSchema = { type: 'string', minLength: 64, maxLength: 64 };
const metadata = (effect: string): JsonObject => ({ 'dev.agentinterop/effect': effect, 'dev.agentinterop/group': 'export', 'dev.agentinterop/resourceTypes': ['.md', '.hwpx'], 'dev.agentinterop/keywords': ['hwpx', 'hwp', '한글', '템플릿', '양식', '서식', 'profile', 'derive'], 'dev.agentinterop/maxResultChars': 40000 });
export const DERIVE_TOOL_DEFINITIONS: JsonObject[] = [
  { name: 'derive_template', title: 'Derive report template', description: 'Create a new single-section HWPX template from an exact sample and verified style-profile note. Preserves only selected fixed content; requires per-call host approval and checkpoint.', inputSchema: { type: 'object', additionalProperties: false, required: ['sample_path', 'expected_sample_sha256', 'profile_path', 'expected_profile_sha256', 'output_path'], properties: { sample_path: pathSchema, expected_sample_sha256: hashSchema, profile_path: pathSchema, expected_profile_sha256: hashSchema, output_path: pathSchema } }, _meta: metadata('commit') },
  { name: 'get_derivation_report', title: 'Inspect derived report template', description: 'Recheck current bytes, XML, marker inventory and provenance after restart or resave. Layout is not measured; metadata is not authenticity evidence.', inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'expected_sha256'], properties: { path: pathSchema, expected_sha256: hashSchema } }, _meta: metadata('read') },
];
export const markerCatalog = [...DERIVATION_MARKERS];
export function userPath(value: unknown): string {
// eslint-disable-next-line no-control-regex -- Control bytes must be rejected in untrusted Vault/archive paths.
  if (typeof value !== 'string' || !value || value.length > 4096 || /^(?:[A-Za-z]:|\/)/.test(value) || /[\\\x00-\x1f]/.test(value) || value.split('/').some(part => !part || part.startsWith('.'))) throw new DeriveProviderError('INVALID_ARGUMENT', 'Canonical user Vault relative path required.');
  return value;
}
const sha = (value: unknown): string => { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new DeriveProviderError('INVALID_ARGUMENT', 'Exact SHA-256 required.'); return value; };
async function read(host: ExportProviderHost, path: string, expected: string, max = 32 * 1024 * 1024): Promise<Uint8Array> {
  const bytes = await host.readBytes(path);
  if (!bytes || bytes.byteLength > max || byteDigest(bytes) !== expected) throw new DeriveProviderError('SOURCE_CHANGED', 'Input missing, oversized or changed.');
  return bytes;
}
export async function dependenciesCurrent(host: ExportProviderHost, dependencies: readonly InputDependency[]): Promise<boolean> {
  if (dependencies.length > 32) return false;
  let total = 0; const paths = new Map<string, string>();
  for (const dependency of dependencies) {
    const path = userPath(dependency.path), expected = sha(dependency.sha256);
    if (paths.has(path) && paths.get(path) !== expected) return false;
    if (paths.has(path)) continue; paths.set(path, expected);
    const bytes = await host.readBytes(path);
    if (!bytes || (total += bytes.length) > 128 * 1024 * 1024 || byteDigest(bytes) !== expected) return false;
  }
  return true;
}
export async function resolveDerivation(host: ExportProviderHost, args: JsonObject): Promise<ExportTarget> {
  const required = ['sample_path', 'expected_sample_sha256', 'profile_path', 'expected_profile_sha256', 'output_path'];
  if (Object.keys(args).length !== required.length || required.some(key => !(key in args))) throw new DeriveProviderError('INVALID_ARGUMENT', 'Exact derivation arguments required.');
  const sample = userPath(args.sample_path), profile = userPath(args.profile_path), output = userPath(args.output_path);
  if (!sample.endsWith('.hwpx') || !profile.endsWith('.md') || !output.endsWith('.hwpx')) throw new DeriveProviderError('UNSUPPORTED_FORMAT', 'Measure an HWPX copy before deriving a template.');
  const folder = host.options().templateFolderPath.replace(/\/$/, '');
  if (output.split('/').slice(0, -1).join('/') !== folder) throw new DeriveProviderError('INVALID_ARGUMENT', 'Template output must be directly under the configured template folder.');
  if (host.exists(output)) throw new DeriveProviderError('ALREADY_EXISTS', 'Template overwrite forbidden.');
  await read(host, sample, sha(args.expected_sample_sha256)); await read(host, profile, sha(args.expected_profile_sha256), 6 * 1024 * 1024);
  return { kind: 'new', destination: output, template: { path: sample, sha256: sha(args.expected_sample_sha256) } };
}
export async function prepareDerivation(host: ExportProviderHost, args: JsonObject, signal?: AbortSignal) {
  const target = await resolveDerivation(host, args);
  const sample = await read(host, target.template.path, target.template.sha256), profile = await read(host, userPath(args.profile_path), sha(args.expected_profile_sha256), 6 * 1024 * 1024);
  const result = await deriveTemplate({ sampleBytes: sample, profileBytes: profile, expectedSampleSha256: target.template.sha256, expectedProfileSha256: sha(args.expected_profile_sha256), signal });
  const inputDependencies = [{ path: target.template.path, sha256: target.template.sha256 }, { path: userPath(args.profile_path), sha256: sha(args.expected_profile_sha256) }];
  if (!await dependenciesCurrent(host, inputDependencies)) throw new DeriveProviderError('SOURCE_CHANGED', 'Input changed during preparation.');
  return { ...result, target, inputDependencies, notePath: userPath(args.profile_path) };
}
export async function derivationReport(host: ExportProviderHost, args: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
  if (Object.keys(args).length !== 2) throw new DeriveProviderError('INVALID_ARGUMENT', 'Exact report arguments required.');
  const path = userPath(args.path), expected = sha(args.expected_sha256), bytes = await read(host, path, expected);
  const report = await getDerivationReport(bytes, expected, signal);
  if (!await dependenciesCurrent(host, [{ path, sha256: expected }])) throw new DeriveProviderError('SOURCE_CHANGED', 'Template changed during inspection.');
  return report as JsonObject;
}
