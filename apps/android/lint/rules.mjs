// Android-only lint rules (plugin `cindl-android`). They are rules of their
// own, not more options for the root's rules: a config block that set a root
// rule's options would replace the root's list for its files, because ESLint
// does not merge rule options.

/** Persistent storage modules. Only src/platform opens them (AGENTS.md invariant 3). */
const STORAGE_MODULE =
  /^(?:@react-native-async-storage\/async-storage|expo-secure-store|expo-file-system|expo-sqlite)(?:\/|$)/

const storageInPlatform = {
  meta: {
    type: 'problem',
    docs: { description: 'Storage modules are imported only in src/platform.' },
    schema: [],
    messages: {
      storage:
        "'{{name}}' stores data on the device: use it only in src/platform (secretStore.ts for secrets, storage.ts for everything else).",
    },
  },
  create(context) {
    const check = (source) => {
      if (
        source?.type === 'Literal' &&
        typeof source.value === 'string' &&
        STORAGE_MODULE.test(source.value)
      )
        context.report({
          node: source,
          messageId: 'storage',
          data: { name: source.value },
        })
    }
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      TSImportType: (node) => check(node.source),
      TSImportEqualsDeclaration: (node) => check(node.moduleReference.expression),
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require')
          check(node.arguments[0])
      },
    }
  },
}

const HEX_COLOUR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const COLOUR_FUNCTION = /\b(?:rgb|hsl)a?\(/i

const noRawColour = {
  meta: {
    type: 'problem',
    docs: { description: 'Colours come from the theme, never as literals.' },
    schema: [],
    messages: {
      raw: 'Use semantic colours from useTheme(); raw colours live in @cindl/tokens.',
    },
  },
  create(context) {
    const check = (node, text) => {
      if (
        typeof text === 'string' &&
        (HEX_COLOUR.test(text.trim()) || COLOUR_FUNCTION.test(text))
      )
        context.report({ node, messageId: 'raw' })
    }
    return {
      Literal: (node) => check(node, node.value),
      TemplateElement: (node) => check(node, node.value.cooked),
    }
  },
}

const DOM_GLOBALS = new Set(['document', 'window'])

/** React Native has no DOM: `document` and `window` are undefined there. */
const noDomGlobals = {
  meta: {
    type: 'problem',
    docs: { description: 'No DOM globals in React Native code.' },
    schema: [],
    messages: { dom: "React Native has no DOM: '{{name}}' is undefined in the app." },
  },
  create(context) {
    return {
      Program(node) {
        const scope = context.sourceCode.getScope(node)
        const report = (reference) =>
          context.report({
            node: reference.identifier,
            messageId: 'dom',
            data: { name: reference.identifier.name },
          })
        // Globals the configuration declares (DOM typings, `globals.browser`)...
        for (const variable of scope.variables)
          if (variable.defs.length === 0 && DOM_GLOBALS.has(variable.name))
            variable.references.forEach(report)
        // ...and names no scope declares.
        for (const reference of scope.through)
          if (DOM_GLOBALS.has(reference.identifier.name)) report(reference)
      },
    }
  },
}

/**
 * React Native's own pressables note no press. The app's controls are built on
 * ui/Press.tsx (Button and Row are), which notes each one (overlay/opener.ts):
 * an overlay a control opens gives focus back to it, and a step that lands
 * later (a save) gives none once the owner pressed something else. Only the
 * files the `builtOn` option names (Press itself, an overlay's scrim) may use
 * Pressable, and none may pass it on.
 */
const PRESSABLES = new Set([
  'Pressable',
  'Button',
  'TouchableHighlight',
  'TouchableNativeFeedback',
  'TouchableOpacity',
  'TouchableWithoutFeedback',
])

const noBarePressable = {
  meta: {
    type: 'problem',
    docs: {
      description: "Controls are built on Press, never on React Native's own pressables.",
    },
    schema: [
      {
        type: 'object',
        properties: { builtOn: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    ],
    messages: {
      bare: "Use Press, Button or Row (ui/), not React Native's {{name}}: they note each press, so focus comes back to the control and a save gives none after another press.",
      passed: '{{name}} is not passed on: controls are built on Press (ui/Press.tsx).',
    },
  },
  create(context) {
    const builtOn = (context.options[0]?.builtOn ?? []).some((file) =>
      context.filename.replaceAll('\\', '/').endsWith(`/${file}`),
    )
    /** Names `react-native` is imported under as a whole (`import * as RN`, `import RN`). */
    const wholes = new Set()
    /** Local names of a Pressable this file may use (builtOn files only). */
    const used = new Set()
    const nameOf = (node) =>
      node.type === 'Identifier' || node.type === 'JSXIdentifier' ? node.name : node.value
    const bare = (node, name) =>
      context.report({ node, messageId: 'bare', data: { name } })
    return {
      ImportDeclaration(node) {
        if (node.source.value !== 'react-native' || node.importKind === 'type') return
        for (const spec of node.specifiers) {
          if (spec.type !== 'ImportSpecifier') {
            wholes.add(spec.local.name)
            continue
          }
          const name = nameOf(spec.imported)
          if (spec.importKind === 'type' || !PRESSABLES.has(name)) continue
          if (builtOn && name === 'Pressable') used.add(spec.local.name)
          else bare(spec, name)
        }
      },
      ExportNamedDeclaration(node) {
        if (node.exportKind === 'type') return
        for (const spec of node.specifiers) {
          if (spec.exportKind === 'type') continue
          const name = nameOf(spec.local)
          if (node.source?.value === 'react-native' && PRESSABLES.has(name))
            context.report({ node: spec, messageId: 'passed', data: { name } })
          else if (!node.source && used.has(name))
            context.report({ node: spec, messageId: 'passed', data: { name } })
        }
      },
      ExportAllDeclaration(node) {
        if (node.source.value === 'react-native' && node.exportKind !== 'type')
          context.report({ node, messageId: 'passed', data: { name: 'react-native' } })
      },
      'MemberExpression, JSXMemberExpression'(node) {
        const object = node.object
        const name = nameOf(node.property)
        if (
          (object.type === 'Identifier' || object.type === 'JSXIdentifier') &&
          wholes.has(object.name) &&
          PRESSABLES.has(name)
        )
          bare(node, name)
      },
      VariableDeclarator(node) {
        if (
          node.id.type !== 'ObjectPattern' ||
          node.init?.type !== 'Identifier' ||
          !wholes.has(node.init.name)
        )
          return
        for (const property of node.id.properties)
          if (property.type === 'Property' && PRESSABLES.has(nameOf(property.key)))
            bare(property, nameOf(property.key))
      },
    }
  },
}

export default {
  meta: { name: 'cindl-android' },
  rules: {
    'storage-in-platform': storageInPlatform,
    'no-raw-colour': noRawColour,
    'no-dom-globals': noDomGlobals,
    'no-bare-pressable': noBarePressable,
  },
}
