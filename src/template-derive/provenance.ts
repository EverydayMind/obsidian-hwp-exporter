import type { Node } from '@xmldom/xmldom';
import type { Document } from './xml';
import { descendants } from './xml';
import { canonicalPrefixes } from './dom';
import type { Asset } from './sanitizePackage';
import { canonicalDigest } from './digest';

export const PROVENANCE_NS = 'urn:verbex:report-style:1';
export type Inventory = Array<{ marker: string; count: number }>;
export function markerInventory(texts: string[]): Inventory {
  const counts = new Map<string, number>();
  for (const text of texts) for (const match of text.matchAll(/\{\{([^{}\r\n]{1,128})\}\}/g)) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([marker, count]) => ({ marker, count }));
}
/** Integrity only: a digest cannot authenticate whoever produced this package. */
export function payloadDigest(header: Document, section: Document, manifest: Document, assets: Asset[]): string {
  const clean = canonicalPrefixes(manifest);
  for (const node of descendants(clean, 'style', PROVENANCE_NS)) node.parentNode!.removeChild(node);
  const tree = (node: Node): unknown => {
    if (node.nodeType === 3 || node.nodeType === 4) return node.nodeValue || null;
    if (node.nodeType !== 1) return null;
    const element = node as import('@xmldom/xmldom').Element;
    return { name: [element.namespaceURI, element.localName], attributes: Array.from(element.attributes).filter(attr => attr.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && attr.name !== 'xmlns').map(attr => [attr.namespaceURI ?? '', attr.localName ?? attr.name, attr.value]).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0), children: Array.from(node.childNodes).map(tree).filter(child => child !== null) };
  };
  return canonicalDigest({ header: tree(header.documentElement!), section: tree(section.documentElement!), manifest: tree(clean.documentElement!), assets: assets.map(({ id, path, sha256 }) => ({ id, path, sha256 })) });
}
export function writeProvenance(document: Document, sourceSha256: string, derivationSha256: string, inventory: Inventory, contentSha256: string): void {
  const metadata = descendants(document, 'metadata', 'http://www.idpf.org/2007/opf/')[0];
  if (!metadata) throw new Error('Package metadata missing.');
  const node = document.createElementNS(PROVENANCE_NS, 'v:style');
  node.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:v', PROVENANCE_NS);
  node.setAttribute('contentSha256', contentSha256); node.setAttribute('schema', 'report-style-derivation/1'); node.setAttribute('sourceSha256', sourceSha256); node.setAttribute('derivationSha256', derivationSha256); node.setAttribute('markerInventorySha256', canonicalDigest(inventory)); metadata.appendChild(node);
}
export function readProvenance(document: Document, inventory: Inventory, contentSha256: string) {
  const entries = descendants(document, 'style', PROVENANCE_NS), node = entries.length === 1 ? entries[0] : undefined;
  const sourceSha256 = node?.getAttribute('sourceSha256'), derivationSha256 = node?.getAttribute('derivationSha256');
  const verified = !!node && node.getAttribute('schema') === 'report-style-derivation/1' && /^[0-9a-f]{64}$/.test(sourceSha256 ?? '') && /^[0-9a-f]{64}$/.test(derivationSha256 ?? '') && node.getAttribute('markerInventorySha256') === canonicalDigest(inventory) && node.getAttribute('contentSha256') === contentSha256;
  return { sourceSha256: sourceSha256 && /^[0-9a-f]{64}$/.test(sourceSha256) ? sourceSha256 : null, derivationSha256: derivationSha256 && /^[0-9a-f]{64}$/.test(derivationSha256) ? derivationSha256 : null, provenance: { state: verified ? 'verified' : 'unverified', reason: verified ? 'Current content and marker inventory match provenance; not an authenticity claim.' : 'Provenance missing, malformed or content/inventory changed.' } };
}
