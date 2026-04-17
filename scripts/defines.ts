import pkg from '../package.json'

export function getMacroDefines(): Record<string, string> {
  return {
    'MACRO.VERSION': JSON.stringify(pkg.version),
    'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
    'MACRO.PACKAGE_URL': JSON.stringify('open-claude-code'),
    'MACRO.NATIVE_PACKAGE_URL': JSON.stringify('open-claude-code'),
    'MACRO.VERSION_CHANGELOG': JSON.stringify(''),
    'MACRO.ISSUES_EXPLAINER': JSON.stringify(
      'file an issue at https://github.com/anthropics/claude-code/issues'
    ),
    'MACRO.FEEDBACK_CHANNEL': JSON.stringify('github'),
  }
}
