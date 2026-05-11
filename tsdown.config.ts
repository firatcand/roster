import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { roster: 'src/bin/roster.ts' },
  outDir: 'bin',
  format: 'esm',
  target: 'es2022',
  platform: 'node',
  clean: true,
  dts: false,
  shims: true,
  outExtensions: () => ({ js: '.js' }),
});
