import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const auditor = fileURLToPath(new URL('./commercial-readiness-audit.mjs', import.meta.url));
const head = '<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>驗收</title><meta http-equiv="Content-Security-Policy" content="default-src &apos;self&apos;"></head>';
function audit(markup, extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'inspection-audit-'));
  try {
    const files = { '_site/v2/index.html': head + markup, ...extra };
    for (const [name, value] of Object.entries(files)) {
      const file = path.join(dir, name);
      mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value);
    }
    const result = spawnSync(process.execPath, [auditor], { cwd: dir, encoding: 'utf8' });
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    assert.equal(path.dirname(dir), path.resolve(tmpdir()));
    assert.ok(path.basename(dir).startsWith('inspection-audit-'));
    rmSync(dir, { recursive: true, force: true });
  }
}
test('部署基底網址、中文資源及 CSS 查詢參數均解析至產物', () => {
  const result = audit('<a href="/Inspection/v2/">首頁</a><img src="/Inspection/v2/%E5%9C%96.svg"><link rel="stylesheet" href="theme.css">', {
    '_site/v2/圖.svg': '<svg/>', '_site/v2/theme.css': 'body{background:url(/Inspection/v2/%E5%9C%96.svg?v=1)}',
  });
  assert.equal(result.status, 0, result.output);
});
test('遺漏 CSP 的實際產物仍阻擋發布', () => {
  const result = audit('', { '_site/system/old.html': '<head><meta charset="UTF-8"><meta name="viewport"><title>舊入口</title></head>' });
  assert.equal(result.status, 1); assert.match(result.output, /content-security-policy/);
});
test('缺檔與缺少外部完整性防護仍會失敗', () => {
  const result = audit('<img src="/Inspection/v2/missing.png"><script src="https://example.org/library.js"></script>');
  assert.equal(result.status, 1); assert.match(result.output, /missing-asset/); assert.match(result.output, /script-integrity/);
});
test('不把 hydration 字串中的範例網址當 DOM 資源，仍檢查腳本語法', () => {
  assert.equal(audit('<script>const example=`href="/missing"`;</script>').status, 0);
  assert.equal(audit('<script>const = ;</script>').status, 1);
});
test('V2 頁面及 CSS 資源納入檢查', () => {
  const result = audit('', { '_site/v2/nested/index.html': head+'<a target="_blank" href="#">連結</a>', '_site/v2/theme.css': 'body{background:url(missing.png)}' });
  assert.equal(result.status, 1); assert.match(result.output, /noopener/); assert.match(result.output, /missing-css-asset/);
});
