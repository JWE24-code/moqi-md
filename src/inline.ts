/**
 * Inline markdown: spans parsed into styled runs, then wrapped by width.
 *
 * Moqi's transcript wraps the raw text first and styles each line after, which
 * is cheap but drops a span that crosses a line break (`**two words**` split
 * in half renders as literal asterisks). A file viewer has the time to do it
 * properly: parse once into runs that each carry their own style, then wrap
 * the runs, so every span keeps its style on whichever lines it lands.
 * @module
 */

import { colAccent, colGold, colGreen, colMuted, colText, style, type StyleOptions } from './vendor/theme.ts'
import { cut, displayWidth } from './vendor/text.ts'

/** A stretch of text with one style, optionally a hyperlink target. */
export interface Run {
  text: string
  style: StyleOptions
  href?: string
}

/** Things inline rendering needs from the surrounding document. */
export interface InlineContext {
  /** Link reference definitions, keyed by lowercased label. */
  refs: ReadonlyMap<string, string>
  /** Emit OSC 8 hyperlinks instead of printing the target after the text. */
  hyperlinks: boolean
  /** Output will lose its colour, so code needs its backticks back. */
  plain?: boolean
}

/** A run that forces a line break. */
const BREAK = '\n'

const PUNCTUATION = /[!-/:-@[-`{-~]/

/** Characters that can open an inline construct. */
const SPECIAL = new Set(['\\', '`', '!', '[', '<', '*', '_', '~'])

/** Merge two styles, the second winning field by field. */
function merge(base: StyleOptions, extra: StyleOptions): StyleOptions {
  return { ...base, ...extra }
}

/** Find the closing delimiter for an emphasis run, or -1. */
function closing(text: string, from: number, delimiter: string): number {
  let index = from
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2
      continue
    }
    if (text[index] === '`') {
      // A code span is opaque: a delimiter inside it does not close anything.
      const ticks = /^`+/.exec(text.slice(index))?.[0] ?? '`'
      const end = text.indexOf(ticks, index + ticks.length)
      index = end === -1 ? index + ticks.length : end + ticks.length
      continue
    }
    if (text.startsWith(delimiter, index) && index > from && text[index - 1] !== ' ') {
      // `_` only closes at a word boundary, so snake_case stays one word.
      if (delimiter[0] !== '_' || !/\w/.test(text[index + delimiter.length] ?? '')) return index
    }
    index += 1
  }
  return -1
}

/** Parse inline markdown into runs over a base style. */
export function parseInline(text: string, base: StyleOptions, context: InlineContext): Run[] {
  const runs: Run[] = []
  let plain = ''
  const flush = (): void => {
    if (plain !== '') runs.push({ text: plain, style: base })
    plain = ''
  }
  const push = (...more: Run[]): void => {
    flush()
    runs.push(...more)
  }

  let index = 0
  while (index < text.length) {
    const char = text[index] ?? ''
    // Most characters start nothing; skip the slicing and pattern tests for them.
    if (!SPECIAL.has(char) && !(char === 'h' && text.startsWith('http', index))) {
      plain += char
      index += 1
      continue
    }
    const rest = text.slice(index)

    if (char === '\\' && PUNCTUATION.test(text[index + 1] ?? '')) {
      plain += text[index + 1]
      index += 2
      continue
    }
    if (char === '\\' && index === text.length - 1) {
      push({ text: BREAK, style: base })
      index += 1
      continue
    }

    if (char === '`') {
      const ticks = /^`+/.exec(rest)?.[0] ?? '`'
      const end = text.indexOf(ticks, index + ticks.length)
      if (end !== -1) {
        const body = text.slice(index + ticks.length, end).replaceAll('\n', ' ')
        const code = body.length > 2 && body.startsWith(' ') && body.endsWith(' ') ? body.slice(1, -1) : body
        // Padded the way Moqi's transcript pads inline code, so it reads as a chip.
        const chip = context.plain === true ? `\`${code}\`` : ` ${code} `
        push({ text: chip, style: merge(base, { fg: colGold, italic: false, bold: false }) })
        index = end + ticks.length
        continue
      }
    }

    const image = /^!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(rest)
    if (image !== null) {
      const alt = image[1] === '' ? 'image' : (image[1] ?? 'image')
      push({ text: `▣ ${alt}`, style: merge(base, { fg: colMuted, italic: true }), href: image[2] })
      index += image[0].length
      continue
    }

    const link = parseLink(rest, context)
    if (link !== undefined) {
      const linkStyle = merge(base, { fg: colGreen, underline: true })
      const inner = parseInline(link.label, linkStyle, context).map((run) => ({ ...run, href: link.href }))
      push(...inner)
      if (!context.hyperlinks && link.href !== link.label) {
        push({ text: ` (${link.href})`, style: merge(base, { fg: colMuted, underline: false }) })
      }
      index += link.length
      continue
    }

    const footnote = /^\[\^([^\]]+)\]/.exec(rest)
    if (footnote !== null) {
      push({ text: `[${footnote[1] ?? ''}]`, style: merge(base, { fg: colAccent }) })
      index += footnote[0].length
      continue
    }

    const auto = /^<((?:https?|mailto):[^>\s]+)>/.exec(rest) ?? (/\w/.test(text[index - 1] ?? '') ? null : /^https?:\/\/[^\s<>]*[^\s<>.,;:!?)\]'"]/.exec(rest))
    if (auto !== null) {
      const href = auto[1] ?? auto[0]
      push({ text: href, style: merge(base, { fg: colGreen, underline: true }), href })
      index += auto[0].length
      continue
    }

    if (/^<br\s*\/?>/i.test(rest)) {
      push({ text: BREAK, style: base })
      index += (/^<br\s*\/?>/i.exec(rest)?.[0] ?? '').length
      continue
    }
    const kbd = /^<kbd>([^<]*)<\/kbd>/i.exec(rest)
    if (kbd !== null) {
      push({ text: context.plain === true ? `[${kbd[1] ?? ''}]` : ` ${kbd[1] ?? ''} `, style: merge(base, { fg: colAccent, bold: true }) })
      index += kbd[0].length
      continue
    }
    const img = /^<img\s[^>]*>/i.exec(rest)
    if (img !== null) {
      const alt = /\balt=["']([^"']*)["']/i.exec(img[0])?.[1] ?? ''
      const src = /\bsrc=["']([^"']*)["']/i.exec(img[0])?.[1]
      if (alt !== '') push({ text: `▣ ${alt}`, style: merge(base, { fg: colMuted, italic: true }), href: src })
      index += img[0].length
      continue
    }
    const tag = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/.exec(rest)
    if (tag !== null) {
      // Other inline HTML has no terminal meaning; its text content stays.
      index += tag[0].length
      continue
    }

    const emphasis = emphasisAt(text, index)
    if (emphasis !== undefined) {
      const inner = text.slice(index + emphasis.delimiter.length, emphasis.end)
      push(...parseInline(inner, merge(base, emphasis.style), context))
      index = emphasis.end + emphasis.delimiter.length
      continue
    }

    plain += char
    index += 1
  }
  flush()
  return runs
}

/** An emphasis span opening at `index`: its delimiter, closing index, and style. */
function emphasisAt(
  text: string,
  index: number,
): { delimiter: string; end: number; style: StyleOptions } | undefined {
  const candidates: [string, StyleOptions][] = [
    ['***', { bold: true, italic: true }],
    ['___', { bold: true, italic: true }],
    ['**', { bold: true }],
    ['__', { bold: true }],
    ['~~', { fg: colMuted, strike: true }],
    ['*', { italic: true }],
    ['_', { italic: true }],
  ]
  for (const [delimiter, spanStyle] of candidates) {
    if (!text.startsWith(delimiter, index)) continue
    const after = text[index + delimiter.length] ?? ''
    if (after === '' || after === ' ') continue
    // An opening `_` inside a word is a literal underscore.
    if (delimiter[0] === '_' && /\w/.test(text[index - 1] ?? '')) continue
    const end = closing(text, index + delimiter.length, delimiter)
    if (end !== -1) return { delimiter, end, style: spanStyle }
  }
  return undefined
}

/** An inline or reference link at the start of `rest`. */
function parseLink(rest: string, context: InlineContext): { label: string; href: string; length: number } | undefined {
  if (!rest.startsWith('[') || rest.startsWith('[^')) return undefined
  // The label may itself contain brackets (an image inside a link, say).
  let depth = 0
  let close = -1
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '\\') {
      index += 1
      continue
    }
    if (rest[index] === '[') depth += 1
    if (rest[index] === ']') {
      depth -= 1
      if (depth === 0) {
        close = index
        break
      }
    }
  }
  if (close === -1) return undefined
  const label = rest.slice(1, close)
  const tail = rest.slice(close + 1)

  const inline = /^\(\s*<?([^)\s>]*)>?(?:\s+["'(][^)]*["')])?\s*\)/.exec(tail)
  if (inline !== null) return { label, href: inline[1] ?? '', length: close + 1 + inline[0].length }

  const full = /^\[([^\]]*)\]/.exec(tail)
  const key = (full === null || full[1] === '' ? label : (full[1] ?? '')).toLowerCase().trim()
  const href = context.refs.get(key)
  if (href === undefined) return undefined
  return { label, href, length: close + 1 + (full?.[0].length ?? 0) }
}

/** The printable text of a list of runs. */
export function plainText(runs: readonly Run[]): string {
  return runs.map((run) => run.text).join('')
}

/** A word: consecutive non-space pieces that must stay together on a line. */
interface Word {
  pieces: Run[]
  width: number
}

type Token = { kind: 'word'; word: Word } | { kind: 'space'; run: Run } | { kind: 'break' }

/** Split runs into words, spaces, and hard breaks. */
function tokenize(runs: readonly Run[]): Token[] {
  const tokens: Token[] = []
  let current: Word | undefined
  const end = (): void => {
    if (current !== undefined) tokens.push({ kind: 'word', word: current })
    current = undefined
  }
  for (const run of runs) {
    if (run.text === BREAK) {
      end()
      tokens.push({ kind: 'break' })
      continue
    }
    for (const part of run.text.split(/( +)/)) {
      if (part === '') continue
      if (part.startsWith(' ')) {
        end()
        tokens.push({ kind: 'space', run: { ...run, text: ' ' } })
        continue
      }
      current ??= { pieces: [], width: 0 }
      current.pieces.push({ ...run, text: part })
      current.width += displayWidth(part)
    }
  }
  end()
  return tokens
}

/** Break one word wider than the line into line-sized chunks. */
function splitWord(word: Word, width: number): Word[] {
  const out: Word[] = []
  let line: Word = { pieces: [], width: 0 }
  for (const piece of word.pieces) {
    let rest = piece.text
    while (rest !== '') {
      const room = width - line.width
      // A wide character on an empty, too-narrow line still has to go somewhere.
      const head = cut(rest, room) || (line.width === 0 ? String.fromCodePoint(rest.codePointAt(0) ?? 32) : '')
      if (head === '') {
        out.push(line)
        line = { pieces: [], width: 0 }
        continue
      }
      line.pieces.push({ ...piece, text: head })
      line.width += displayWidth(head)
      rest = rest.slice(head.length)
    }
  }
  if (line.pieces.length > 0) out.push(line)
  return out
}

/** Wrap runs into lines of at most `width` columns. */
export function wrapRuns(runs: readonly Run[], width: number): Run[][] {
  const lines: Run[][] = []
  let line: Run[] = []
  let used = 0
  let pending: Run | undefined
  const newline = (): void => {
    lines.push(line)
    line = []
    used = 0
    pending = undefined
  }
  for (const token of tokenize(runs)) {
    if (token.kind === 'break') {
      newline()
      continue
    }
    if (token.kind === 'space') {
      if (used > 0) pending = token.run
      continue
    }
    const gap = pending === undefined ? 0 : 1
    if (used + gap + token.word.width <= width) {
      if (pending !== undefined) line.push(pending)
      line.push(...token.word.pieces)
      used += gap + token.word.width
      pending = undefined
      continue
    }
    if (used > 0) newline()
    const chunks = token.word.width > width ? splitWord(token.word, Math.max(width, 1)) : [token.word]
    chunks.forEach((chunk, position) => {
      if (position > 0) newline()
      line.push(...chunk.pieces)
      used = chunk.width
    })
    pending = undefined
  }
  if (line.length > 0 || lines.length === 0) lines.push(line)
  return lines
}

const OSC8_OPEN = (href: string): string => `\x1b]8;;${href}\x1b\\`
const OSC8_CLOSE = '\x1b]8;;\x1b\\'

/** Paint a line of runs to an ANSI string. */
export function paint(line: readonly Run[], context: InlineContext): string {
  let out = ''
  for (const run of coalesce(line)) {
    const styled = style(run.text, run.style)
    out += context.hyperlinks && run.href !== undefined && run.href !== ''
      ? `${OSC8_OPEN(run.href)}${styled}${OSC8_CLOSE}`
      : styled
  }
  return out
}

/** Merge neighbouring runs that look the same, so a line is a few escapes, not one per word. */
function coalesce(line: readonly Run[]): Run[] {
  const out: Run[] = []
  for (const run of line) {
    const last = out.at(-1)
    if (last !== undefined && last.href === run.href && sameStyle(last.style, run.style)) {
      out[out.length - 1] = { ...last, text: last.text + run.text }
      continue
    }
    out.push(run)
  }
  return out
}

function sameStyle(a: StyleOptions, b: StyleOptions): boolean {
  const keys = ['fg', 'bg', 'bold', 'italic', 'underline', 'dim', 'strike'] as const
  return keys.every((key) => a[key] === b[key])
}

/** Parse, wrap, and paint inline text in one go. */
export function renderInline(text: string, width: number, base: StyleOptions, context: InlineContext): string[] {
  return wrapRuns(parseInline(text, base, context), width).map((line) => paint(line, context))
}

/** The default body style. */
export const BODY: StyleOptions = { fg: colText }
