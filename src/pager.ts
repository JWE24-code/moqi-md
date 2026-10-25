/**
 * The interactive viewer: Moqi's chrome around a rendered document.
 *
 * The screen is laid out the way Moqi lays out a session — the `◆` header
 * line, the reading area, and the muted footer with `·`-separated segments —
 * and search borrows Moqi's bordered composer, so a query is typed exactly
 * where a prompt would be. Everything else is a pager: less/vim movement,
 * section jumps, an outline overlay, and a live reload when the file changes.
 * @module
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import type { ReadStream } from 'node:tty'

import { renderDocument, type Rendered } from './markdown.ts'
import { createDecoder, type Key } from './vendor/keys.ts'
import { displayWidth, padEnd, sliceColumns, stripAnsi, truncate } from './vendor/text.ts'
import {
  accent,
  bold,
  colAccent,
  colBorder,
  colGold,
  colInvert,
  colMuted,
  colText,
  muted,
  RESET,
  selected,
  style,
  warn,
} from './vendor/theme.ts'

const ESC = '\x1b'
const ALT_SCREEN_ON = `${ESC}[?1049h`
const ALT_SCREEN_OFF = `${ESC}[?1049l`
const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`
const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1000l`
const CURSOR_HIDE = `${ESC}[?25l`
const CURSOR_SHOW = `${ESC}[?25h`
const CLEAR_ALL = `${ESC}[2J`
const CLEAR_LINE = `${ESC}[K`
const moveTo = (row: number, column: number): string => `${ESC}[${String(row)};${String(column)}H`

/** What the viewer is showing and where it came from. */
export interface PagerSource {
  /** The document text. */
  text: string
  /** The file it was read from; absent for stdin, which cannot reload. */
  path?: string
}

export interface PagerOptions {
  /** The widest the reading column may grow. */
  maxWidth: number
  mouse: boolean
  watch: boolean
  input: ReadStream
}

interface Match {
  line: number
  start: number
  end: number
}

type Mode = 'read' | 'search' | 'outline' | 'help'

const SEPARATOR = '  ·  '

const HELP: [string, string][] = [
  ['j k  ↓ ↑', 'scroll a line'],
  ['space  b', 'page down / up'],
  ['d  u', 'half page down / up'],
  ['g  G', 'top / bottom'],
  [']  [', 'next / previous section'],
  ['t', 'outline'],
  ['/  n  N', 'search, next, previous'],
  ['e', 'edit in $EDITOR'],
  ['r', 'reload'],
  ['q', 'quit'],
]

/** Draw the frame lines the terminal does not already show. */
class Painter {
  private previous: string[] = []
  private readonly out = process.stdout

  invalidate(): void {
    this.previous = []
    this.out.write(CLEAR_ALL)
  }

  paint(lines: readonly string[]): void {
    let chunk = ''
    lines.forEach((line, row) => {
      if (this.previous[row] === line) return
      chunk += `${moveTo(row + 1, 1)}${line}${RESET}${CLEAR_LINE}`
    })
    this.previous = [...lines]
    if (chunk !== '') this.out.write(chunk)
  }
}

/** Run the viewer until the user quits. */
export function runPager(source: PagerSource, options: PagerOptions): Promise<void> {
  return new Promise((done) => {
    new Pager(source, options, done).start()
  })
}

class Pager {
  private text: string
  private readonly path: string | undefined
  private rendered: Rendered = { lines: [], headings: [] }
  private columns = 80
  private rows = 24
  private top = 0
  private mode: Mode = 'read'
  private query = ''
  private queryBefore = ''
  private topBefore = 0
  private matches: Match[] = []
  private current = -1
  private outlineIndex = 0
  private message = ''
  private messageIsError = false
  private messageTimer: ReturnType<typeof setTimeout> | undefined
  private watcher: FSWatcher | undefined
  private reloadTimer: ReturnType<typeof setTimeout> | undefined
  private readonly painter = new Painter()
  private readonly decode = createDecoder((key) => {
    this.onKey(key)
  })
  private readonly onData = (chunk: Buffer | string): void => {
    for (const key of this.decode(chunk.toString())) this.onKey(key)
  }
  private readonly onResize = (): void => {
    this.layout(true)
  }
  private readonly onCont = (): void => {
    this.attach()
    this.layout(true)
  }
  private stopped = false

  private readonly options: PagerOptions
  private readonly done: () => void

  constructor(source: PagerSource, options: PagerOptions, done: () => void) {
    this.options = options
    this.done = done
    this.text = source.text
    this.path = source.path === undefined ? undefined : resolve(source.path)
  }

  start(): void {
    this.attach()
    this.options.input.on('data', this.onData)
    process.stdout.on('resize', this.onResize)
    process.on('SIGCONT', this.onCont)
    process.on('exit', () => {
      this.detach()
    })
    if (this.options.watch) this.startWatching()
    this.layout(true)
  }

  // ── Terminal ownership ───────────────────────────────────────────────────

  private attach(): void {
    this.options.input.setRawMode(true)
    this.options.input.resume()
    process.stdout.write(ALT_SCREEN_ON + CURSOR_HIDE + (this.options.mouse ? MOUSE_ON : ''))
  }

  private detach(): void {
    if (this.stopped) return
    this.options.input.setRawMode(false)
    process.stdout.write((this.options.mouse ? MOUSE_OFF : '') + RESET + CURSOR_SHOW + ALT_SCREEN_OFF)
  }

  private quit(): void {
    this.detach()
    this.stopped = true
    this.decode.dispose()
    this.watcher?.close()
    this.options.input.off('data', this.onData)
    this.options.input.pause()
    process.stdout.off('resize', this.onResize)
    process.off('SIGCONT', this.onCont)
    clearTimeout(this.messageTimer)
    clearTimeout(this.reloadTimer)
    this.done()
  }

  /** Give the terminal back, run something in it, and take it again. */
  private suspendFor(run: () => void): void {
    this.detach()
    try {
      run()
    } finally {
      this.attach()
      this.layout(true)
    }
  }

  // ── Geometry ─────────────────────────────────────────────────────────────

  /** Columns the document is rendered at. */
  private get contentWidth(): number {
    return Math.max(Math.min(this.columns - 6, this.options.maxWidth), 20)
  }

  /** Left margin that centres the reading column. */
  private get margin(): number {
    return Math.max(Math.floor((this.columns - this.contentWidth) / 2), 2)
  }

  /** Rows the document gets: header and blank above, blank and footer below. */
  private get bodyHeight(): number {
    const composer = this.mode === 'search' ? 3 : 1
    return Math.max(this.rows - 3 - composer, 1)
  }

  private get maxTop(): number {
    return Math.max(this.rendered.lines.length - this.bodyHeight, 0)
  }

  /** Re-render at the current size, keeping the reader where they were. */
  private layout(resized: boolean): void {
    const before = this.rendered.lines.length
    const fraction = before === 0 ? 0 : this.top / before
    if (resized) {
      this.columns = process.stdout.columns > 0 ? process.stdout.columns : 80
      this.rows = process.stdout.rows > 0 ? process.stdout.rows : 24
      this.painter.invalidate()
    }
    const previousWidth = this.renderedWidth
    if (resized || previousWidth !== this.contentWidth) {
      this.rendered = renderDocument(this.text, { width: this.contentWidth, hyperlinks: true })
      this.renderedWidth = this.contentWidth
      if (before > 0) this.top = Math.round(fraction * this.rendered.lines.length)
      this.refreshMatches(false)
    }
    this.scrollTo(this.top)
  }

  private renderedWidth = 0

  // ── Movement ─────────────────────────────────────────────────────────────

  /**
   * Move the view's top edge. A heading jump may put its heading at the top
   * even near the end of the document, leaving blank rows below; ordinary
   * movement never scrolls further past the end than it already is.
   */
  private scrollTo(line: number, pastEnd = false): void {
    const limit = pastEnd
      ? Math.max(this.rendered.lines.length - 1, 0)
      : Math.max(this.maxTop, Math.min(this.top, line))
    this.top = Math.min(Math.max(line, 0), limit)
    this.draw()
  }

  private scrollBy(delta: number): void {
    this.scrollTo(this.top + delta)
  }

  /** Index of the heading whose section holds the top of the view. */
  private sectionIndex(): number {
    let index = -1
    this.rendered.headings.forEach((heading, at) => {
      if (heading.line <= this.top + 1) index = at
    })
    return index
  }

  private jumpSection(direction: 1 | -1): void {
    const headings = this.rendered.headings
    const target = direction === 1
      ? headings.find((heading) => heading.line > this.top + 1)
      : headings.findLast((heading) => heading.line < this.top)
    if (target === undefined) {
      this.scrollTo(direction === 1 ? this.maxTop : 0)
      return
    }
    this.scrollTo(target.line, true)
  }

  // ── Search ───────────────────────────────────────────────────────────────

  /** Find every match of the query; smart-case like vim and less. */
  private refreshMatches(jump: boolean): void {
    this.matches = []
    this.current = -1
    if (this.query === '') return
    const caseSensitive = this.query !== this.query.toLowerCase()
    const needle = caseSensitive ? this.query : this.query.toLowerCase()
    this.rendered.lines.forEach((line, index) => {
      const plain = stripAnsi(line)
      const haystack = caseSensitive ? plain : plain.toLowerCase()
      let from = haystack.indexOf(needle)
      while (from !== -1) {
        const start = displayWidth(plain.slice(0, from))
        this.matches.push({ line: index, start, end: start + displayWidth(plain.slice(from, from + needle.length)) })
        from = haystack.indexOf(needle, from + Math.max(needle.length, 1))
      }
    })
    if (jump) this.stepMatch(1, this.topBefore - 1)
  }

  /** Move to the next (or previous) match after line `from`. */
  private stepMatch(direction: 1 | -1, from = this.current === -1 ? this.top - 1 : (this.matches[this.current]?.line ?? this.top)): void {
    if (this.matches.length === 0) {
      if (this.query !== '') this.flash(`no matches for “${this.query}”`, true)
      return
    }
    let next: number
    if (this.current !== -1 && from === this.matches[this.current]?.line) {
      next = (this.current + direction + this.matches.length) % this.matches.length
    } else if (direction === 1) {
      next = this.matches.findIndex((match) => match.line > from)
      if (next === -1) next = 0
    } else {
      next = this.matches.findLastIndex((match) => match.line < from)
      if (next === -1) next = this.matches.length - 1
    }
    this.current = next
    const line = this.matches[next]?.line ?? 0
    // Keep the match a few lines below the top edge so its context shows.
    if (line < this.top || line >= this.top + this.bodyHeight) this.top = line - Math.min(3, Math.floor(this.bodyHeight / 4))
    this.scrollTo(this.top)
  }

  // ── Reload ───────────────────────────────────────────────────────────────

  private startWatching(): void {
    if (this.path === undefined) return
    const file = basename(this.path)
    try {
      // Watch the directory: editors save by renaming over the file, which
      // silently ends a watch held on the file itself.
      this.watcher = watch(dirname(this.path), (_event, name) => {
        if (name !== null && name !== file) return
        clearTimeout(this.reloadTimer)
        this.reloadTimer = setTimeout(() => {
          this.reload(false)
        }, 80)
      })
    } catch {
      this.watcher = undefined
    }
  }

  private reload(manual: boolean): void {
    if (this.path === undefined) {
      if (manual) this.flash('stdin cannot be reloaded', true)
      return
    }
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch {
      // Mid-save the file can briefly be missing; the next event brings it back.
      if (manual) this.flash('could not read the file', true)
      return
    }
    if (text === this.text && !manual) return
    this.text = text
    this.rendered = renderDocument(this.text, { width: this.contentWidth, hyperlinks: true })
    this.refreshMatches(false)
    this.flash('reloaded', false)
    this.scrollTo(this.top)
  }

  private edit(): void {
    if (this.path === undefined) {
      this.flash('stdin has no file to edit', true)
      return
    }
    const editor = process.env['VISUAL'] ?? process.env['EDITOR'] ?? 'vi'
    const path = this.path
    const line = this.sourceLineHint()
    this.suspendFor(() => {
      const [command = 'vi', ...rest] = editor.split(' ')
      spawnSync(command, [...rest, `+${String(line)}`, path], { stdio: 'inherit' })
    })
    this.reload(true)
  }

  /** The source line of the current section heading, so the editor opens near it. */
  private sourceLineHint(): number {
    const heading = this.rendered.headings[this.sectionIndex()]
    if (heading === undefined) return 1
    const lines = this.text.split('\n')
    const found = lines.findIndex((line) => line.replace(/^#+\s*/, '').trim() === heading.text || line.trim() === heading.text)
    return found === -1 ? 1 : found + 1
  }

  private flash(text: string, error: boolean): void {
    this.message = text
    this.messageIsError = error
    clearTimeout(this.messageTimer)
    this.messageTimer = setTimeout(() => {
      this.message = ''
      this.draw()
    }, 2500)
    this.messageTimer.unref()
    this.draw()
  }

  // ── Input ────────────────────────────────────────────────────────────────

  private onKey(key: Key): void {
    if (this.stopped) return
    if (key.name === 'ctrl+c') {
      this.quit()
      return
    }
    if (key.name === 'ctrl+z') {
      this.detach()
      process.kill(process.pid, 'SIGTSTP')
      return
    }
    switch (this.mode) {
      case 'search':
        this.onSearchKey(key)
        return
      case 'outline':
        this.onOutlineKey(key)
        return
      case 'help':
        this.mode = 'read'
        this.draw()
        return
      case 'read':
        this.onReadKey(key)
    }
  }

  private onReadKey(key: Key): void {
    const page = Math.max(this.bodyHeight - 2, 1)
    const half = Math.max(Math.floor(this.bodyHeight / 2), 1)
    switch (key.name) {
      case 'q':
        this.quit()
        return
      case 'esc':
        if (this.query !== '') {
          this.query = ''
          this.refreshMatches(false)
          this.draw()
        }
        return
      case 'j':
      case 'down':
      case 'enter':
      case 'ctrl+e':
      case 'ctrl+n':
        this.scrollBy(1)
        return
      case 'k':
      case 'up':
      case 'ctrl+y':
      case 'ctrl+p':
        this.scrollBy(-1)
        return
      case 'wheeldown':
        this.scrollBy(3)
        return
      case 'wheelup':
        this.scrollBy(-3)
        return
      case ' ':
      case 'f':
      case 'pagedown':
      case 'ctrl+f':
        this.scrollBy(page)
        return
      case 'b':
      case 'pageup':
      case 'ctrl+b':
        this.scrollBy(-page)
        return
      case 'd':
      case 'ctrl+d':
        this.scrollBy(half)
        return
      case 'u':
      case 'ctrl+u':
        this.scrollBy(-half)
        return
      case 'g':
      case 'home':
        this.scrollTo(0)
        return
      case 'G':
      case 'end':
        this.scrollTo(this.maxTop)
        return
      case ']':
      case '}':
        this.jumpSection(1)
        return
      case '[':
      case '{':
        this.jumpSection(-1)
        return
      case '/':
        this.queryBefore = this.query
        this.topBefore = this.top
        this.query = ''
        this.mode = 'search'
        this.refreshMatches(false)
        this.draw()
        return
      case 'n':
        this.stepMatch(1)
        return
      case 'N':
        this.stepMatch(-1)
        return
      case 't':
      case 'o':
      case 'tab':
        if (this.rendered.headings.length === 0) {
          this.flash('this document has no headings', true)
          return
        }
        this.outlineIndex = Math.max(this.sectionIndex(), 0)
        this.mode = 'outline'
        this.draw()
        return
      case '?':
        this.mode = 'help'
        this.draw()
        return
      case 'r':
        this.reload(true)
        return
      case 'e':
        this.edit()
        return
      case 'ctrl+l':
        this.layout(true)
    }
  }

  private onSearchKey(key: Key): void {
    switch (key.name) {
      case 'esc':
        this.query = this.queryBefore
        this.mode = 'read'
        this.refreshMatches(false)
        this.scrollTo(this.topBefore)
        return
      case 'enter':
        this.mode = 'read'
        if (this.matches.length === 0 && this.query !== '') this.flash(`no matches for “${this.query}”`, true)
        this.scrollTo(this.top)
        return
      case 'backspace':
        if (this.query === '') {
          this.mode = 'read'
          this.scrollTo(this.topBefore)
          return
        }
        this.query = [...this.query].slice(0, -1).join('')
        break
      case 'ctrl+u':
        this.query = ''
        break
      default:
        if (key.text === '' || key.text < ' ') return
        this.query += key.text
    }
    // Incremental: each keystroke re-searches from where the search began.
    this.top = this.topBefore
    this.refreshMatches(true)
    this.draw()
  }

  private onOutlineKey(key: Key): void {
    const count = this.rendered.headings.length
    switch (key.name) {
      case 'j':
      case 'down':
      case 'tab':
      case 'ctrl+n':
        this.outlineIndex = (this.outlineIndex + 1) % count
        break
      case 'k':
      case 'up':
      case 'shift+tab':
      case 'ctrl+p':
        this.outlineIndex = (this.outlineIndex - 1 + count) % count
        break
      case 'g':
      case 'home':
        this.outlineIndex = 0
        break
      case 'G':
      case 'end':
        this.outlineIndex = count - 1
        break
      case 'enter':
      case 'l':
      case 'right': {
        this.mode = 'read'
        this.scrollTo(this.rendered.headings[this.outlineIndex]?.line ?? 0, true)
        return
      }
      case 'esc':
      case 'q':
      case 't':
      case 'o':
        this.mode = 'read'
        break
      default:
        return
    }
    this.draw()
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  private draw(): void {
    if (this.stopped) return
    const frame: string[] = [this.header(), '']
    const body = this.body()
    frame.push(...body)
    if (this.mode === 'search') frame.push(...this.composer())
    else frame.push('')
    frame.push(this.footer())
    let lines = frame
    if (this.mode === 'outline') lines = this.overlay(frame, this.outlineBox())
    if (this.mode === 'help') lines = this.overlay(frame, this.helpBox())
    this.painter.paint(lines.map((line) => truncate(line, this.columns)))
  }

  /** `◆ moqi-md  file` on the left, its folder on the right. */
  private header(): string {
    const name = this.path === undefined ? 'stdin' : basename(this.path)
    const left = ` ${bold('◆ moqi-md')}${muted(`  ${name}`)}`
    const folder = this.path === undefined ? '' : tildify(dirname(this.path))
    const right = muted(`${folder} `)
    const gap = this.columns - displayWidth(left) - displayWidth(right)
    return gap < 2 ? left : left + ' '.repeat(gap) + right
  }

  private body(): string[] {
    const height = this.bodyHeight
    const pad = ' '.repeat(this.margin)
    const lines = this.rendered.lines
    const thumb = this.thumb(height)
    const out: string[] = []
    for (let row = 0; row < height; row += 1) {
      const index = this.top + row
      let line = lines[index] ?? ''
      if (this.matches.length > 0) line = this.highlightMatches(line, index)
      const gutter = thumb === undefined ? '' : (row >= thumb.start && row < thumb.end ? style('┃', { fg: colMuted }) : style('│', { fg: colBorder }))
      const content = `${pad}${line}${RESET}`
      out.push(gutter === '' ? content : padEnd(content, this.columns - 2) + gutter)
    }
    return out
  }

  /** The scroll thumb's rows, or nothing when the whole document fits. */
  private thumb(height: number): { start: number; end: number } | undefined {
    const total = this.rendered.lines.length
    if (total <= height) return undefined
    const size = Math.max(Math.round((height * height) / total), 1)
    const start = Math.round((this.top / Math.max(total - height, 1)) * (height - size))
    return { start, end: start + size }
  }

  private highlightMatches(line: string, index: number): string {
    const here = this.matches
      .map((match, at) => ({ match, at }))
      .filter(({ match }) => match.line === index)
      .reverse()
    let out = line
    const plain = stripAnsi(line)
    for (const { match, at } of here) {
      const text = sliceColumns(plain, match.start, match.end)
      const look = at === this.current
        ? { fg: colInvert, bg: colAccent, bold: true }
        : { fg: colInvert, bg: colGold }
      out = `${sliceColumns(out, 0, match.start)}${RESET}${style(text, look)}${sliceColumns(out, match.end, Number.POSITIVE_INFINITY)}`
    }
    return out
  }

  /** Moqi's bordered composer, holding the search query. */
  private composer(): string[] {
    const inner = Math.max(this.columns - 6, 10)
    const color = colAccent
    const side = style('│', { fg: color })
    const text = this.query === ''
      ? muted('search…  (enter to keep, esc to cancel)')
      : `${accent('/')} ${style(this.query, { fg: colText })}${style('▏', { fg: colAccent })}`
    const count = this.query === '' ? '' : muted(this.matches.length === 0 ? 'no matches' : `${String(this.current + 1)}/${String(this.matches.length)}`)
    const gap = Math.max(inner - displayWidth(text) - displayWidth(count), 1)
    return [
      ` ${style(`╭${'─'.repeat(inner + 2)}╮`, { fg: color })}`,
      ` ${side} ${truncate(text + ' '.repeat(gap) + count, inner)} ${side}`,
      ` ${style(`╰${'─'.repeat(inner + 2)}╯`, { fg: color })}`,
    ]
  }

  /** The footer: section and position on the left, the next useful thing on the right. */
  private footer(): string {
    const section = this.rendered.headings[this.sectionIndex()]
    const total = this.rendered.lines.length
    const percent = this.maxTop === 0 ? 100 : Math.min(Math.round((this.top / this.maxTop) * 100), 100)
    const segments: string[] = []
    if (section !== undefined) segments.push(`§ ${section.text}`)
    segments.push(`${String(Math.min(this.top + this.bodyHeight, total))}/${String(total)}`)
    segments.push(percent === 100 ? 'end' : `${String(percent)}%`)
    const left = ` ${muted(segments.join(SEPARATOR))}`

    let right: string
    if (this.message !== '') right = this.messageIsError ? warn(this.message) : accent(this.message)
    else if (this.query !== '' && this.matches.length > 0 && this.mode === 'read') {
      right = muted(`“${this.query}”  ${String(this.current + 1)}/${String(this.matches.length)}${SEPARATOR}n next  ·  esc clear`)
    } else {
      // A narrow terminal keeps the two hints that lead to all the others.
      const full = `/ search${SEPARATOR}t outline${SEPARATOR}? keys${SEPARATOR}q quit`
      right = muted(displayWidth(left) + displayWidth(full) + 4 <= this.columns ? full : `? keys${SEPARATOR}q quit`)
    }
    right = `${right} `

    const room = this.columns - displayWidth(right)
    if (room < 12) return truncate(left, this.columns)
    const fitted = truncate(left, room - 2)
    return fitted + ' '.repeat(Math.max(room - displayWidth(fitted), 0)) + right
  }

  private outlineBox(): string[] {
    const headings = this.rendered.headings
    const inner = Math.min(Math.max(...headings.map((heading) => (heading.level - 1) * 2 + displayWidth(heading.text)), 20) + 2, this.columns - 8)
    const title = `outline  ${String(this.outlineIndex + 1)}/${String(headings.length)}`
    const hint = '↑↓ move  ·  enter jump  ·  esc close'
    const boxInner = Math.min(Math.max(inner, displayWidth(title) + 4, displayWidth(hint) + 4), this.columns - 4)
    const visible = Math.min(headings.length, Math.max(this.bodyHeight - 4, 3))
    const first = Math.min(Math.max(this.outlineIndex - Math.floor(visible / 2), 0), headings.length - visible)
    const minLevel = Math.min(...headings.map((heading) => heading.level))
    const rows = headings.slice(first, first + visible).map((heading, offset) => {
      const index = first + offset
      const indent = '  '.repeat(heading.level - minLevel)
      const label = truncate(`${indent}${heading.text}`, inner)
      if (index === this.outlineIndex) return selected(padEnd(` ${label}`, boxInner + 2))
      return heading.level - minLevel === 0 ? ` ${style(label, { fg: colText, bold: true })}` : ` ${style(label, { fg: colText })}`
    })
    return this.box(title, rows, inner, hint)
  }

  private helpBox(): string[] {
    const keyWidth = Math.max(...HELP.map(([keys]) => displayWidth(keys)))
    const rows = HELP.map(([keys, action]) => ` ${style(padEnd(keys, keyWidth), { fg: colAccent })}   ${style(action, { fg: colText })}`)
    const inner = Math.max(...rows.map((row) => displayWidth(row))) + 2
    return this.box('keys', rows, inner, 'any key to close')
  }

  /** A rounded Moqi box with a title in its top edge and a hint in its bottom one. */
  private box(title: string, rows: readonly string[], minInner: number, hint: string): string[] {
    const inner = Math.min(Math.max(minInner, displayWidth(title) + 4, displayWidth(hint) + 4), this.columns - 4)
    const edge = (text: string, left: string, right: string): string => {
      const label = text === '' ? '' : ` ${text} `
      const rest = Math.max(inner + 2 - displayWidth(label) - 1, 0)
      return style(left + '─', { fg: colAccent }) + muted(label) + style('─'.repeat(rest) + right, { fg: colAccent })
    }
    const side = style('│', { fg: colAccent })
    return [
      edge(title, '╭', '╮'),
      ...rows.map((row) => `${side}${padEnd(truncate(row, inner + 2), inner + 2)}${side}`),
      edge(hint, '╰', '╯'),
    ]
  }

  /** Lay a box over the middle of the frame, the document still visible around it. */
  private overlay(frame: readonly string[], box: readonly string[]): string[] {
    const width = Math.max(...box.map((line) => displayWidth(line)))
    const left = Math.max(Math.floor((this.columns - width) / 2), 0)
    const topRow = Math.max(Math.floor((frame.length - box.length) / 2), 2)
    return frame.map((line, row) => {
      const piece = box[row - topRow]
      if (piece === undefined) return line
      const before = padEnd(sliceColumns(line, 0, left), left)
      const after = sliceColumns(line, left + width, Number.POSITIVE_INFINITY)
      return `${before}${RESET}${piece}${RESET}${after}`
    })
  }
}

/** `/home/me/x` as `~/x`. */
function tildify(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}
