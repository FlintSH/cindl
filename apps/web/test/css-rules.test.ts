// @vitest-environment node
import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../src/', import.meta.url))
const files = globSync('**/*.css', { cwd: root })

/** Rule blocks (selector + declarations) in a stylesheet, ignoring nesting levels above one. */
function blocks(css: string) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    (m) => ({
      selector: (m[1] ?? '').trim(),
      body: m[2] ?? '',
    }),
  )
}

/** CSS named colours (CSS Color 4), matched as whole words in declaration values. */
const namedColours = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue ' +
    'blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk ' +
    'crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki ' +
    'darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue ' +
    'dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite ' +
    'gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen ' +
    'lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen ' +
    'magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream ' +
    'mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen ' +
    'steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
)

/** Raw colour literals in a declaration block: hex, colour functions and named colours. */
function rawColours(body: string): string[] {
  const found: string[] = []
  for (const declaration of body.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    // Values only, without custom property names such as --color-orange.
    const value = declaration.slice(colon + 1).replace(/--[\w-]+/g, '')
    for (const m of value.matchAll(
      /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix|color)\(/g,
    ))
      found.push(m[0])
    for (const word of value.match(/[A-Za-z]+/g) ?? [])
      if (namedColours.has(word.toLowerCase())) found.push(word)
  }
  return found
}

describe('web stylesheet rules', () => {
  it('finds the stylesheets', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  // Regression: visually hidden (absolutely positioned) helpers inside a scroll
  // container without a containing block were positioned against the page and
  // stretched the document (outer scrollbar, 1423px document in a 795px window).
  it.each(files)('every scroll container in %s is a containing block', (file) => {
    const offenders = blocks(readFileSync(root + file, 'utf8'))
      .filter(
        (b) =>
          /overflow(-x|-y)?\s*:\s*(auto|scroll)/.test(b.body) &&
          !/\bposition\s*:\s*(relative|absolute|fixed|sticky)\b/.test(b.body),
      )
      .map((b) => b.selector)
    expect(offenders).toEqual([])
  })

  it.each(files)('%s uses colour tokens, not raw colour literals', (file) => {
    const raw = blocks(readFileSync(root + file, 'utf8')).flatMap((b) =>
      rawColours(b.body).map((found) => `${b.selector}: ${found}`),
    )
    expect(raw).toEqual([])
  })

  it('recognises every form of raw colour it is meant to reject', () => {
    for (const body of [
      'color: #fff',
      'background: rgb(0 0 0)',
      'border-color: hsl(0 0% 0%)',
      'color: oklch(70% 0.1 30)',
      'background: color-mix(in srgb, var(--color-text), white)',
      'outline: 2px solid red',
      'background-color: RebeccaPurple',
      'color: lab(50% 40 59)',
    ])
      expect(rawColours(body), body).not.toEqual([])
    for (const body of [
      'color: var(--color-text-secondary)',
      'white-space: normal',
      'background: transparent',
      'border-color: currentColor',
      'transition: background-color 120ms ease',
    ])
      expect(rawColours(body), body).toEqual([])
  })
})
