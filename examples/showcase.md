---
title: moqi-md showcase
tags: [terminal, markdown]
---

# moqi-md

*默契* — markdown files, read the way **Moqi** draws its transcript.

## Inline

Plain text with **bold**, *italic*, ***both***, ~~struck~~, `inline code`, a
[link](https://github.com/JWE24-code/moqi), an autolink <https://example.com>,
a reference [to the repo][repo], snake_case_words, and <kbd>ctrl</kbd>+<kbd>o</kbd>.
A **bold span that is long enough to be wrapped across the line break should keep its style** all the way.  
That line ended with a hard break.

[repo]: https://github.com/JWE24-code/moqi

## Lists

- First item
- Second item with a longer body that has to wrap onto a second line at narrow widths, to show the hanging indent
  - nested one
    - nested two
- Third

1. Install
2. Configure
   ```sh
   moqi-md README.md
   ```
3. Read

- [x] parse blocks
- [ ] write docs

## Code

```ts
// a comment
export function greet(name: string): string {
  return `hello ${name}` + 42
}
```

```diff
--- a/file
+++ b/file
@@ -1,2 +1,2 @@
-old line
+new line
 context
```

## Quotes

> The unspoken understanding between you and your harness.
> It spans *two* lines.

> [!TIP]
> Press `t` for the outline and `/` to search.

> [!WARNING]
> Mouse reporting is on; hold shift to select text.

## Table

| Key | Action | Notes |
|:----|:------:|------:|
| `j`/`k` | scroll | one line |
| `space` | page down | also `pgdn` |
| `/` | search | smart-case, `n`/`N` to step through every match in the document |

---

### Third level

#### Fourth level

Setext heading
--------------

<p align="center"><img src="logo.png" alt="Moqi logo"></p>

<!-- a comment that should vanish -->

Footnote reference[^1].

[^1]: The footnote text.
