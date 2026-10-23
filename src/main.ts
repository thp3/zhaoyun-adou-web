// M0 暫時入口：只驗證資料可載入並列出數量。M1 會換成應用狀態機。
import { DataError, loadGameData } from './data';

const app = document.getElementById('app')!;
try {
  const data = loadGameData();
  const rows = Object.entries(data.manifest.counts)
    .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
    .join('');
  app.innerHTML = `<h1>趙雲與阿斗</h1><p>規則版本 ${data.manifest.rulesetVersion}，資料已載入。</p><table>${rows}</table>`;
} catch (e) {
  const issues = e instanceof DataError ? e.issues : [String(e)];
  app.innerHTML = `<h1>資料載入失敗</h1><pre>${issues.join('\n')}</pre>`;
}
