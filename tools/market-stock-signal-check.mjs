import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const movement = readFileSync('web/lib/market-movement.ts', 'utf8');
const badge = readFileSync('web/components/MarketMovementBadge.tsx', 'utf8');
const workspace = readFileSync('web/app/systems/[system]/[module]/market-analytics-workspace.tsx', 'utf8');
const marketCss = readFileSync('web/app/systems/[system]/[module]/market-analytics.css', 'utf8');
const dashboard = readFileSync('web/components/MarketExecutiveBoard.tsx', 'utf8');
const boardPage = readFileSync('web/app/board/page.tsx', 'utf8');
const dashboardCss = readFileSync('web/app/dashboard.css', 'utf8');

assert.match(movement, /numeric === null \|\| !Number\.isFinite\(numeric\)[\s\S]*?tone: 'neutral'[\s\S]*?label: '無比較基準'/,
  '共用行情方向 helper 必須把缺值與非有限數標為無比較基準，不能偽裝為零');
assert.match(movement, /Math\.abs\(numeric\) < \.05[\s\S]*?tone: 'steady'[\s\S]*?symbol: '—'[\s\S]*?label: '持平'/,
  '共用行情方向 helper 必須把零與極小差異標為持平');
assert.match(movement, /const rise = numeric > 0[\s\S]*?const symbol = rise \? '▲' : '▼'[\s\S]*?const label = rise \? '上漲' : '下跌'[\s\S]*?tone: rise \? 'rise' : 'fall'/,
  '共用行情方向 helper 必須統一正值為紅漲 ▲、負值為綠跌 ▼ 的語意');
assert.match(badge, /marketMovementPresentation\(value\)[\s\S]*?market-movement-badge[\s\S]*?aria-label=\{movement\.ariaLabel\}[\s\S]*?aria-hidden="true"/,
  '行情方向徽章必須重用共用 helper，並以可讀標籤補足不能只靠顏色辨識的語意');

assert.match(workspace, /market-stock-legend market-stock-legend-compact[\s\S]*?data-direction="rise"[\s\S]*?▲[\s\S]*?上漲（紅）[\s\S]*?data-direction="fall"[\s\S]*?▼[\s\S]*?下跌（綠）/,
  '市場分析頁必須有可見的臺股式紅 ▲ 上漲／綠 ▼ 下跌圖例');
assert.match(boardPage, /<MarketExecutiveBoard/,
  '市場公開看板必須載入共用行情看板');
assert.match(dashboard, /market-board-legend[\s\S]*?▲[\s\S]*?上漲（紅）[\s\S]*?▼[\s\S]*?下跌（綠）[\s\S]*?非漲停／跌停/,
  '現行行情看板必須有可見的紅 ▲ 上漲／綠 ▼ 下跌圖例及非漲跌停說明');

assert.match(workspace, /label: '本期每日行情（實線）'/,
  '每日行情趨勢必須明示本期使用實線');
assert.match(workspace, /label: '比較期每日行情（虛線）'[\s\S]*?borderDash: \[7, 5\]/,
  '每日行情趨勢必須明示比較期使用虛線，不能只靠顏色區分期間');
assert.match(workspace, /const validCurrentIndices =[\s\S]*?Math\.ceil\(validCurrentIndices\.length \/ 45\)[\s\S]*?visiblePointIndices[\s\S]*?pointRadius: pointRadii/,
  '長期間行情仍須抽樣保留紅漲綠跌資料點，不能因超過 90 日全部隱藏');
assert.match(workspace, /legend: \{ display: false \}[\s\S]*?data-series="current"[\s\S]*?本期（實線）[\s\S]*?data-series="comparison"[\s\S]*?比較期（虛線）/,
  '期間線型必須用外部圖例明示，不能讓 Chart.js 的方向資料點冒充系列線型圖例');
assert.match(workspace, /current: colors\[0\][\s\S]*?comparison: colors\[1 % colors\.length\][\s\S]*?--market-current-color': palette\.current[\s\S]*?--market-compare-color': palette\.comparison/,
  '每日趨勢與外部線型圖例必須同步套用使用者選擇的圖表色卡');
assert.match(workspace, /x: \{[\s\S]*?title: \{ display: true, text: '本期日期'/,
  '每日行情趨勢必須顯示 X 軸日期標題');
assert.match(workspace, /y: \{[\s\S]*?title: \{ display: true, text: `\$\{field\?\.label \|\| measure\}[\s\S]*?color: palette\.dim/,
  '每日行情趨勢必須顯示動態 Y 軸指標與單位標題');
assert.match(workspace, /本期實線、比較期虛線；紅色向上三角形代表本期高於比較期，綠色向下三角形代表本期低於比較期/,
  '趨勢圖無障礙名稱必須同時說明期間線型與紅漲綠跌符號');
assert.match(workspace, /market-chart-summary market-trend-summary[\s\S]*?<summary>查看每日行情、比較日期與漲跌差異<\/summary>[\s\S]*?<th>本期日期<\/th><th>比較期日期<\/th>[\s\S]*?point\.compare_observed_on \|\| '—'[\s\S]*?<MarketMovementBadge value=\{percent\}/,
  '趨勢圖必須提供可展開的本期／比較日期與完整數值表，並保留方向文字替代');

assert.match(marketCss, /--market-rise-color:var\(--red\);--market-fall-color:var\(--green\)/,
  '市場分析頁的語意色必須固定為紅漲、綠跌');
assert.match(marketCss, /--market-fall-readable:color-mix\(in srgb,var\(--market-fall-color\) 68%,var\(--text\)\)/,
  '綠色下跌符號必須使用主題感知的可讀色，確保淺色版文字對比');
assert.match(marketCss, /--market-rise-readable:color-mix\(in srgb,var\(--market-rise-color\) 72%,var\(--text\)\)/,
  '紅色上漲符號也必須使用主題感知的可讀色，確保淡色卡片上的文字對比');
assert.match(marketCss, /\[data-direction=rise\] i\{color:var\(--market-rise-readable\)\}[\s\S]*?\[data-direction=fall\] i\{color:var\(--market-fall-readable\)\}/,
  '市場分析頁圖例的紅 ▲／綠 ▼ 必須跟隨共用語意色');
assert.match(marketCss, /progress\.rise::-(?:webkit-progress-value|moz-progress-bar)\{background:var\(--market-rise-color\)\}[\s\S]*?progress\.fall::-(?:webkit-progress-value|moz-progress-bar)\{background:var\(--market-fall-color\)\}/,
  '行情變動進度條也必須維持紅漲、綠跌');
assert.match(dashboardCss, /--market-rise-color:var\(--red\);--market-fall-color:var\(--green\)/,
  '中央戰情儀表板必須自行載入紅漲、綠跌語意色，不能依賴市場分析頁的局部 CSS');
assert.match(dashboardCss, /\.dash-market-stock-legend/,
  '中央戰情儀表板的可見股票式圖例必須有對應版型');
assert.match(dashboardCss, /\.market-movement-badge[\s\S]*?\.market-movement-badge\.rise \.market-movement-glyph\{color:var\(--market-rise-readable\)\}[\s\S]*?\.market-movement-badge\.fall \.market-movement-glyph\{color:var\(--market-fall-readable\)\}/,
  '中央戰情儀表板必須替共用方向徽章提供紅 ▲、綠 ▼ 樣式');

console.log('市場行情股票式差異檢查通過：共用方向語意、雙頁圖例、趨勢線型與座標軸、比較日期表及紅漲綠跌樣式完整。');
