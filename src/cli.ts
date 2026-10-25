/**
 * `moqi-md` — read a markdown file the way Moqi draws its transcript.
 *
 * With a terminal on stdout it opens the viewer; piped, or with `--print`, it
 * renders once and writes the result, so it also works as a `cat` for
 * markdown. The palette follows Moqi's own `/theme` choice unless told
 * otherwise.
 * @module
 */

import { openSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { ReadStream } from 'node:tty'

import { renderDocument } from './markdown.ts'
import { runPager, type PagerSource } from './pager.ts'
import { stripAnsi } from './vendor/text.ts'
import { applyTheme, listThemes, activeTheme } from './vendor/theme.ts'

const VERSION = '0.2.0'

const USAGE = `moqi-md ${VERSION} — markdown in the terminal, Moqi style

usage
  moqi-md [options] [file…]     view files, one tab each (README.md when none)
  moqi-md docs/                 a tab per markdown file in a folder
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
  files: string[]
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
  const args: Args = { files: [], print: false, width: 100, theme: undefined, listThemes: false, color: false, mouse: true, watch: true }
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
        args.files.push(arg)
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

/** Markdown files in a folder, README first, then by name. */
function markdownIn(folder: string): string[] {
  const names = readdirSync(folder)
    .filter((name) => /\.(md|markdown|mdx)$/i.test(name))
    .sort((a, b) => {
      const readme = (name: string): number => (/^readme\./i.test(name) ? 0 : 1)
      return readme(a) - readme(b) || a.localeCompare(b)
    })
  return names.map((name) => join(folder, name))
}

/** Read every named file (folders expanded, duplicates dropped), or stdin, or the README. */
async function gatherSources(files: readonly string[]): Promise<PagerSource[]> {
  if (files.length === 0) {
    if (!process.stdin.isTTY) return [{ text: await readStdin() }]
    if (existsSync('README.md')) files = ['README.md']
    else throw new UsageError(`no file given and no README.md here\n\n${USAGE}`)
  }
  const sources: PagerSource[] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (file === '-') {
      if (seen.has('-')) continue
      seen.add('-')
      sources.push({ text: await readStdin() })
      continue
    }
    let paths: string[]
    try {
      paths = statSync(file).isDirectory() ? markdownIn(file) : [file]
    } catch (error) {
      throw new UsageError(`cannot read ${file}: ${(error as Error).message}`)
    }
    if (paths.length === 0) throw new UsageError(`no markdown files in ${file}`)
    for (const path of paths) {
      const key = resolve(path)
      if (seen.has(key)) continue
      seen.add(key)
      try {
        sources.push({ text: readFileSync(path, 'utf8'), path })
      } catch (error) {
        throw new UsageError(`cannot read ${basename(path)}: ${(error as Error).message}`)
      }
    }
  }
  return sources
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

  // Where the documents come from: named files and folders, stdin, or the README here.
  let sources: PagerSource[]
  try {
    sources = await gatherSources(args.files)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    process.stderr.write(`moqi-md: ${error.message}\n`)
    return error.message.startsWith('no file given') ? 2 : 1
  }

  if (args.print || !process.stdout.isTTY) {
    const terminal = process.stdout.isTTY
    const width = Math.min(terminal ? process.stdout.columns - 2 : 80, args.width)
    const plain = !terminal && !args.color
    const parts = sources.map((source) => {
      const { lines } = renderDocument(source.text, { width, hyperlinks: terminal, plain })
      const body = lines.map((line) => (plain ? stripAnsi(line) : line).trimEnd()).join('\n')
      // Several files print one after another, each under its name.
      if (sources.length === 1) return body
      const name = source.path === undefined ? 'stdin' : source.path
      return `${plain ? `◆ ${name}` : `\x1b[1m◆ ${name}\x1b[0m`}\n\n${body}`
    })
    process.stdout.write(`${parts.join('\n\n')}\n`)
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
  await runPager(sources, {
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
