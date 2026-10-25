/**
 * A small syntax highlighter for fenced code, lifted from Moqi's transcript
 * renderer so code reads the same in both: strings, line comments, numbers,
 * and keywords, never failing on a language it does not know. Diffs are the
 * one addition — a file viewer meets them far more often than a chat does.
 * @module
 */

import { colAccent, colGold, colGreen, colMuted, colRose, colText, colWarn, style } from './vendor/theme.ts'

/** Languages the highlighter knows keywords for. */
const KEYWORDS: Record<string, readonly string[]> = {
  js: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'new', 'await', 'async', 'import', 'export', 'from', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'this', 'null', 'undefined', 'true', 'false', 'switch', 'case', 'break', 'continue', 'default', 'extends', 'static', 'yield', 'delete', 'in', 'of'],
  ts: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'new', 'await', 'async', 'import', 'export', 'from', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'this', 'null', 'undefined', 'true', 'false', 'switch', 'case', 'break', 'continue', 'default', 'extends', 'implements', 'interface', 'type', 'enum', 'readonly', 'private', 'public', 'protected', 'static', 'satisfies', 'as', 'is', 'keyof', 'declare', 'namespace', 'yield', 'in', 'of'],
  go: ['package', 'import', 'func', 'return', 'if', 'else', 'for', 'range', 'var', 'const', 'type', 'struct', 'interface', 'map', 'chan', 'go', 'defer', 'switch', 'case', 'default', 'break', 'continue', 'nil', 'true', 'false', 'select', 'fallthrough', 'goto'],
  python: ['def', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'class', 'try', 'except', 'finally', 'raise', 'with', 'lambda', 'None', 'True', 'False', 'and', 'or', 'not', 'in', 'is', 'pass', 'yield', 'global', 'nonlocal', 'assert', 'async', 'await', 'del'],
  bash: ['if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'case', 'esac', 'function', 'return', 'export', 'local', 'readonly', 'set', 'unset', 'echo', 'cd', 'exit', 'source'],
  yaml: ['true', 'false', 'null', 'yes', 'no', 'on', 'off'],
  json: ['true', 'false', 'null'],
  rust: ['fn', 'let', 'mut', 'const', 'struct', 'enum', 'impl', 'trait', 'pub', 'use', 'mod', 'match', 'if', 'else', 'for', 'while', 'loop', 'return', 'self', 'Self', 'where', 'async', 'await', 'move', 'ref', 'dyn', 'true', 'false', 'crate', 'super', 'type', 'unsafe'],
}

/** Map a fence's info string onto a keyword set. */
export function languageOf(info: string): readonly string[] | undefined {
  const name = info.trim().toLowerCase().split(/\s+/)[0] ?? ''
  switch (name) {
    case 'js':
    case 'javascript':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return KEYWORDS['js']
    case 'ts':
    case 'typescript':
    case 'tsx':
      return KEYWORDS['ts']
    case 'go':
    case 'golang':
      return KEYWORDS['go']
    case 'py':
    case 'python':
      return KEYWORDS['python']
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'shell':
    case 'console':
      return KEYWORDS['bash']
    case 'yaml':
    case 'yml':
      return KEYWORDS['yaml']
    case 'json':
      return KEYWORDS['json']
    case 'rs':
    case 'rust':
      return KEYWORDS['rust']
    default:
      return undefined
  }
}

const COMMENT_PREFIX: Record<string, string> = {
  python: '#',
  bash: '#',
  yaml: '#',
}

/**
 * Highlight one line of code. A deliberately small tokenizer: strings, line
 * comments, numbers, and keywords. It never fails, so a language it does not
 * know simply renders in the plain code color.
 */
function highlightLine(line: string, keywords: readonly string[] | undefined, info: string): string {
  const name = info.trim().toLowerCase().split(/\s+/)[0] ?? ''
  const hashComment = COMMENT_PREFIX[name] !== undefined
  let out = ''
  let index = 0
  while (index < line.length) {
    const rest = line.slice(index)

    // Line comments run to the end of the line.
    if ((hashComment && rest.startsWith('#')) || (!hashComment && rest.startsWith('//'))) {
      out += style(rest, { fg: colMuted, italic: true })
      break
    }

    // String literals, single or double quoted, with backslash escapes.
    const quote = rest[0]
    if (quote === '"' || quote === "'" || quote === '`') {
      const end = stringLiteralLength(rest, quote)
      out += style(rest.slice(0, end), { fg: colGold })
      index += end
      continue
    }

    // Identifiers and keywords.
    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest)
    if (word !== null) {
      const text = word[0]
      out += keywords?.includes(text) === true
        ? style(text, { fg: colAccent, bold: true })
        : style(text, { fg: colText })
      index += text.length
      continue
    }

    // Numbers.
    const number = /^\d[\d_.]*/.exec(rest)
    if (number !== null) {
      out += style(number[0], { fg: colRose })
      index += number[0].length
      continue
    }

    out += style(rest[0] ?? '', { fg: colMuted })
    index += 1
  }
  return out
}

/** How many bytes one quoted literal spans, opening quote included. */
function stringLiteralLength(rest: string, quote: string): number {
  let end = 1
  while (end < rest.length) {
    if (rest[end] === '\\') {
      end += 2
      continue
    }
    if (rest[end] === quote) return end + 1
    end += 1
  }
  return end
}

/** Highlight one line of a fenced block, picking the language from its info string. */
export function highlight(line: string, info: string): string {
  const name = info.trim().toLowerCase().split(/\s+/)[0] ?? ''
  if (name === 'diff' || name === 'patch') return highlightDiff(line)
  return highlightLine(line, languageOf(info), info)
}

/** A unified-diff line, colored by its first character. */
function highlightDiff(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return style(line, { fg: colText, bold: true })
  if (line.startsWith('@@')) return style(line, { fg: colAccent })
  if (line.startsWith('+')) return style(line, { fg: colGreen })
  if (line.startsWith('-')) return style(line, { fg: colWarn })
  return style(line, { fg: colMuted })
}
