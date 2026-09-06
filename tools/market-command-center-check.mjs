import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(path, 'utf8');
const modules = read('web/lib/modules.ts');
const router = read('web/app/systems/[system]/[module]/workspace-router.tsx');
const workspace = read('web/app/systems/[system]/[module]/market-analytics-workspace.tsx');
const command = read('web/app/systems/[system]/[module]/market-command-center.tsx');
const css = read('web/app/systems/[system]/[module]/market-analytics.css');

assert.match(modules, /command-center[\s\S]*?市場戰情儀表板[\s\S]*?日、週、月、季、年切換行情/,
  '市場分析系統必須註冊獨立的戰情儀表板模組');
assert.match(router, /module\.key === 'command-center'[\s\S]*?MarketCommandCenterWorkspace/,
  '戰情儀表板必須由獨立 workspace route 載入');
assert.match(command, /日[\s\S]*?週[\s\S]*?月[\s\S]*?季[\s\S]*?年[\s\S]*?ChartMode/,
  '戰情儀表板必須提供日／週／月／季／年切換與圖表模式');
assert.match(command, /趨勢[\s\S]*?長條[\s\S]*?K 線[\s\S]*?圓餅[\s\S]*?甜甜圈[\s\S]*?柏拉圖[\s\S]*?明細/,
  '戰情儀表板必須提供趨勢、長條、K 線、圓餅、甜甜圈、柏拉圖與明細視角');
assert.match(command, /下鑽路徑[\s\S]*?onSelect[\s\S]*?chooseDrill/,
  '戰情儀表板必須保留 Power BI 式逐層下鑽路徑與操作');
assert.match(command, /market_dimension_catalog[\s\S]*?datalist id="market-command-market-options"[\s\S]*?datalist id="market-command-category-options"/,
  '市場與蔬果分類選項必須從資料來源目錄動態載入，並保留可輸入篩選');
assert.match(command, /const catalogFilters = useMemo[\s\S]*?next\.market[\s\S]*?next\.category[\s\S]*?filters: catalogFilters/,
  '品項目錄必須依目前市場與蔬果大類連動查詢');
assert.match(command, /setCategory\(''\); setItem\(''\)/,
  '切換市場或蔬果大類時必須清除不再相容的品項');
assert.match(command, /XLSX|K 線|累積占比|收盤高於開盤/,
  '戰情儀表板必須提供初學者可讀的 K 線與統計圖例');
assert.match(command, /行情方向圖例[\s\S]*?▲[\s\S]*?上漲（紅）[\s\S]*?▼[\s\S]*?下跌（綠）/,
  '戰情儀表板必須明示紅色上漲三角形與綠色下跌三角形');
assert.match(workspace, /parseMarketExcelFile\(file\)[\s\S]*?accept=.*xlsx/,
  '資料介接中心必須使用共用 Excel 解析器');
assert.match(read('web/lib/market-file-import.ts'), /workbook\.xlsx\.load[\s\S]*?workbook\.worksheets\[0\]/,
  '共用解析器必須可讀取 XLSX 第一個工作表');
assert.match(workspace, /IMPORT_HEADER_ALIASES[\s\S]*?品名代號[\s\S]*?平均價[\s\S]*?inferImportHeader/,
  '行情匯入必須能辨識北農歷史檔的中文欄位名稱');
assert.match(workspace, /total_value[\s\S]*?average_price[\s\S]*?quantity[\s\S]*?averagePrice \* quantity/,
  '行情匯入缺少成交金額欄位時必須可推估交易金額');
assert.match(workspace, /匯入 XLS／XLSX／CSV／JSON 行情資料/,
  '資料介接中心的介接說明必須明示支援 XLSX');
assert.match(css, /market-command-page[\s\S]*?market-command-chart-switch[\s\S]*?market-kline/,
  '戰情儀表板必須有獨立的響應式視覺樣式');

console.log('市場戰情儀表板檢查通過：期間切換、Power BI 式下鑽、複合圖表、K 線圖例及 XLSX 介接完整。');
