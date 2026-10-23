// 建置設定：相對路徑（可部署在任何子路徑），並把版本資訊寫進程式與 version.json。
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const manifest = JSON.parse(readFileSync(new URL('./data/manifest.json', import.meta.url), 'utf8')) as { rulesetVersion: string };

function gitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
}

const build = {
  appVersion: pkg.version,
  commit: process.env.GITHUB_SHA?.slice(0, 7) ?? gitCommit(),
  rulesetVersion: manifest.rulesetVersion,
  builtAt: new Date().toISOString(),
};

/** 產生 version.json，供已開啟的頁面比對是否有新版本 */
function versionFile(): Plugin {
  return {
    name: 'zyad-version-file',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(build, null, 2) });
    },
  };
}

export default defineConfig({
  base: './',
  define: { __BUILD__: JSON.stringify(build) },
  plugins: [versionFile()],
  build: { target: 'es2022', sourcemap: true },
});
