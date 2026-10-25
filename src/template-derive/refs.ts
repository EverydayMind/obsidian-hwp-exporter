import type { NodeRef } from './types';
export class References {
  private paragraphs = 0; private tables = 0; private headers = 0; private footers = 0; private top = 0;
  constructor(readonly section: string, readonly nodes: NodeRef[]) {}
  add(kind: NodeRef['kind'], parentRef: string | null, address?: string): string {
    const suffix = kind === 'paragraph' ? `p${this.paragraphs++}` : kind === 'table' ? `t${this.tables++}` : kind === 'header' ? `h${this.headers++}` : kind === 'footer' ? `f${this.footers++}` : `c${address}`;
    const ref = kind === 'cell' ? `${parentRef}/${suffix}` : `${this.section}/${suffix}`;
    this.nodes.push({ ref, kind, parentRef, topLevelOrder: parentRef === null ? this.top++ : null });
    return ref;
  }
}
