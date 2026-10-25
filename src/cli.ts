/**
 * `moqi-md` — read a markdown file the way Moqi draws its transcript.
 *
 * With a terminal on stdout it opens the viewer; piped, or with `--print`, it
 * renders once and writes the result, so it also works as a `cat` for
 * markdown. The palette follows Moqi's own `/theme` choice unless told
 * otherwise.
 * @module
 */

import { openSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ReadStream } from 'node:tty'

import { renderDocument } from './markdown.ts'
import { runPager } from './pager.ts'
import { stripAnsi } from './vendor/text.ts'
import { applyTheme, listThemes, activeTheme } from './vendor/theme.ts'

const VERSION = '0.1.0'

const USAGE = `moqi-md ${VERSION} — markdown in the terminal, Moqi style

usage
  moqi-md [options] [file]      view a file (README.md when none is given)
  cat notes.md | moqi-md        view stdin
  moqi-md -p file > out.txt     render once and print

options
  -p, --print          render to stdout and exit (automatic when piped)
  -w, --width <cols>   widest reading column (default 100)
  -t, --theme <name>   palette; defaults to Moqi's own /theme choice
      --list-themes    list palettes and exit
      --color          keep colour when printing to a pipe
      --no-mouse       leave mouse selection to the terminal
      --no-watch       do not reload when the file changes
  -h, --help           show this help
  -v, --version        show the version

keys in the viewer: ? lists them`

interface Args {
  file: string | undefined
  print: boolean
  width: number
  theme: string | undefined
  listThemes: boolean
  color: boolean
  mouse: boolean
  watch: boolean
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Args | 'help' | 'version' {
  const args: Args = { file: undefined, print: false, width: 100, theme: undefined, listThemes: false, color: false, mouse: true, watch: true }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    const value = (): string => {
      const next = argv[index + 1]
      if (next === undefined) throw new UsageError(`${arg} needs a value`)
      index += 1
      return next
    }
    switch (arg) {
      case '-h':
      case '--help':
        return 'help'
      case '-v':
      case '--version':
        return 'version'
      case '-p':
      case '--print':
        args.print = true
        break
      case '-w':
      case '--width': {
        const width = Number.parseInt(value(), 10)
        if (!Number.isFinite(width) || width < 20) throw new UsageError('--width must be a number of at least 20')
        args.width = width
        break
      }
      case '-t':
      case '--theme':
        args.theme = value()
        break
      case '--list-themes':
        args.listThemes = true
        break
      case '--color':
        args.color = true
        break
      case '--no-mouse':
        args.mouse = false
        break
      case '--no-watch':
        args.watch = false
        break
      default:
        if (arg.startsWith('-') && arg !== '-') throw new UsageError(`unknown option ${arg}`)
        if (args.file !== undefined) throw new UsageError('one file at a time')
        args.file = arg
    }
  }
  return args
}

/** Moqi's saved `/theme`, from `$DSH_HOME/tui-state.json`. */
function moqiTheme(): string | undefined {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  try {
    const state = JSON.parse(readFileSync(join(home, 'tui-state.json'), 'utf8')) as { theme?: unknown }
    return typeof state.theme === 'string' ? state.theme : undefined
  } catch {
    return undefined
  }
}

function pickTheme(requested: string | undefined): void {
  if (requested !== undefined) {
    if (!applyTheme(requested)) throw new UsageError(`no theme called ${requested} (see --list-themes)`)
    return
  }
  const fallback = process.env['MOQI_MD_THEME'] ?? moqiTheme()
  if (fallback !== undefined) applyTheme(fallback)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs(process.argv.slice(2))
    if (typeof parsed !== 'string') pickTheme(parsed.theme)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    process.stderr.write(`moqi-md: ${error.message}\n`)
    return 2
  }
  if (parsed === 'help') {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (parsed === 'version') {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  const args = parsed

  if (args.listThemes) {
    const width = Math.max(...listThemes().map((theme) => theme.name.length))
    for (const theme of listThemes()) {
      const mark = theme.name === activeTheme() ? '◆' : ' '
      process.stdout.write(`${mark} ${theme.name.padEnd(width)}  ${theme.description}\n`)
    }
    return 0
  }

  // Where the document comes from: a named file, stdin, or the README here.
  let text: string
  let path: string | undefined
  const fromStdin = args.file === '-' || (args.file === undefined && !process.stdin.isTTY)
  if (fromStdin) {
    text = await readStdin()
  } else {
    path = args.file ?? (existsSync('README.md') ? 'README.md' : undefined)
    if (path === undefined) {
      process.stderr.write(`moqi-md: no file given and no README.md here\n\n${USAGE}\n`)
      return 2
    }
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      process.stderr.write(`moqi-md: cannot read ${path}: ${(error as Error).message}\n`)
      return 1
    }
  }

  if (args.print || !process.stdout.isTTY) {
    const terminal = process.stdout.isTTY
    const width = Math.min(terminal ? process.stdout.columns - 2 : 80, args.width)
    const plain = !terminal && !args.color
    const { lines } = renderDocument(text, { width, hyperlinks: terminal, plain })
    const output = lines.map((line) => (plain ? stripAnsi(line) : line).trimEnd()).join('\n')
    process.stdout.write(`${output}\n`)
    return 0
  }

  // Keys come from the terminal itself, so piping a document in still works.
  let input: ReadStream
  if (process.stdin.isTTY) {
    input = process.stdin
  } else {
    try {
      input = new ReadStream(openSync('/dev/tty', 'r'))
    } catch {
      process.stderr.write('moqi-md: no terminal to read keys from; use --print\n')
      return 1
    }
  }
  await runPager(path === undefined ? { text } : { text, path }, {
    maxWidth: args.width,
    mouse: args.mouse,
    watch: args.watch,
    input,
  })
  return 0
}

main().then(
  (code) => {
    process.exitCode = code
    // A /dev/tty stream keeps the loop alive; the viewer is done with it.
    if (!process.stdin.isTTY) process.exit(code)
  },
  (error: unknown) => {
    process.stderr.write(`moqi-md: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exitCode = 1
  },
)
