// Metro for the Cindl Android app in the pnpm workspace.
//
// expo/metro-config already handles the monorepo: it watches the workspace
// root and resolves pnpm's isolated (symlinked) node_modules, including the
// TypeScript sources that @cindl/* packages export. The only Cindl-specific
// rule: synthetic fixtures resolve to an empty module unless this bundle is
// the labelled demo (EXPO_PUBLIC_CINDL_DEMO=1), so a production APK cannot
// contain demo data even in unreachable code.
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
const demo = process.env.EXPO_PUBLIC_CINDL_DEMO === '1'
const upstreamResolve = config.resolver.resolveRequest

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (!demo && /^@cindl\/fixtures(\/|$)/.test(moduleName)) return { type: 'empty' }
  return (upstreamResolve ?? context.resolveRequest)(context, moduleName, platform)
}

module.exports = config
