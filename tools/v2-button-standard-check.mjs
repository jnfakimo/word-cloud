import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { systems } from '../web/lib/modules.ts';

const moduleCount = systems.reduce((total, system) => total + system.modules.length, 0);
assert.equal(systems.length, 12, '按鈕規格稽核必須涵蓋 12 大系統');
assert.equal(moduleCount, 58, '按鈕規格稽核必須涵蓋 58 個已登錄路由');

const globals = readFileSync('web/app/globals.css', 'utf8');
const layout = readFileSync('web/app/layout.tsx', 'utf8');
assert.doesNotMatch(globals, /button-standard\.css/, '共用按鈕規格不可重複嵌入 globals.css');
assert.match(layout, /import '\.\/button-standard\.css';/, '根版面必須最後載入共用按鈕規格');

const css = readFileSync('web/app/button-standard.css', 'utf8');
for (const className of ['.primary-btn', '.secondary-btn', '.danger-btn', '.compact']) {
  assert.ok(css.includes(className), `共用按鈕規格缺少 ${className}`);
}
assert.match(css, /min-height:\s*36px/, '標準按鈕高度必須為 36px');
assert.match(css, /padding:\s*8px 13px/, '標準按鈕內距必須為 8px 13px');
assert.match(css, /border-radius:\s*8px/, '標準按鈕圓角必須為 8px');
assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?min-height:\s*40px/, '手機主要按鈕必須提升至 40px');
assert.match(css, /color-mix\(in srgb, var\(--cyan\)/, '按鈕配色必須沿用主題變數');
assert.match(css, /:disabled/, '按鈕必須有停用狀態');

console.log(`V2 共用按鈕規格檢查通過：${systems.length} 大系統、${moduleCount} 個子系統。`);
