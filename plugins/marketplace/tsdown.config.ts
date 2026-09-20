import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

const id = '@shamcleren/dsh-plugin-marketplace'
const external = ['react', 'react/jsx-runtime', 'react-dom']
const cssPrefix = '\0dsh-marketplace-css:'
const cssSuffix = '.mjs'

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: external,
    alwaysBundle: (source: string) => external.includes(source) ? undefined : true,
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  plugins: [{
    name: 'dsh-marketplace-css-modules',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const absolute = importer === undefined ? source : resolvePath(dirname(importer), source)
      return cssPrefix + absolute + cssSuffix
    },
    async load(this: { addWatchFile(file: string): void }, virtualId: string) {
      if (!virtualId.startsWith(cssPrefix)) return null
      const file = virtualId.slice(cssPrefix.length, -cssSuffix.length)
      this.addWatchFile(file)
      const result = transform({
        filename: relative(process.cwd(), file).split('\\').join('/'),
        code: await readFile(file),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
        targets: { chrome: 90 << 16, firefox: 100 << 16, safari: 13 << 16, edge: 90 << 16 },
      })
      const classes: Record<string, string> = {}
      for (const [local, entry] of Object.entries(result.exports ?? {})) classes[local] = entry.name
      const tagId = `${id}/${basename(file)}`
      return [
        `const css = ${JSON.stringify(result.code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
        "  const tag = document.createElement('style');",
        `  tag.dataset.plugin = ${JSON.stringify(id)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classes)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
