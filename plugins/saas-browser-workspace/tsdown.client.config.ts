import { readFile } from 'node:fs/promises'
import { dirname, resolve, relative } from 'node:path'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

const packageName = '@shamcleren/dsh-saas-browser-workspace'
const shared = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-slots'])
const stylesModule = resolve('src/client/styles.ts')
const cssPrefix = '\0saas-css:'
export default {
  entry: { client: 'src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser', target: 'es2022', dts: false, clean: false, sourcemap: true,
  deps: { onlyBundle: false, neverBundle: (id: string) => shared.has(id), alwaysBundle: (id: string) => !shared.has(id) },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [{
    name: 'saas-owned-css-modules',
    resolveId(id, importer) { if (id.endsWith('.module.css') && importer) return cssPrefix + relative(process.cwd(), resolve(dirname(importer), id)) + '.js'; return null },
    async load(id) {
      if (!id.startsWith(cssPrefix)) return null
      const file = resolve(id.slice(cssPrefix.length, -3)); this.addWatchFile(file)
      const result = transform({ filename: relative(process.cwd(), file), code: await readFile(file), minify: true, cssModules: { pattern: 'saas_[hash]_[local]' } })
      const classes = Object.fromEntries(Object.entries(result.exports ?? {}).map(([key, value]) => [key, value.name]))
      return `import { registerImportedStyle } from ${JSON.stringify(stylesModule)}; registerImportedStyle(${JSON.stringify(result.code.toString())}); export default ${JSON.stringify(classes)};`
    },
  }],
  outputOptions: { codeSplitting: false, entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;', footer: 'return module.exports; } });' },
} satisfies UserConfig
