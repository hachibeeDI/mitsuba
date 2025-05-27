import path from "node:path";

import {defineConfig} from 'vitest/config';

import baseConf from './tsconfig.base.json';

const alias = Object.entries(baseConf.compilerOptions.paths).reduce((buf, [k, v]) => {
  buf[k] = path.resolve(__dirname, v[0]);
  return buf;
} ,{})

export default defineConfig({
  test: {
    alias,
    globals: true,
    environment: 'node',
    include: ['src/tests/**/*.test.{ts,js}', 'packages/*/src/**/*.test.{ts,js}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/tests/**', 'packages/*/dist/**'],
    },
  },
}); 