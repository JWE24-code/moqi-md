# moqi-md

*Markdown files, read the way [Moqi](https://github.com/JWE24-code/moqi) draws its transcript.*

```
 ◆ moqi-md  README.md                                        ~/Projects/moqi

   Moqi
   ━━━━

   默契 — the unspoken understanding between you and your harness.

   • Tool calls, where they happened — each call renders inline
   • Approvals that remember — allow a command once, or always

     sh
     │ npm install -g moqi-md

   ┃ ✦ Tip
   ┃ Press t for the outline and / to search.

 § Moqi  ·  24/310  ·  0%              / search  ·  t outline  ·  ? keys  ·  q quit
```

A zero-dependency terminal markdown viewer. Moqi's palette, its `◆` header and
`·` footer, its `│` code gutter and gold code chips, around a pager that knows
the document's structure.

## Use

```sh
moqi-md notes.md             # view a file
moqi-md                      # view ./README.md
cat CHANGELOG.md | moqi-md   # view stdin
moqi-md -p doc.md | less -R  # render once (automatic when piped; plain text unless --color)
```

| Key | Does |
|:----|:-----|
| `j` `k` `↓` `↑` | scroll a line (the mouse wheel scrolls three) |
| `space` `b` | page down / up |
| `d` `u` | half a page down / up |
| `g` `G` | top / bottom |
| `]` `[` | next / previous section |
| `t` | outline — jump to any heading |
| `/` `n` `N` | incremental smart-case search, next, previous |
| `e` | open in `$EDITOR` near the current section |
| `r` | reload (it also reloads on its own when the file changes) |
| `?` | key list |
| `q` | quit |

Options: `--width <cols>` (reading column, default 100), `--theme <name>`,
`--list-themes`, `--color`, `--no-mouse`, `--no-watch`.

## Themes

The palette follows the theme picked with `/theme` in Moqi (read from
`$DSH_HOME/tui-state.json`), so the viewer matches the app. Override with
`--theme` or `MOQI_MD_THEME`; `MOQI_THEME=light|dark` picks the variant, and
`NO_COLOR` is honored.

## What it renders

Headings (ATX and setext), paragraphs with soft and hard breaks, **bold**,
*italic*, ~~strike~~, `code`, links (OSC 8 hyperlinks in a terminal, targets
printed in a pipe), reference links, autolinks, images as `▣ alt`, nested
ordered/unordered/task lists, fenced and indented code with highlighting (js,
ts, go, python, bash, yaml, json, rust, diff), block quotes with nested
content, GitHub alerts (`> [!NOTE]` …), pipe tables with alignment and
wrapping cells, YAML front matter, footnote markers, `<kbd>`, `<br>`, and
README-style HTML wrappers. Anything else falls through as a paragraph.
Rendering never throws.

## Develop

```sh
npm install        # also builds lib/
npm test           # renderer tests
npm run preview    # open examples/showcase.md from source
npm link           # put moqi-md on your PATH
```

Node ≥ 22.18 runs the TypeScript sources directly. `src/vendor/` holds
`theme.ts`, `themes.ts`, `text.ts`, and `keys.ts` copied unchanged from Moqi
(52ecd3c); refresh them from there rather than editing them here.
