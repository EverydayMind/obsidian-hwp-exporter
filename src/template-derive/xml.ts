import { DOMParser, type Element, type Document, type Node } from '@xmldom/xmldom';
import { preflightXml } from './xmlPreflight';
import { Guard, LIMITS, StyleError } from './limits';
export type { Element, Document } from '@xmldom/xmldom';
export const NS = { head: 'http://www.hancom.co.kr/hwpml/2011/head', para: 'http://www.hancom.co.kr/hwpml/2011/paragraph', core: 'http://www.hancom.co.kr/hwpml/2011/core', section: 'http://www.hancom.co.kr/hwpml/2011/section' };
export function children(node: Node): Element[] { return Array.from(node.childNodes ?? []).filter(child => child.nodeType === 1) as Element[]; }
export function is(node: Element, local: string, namespace: string): boolean { return node.localName === local && node.namespaceURI === namespace; }
export function first(node: Node | undefined, local: string, namespace: string): Element | undefined { return node ? descendants(node, local, namespace)[0] : undefined; }
export function descendants(node: Node, local: string, namespace: string): Element[] {
  const result: Element[] = [], stack = children(node).reverse();
  while (stack.length) { const current = stack.pop()!; if (is(current, local, namespace)) result.push(current); stack.push(...children(current).reverse()); }
  return result;
}
export async function parseXml(bytes: Uint8Array, guard: Guard): Promise<Document> {
  if (bytes.length > LIMITS.stream) throw new StyleError('too_large', 'XML stream too large.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new StyleError('corrupted', 'XML must be valid UTF-8.'); }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw new StyleError('unsupported', 'DTD/entities are forbidden.');
  await preflightXml(text, guard);
  let document: Document;
  try { document = new DOMParser({ onError: (level, message) => { if (level === 'warning' && message.startsWith('Unicode replacement character detected')) return; throw new Error(`${level}: ${message}`); } }).parseFromString(text, 'application/xml'); }
  catch { throw new StyleError('corrupted', 'Malformed XML.'); }
  const stack: Array<[Node, number]> = [[document, 0]];
  while (stack.length) { const [node, depth] = stack.pop()!; await guard.tick(); for (const child of Array.from(node.childNodes ?? [])) stack.push([child, depth + 1]); }
  return document;
}
