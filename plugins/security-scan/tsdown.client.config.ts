import type { UserConfig } from 'tsdown'
const id = '@shamcleren/dsh-security-scan'
const shared = new Set(['react', 'react/jsx-runtime', 'react-dom'])
export default {
  entry: { client: 'src/client/index.ts' }, outDir: 'lib', format: 'cjs', platform: 'browser', target: 'es2022', dts: false, sourcemap: false, clean: false,
  deps: { neverBundle: (name: string) => shared.has(name), alwaysBundle: (name: string) => !shared.has(name) },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  outputOptions: { entryFileNames: 'client.js', banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(id) + ', factory: (require) => {', footer: 'return module.exports; } });', intro: 'var module = { exports: {} }; var exports = module.exports;' },
} satisfies UserConfig
