import { defineConfig } from 'tsdown';

const entryKind = process.env['ROSTER_350_CERTIFICATION_BUNDLE'];

if (entryKind !== 'adapter' && entryKind !== 'roster') {
  throw new Error('ROSTER_350_CERTIFICATION_BUNDLE must select adapter or roster.');
}

export default defineConfig({
  entry: entryKind === 'adapter'
    ? { 'host-led-learning-adapter': './host-led-learning-adapter.ts' }
    : { roster: '../../bin/roster.js' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  dts: false,
  shims: false,
  treeshake: true,
  deps: {
    alwaysBundle: [/^(?!node:)/u],
    onlyBundle: false,
  },
  outputOptions: {
    codeSplitting: false,
  },
  outExtensions: () => ({ js: '.mjs' }),
});
