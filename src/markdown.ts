/**
 * Markdown documents to Moqi-styled terminal lines.
 *
 * The look is Moqi's transcript — accent headings over a quiet rule, a `│`
 * gutter for code, `┃` for quotes, `•` bullets, padded gold code chips — but
 * the parser is built for whole files rather than chat replies: containers
 * nest (a code block inside a list item inside a quote), tables align and wrap
 * their cells, and front matter, reference links, task lists, and GitHub
 * alerts all have a shape of their own.
 *
 * Parsing is total: any input renders, and a construct it does not recognize
 * falls through to a paragraph rather than disappearing.
 * @module
 */

import { highlight } from './highlight.ts'
import { BODY, paint, parseInline, plainText, renderInline, wrapRuns, type InlineContext, type Run } from './inline.ts'
import {
  colAccent,
  colGold,
  colMuted,
  colOK,
  colRose,
  colText,
  colWarn,
  style,
  type AdaptiveColor,
  type StyleOptions,
} from './vendor/theme.ts'
import { displayWidth, padEnd, sliceColumns } from './vendor/text.ts'

type Align = 'left' | 'center' | 'right'

interface ListItem {
  /** `undefined` for a plain item, else whether the task box is ticked. */
  task: boolean | undefined
  blocks: Block[]
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; info: string; lines: string[] }
  | { kind: 'list'; ordered: boolean; start: number; loose: boolean; items: ListItem[] }
  | { kind: 'quote'; alert: string | undefined; blocks: Block[] }
  | { kind: 'rule' }
  | { kind: 'table'; align: Align[]; rows: string[][] }
  | { kind: 'front'; entries: [string, string][] }

/** A heading's text and the rendered line it starts on, for the outline. */
export interface Heading {
  level: number
  text: string
  line: number
}

/** A rendered document. */
export interface Rendered {
  lines: string[]
  headings: Heading[]
}

export interface RenderOptions {
  /** Columns available to the document. */
  width: number
  /** Emit OSC 8 hyperlinks (a terminal) or print link targets (a pipe). */
  hyperlinks: boolean
  /** The output will be stripped of colour. */
  plain?: boolean
}

// ── Line classifiers ─────────────────────────────────────────────────────────

// Patterns match only a line's fixed-shape prefix; the rest is sliced off as a
// string. A trailing `(.*)$` next to another quantifier backtracks.
const FENCE = /^( {0,3})(`{3,}|~{3,})/
const HEADING_OPEN = /^ {0,3}(#{1,6})(?=[ \t]|$)/
const RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/
const QUOTE = /^ {0,3}>[ ]?(.*)$/
const LIST_OPEN = /^( {0,3})([-*+]|\d{1,9}[.)])(?=[ \t]|$)/
const REF_DEF = /^ {0,3}\[([^\]^][^\]]*)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+["'(].*["')])?[ \t]*$/
const HTML_BLOCK = /^ {0,3}<\/?(?:[A-Za-z][A-Za-z0-9-]*)(?:\s|\/?>|$)/
const BLANK = /^\s*$/

function isBlank(line: string): boolean {
  return BLANK.test(line)
}

/** An ATX heading's level and text, closing `#` run removed. */
function atxHeading(line: string): { level: number; text: string } | undefined {
  const open = HEADING_OPEN.exec(line)
  if (open === null) return undefined
  let text = line.slice(open[0].length).trim()
  let end = text.length
  while (end > 0 && text[end - 1] === '#') end -= 1
  // A closing run counts only when it stands apart from the text (or is all there is).
  if (end === 0) text = ''
  else if (end < text.length && (text[end - 1] === ' ' || text[end - 1] === '\t')) text = text.slice(0, end).trimEnd()
  return { level: (open[1] ?? '#').length, text }
}

/** A list item's marker line: indent, marker, spaces after it, and its content. */
interface ListMarker {
  indent: number
  marker: string
  gap: number
  content: string
}

function listMarker(line: string): ListMarker | undefined {
  if (RULE.test(line)) return undefined
  const open = LIST_OPEN.exec(line)
  if (open === null) return undefined
  const rest = line.slice(open[0].length)
  const content = rest.trimStart()
  return { indent: (open[1] ?? '').length, marker: open[2] ?? '-', gap: rest.length - content.length, content }
}

/** A table's delimiter row: `| :--- | ---: |`, pipes at the edges optional. */
function isTableSeparator(line: string): boolean {
  if (indentOf(line) > 3) return false
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  if (!text.includes('-')) return false
  return text.split('|').every((cell) => /^:?-+:?$/.test(cell.trim()))
}

/** Whether `line` would start a block that interrupts a paragraph. */
function interrupts(line: string): boolean {
  return (
    FENCE.test(line) ||
    atxHeading(line) !== undefined ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    HTML_BLOCK.test(line) ||
    // An ordered list may only interrupt a paragraph when it starts at 1.
    /^ {0,3}(?:[-*+]|1[.)])[ \t]+\S/.test(line)
  )
}

/** Expand tabs to four-column stops, so indentation arithmetic is in columns. */
function expandTabs(line: string): string {
  if (!line.includes('\t')) return line
  let out = ''
  for (const char of line) {
    out += char === '\t' ? ' '.repeat(4 - (out.length % 4)) : char
  }
  return out
}

/** Leading spaces of a line. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** Remove up to `count` leading spaces. */
function dedent(line: string, count: number): string {
  let index = 0
  while (index < count && line[index] === ' ') index += 1
  return line.slice(index)
}

/** Split a table row into cells on unescaped pipes outside code spans. */
function splitCells(row: string): string[] {
  let text = row.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  let inCode = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ''
    if (char === '\\' && text[index + 1] === '|') {
      cell += '|'
      index += 1
      continue
    }
    if (char === '`') inCode = !inCode
    if (char === '|' && !inCode) {
      cells.push(cell.trim())
      cell = ''
      continue
    }
    cell += char
  }
  cells.push(cell.trim())
  return cells
}

// ── Block parser ─────────────────────────────────────────────────────────────

/** One parsed block and the index just past it; `block` absent for no output. */
interface Step {
  block?: Block
  next: number
}

class Parser {
  readonly refs = new Map<string, string>()

  /** Parse a whole document, front matter included. */
  document(source: string): Block[] {
    const lines = source.replace(/^﻿/, '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n').map(expandTabs)
    const blocks: Block[] = []
    let start = 0
    const front = this.frontMatter(lines)
    if (front !== undefined) {
      if (front.block !== undefined) blocks.push(front.block)
      start = front.next
    }
    blocks.push(...this.blocks(lines.slice(start)))
    return blocks
  }

  /** Parse a run of lines into blocks. */
  blocks(lines: readonly string[]): Block[] {
    const blocks: Block[] = []
    let index = 0
    while (index < lines.length) {
      const line = lines[index] ?? ''
      if (isBlank(line)) {
        index += 1
        continue
      }
      const step =
        this.fence(lines, index) ??
        this.comment(lines, index) ??
        this.heading(lines, index) ??
        this.rule(lines, index) ??
        this.quote(lines, index) ??
        this.list(lines, index) ??
        this.table(lines, index) ??
        this.refDef(lines, index) ??
        this.html(lines, index) ??
        this.indentedCode(lines, index) ??
        this.paragraph(lines, index)
      if (step.block !== undefined) blocks.push(step.block)
      index = Math.max(step.next, index + 1)
    }
    return blocks
  }

  private frontMatter(lines: readonly string[]): Step | undefined {
    if (lines[0]?.trim() !== '---') return undefined
    const end = lines.findIndex((line, index) => index > 0 && (line.trim() === '---' || line.trim() === '...'))
    if (end === -1) return undefined
    const entries: [string, string][] = []
    for (const line of lines.slice(1, end)) {
      const colon = line.indexOf(':')
      const key = colon === -1 ? '' : line.slice(0, colon)
      if (/^[\w.-]+$/.test(key)) {
        entries.push([key, line.slice(colon + 1).trim()])
        continue
      }
      // A nested value or list item belongs to the key above it.
      const last = entries.at(-1)
      if (last !== undefined && line.trim() !== '') {
        last[1] = `${last[1]} ${line.trim().replace(/^- /, '')}`.trim()
      }
    }
    return { block: { kind: 'front', entries }, next: end + 1 }
  }

  private fence(lines: readonly string[], index: number): Step | undefined {
    const line = lines[index] ?? ''
    const open = FENCE.exec(line)
    if (open === null) return undefined
    const indent = (open[1] ?? '').length
    const marker = open[2] ?? '```'
    const info = line.slice(open[0].length).trim()
    // A backtick fence's info string may not itself contain a backtick.
    if (marker.startsWith('`') && info.includes('`')) return undefined
    const body: string[] = []
    let next = index + 1
    while (next < lines.length) {
      const candidate = lines[next] ?? ''
      const close = FENCE.exec(candidate)
      const closes = close !== null && candidate.slice(close[0].length).trim() === ''
      if (closes && (close[2] ?? '')[0] === marker[0] && (close[2] ?? '').length >= marker.length) {
        next += 1
        break
      }
      body.push(dedent(candidate, indent))
      next += 1
    }
    return { block: { kind: 'code', info, lines: body }, next }
  }

  private comment(lines: readonly string[], index: number): Step | undefined {
    if (!/^ {0,3}<!--/.test(lines[index] ?? '')) return undefined
    let next = index
    while (next < lines.length && !(lines[next] ?? '').includes('-->')) next += 1
    // Text after the comment on its closing line is ordinary content.
    const tail = (lines[next] ?? '').split('-->').slice(1).join('-->').trim()
    if (tail !== '') return { block: { kind: 'paragraph', text: tail }, next: next + 1 }
    return { next: next + 1 }
  }

  private heading(lines: readonly string[], index: number): Step | undefined {
    const heading = atxHeading(lines[index] ?? '')
    if (heading === undefined) return undefined
    return { block: { kind: 'heading', level: heading.level, text: heading.text }, next: index + 1 }
  }

  private rule(lines: readonly string[], index: number): Step | undefined {
    return RULE.test(lines[index] ?? '') ? { block: { kind: 'rule' }, next: index + 1 } : undefined
  }

  private quote(lines: readonly string[], index: number): Step | undefined {
    if (!QUOTE.test(lines[index] ?? '')) return undefined
    const inner: string[] = []
    let next = index
    while (next < lines.length) {
      const line = lines[next] ?? ''
      const match = QUOTE.exec(line)
      if (match !== null) {
        inner.push(match[1] ?? '')
      } else if (!isBlank(line) && !interrupts(line) && !isBlank(inner.at(-1) ?? '')) {
        // Lazy continuation: an unmarked line carries on the quoted paragraph.
        inner.push(line)
      } else {
        break
      }
      next += 1
    }
    let alert: string | undefined
    const marker = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(inner[0] ?? '')
    if (marker !== null) {
      alert = (marker[1] ?? 'NOTE').toUpperCase()
      inner.shift()
    }
    return { block: { kind: 'quote', alert, blocks: this.blocks(inner) }, next }
  }

  private list(lines: readonly string[], index: number): Step | undefined {
    const first = listMarker(lines[index] ?? '')
    if (first === undefined) return undefined
    const ordered = /\d/.test(first.marker)
    const delimiter = first.marker.slice(-1)
    const start = ordered ? Number.parseInt(first.marker, 10) : 1
    const sameList = (item: ListMarker | undefined): item is ListMarker =>
      item !== undefined && /\d/.test(item.marker) === ordered && item.marker.slice(-1) === delimiter
    const items: ListItem[] = []
    let loose = false
    let next = index

    while (next < lines.length) {
      const match = listMarker(lines[next] ?? '')
      if (!sameList(match)) break

      const markerIndent = match.indent + match.marker.length
      const gap = match.gap
      // Content starts after the marker and its spaces; five or more spaces
      // mean the content is indented code, so the item takes just one.
      const contentIndent = markerIndent + (gap === 0 || gap > 4 ? 1 : gap)
      const body: string[] = [match.content]
      next += 1

      while (next < lines.length) {
        const line = lines[next] ?? ''
        if (isBlank(line)) {
          body.push('')
          next += 1
          continue
        }
        if (indentOf(line) >= contentIndent) {
          body.push(dedent(line, contentIndent))
          next += 1
          continue
        }
        const previousBlank = isBlank(body.at(-1) ?? '')
        if (!previousBlank && !interrupts(line) && listMarker(line) === undefined) {
          body.push(line.trim())
          next += 1
          continue
        }
        break
      }

      // Trailing blanks belong between items, and make the list loose.
      let trailing = 0
      while (body.length > 1 && isBlank(body.at(-1) ?? '')) {
        body.pop()
        trailing += 1
      }
      const continues = sameList(listMarker(lines[next] ?? ''))
      if (trailing > 0 && continues) loose = true
      if (trailing > 0 && !continues) next -= trailing
      // A blank line between two blocks inside one item also loosens the list.
      if (body.some((line, at) => isBlank(line) && !isBlank(body[at + 1] ?? ''))) loose = true

      let task: boolean | undefined
      const box = /^\[([ xX])\][ \t]+/.exec(body[0] ?? '')
      if (box !== null) {
        task = (box[1] ?? ' ') !== ' '
        body[0] = (body[0] ?? '').slice(box[0].length)
      }
      items.push({ task, blocks: this.blocks(body) })
      if (!continues) break
    }
    return { block: { kind: 'list', ordered, start, loose, items }, next }
  }

  private table(lines: readonly string[], index: number): Step | undefined {
    const head = lines[index] ?? ''
    const separator = lines[index + 1] ?? ''
    if (!head.includes('|') || !isTableSeparator(separator)) return undefined
    const header = splitCells(head)
    const align = splitCells(separator).map((cell): Align => {
      const left = cell.startsWith(':')
      const right = cell.endsWith(':')
      if (left && right) return 'center'
      return right ? 'right' : 'left'
    })
    if (align.length !== header.length) return undefined
    const rows = [header]
    let next = index + 2
    while (next < lines.length) {
      const line = lines[next] ?? ''
      if (isBlank(line) || !line.includes('|') || interrupts(line)) break
      rows.push(splitCells(line))
      next += 1
    }
    return { block: { kind: 'table', align, rows }, next }
  }

  private refDef(lines: readonly string[], index: number): Step | undefined {
    const match = REF_DEF.exec(lines[index] ?? '')
    if (match === null) return undefined
    const key = (match[1] ?? '').toLowerCase().trim()
    if (!this.refs.has(key)) this.refs.set(key, match[2] ?? '')
    return { next: index + 1 }
  }

  /** An HTML block: its tags dropped, its text kept, nothing when that is empty. */
  private html(lines: readonly string[], index: number): Step | undefined {
    if (!HTML_BLOCK.test(lines[index] ?? '')) return undefined
    const parts: string[] = []
    let next = index
    while (next < lines.length && !isBlank(lines[next] ?? '')) {
      parts.push((lines[next] ?? '').trim())
      next += 1
    }
    const text = parts.join(' ')
    const visible = plainText(parseInline(text, {}, { refs: this.refs, hyperlinks: false })).trim()
    return visible === '' ? { next } : { block: { kind: 'paragraph', text }, next }
  }

  private indentedCode(lines: readonly string[], index: number): Step | undefined {
    if (indentOf(lines[index] ?? '') < 4) return undefined
    const body: string[] = []
    let next = index
    while (next < lines.length && (isBlank(lines[next] ?? '') || indentOf(lines[next] ?? '') >= 4)) {
      body.push(dedent(lines[next] ?? '', 4))
      next += 1
    }
    while (body.length > 0 && isBlank(body.at(-1) ?? '')) {
      body.pop()
      next -= 1
    }
    return { block: { kind: 'code', info: '', lines: body }, next }
  }

  private paragraph(lines: readonly string[], index: number): Step {
    const parts: string[] = [lines[index] ?? '']
    let next = index + 1
    while (next < lines.length) {
      const line = lines[next] ?? ''
      // Setext headings: a paragraph underlined with `===` or `---`.
      if (/^ {0,3}=+[ \t]*$/.test(line) || /^ {0,3}-+[ \t]*$/.test(line)) {
        return { block: { kind: 'heading', level: line.trim().startsWith('=') ? 1 : 2, text: joinLines(parts) }, next: next + 1 }
      }
      if (isBlank(line) || interrupts(line)) break
      if (line.includes('|') && isTableSeparator(lines[next + 1] ?? '')) break
      parts.push(line)
      next += 1
    }
    return { block: { kind: 'paragraph', text: joinLines(parts) }, next }
  }
}

/** Join paragraph lines: soft breaks become spaces, hard breaks `<br>`. */
function joinLines(parts: readonly string[]): string {
  return parts
    .map((line, index) => {
      const last = index === parts.length - 1
      const trimmed = line.trim()
      if (last) return trimmed
      if (line.endsWith('  ') || (trimmed.endsWith('\\') && !trimmed.endsWith('\\\\'))) {
        return `${trimmed.replace(/\\$/, '')}<br>`
      }
      return trimmed
    })
    .join(' ')
    .replaceAll('<br> ', '<br>')
}

// ── Renderer ─────────────────────────────────────────────────────────────────

interface Scope {
  width: number
  base: StyleOptions
  inline: InlineContext
  /** List nesting depth, for the bullet glyph. */
  depth: number
}

const BULLETS = ['•', '◦', '▪', '▫']

const ALERTS: Record<string, { icon: string; label: string; color: AdaptiveColor }> = {
  NOTE: { icon: 'ⓘ', label: 'Note', color: colAccent },
  TIP: { icon: '✦', label: 'Tip', color: colOK },
  IMPORTANT: { icon: '◆', label: 'Important', color: colRose },
  WARNING: { icon: '▲', label: 'Warning', color: colGold },
  CAUTION: { icon: '✕', label: 'Caution', color: colWarn },
}

const muted = (text: string): string => style(text, { fg: colMuted })

/** Render blocks to lines, a blank line between each pair. */
function renderBlocks(blocks: readonly Block[], scope: Scope, tight = false): string[] {
  const out: string[] = []
  blocks.forEach((block, index) => {
    if (index > 0 && !tight) out.push('')
    out.push(...renderBlock(block, scope))
  })
  return out
}

function renderBlock(block: Block, scope: Scope): string[] {
  switch (block.kind) {
    case 'heading':
      return renderHeading(block, scope)
    case 'paragraph':
      return renderInline(block.text, scope.width, scope.base, scope.inline)
    case 'code':
      return renderCode(block, scope.width)
    case 'list':
      return renderList(block, scope)
    case 'quote':
      return renderQuote(block, scope)
    case 'rule':
      return [muted('─'.repeat(scope.width))]
    case 'table':
      return renderTable(block, scope)
    case 'front':
      return renderFront(block, scope)
  }
}

function renderHeading(block: Extract<Block, { kind: 'heading' }>, scope: Scope): string[] {
  const top = block.level <= 2
  const prefix = top ? '' : `${'#'.repeat(block.level)} `
  const headingStyle: StyleOptions = { fg: top ? colAccent : colText, bold: true }
  const wrapped = wrapRuns(parseInline(block.text, headingStyle, scope.inline), Math.max(scope.width - prefix.length, 8))
  const lines = wrapped.map((line, index) => {
    const lead = index === 0 ? muted(prefix) : ' '.repeat(prefix.length)
    return lead + paint(line, scope.inline)
  })
  if (!top) return lines
  const underline = Math.min(scope.width, Math.max(...wrapped.map((line) => displayWidth(plainText(line)))))
  return [...lines, muted((block.level === 1 ? '━' : '─').repeat(underline))]
}

/** A fenced block: the language label, then each line behind a `│` gutter. */
function renderCode(block: Extract<Block, { kind: 'code' }>, width: number): string[] {
  const room = Math.max(width - 4, 8)
  const head = block.info === '' ? [] : [style(`  ${block.info.split(/\s+/)[0] ?? ''}`, { fg: colMuted, italic: true })]
  const body = block.lines.flatMap((line) => {
    const painted = highlight(line, block.info)
    const columns = displayWidth(line)
    if (columns <= room) return [`  ${muted('│')} ${painted}`]
    // Long lines wrap behind a dotted gutter rather than vanishing off-screen.
    const chunks: string[] = []
    for (let start = 0; start < columns; start += room) {
      chunks.push(`  ${muted(start === 0 ? '│' : '┆')} ${sliceColumns(painted, start, start + room)}\x1b[0m`)
    }
    return chunks
  })
  return [...head, ...(body.length === 0 ? [`  ${muted('│')}`] : body)]
}

function renderList(block: Extract<Block, { kind: 'list' }>, scope: Scope): string[] {
  const last = block.start + block.items.length - 1
  const ordinalWidth = String(last).length + 1
  const out: string[] = []
  block.items.forEach((item, index) => {
    if (index > 0 && block.loose) out.push('')
    let marker: string
    let markerWidth: number
    if (item.task !== undefined) {
      marker = item.task ? style('✓', { fg: colOK, bold: true }) : muted('☐')
      markerWidth = 1
    } else if (block.ordered) {
      const ordinal = `${String(block.start + index)}.`
      marker = style(ordinal.padStart(ordinalWidth), { fg: colRose })
      markerWidth = ordinalWidth
    } else {
      marker = style(BULLETS[scope.depth % BULLETS.length] ?? '•', { fg: colAccent })
      markerWidth = 1
    }
    const inner: Scope = {
      ...scope,
      width: Math.max(scope.width - markerWidth - 1, 8),
      depth: scope.depth + 1,
      base: item.task === true ? { ...scope.base, fg: colMuted } : scope.base,
    }
    const body = renderBlocks(item.blocks, inner, !block.loose)
    if (body.length === 0) body.push('')
    body.forEach((line, position) => {
      if (position === 0) out.push(`${marker} ${line}`)
      else out.push(line === '' ? '' : `${' '.repeat(markerWidth + 1)}${line}`)
    })
  })
  return out
}

function renderQuote(block: Extract<Block, { kind: 'quote' }>, scope: Scope): string[] {
  const alert = block.alert === undefined ? undefined : ALERTS[block.alert]
  const color = alert?.color ?? colMuted
  const inner: Scope = {
    ...scope,
    width: Math.max(scope.width - 2, 8),
    // A plain quote recedes the way Moqi's do; an alert is content to read.
    base: alert === undefined ? { ...scope.base, fg: colMuted, italic: true } : scope.base,
  }
  const body = renderBlocks(block.blocks, inner)
  if (alert !== undefined) body.unshift(style(`${alert.icon} ${alert.label}`, { fg: alert.color, bold: true }))
  const bar = style('┃', { fg: color })
  return body.map((line) => (line === '' ? bar : `${bar} ${line}`))
}

function renderFront(block: Extract<Block, { kind: 'front' }>, scope: Scope): string[] {
  if (block.entries.length === 0) return []
  const keyWidth = Math.min(Math.max(...block.entries.map(([key]) => displayWidth(key))), 16)
  const room = Math.max(scope.width - keyWidth - 2, 8)
  const lines = block.entries.flatMap(([key, value]) => {
    const wrapped = renderInline(value.replace(/^["']|["']$/g, ''), room, { fg: colMuted }, scope.inline)
    return wrapped.map((line, index) =>
      index === 0 ? `${style(padEnd(key, keyWidth), { fg: colAccent })}  ${line}` : `${' '.repeat(keyWidth + 2)}${line}`,
    )
  })
  return [...lines, muted('┄'.repeat(scope.width))]
}

/** A pipe table: header, a rule, then rows; cells wrap rather than clip. */
function renderTable(block: Extract<Block, { kind: 'table' }>, scope: Scope): string[] {
  const columns = Math.max(...block.rows.map((row) => row.length), block.align.length)
  const cells = block.rows.map((row, rowIndex) =>
    Array.from({ length: columns }, (_, column) =>
      parseInline(row[column] ?? '', rowIndex === 0 ? { fg: colText, bold: true } : scope.base, scope.inline),
    ),
  )
  const natural = Array.from({ length: columns }, (_, column) =>
    Math.max(...cells.map((row) => displayWidth(plainText(row[column] ?? []))), 1),
  )
  const widths = fitColumns(natural, scope.width - 3 * (columns - 1))
  const separator = muted(' │ ')

  const renderRow = (row: Run[][]): string[] => {
    const wrapped = row.map((runs, column) => wrapRuns(runs, widths[column] ?? 1))
    const height = Math.max(...wrapped.map((lines) => lines.length))
    const lines: string[] = []
    for (let line = 0; line < height; line += 1) {
      const parts = wrapped.map((cellLines, column) => {
        const runs = cellLines[line] ?? []
        const text = paint(runs, scope.inline)
        const pad = Math.max((widths[column] ?? 1) - displayWidth(plainText(runs)), 0)
        const align = block.align[column] ?? 'left'
        if (align === 'right') return ' '.repeat(pad) + text
        if (align === 'center') return ' '.repeat(Math.floor(pad / 2)) + text + ' '.repeat(Math.ceil(pad / 2))
        return text + ' '.repeat(pad)
      })
      lines.push(parts.join(separator).trimEnd())
    }
    return lines
  }

  const [head, ...body] = cells
  const rule = muted(widths.map((width) => '─'.repeat(width)).join('─┼─'))
  return [...(head === undefined ? [] : renderRow(head)), rule, ...body.flatMap(renderRow)]
}

/**
 * Column widths that fit `available`: every column at its natural width when
 * that fits, else the widest columns capped at one shared limit, so narrow
 * columns keep their width and the wide ones wrap.
 */
function fitColumns(natural: readonly number[], available: number): number[] {
  const total = natural.reduce((sum, width) => sum + width, 0)
  if (total <= available) return [...natural]
  let low = 1
  let high = Math.max(...natural)
  while (low < high) {
    const limit = Math.ceil((low + high) / 2)
    const used = natural.reduce((sum, width) => sum + Math.min(width, limit), 0)
    if (used <= available) low = limit
    else high = limit - 1
  }
  return natural.map((width) => Math.min(width, Math.max(low, 4)))
}

/** Render a markdown document to styled lines at `width` columns. */
export function renderDocument(source: string, options: RenderOptions): Rendered {
  const parser = new Parser()
  const blocks = parser.document(source)
  const scope: Scope = {
    width: Math.max(options.width, 20),
    base: BODY,
    inline: { refs: parser.refs, hyperlinks: options.hyperlinks, plain: options.plain === true },
    depth: 0,
  }
  const lines: string[] = []
  const headings: Heading[] = []
  blocks.forEach((block, index) => {
    if (index > 0) lines.push('')
    if (block.kind === 'heading') {
      headings.push({ level: block.level, text: plainText(parseInline(block.text, {}, scope.inline)).trim(), line: lines.length })
    }
    lines.push(...renderBlock(block, scope))
  })
  return { lines, headings }
}
