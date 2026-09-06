#!/usr/bin/env node
/**
 * V2 開發前資安閘門：檢查提交內容是否出現明顯的機密外洩或危險執行模式。
 * 這是 ISO/IEC 27000 系列的工程前置檢核，不等同第三方驗證或認證。
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const roots = ['web', 'supabase', 'tools'];
const findings = [];
const add = (severity, file, rule, message) => findings.push({ severity, file: path.relative(root, file).replaceAll('\\', '/'), rule, message });

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', 'out', '_site', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (/\.(?:tsx?|jsx?|mjs|css|sql|ya?ml|json)$/i.test(entry.name)) files.push(full);
  }
  return files;
}

for (const relative of roots) {
  for (const file of walk(path.join(root, relative))) {
    const text = fs.readFileSync(file, 'utf8');
    if (/SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*["']eyJ/i.test(text)) add('error', file, '硬編碼服務金鑰', '不可將 service_role JWT 寫入前端或版本庫。');
    if (/-----BEGIN (?:RSA |EC |)PRIVATE KEY-----\s*\r?\n[A-Za-z0-9+/=\r\n]{100,}\r?\n-----END (?:RSA |EC |)PRIVATE KEY-----/.test(text)) add('error', file, '硬編碼私鑰', '私鑰只能透過受控的部署密鑰注入。');
    if (/\beval\s*\(|new\s+Function\s*\(/.test(text)) add('error', file, '動態程式碼執行', '禁止 eval／new Function，避免注入風險。');
    if (/http:\/\/(?!localhost|127\.0\.0\.1|www\.w3\.org)/i.test(text)) add('warning', file, '非加密連線', '確認此 URL 僅限受控的內部設備來源，正式外部服務必須使用 HTTPS。');
    if (/dangerouslySetInnerHTML/.test(text) && !file.endsWith('security-design-audit.mjs')) add('warning', file, 'HTML 注入 API', '確認內容已固定或完成跳脫，並保留 CSP 防線。');
    if (/document\.write\s*\(/.test(text)) add('warning', file, '文件字串輸出', '列印或報表內容必須逐欄跳脫，優先改為 React 列印區塊。');
  }
}

const errors = findings.filter(item => item.severity === 'error');
const warnings = findings.filter(item => item.severity === 'warning');
const modulesFile = path.join(root, 'web', 'lib', 'modules.ts');
if (fs.existsSync(modulesFile)) {
  const registry = fs.readFileSync(modulesFile, 'utf8');
  const systemCount = (registry.match(/code:'SYS-\d+'/g) || []).length;
  const moduleCount = (registry.match(/\bm\(/g) || []).length;
  console.log(`V2 模組盤點：${systemCount} 大系統、${moduleCount} 個子系統`);
  if (systemCount !== 12 || moduleCount !== 58) {
    findings.push({ severity: 'error', file: 'web/lib/modules.ts', rule: '系統拓撲數量', message: 'V2 必須維持 12 大系統、58 個已登錄路由，請同步更新專案設計與權限盤點。' });
  }
}
for (const file of walk(path.join(root, 'web'))) {
  // 這兩支就是規範本身的實作，內部必然出現原生欄位或提及它。
  if (['LocalizedDateInput.tsx', 'LocalizedDateTimeInput.tsx', 'TimeSelect.tsx'].some(name => file.endsWith(name))) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (/type=["']date["']/.test(text)) add('error', file, '原生日期欄位', '可見日期欄位必須使用 LocalizedDateInput，避免瀏覽器顯示 yyyy/月/dd。');
  // 動態切換 type 也算——曾經有欄位寫成 type={cond ? 'date' : 'text'} 而躲過這條規則。
  if (/type=\{[^}]*['"]date['"]/.test(text)) add('error', file, '原生日期欄位', '不得以動態 type 切換成原生日期欄位，一律使用 LocalizedDateInput。');
  // datetime-local 同樣不得直接使用：step=1800 只約束驗證，使用者仍可打出 08:17，
  // 而且空值時瀏覽器會顯示 yyyy/mm/dd --:--。改用 LocalizedDateTimeInput。
  if (/type=["']datetime-local["']/.test(text)) add('error', file, '原生日期時間欄位', '日期時間欄位必須使用 LocalizedDateTimeInput（日期＋30 分鐘級距時間）。');
  if (/type=["']time["']/.test(text)) add('error', file, '原生時間欄位', '時間欄位必須使用 TimeSelect（30 分鐘級距下拉）。');
}
const finalErrors = findings.filter(item => item.severity === 'error');
const finalWarnings = findings.filter(item => item.severity === 'warning');
console.log(`資安設計自我檢核：錯誤 ${finalErrors.length}，警告 ${finalWarnings.length}`);
for (const item of findings) console.log(`[${item.severity === 'error' ? '錯誤' : '警告'}] ${item.file}（${item.rule}）${item.message}`);
if (finalErrors.length) process.exitCode = 1;
