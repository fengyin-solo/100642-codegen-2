// 用 esbuild 把 local-service 及其依赖打包成 CJS，供 verify-laborder.mjs 做规则验证。
import { build } from 'esbuild'

await build({
  entryPoints: ['src/api/local-service.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'scripts/.lab-test-dist/local-service.cjs',
  alias: { '@': new URL('../src/', import.meta.url).pathname },
  logLevel: 'silent',
})
console.log('lab test bundle ready')
