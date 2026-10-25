// Normative report-style/v1 types; schemas are in contracts/report-style/v1.
export type Sha256 = string // ^[0-9a-f]{64}$
export type SourceFormat = 'hwp5' | 'hwpx'
export type Origin = 'explicit' | 'inherited' | 'extractor_default'
export type MissingReason = 'absent' | 'unsupported' | 'unresolved_reference'
export type RawScalar = null | boolean | number | string
export type Atom<T> =
  | {
      state: 'measured'
      value: T
      raw: RawScalar
      rawUnit: string
      origin: Origin
      evidenceRef: string
    }
  | { state: 'not_measured'; reason: MissingReason; evidenceRef: string }
export type Language =
  | 'hangul'
  | 'latin'
  | 'hanja'
  | 'japanese'
  | 'other'
  | 'symbol'
  | 'user'
export type CharacterStyle = {
  fonts: Record<Language, Atom<string>>
  sizePt: Atom<number>
  colorRgb: Atom<string>
  bold: Atom<boolean>
  italic: Atom<boolean>
  ratioPct: Record<Language, Atom<number>>
  spacingPct: Record<Language, Atom<number>>
}
export type LineSpacing = {
  kind: 'percent' | 'fixed' | 'minimum' | 'between'
  value: number
  unit: 'pct' | 'pt'
}
export type ParagraphStyle = {
  align: Atom<'left' | 'right' | 'center' | 'justify' | 'distribute'>
  leftPt: Atom<number>
  rightPt: Atom<number>
  firstLinePt: Atom<number>
  beforePt: Atom<number>
  afterPt: Atom<number>
  lineSpacing: Atom<LineSpacing>
  pageBreakBefore: Atom<boolean>
  outlineLevel: Atom<number> // 0=없음, 1..9=개요 수준
}
export type SectionStyle = {
  ref: string
  widthPt: Atom<number>
  heightPt: Atom<number>
  orientation: Atom<'portrait' | 'landscape'>
  marginsPt: Record<
    'left' | 'right' | 'top' | 'bottom' | 'header' | 'footer' | 'gutter',
    Atom<number>
  >
  columns: Atom<number>
}
export type Border = { kind: string; widthPt: number; colorRgb: string }
export type TableStyle = {
  ref: string
  rowCount: number
  columnCount: number
  columnRatios: Atom<number[]>
  cells: Array<{
    ref: string
    row: number
    column: number
    rowSpan: number
    columnSpan: number
    borders: Record<'left' | 'right' | 'top' | 'bottom', Atom<Border>>
    fillRgb: Atom<string>
    paddingPt: Record<'left' | 'right' | 'top' | 'bottom', Atom<number>>
    paragraphRefs: string[]
  }>
}
export type NodeRef = {
  ref: string
  parentRef: string | null
  kind: 'paragraph' | 'table' | 'cell' | 'header' | 'footer'
  topLevelOrder: number | null
}
export type Paragraph = {
  ref: string
  sourceStyleId: string | null
  paragraphStyle: number // paragraphStyles 색인
  textCodePoints: number
  runs: Array<{ start: number; length: number; characterStyle: number }> // characterStyles 색인
  prefix: string | null // 본문 일부가 아닌 번호/글머리 토큰만
  candidates: Array<{ role: string; rule: string; evidenceRefs: string[] }>
}
export type StyleSnapshot = {
  schema: 'report-style-snapshot/1'
  extractorVersion: string
  source: { sha256: Sha256; size: number; format: SourceFormat } // 경로 없음
  complete: true // 전수 순회 완료. 개별 미측정 속성과 별개
  sections: SectionStyle[]
  nodes: NodeRef[]
  characterStyles: CharacterStyle[]
  paragraphStyles: ParagraphStyle[]
  paragraphs: Paragraph[]
  tables: TableStyle[]
  unsupported: Array<{ feature: string; refs: string[] }>
  warnings: Array<{ code: string; count: number }>
}
export type Binding = {
  key: string // 프로파일 안에서 유일, 최대64자
  marker: string // Exporter의 실제 지원 marker catalog로 재검증
  representativeRef: string
  assignedBy: 'rule' | 'model' | 'user'
}
export type FixedRegion = {
  ref: string
  position: 'before_content' | 'after_content'
  replacements: Array<{ paragraphRef: string; metaKey: string }>
}
export type ProfileMachine = {
  schema: 'report-style-profile/1'
  id: string
  revision: number
  created: string
  updated: string
  title: string
  sourcePath: string // 측정 당시 Vault 경로. 표시·재측정용, digest 결속 아님
  measurementSha256: Sha256
  snapshot: StyleSnapshot
  bindings: Binding[]
  fixedRegions: FixedRegion[]
  template: null | {
    path: string
    sha256: Sha256
    derivedFromSourceSha256: Sha256
    derivationSha256: Sha256
  }
}
