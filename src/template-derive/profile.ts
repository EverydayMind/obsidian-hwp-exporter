import { parseDocument, stringify } from 'yaml'

import {
  canonicalDigest,
  canonicalDigestJson,
} from './digest'

import { validateProfile } from './schema'
import type { ProfileMachine } from './types'

const markers = {
  machineStart: '<!-- verbex:report-style:machine:start -->',
  machineEnd: '<!-- verbex:report-style:machine:end -->',
  guidanceStart: '<!-- verbex:report-style:guidance:start -->',
  guidanceEnd: '<!-- verbex:report-style:guidance:end -->',
}
const bytes = (value: string) => new TextEncoder().encode(value).byteLength

function guidanceCheck(guidance: string): void {
  if (bytes(guidance) > 32 * 1024) throw new Error('Guidance exceeds 32 KiB.')
  if (Object.values(markers).some((marker) => guidance.includes(marker)))
    throw new Error('Guidance contains reserved profile markers.')
}

export function profileSummary(profile: ProfileMachine) {
  return {
    title: profile.title,
    revision: profile.revision,
    sourcePath: profile.sourcePath,
    sourceSha256: profile.snapshot.source.sha256,
    measurementSha256: profile.measurementSha256,
    sections: profile.snapshot.sections.slice(0, 4),
    sectionCount: profile.snapshot.sections.length,
    sectionsTruncated: profile.snapshot.sections.length > 4,
    paragraphs: profile.snapshot.paragraphs.length,
    tables: profile.snapshot.tables.length,
    characterStyles: profile.snapshot.characterStyles.length,
    paragraphStyles: profile.snapshot.paragraphStyles.length,
    bindings: profile.bindings.length,
    fixedRegions: profile.fixedRegions.length,
    template: profile.template,
    unsupported: profile.snapshot.unsupported.slice(0, 50).map((item) => ({
      feature: item.feature,
      refs: item.refs.slice(0, 20),
      totalRefs: item.refs.length,
    })),
    layout: { state: 'not_measured' },
  }
}

export async function renderProfileNote(
  input: ProfileMachine,
  guidance: string,
  newline = '\n',
): Promise<string> {
  const profile = await validateProfile(input)
  guidanceCheck(guidance)
  const frontmatter = stringify({
    type: 'report-style-profile',
    schema: profile.schema,
    profile_id: profile.id,
    revision: profile.revision,
    title: profile.title,
    source: profile.sourcePath,
    source_sha256: profile.snapshot.source.sha256,
    measurement_sha256: profile.measurementSha256,
    profile_revision_sha256: canonicalDigest(profile),
    template: profile.template?.path ?? null,
    template_sha256: profile.template?.sha256 ?? null,
  }).trimEnd()
  const summary = `${profile.snapshot.sections.length} sections; ${profile.snapshot.paragraphs.length} paragraphs; ${profile.snapshot.tables.length} tables; ${profile.bindings.length} bindings. Layout not measured.`
  const before = [
    '---',
    frontmatter,
    '---',
    '## 서식 요약',
    summary,
    markers.machineStart,
    '```report-style-profile-json',
    JSON.stringify(profile),
    '```',
    markers.machineEnd,
    '## 작성 지침',
    markers.guidanceStart,
    '',
  ]
    .join('\n')
    .replace(/\n/g, newline)
  return before + guidance + newline + markers.guidanceEnd + newline
}

export type ParsedProfileNote = {
  machine: ProfileMachine
  guidance: string
  newline: string
}
export async function parseProfileNote(
  note: string,
): Promise<ParsedProfileNote> {
  if (bytes(note) > 6 * 1024 * 1024)
    throw new Error('Profile note exceeds 6 MiB.')
  const positions = Object.fromEntries(
    Object.entries(markers).map(([key, marker]) => {
      if (note.split(marker).length !== 2)
        throw new Error('Missing or duplicate profile section.')
      return [key, note.indexOf(marker)]
    }),
  )
  if (
    !(
      positions.machineStart < positions.machineEnd &&
      positions.machineEnd < positions.guidanceStart &&
      positions.guidanceStart < positions.guidanceEnd
    )
  )
    throw new Error('Invalid profile section order.')
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(note)
  if (!front) throw new Error('Profile frontmatter required.')
  const yaml = parseDocument(front[1], { uniqueKeys: true })
  if (yaml.errors.length) throw new Error('Invalid profile frontmatter.')
  const fm = yaml.toJS() as Record<string, unknown> | null
  if (!fm || typeof fm !== 'object')
    throw new Error('Profile frontmatter must be an object.')
  const section = note
    .slice(
      positions.machineStart + markers.machineStart.length,
      positions.machineEnd,
    )
    .trim()
  const block = /^```report-style-profile-json\r?\n([\s\S]*?)\r?\n```$/.exec(
    section,
  )
  if (!block) throw new Error('Exactly one profile JSON block required.')
  canonicalDigestJson(block[1])
  const machine = await validateProfile(JSON.parse(block[1]))
  const expected: Record<string, unknown> = {
    type: 'report-style-profile',
    schema: machine.schema,
    profile_id: machine.id,
    revision: machine.revision,
    source: machine.sourcePath,
    source_sha256: machine.snapshot.source.sha256,
    measurement_sha256: machine.measurementSha256,
    profile_revision_sha256: canonicalDigest(machine),
    template: machine.template?.path ?? null,
    template_sha256: machine.template?.sha256 ?? null,
  }
  if (Object.entries(expected).some(([key, value]) => fm[key] !== value))
    throw new Error(
      'Profile frontmatter/machine identity, revision or digest mismatch.',
    )
  const raw = note.slice(
    positions.guidanceStart + markers.guidanceStart.length,
    positions.guidanceEnd,
  )
  if (!/^\r?\n/.test(raw) || !/\r?\n$/.test(raw))
    throw new Error('Invalid guidance section boundary.')
  const guidance = raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '')
  guidanceCheck(guidance)
  return { machine, guidance, newline: note.includes('\r\n') ? '\r\n' : '\n' }
}
