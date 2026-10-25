import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderDocument } from '../src/markdown.ts'
import { displayWidth, stripAnsi } from '../src/vendor/text.ts'

/** Render to plain text lines, the way a pipe sees them. */
function plain(source: string, width = 60): string[] {
  return renderDocument(source, { width, hyperlinks: false, plain: true }).lines.map((line) => stripAnsi(line).trimEnd())
}

test('headings get Moqi rules and land in the outline', () => {
  const { lines, headings } = renderDocument('# Title\n\ntext\n\n## Part\n\n### Deep', { width: 40, hyperlinks: false })
  const text = lines.map(stripAnsi)
  assert.deepEqual(text.slice(0, 2), ['Title', '━━━━━'])
  assert.ok(text.includes('### Deep'))
  assert.deepEqual(headings.map((heading) => [heading.level, heading.text, text[heading.line]]), [
    [1, 'Title', 'Title'],
    [2, 'Part', 'Part'],
    [3, 'Deep', '### Deep'],
  ])
})

test('a styled span keeps its style across a wrap', () => {
  const { lines } = renderDocument('aaa **bold words that wrap** bbb', { width: 14, hyperlinks: false })
  const bolded = lines.filter((line) => line.includes('\x1b[1;'))
  assert.equal(bolded.length, lines.length)
  assert.ok(!lines.some((line) => stripAnsi(line).includes('*')))
})

test('no line is wider than the width asked for', () => {
  const source = '# A heading long enough to wrap around\n\n' + 'word '.repeat(80) + '\n\n- item ' + 'x'.repeat(90) + '\n\n| a | b |\n|---|---|\n| ' + 'long '.repeat(30) + '| y |'
  for (const line of renderDocument(source, { width: 30, hyperlinks: false }).lines) {
    assert.ok(displayWidth(line) <= 30, `too wide: ${stripAnsi(line)}`)
  }
})

test('lists nest, number, and tick', () => {
  assert.deepEqual(plain('- one\n  - two\n- three\n\n3. c\n4. d\n\n- [x] done\n- [ ] todo'), [
    '• one',
    '  ◦ two',
    '• three',
    '',
    '3. c',
    '4. d',
    '',
    '✓ done',
    '☐ todo',
  ])
})

test('code blocks keep their text behind the gutter', () => {
  assert.deepEqual(plain('```js\nconst a = 1\n```'), ['  js', '  │ const a = 1'])
  assert.deepEqual(plain('    indented'), ['  │ indented'])
})

test('an unterminated fence still renders its body', () => {
  assert.deepEqual(plain('```\nhalf written'), ['  │ half written'])
})

test('quotes and alerts', () => {
  assert.deepEqual(plain('> quoted *text*'), ['┃ quoted text'])
  assert.deepEqual(plain('> [!WARNING]\n> careful'), ['┃ ▲ Warning', '┃ careful'])
})

test('tables align and keep a header rule', () => {
  assert.deepEqual(plain('| k | v |\n|:--|--:|\n| a | 10 |\n| bb | 2 |'), ['k  │  v', '───┼───', 'a  │ 10', 'bb │  2'])
})

test('links, references, and inline code in a pipe', () => {
  assert.deepEqual(plain('see [docs](https://x.dev) and [ref] with `code`\n\n[ref]: https://r.dev'), [
    'see docs (https://x.dev) and ref (https://r.dev) with `code`',
  ])
})

test('front matter, comments, and HTML wrappers', () => {
  const lines = plain('---\ntitle: Hi\n---\n\n<!-- hidden -->\n\n<p align="center"><img src="a.png" alt="Logo"></p>\n\nbody')
  assert.equal(lines[0], 'title  Hi')
  assert.ok(lines.includes('▣ Logo'))
  assert.ok(!lines.some((line) => line.includes('hidden') || line.includes('<')))
  assert.equal(lines.at(-1), 'body')
})

test('snake_case is not emphasis, escapes are literal', () => {
  assert.deepEqual(plain('a snake_case_name and \\*stars\\*'), ['a snake_case_name and *stars*'])
})

test('setext headings and hard breaks', () => {
  assert.deepEqual(plain('Title\n=====\n\nline one  \nline two'), ['Title', '━━━━━', '', 'line one', 'line two'])
})
