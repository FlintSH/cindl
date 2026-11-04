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
 * React Native's Pressable notes no press. The app's controls are
 * ui/primitives.tsx Press or Button, which note each one (overlay/opener.ts):
 * an overlay a control opens gives focus back to it, and a step that lands
 * later (a save) gives none once the owner pressed something else.
 */
const noBarePressable = {
  meta: {
    type: 'problem',
    docs: {
      description: "Controls are Press or Button, never React Native's Pressable.",
    },
    schema: [],
    messages: {
      bare: 'Use Press or Button (ui/primitives.tsx): they note each press, so focus comes back to the control and a save gives none after another press.',
    },
  },
  create(context) {
    /** Names `react-native` is imported under as a namespace (`import * as RN`). */
    const namespaces = new Set()
    const isPressable = (name) =>
      (name.type === 'Identifier' || name.type === 'JSXIdentifier'
        ? name.name
        : name.value) === 'Pressable'
    return {
      ImportDeclaration(node) {
        if (node.source.value !== 'react-native') return
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportSpecifier' && isPressable(spec.imported))
            context.report({ node: spec, messageId: 'bare' })
          if (spec.type === 'ImportNamespaceSpecifier') namespaces.add(spec.local.name)
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source?.value !== 'react-native') return
        for (const spec of node.specifiers)
          if (isPressable(spec.local)) context.report({ node: spec, messageId: 'bare' })
      },
      'MemberExpression, JSXMemberExpression'(node) {
        const object = node.object
        if (
          (object.type === 'Identifier' || object.type === 'JSXIdentifier') &&
          namespaces.has(object.name) &&
          isPressable(node.property)
        )
          context.report({ node, messageId: 'bare' })
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
