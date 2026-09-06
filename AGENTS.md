# AGENTS.md — 臺北農產 巡檢/報修/派工系統

> Instructions for AI coding agents (OpenCode, etc.) working in this repo.
> Human setup lives in `README.md`; deeper context in `PROJECT_CONTEXT.md`.

## What this is
A web-based **equipment inspection / repair / dispatch / maintenance** system for
臺北農產運銷股份有限公司 第一果菜市場, plus floor-plan (2D) and stacked-floor (3D)
viewers with a marker layer. **No build step** — every page is a standalone
static HTML file that loads libraries from CDNs and talks directly to Supabase.

## Tech stack
- **Frontend**: plain multi-page HTML/CSS/JS (no framework, no bundler). Each
  `system/*.html` is self-contained.
- **Backend**: Supabase (PostgreSQL + PostgREST REST + Auth + Storage), accessed
  from the browser with the **anon key** (already embedded in each HTML file).
  Project ref: `qztffronusdhgxhjjubt`.
- **Libraries via CDN**: `@supabase/supabase-js@2`, OpenSeadragon 4.1 (2D deep-zoom),
  Three.js r128 (3D), SheetJS `xlsx@0.18.5` (XLSX/CSV), Chart.js, qrcodejs.
- **Hosting**: GitHub Pages, auto-deployed from the `main` branch.
  Base URL: `https://jnfakimo.github.io/word-cloud/system/<page>.html`

## Repo layout
```
index.html              # root: redirects to system/index.html
PROJECT_CONTEXT.md      # full architecture / onboarding notes
system/*.html           # the actual application pages (see table below)
system/sql/*.sql        # Supabase schema — idempotent, run in SQL Editor
system/plans/*          # LIVE floor-plan assets (DZI tiles + textures) — do NOT delete
supabase/functions/     # edge function (LINE notify)
supabase/templates/     # 認證信件的繁中範本（見該目錄 README；**不要**跑 config push）
```

### Key pages (`system/`)
`index.html` portal · `login.html` · `app.html` inspection · `admin.html` back-office
· `dashboard.html` · `workorder.html` repair/dispatch · `materials.html` Material
Master · `arealist.html` floor-space table · `b1_integrated_marker_system.html`
marker editor · `b1plan.html` 2D plan · `floor3d.html` 3D floors · `modeler.html`
DXF→plan/3D · `handover.html` shift handover · `analytics.html` · `rbac.html`.

## How to run / verify
- **Run**: it's static. Open any `system/*.html` in a browser, or serve the repo
  root (`python3 -m http.server`) and browse to `/system/...`. No install/build.
- **Verify JS**: this repo has no test suite. Sanity-check a page's inline script
  with Node before committing:
  ```
  node -e "const fs=require('fs');const h=fs.readFileSync('system/PAGE.html','utf8');const p=h.split('<script>');require('vm').compileFunction(p[p.length-1].split('</script>')[0])"
  ```
- **Deploy check**: pushing to `main` triggers the `pages build and deployment`
  workflow. The live site is CDN-cached — append `?v=<n>` to a URL to bypass cache.

## Database
All schema is in `system/sql/` and is **idempotent** (`create table if not exists`,
`add column if not exists`, `drop policy if exists` before create). To provision a
fresh Supabase project, run in the SQL Editor in this order:
`schema.sql` → `locations_schema.sql` → `work_order_schema.sql` → `floor_models.sql`
→ `handover_schema.sql` → `floor_spaces.sql` → `plan_markers.sql` → `material_master.sql`
→ `equipment_lifecycle.sql` → `patrol_shifts.sql` → `checkin_logs.sql` → `dashboard_layouts.sql` → `market_analytics.sql` → `system_access_seed.sql`
→ `audit_login_events.sql` → `meeting_rooms.sql` → `meeting_booking_change_requests.sql` → `meeting_booking_notifications.sql`
→ `rls_hardening.sql` → `rls_hardening_login_fix.sql`
→ `supabase/migrations/20260806020000_full_commercial_hardening.sql`
→ `supabase/migrations/20260806023000_atomic_repair_completion.sql`
→ `supabase/migrations/20260806024000_query_performance.sql`
→ `supabase/migrations/20260806025000_disable_insecure_error_threshold_cron.sql`
→ `supabase/migrations/20260806026000_client_error_monitoring.sql`
→ `supabase/migrations/20260806027000_permission_fallback_alignment.sql`
→ `supabase/migrations/20260806028000_workorder_equipment_scope.sql`
→ `supabase/migrations/20260806029000_workorder_close_sign_scope.sql`
→ `supabase/migrations/20260806030000_floorplan_storage_scope.sql`
→ `supabase/migrations/20260806031000_notification_log_scope.sql`
→ `supabase/migrations/20260806032000_disable_email_lookup_rpc.sql`
→ `system/sql/pii_deidentify.sql` → `permanent_data_protection.sql`.
`permanent_data_protection.sql` must be applied last. Production data is append/update/
deactivate only: never reset the database, truncate tables, or physically delete personnel.
RLS is enforced in production. Bootstrap `allow_all_for_now` policies apply only to
`authenticated`; the commercial hardening migrations replace them with row-scoped
rules. Storage buckets: `floorplans`, `repair-files`, `handover-attachments`,
`vehicle-dispatch-files` (all private), plus `inspection-photos`, which is **public**
and currently empty — anything uploaded there is anonymously readable.

**Backups** (verified 2026-09-06): the cloud organization now shows Pro and the
Dashboard lists seven daily physical backups; PITR is not enabled. Platform
backups do not include Storage objects. `trg_prevent_removal` only stops
DELETE/TRUNCATE — it does not protect against a bad UPDATE.
`.github/workflows/database-backup.yml` dumps every `public` table plus Storage nightly
and uploads it AES256-encrypted, because this repo is public and artifacts are world-
readable. Restoring is manual, dry-run unless `--execute`, and never deletes rows.
**Auth accounts are deliberately out of scope** — after a full restore nobody can log in
until an admin recreates them. Full procedure: `docs/DATABASE_BACKUP_RECOVERY.md`.

## Conventions (follow these)
- **Match the surrounding style**: cyberpunk dark theme. Core vars: `--bg:#020b18`,
  `--cyan:#00d4ff`, `--green:#00ff9d`, `--amber:#ffb300`, `--red:#ff3b3b`; fonts
  Noto Sans TC + Rajdhani. UI text is Traditional Chinese.
- **Never hardcode a colour that carries text — there is no light-theme safety net.**
  V2 defaults to the **light** theme (`data-theme="light"`; the dark one is `"tech"`).
  `v1-layout.css` used to whitelist every class that needed flipping to a white
  background, but that list silently missed each new component, so on 2026-08-18 it
  was removed on the premise that components derive their colours from theme vars.
  **That premise is now load-bearing**: a hardcoded dark background added afterwards
  has nothing to catch it and renders dark-on-dark in the default theme.
  - Backgrounds: `var(--panel)` / `var(--panel2)` / `var(--bg)`. For a tint, use
    `color-mix(in srgb, var(--cyan) 8%, transparent)` — never a raw `rgba()` of the
    dark palette. Low-alpha accent tints (≤0.15) over a themed surface are fine.
  - Legitimate exceptions, all of which already exist: modal backdrops (a dark scrim
    is correct in both themes), blocks whose background **and** text colour are
    hardcoded together as a pair (e.g. the `<pre>` in `.admin-modal`), and viewer
    canvases that hold no text (`.plan-stage`, `.floor-canvas`).
  - Before pushing a style change, load the page with `data-theme="light"` and check
    text contrast is ≥ 4.5:1. This has already regressed once: `.dash-widget` was
    fixed on 08-18, had `rgba(2,11,24,0.7)` put back on 08-19 by a different agent,
    and shipped at 1.84:1 on the post-login landing page until it was caught.
- **Date inputs**: unified format is 西元 `YYYY-MM-DD` (datetime `YYYY-MM-DD HH:mm`);
  forms show a 填表日期 (today). Use the local `fmtDate()`/`todayISO()` helpers.
  **Always render date fields with `@/components/LocalizedDateInput`, never a bare
  `<input type="date">`** (and never hand-roll a text↔date type swap). An empty native
  date field is painted with the browser's own format hint, which in a Traditional Chinese
  environment comes out as the mixed 「yyyy/月/dd」. `LocalizedDateInput` shows 「年/月/日」
  while empty and only opens the native calendar on focus, so every date field looks the
  same on every machine. Date+time fields use `@/components/LocalizedDateTimeInput`
  (LocalizedDateInput + TimeSelect, emitting the same `YYYY-MM-DDTHH:mm` value), never
  `<input type="datetime-local">` — its `step="1800"` only constrained validation, so
  users could still type 08:17. `security:audit` now fails the build on native `date`,
  `datetime-local` and `time` inputs, including a dynamic `type={cond ? 'date' : 'text'}`
  swap, which is how one of these slipped through before.
- **Every user-facing string is Traditional Chinese.** Status codes, action codes and
  enum values are stored in English (`create`, `closed`, `pending`, …) but must never
  reach the screen raw — map them through a `Record<string, string>` label table next
  to the component, the way `ACTION_LABELS` in `AuditAdminV2.tsx` and
  `CASE_LOG_ACTION_LABELS` in `handover-workspace.tsx` do, and fall back to the raw
  value only so an unmapped code still shows something. This includes timeline entries,
  table cells, filter dropdowns and toast messages.
  Database column names must not appear in prose either — write 「已綁定場域位置」,
  not 「有填 location_id」. Identifiers belong in code and comments, not on screen.
- **The repair-request stat cards have one definition.** `repairRequestSummary()` in
  `supabase/functions/app-api/index.ts` feeds both the 報修案件 table page (`workorder_list`)
  and the 維修／派工／完工 system hub (`module_data`). Add or change a card there and both
  pages follow; never add one in a component. Before this, each side computed its own
  「top 3 statuses」 and the front end spliced in an extra card, so the two pages showed
  different cards from the same data — and the set silently changed as the data changed.
- **Shared V2 button standard (9 systems／49 modules)**: use `.primary-btn` for the main
  action, `.secondary-btn` for neutral or return actions, and `.danger-btn` for destructive
  or deactivation actions; append `.compact` when a dense table or toolbar needs the smaller
  variant. The aliases `.btn`, `.btn-primary`, and `.btn-danger` are kept aligned for legacy
  module code. Geometry, hover, disabled, focus, and light／tech theme colors are centralized
  in `web/app/button-standard.css` (loaded last by the root `layout.tsx`); do not create a new one-off
  button size or hardcoded text color for a matching action.
- **Time inputs**: always use `@/components/TimeSelect` (a 30-minute-step `<select>`),
  never `<input type="time">`. The native field's `step` only constrains validation,
  so users can still type 08:17, and its rendering (上午/下午 vs 24-hour) is decided by
  the browser locale, which made the same system look different on different machines.
  `TimeSelect` emits 24-hour `HH:mm`, matching the tables and the DB `time` columns, and
  keeps an off-step legacy value as an extra option so editing another field can't erase it.
- **Table Filters / Dropdowns**: Whenever creating a filter dropdown in a table header, use a combobox design (`<input list="..."><datalist>`) rather than a native `<select>`. This allows users to type to filter while providing a dropdown list. Ensure the `<option>` values in the datalist use the localized display labels (e.g. `緊急` instead of `urgent`), and update the filtering logic to match against labels so the UI shows Traditional Chinese properly.
- **Floor naming differs between systems**: area/material data may use `B1F`,
  while plan/3D use `B1`. Reconcile with a `canonicalFloor()` (B1≈B1F, 1F≈1, RF≈頂樓).
- **New/changed DB columns**: `create table if not exists` won't alter an existing
  table — always add a matching `alter table … add column if not exists`.
- **Adding a page**: give it the shared navbar/topbar, the Supabase init block, and
  cross-links consistent with sibling pages. Every page must load `system/theme.js`;
  its shared system-meta component must be visible at the top and show connectivity,
  the signed-in user's `department unit | name`, and Asia/Taipei time in
  `YYYY-MM-DD HH:mm:ss` format. Use the shared component and session profile fields;
  do not create a second, page-specific user/status/clock format. The component must
  sit at the far right of the page header in this exact order: user, connectivity,
  clock.
- **Shared header actions**: V2 一般內容頁（共 12 大系統的 53 個子系統）頂列只保留三個
  帳號／入口動作：首頁、個人資料、登出；移除戰情儀表板、維修／派完工、駐衛警巡檢、
  電子交接簿與後台等跨系統按鈕，系統切換改由入口頁、系統頁與後台側欄承擔。
  首頁使用 `assets/system-icons/home-nav-icon.png`，個人資料使用
  `assets/system-icons/profile-nav-icon.png`，兩者為同一套生圖的藍／青色立體 ICON；
  登出維持文字按鈕。不可再以 emoji 或文字符號建立另一套。三個全螢幕圖資工具頁
  （3D 模型圖、平面／整合標記、立體巡檢雲臺）保留其必要的圖資工作連結，不加入
  一般頁的跨系統導覽列。此為使用者明確指定的新頂列標準；若未來要變更，需再次取得
  使用者明確要求。
- **Shared brand bar** (added 2026-08-04, unified per owner request): the far-left
  of the header must read `■ TAIPEC-MKT-1 <頁面名稱> 臺北農產公司／第一果菜市場`. This is
  built automatically by `installBrandBar()`/`applyBrandNames()` in `theme.js` — do
  **not** hand-write it into new pages. To get the page name right:
  - If the page already has `<div class="nav-title">頁面名稱</div>` inside its
    `.navbar`/`.topbar` (the existing convention on most pages), theme.js reuses that
    text automatically — nothing else to do.
  - Pages without a `.nav-title` (currently only `admin.html`) fall back to a
    hardcoded `'後台'` in `pageBrandLabel()`; any other page without `.nav-title` falls
    back to the text before the first `—`/`-` in `<title>`.
  - `admin.html`/`handover.html` still ship their own literal `.topbar-left` markup
    from before this change — theme.js finds and overwrites it at runtime, so the two
    versions can look out of sync only if you read the HTML source, not in the browser.
  - Org/site name (`臺北農產公司`／`第一果菜市場`) comes from `system_settings`
    (`org_name`/`site_name`) via `applyBrandNames()`, applied to every
    `[data-sysname="org"]`/`[data-sysname="site"]` element on the page — reuse those
    same `data-sysname` attributes if a page needs to show the org/site name elsewhere.
  - Pages using a fixed `#topbar` icon-only toolbar (`b1plan.html`, `floor3d.html`,
    `b1_integrated_marker_system.html`, `guardpatrol3d.html`) and the entry pages
    (`index.html`, `login.html`, `app.html`, `materials.html`) intentionally do **not**
    get the brand bar — the toolbar is too narrow and the entry pages have their own
    branding. Don't force it onto these without an explicit request.
  - **Exception, requested 2026-08-21**: V2 的 3D 模型圖
    (`/v2/systems/structuremap/floor3d/`) 的頂列**要**掛共用的六個動作，比照
    3D建模系統 (`/v2/systems/structuremap/modeler/`)。動作定義取自
    `web/lib/shared-actions.ts`（AppShell 用的是同一份）。這是使用者明確要求，
    不是誤把 V2 頁面當成 V1 的 `floor3d.html`——**請勿再以「全螢幕工具頁不掛導覽」
    為由還原**。V1 的 `floor3d.html` 不在此例外內，維持不掛。

## V2 系統子頁標題規範（2026-08-27 訂）

- 12 大系統、53 個子系統的一般內容頁一律由 `AppShell` 自動插入
  `components/SystemPageHeader.tsx`，不得在工作區再手寫另一個系統級 `<h1>`。
- 標題頂端距共用頂列底部固定 **22px**；桌面版由 `.content.v1-content` 的 20px
  上內距加標題元件 2px 上內距構成，手機版則為 14px + 8px。不要用負 margin 或頁面
  專用覆蓋改變這個距離。
- 系統標題固定 **26px**、`var(--cyan)`；Logo 固定 **42×42px**，來源必須是
  `web/lib/modules.ts` 該系統的 `icon`，不可用 emoji、臨時圖示或子系統自行指定的替代圖。
- 桌面內容區左右內距固定 **24px**，標題元件不得再加水平 padding；因此未觸發
  `max-width` 置中時，Logo 左緣距視窗 24px，標題文字左緣為 **80px**（24 + 42 + 14px
  gap）。手機內容區左右內距 14px，標題文字左緣為 70px。日後新增一般內容頁沿用
  `.content.v1-content` 與 `SystemPageHeader`，不得以頁面專用 margin 改變此對齊。
- 標題結構固定為：系統名稱、系統代碼／子系統名稱、子系統說明。子系統自己的功能區
  標題只能使用 `<h2>` 以下，不得再與共用系統標題競爭。
- 三個全螢幕圖資工具頁是版型例外：`structuremap/floor2d`、`structuremap/floor3d`、
  `guardpatrol/map3d`。它們不套 AppShell，使用 `data-system-page-heading="compact"` 的
  緊湊頂列標題，但仍必須顯示對應系統 Logo、主題色與模組名稱。
- **交接紀錄首頁例外（2026-08-27 使用者指定）**：`/v2/systems/handover/` 直接呈現
  `records` 模組，大標題使用「交接紀錄」，識別行顯示「SYS-04 · 電子交接簿」；距離、
  字級、顏色與 Logo 尺寸仍完全沿用 `SystemPageHeader`，不可另寫一套樣式。
- **駐衛警系統入口（2026-08-27 使用者指定）**：`/v2/systems/guardpatrol/` 使用共用
  標題，說明固定取系統定義「巡邏點、打卡、排班、逾時通知與立體巡檢。」；四張功能
  縮放時四張桌面功能圖卡固定為 **269px × 200px** 並置中。瀏覽器縮放造成可用 CSS
  寬度改變時必須自動響應：寬版 4 欄、1100px 以下 2 欄並恢復滿寬、600px 以下 1 欄，
  禁止水平溢出。
- 新增／修改系統子頁後必須執行 `npm run test:page-headings`；此檢查固定盤點 10／53、
  正式 Logo、標題 token，以及 49 個一般頁首與 3 個全螢幕頁首的覆蓋關係。

- **53 個子系統圖卡（2026-08-27 使用者指定）**：一般 `.module-grid` 與交接／駐衛警入口
  的子系統圖卡，桌面瀏覽器 100% 統一為 **269×200px**；標題沿用共用頁首規格（距頂列
  22px、26px、淺藍 `rgb(2, 132, 199)`、Logo 左側 24px、標題左側 80px、Logo 42×42px）。
  1100px 以下改兩欄、600px 以下改單欄，並恢復彈性寬度避免水平溢出。
- 維修／派工入口另有 7 張統計小卡，桌面維持單列並依主圖卡 80% 比例縮放；3 張流程
  主圖卡同樣固定為 269×200px，窄版依 900px／600px 斷點改為兩欄／單欄。

## 樓層平面圖的圖檔與效能（2026-08-28 訂）

- `floorplans` 儲存桶的原圖是 **4096×4015（約 1～2.3MB）**，但畫面最大只用到視窗寬度。
  客戶端目前會「下載原圖 → `getImageData` → 逐像素重畫 → `toBlob` 重新編碼 PNG」，
  實測桌機 Chrome 這段 **250～450ms**，手機約 3～6 倍。
- 已做的緩解：**手機／觸控裝置改讀 `mobile/`（1024px）**（比照 V1 `b1plan.html` 的
  `matchMedia('(max-width:768px),(pointer:coarse)')`）；**重畫後的 blob 依「路徑＋主題」
  LRU 快取 4 張**，切回看過的樓層不再重跑。
- 治本作法：用 `tools/build-floorplan-variants.py` 在**上傳時**就產生
  `light/`、`tech/`（已重畫完成）與 `desktop/`（2048px）、`mobile/`（1024px）四組衍生圖，
  客戶端直接下載對應主題的成品，零像素處理。腳本的 `to_light()`／`to_tech()`
  **必須與 `floor-stack-3d.tsx` 的 `preparePlanCanvas` 演算法一致**（light：alpha=0 略過、
  luma>232 轉透明、其餘塗黑；tech：alpha<64 轉透明），改其中一邊就要同步改另一邊。
- 兩個已驗證無效、不要再試的方向：`toBlob` 改 WebP **更慢**（PNG 116ms vs WebP 無損 293ms）；
  canvas 開 `willReadFrequently:true` 的 `getImageData` 沒有比較快（106ms vs 90ms）。
- `RF.png` 目前在儲存桶**沒有 `mobile/` 版本**，選圖邏輯取不到時必須退回原圖。

## V2 手機版版型規範（2026-08-28 訂）

- **頁首操作按鈕一律靠右**。`components/admin/shared.tsx` 的 `AdminHeader`（`.admin-page-actions`）
  在 **≤800px** 時，右側按鈕組為 `width:100%; justify-content:flex-end`。規則寫在
  `web/app/admin-workspace.css` 的 800px 斷點，**涵蓋所有使用 AdminHeader 的子系統**；
  新頁面不需要、也不應該再逐頁加同樣的宣告（`tools/system-page-heading-check.mjs`
  會擋下 `.admin-page-actions:has(...)` 這類重複的分頁規則）。
  另一種頁首 `.operations-panel-title` 本身就是 `justify-content:space-between`，按鈕已在右側。
- **不要用行內樣式排版**。`style={{...}}` 的優先序高於任何選擇器，media query 蓋不過去，
  頁面就再也無法只調整手機版。2026-08-28 一天內就被擋住三次（`LocalizedDateInput` 的
  原生日期欄位、會議室管理彈窗的按鈕列、巡檢排班的 `maxWidth:85%` 外框），全部改成 class。
- **手機版排版靠 flex-basis，不是靠 flex-wrap**。控制項「明明空間夠卻換行」時，先查
  `flex-basis`：`flex:1 1 auto` 會取內容寬度當基準，先佔滿一整行把後面的項目擠下去。
  巡檢排班的日期欄位就是這樣（basis 190px → 收到 72px 才排得進同一列）。
- **`display:contents` 的容器要先解掉才能分列**。`.operations-tool-row` 在寬版面用
  `display:contents` 把日期列與篩選列攤平成同一列；手機版要分成上下兩列，必須先把子容器
  改回 `display:flex`，否則所有控制項都是同一個 flex 容器的直接子項。
- **圖示一律收在 320px 以內**。系統 Logo 最大顯示尺寸是入口圖卡的 88px，Sprite 依格數換算
  （`equipment-structure-icons-ai.png` 4×4→512px、`topbar-nav-icons-ai.png` 2×2→256px）。
  用 `draw` 技能產生的圖多半是 1024～1254px、單檔 1MB 以上，**進版控前務必縮圖**；
  2026-08-28 就是因為沒縮，`/v2/systems/` 入口頁光圖示要載 2.6MB，全站 24 個圖示共 13.6MB。
  `tools/system-page-heading-check.mjs` 會擋下超過 200KB 的系統 Logo。
  縮圖用 Pillow 的 LANCZOS 重取樣即可；**不要用 256 色量化**——實測這批 3D 光澤圖示量化後
  在 88px 顯示時色差 RMS 達 5～17（可見的色帶），省下的容量不值得。
- **手機版驗證方式**：本專案的 V2 頁面多半要登入才看得到內容，改版型後請用
  `npm run build:v2` 產出的**實際 CSS chunk** 建立靜態重現頁，以 375px／320px／1280px
  量測元素座標與 `document.scrollWidth`（確認無水平溢出），不要只靠目視。
  重現頁務必把**基礎樣式 chunk 一起載入**——只載含新規則的那一個，會因為缺少
  `display:flex` 之類的基礎宣告而量到錯誤結果。

## V2 登入頁版型規範（2026-08-27 訂）

- `/v2/login/` 的白色登入圖卡在桌面以共用 `.login-card` 的 430px 基準做 **80%**
  整體縮放（實際視覺寬度 344px），Logo、文字、欄位、驗證碼與按鈕必須跟著同倍率
  縮放，不可只縮外框。
- 桌面登入頁固定使用 `100svh` 並禁止頁面水平／垂直溢出；瀏覽器 100% 縮放時，完整
  登入卡與頁尾必須同時位於可視區內且不得出現捲軸。短螢幕仍沿用既有高度斷點收斂間距。
- 80% 縮放僅適用登入、忘記密碼與重設密碼白色圖卡；`.account-apply-card` 是資料較多的
  帳號申請表，必須排除，維持自身的響應式寬度與捲動行為。

## 讀取存取稽核與資安告警（2026-08-21 訂）

- **資安告警不是資料庫觸發器產生的**。`security_alerts` 由 `audit-event` edge function
  在 5 分鐘視窗內判定「非互動高頻讀取」後建立（門檻：同一人同 IP ≥40 次非互動讀取、
  且跨 ≥8 個不同資源），而該函式**必須由前端主動呼叫**。
- **V2 的呼叫端是 `web/lib/access-audit.ts`**，掛在根版面（`ErrorTrackerMount`），
  以包裝 `window.fetch` 的方式攔截所有 GET／HEAD 的 `/rest/v1/*` 與
  `/storage/v1/object/*`。**新增頁面或查詢不必、也不該自己補呼叫**；在呼叫端各自加
  只會重複計數並破壞去重。
- **`details.user_initiated` 必須是布林**。偵測用嚴格比較 `=== false` 篩選自動化讀取，
  送成字串 `"false"` 會讓該筆永遠不列入判定——這種錯誤不會有任何徵兆，只會讓告警
  再也不觸發。`access_origin` 同理只認 `page_load` / `user_action`。
- 稽核自身的資料表（`audit_logs`、`security_alerts`）不列入記錄，否則開稽核頁會不斷
  自我產生紀錄。
- 回應中的 `security_action` 是**實際的資安控制**（大量讀取切斷），收到就要強制登出，
  不可以只當提示忽略。
- V1 的對應實作在 `system/theme.js` 的 `installReadAccessAudit`，payload 格式相同；
  兩邊改動要一起看，否則同一張表會混入兩種格式。

## 介面風格切換（一般版／科技版，2026-08-21 訂）

- **切換入口是右下角的浮動圖示，不是頂列的文字按鈕**。一般版顯示 🌙（點了切到科技
  版）、科技版顯示 ☀️，版位與外觀比照 V1 `theme.js` 的 `#themeToggleBtn`
  （右下 16px、44×44 圓鈕）。
- **V2 的實作掛在根版面** `web/app/layout.tsx`（`components/ThemeToggle.tsx`），所以
  **每一頁都自動有**，含登入頁與不套 AppShell 的全螢幕工具頁。
  **新增頁面不必、也不該再自己做一顆**，頂列不要再放主題按鈕。
- 兩版共用同一個 localStorage 鍵 `siteTheme`，V1 與 V2 互通。主題屬性由
  `layout.tsx` 的行內腳本在算繪前設好，元件只負責切換。
- **新增固定在右下角的元件時要讓出這顆鈕的位置**（`bottom: 70px` 起跳）。目前已讓位
  的有 `.f3-bottomright`（模型圖）與 `.mb-bottomright`（整合標記系統）。
- 這顆鈕的顏色**刻意不走主題 token**：它會疊在圖面與 3D 場景之上，需要自己有足夠
  對比，跟著 token 走會在深色圖面上消失。

## 圖資頁面的共同規範（模型圖／標記圖臺／雲台，2026-08-21 訂）

適用於任何呈現樓層平面或立體模型並在上面放標記的頁面：3D 模型圖、平面模型圖、
整合標記系統，以及日後任何用到同一批圖資的功能（雲台、巡檢圖臺等）。
**這些是共用資產，不要各自再抄一份**——V1 的 `floor3d.html` 與 `guardpatrol3d.html`
就是各寫一份之後逐漸分岔的前例。

- **全螢幕外殼**：`structuremap-floor3d.css` 的 `.f3-*`（頂列、`.f3-stage`、三個可收合
  浮動面板、底部右側的操作說明與 HUD）。頂列的六個共用動作取自 `lib/shared-actions`。
- **圖釘**：`structuremap-pin.css` 的 `.mb-pin` / `.mb-pdot` / `.mb-plab` / `.mb-lead`。
- **標籤一定要做防重疊排版**。密集樓層直接疊上去會糊成一片（B1 有 30 個標記）。
  規則：標籤可往上、也可往左右錯開，一律以引線指回圓點；`--lx`／`--ly` 決定位置，
  `--llen`／`--lang` 決定引線長度與角度；候選位置由近而遠嘗試，**真的排不下才拿掉該
  圖釘的 `show-lab`**（落回預設隱藏，滑過仍會浮現）。實作見
  `structuremap-viewers.tsx` 的 `layoutLabels`；3D 側是等效的螢幕空間剔除。
  平移、縮放、視窗改變都要重排，用 rAF 收斂成一幀一次。
- **兩種主題都要先預處理貼圖**，用 `preparePlanCanvas`／`preparePlanObjectUrl`
  （`floor-stack-3d.tsx`）：
  - `light`：近白視為背景轉透明、其餘塗黑。青色是烘在 PNG 裡的，
    **不要用 material.color 相乘或 CSS filter**——圖檔若是不透明白底，整片平面會變黑。
  - `tech`：保留原色，但濾掉 alpha < 64 的光暈。`renderNeon` 的發光是三道疊出來的，
    不濾掉會讓科技版的線比一般版粗一截（實測光暈像素是核心線的兩倍多）。
  兩邊用同一支函式，粗細才會一致；只處理其中一種主題就會再度不對稱。
- **OpenSeadragon 的縮圖顏色只能由選項給**（`navigatorBackground` 等），OSD 在建構時
  寫成行內樣式，CSS 蓋不掉。值一律讀主題 token，不要寫死。切換主題時要自己補寫一次
  行內樣式，選項只在建構當下生效。
- **凡是在「建場景／開圖當下」讀 `data-theme` 決定顏色的，都必須監看該屬性並重建**。
  three.js 的 `scene.background`、樓層板與邊線顏色、貼圖黑線重畫，OSD 的線稿重畫都屬
  此類：只讀一次的話，切換主題後畫面會停在舊主題直到重新整理。作法見
  `floor-stack-3d.tsx` 與 `structuremap-viewers.tsx` 的 `MutationObserver`，並把
  theme 列入該 effect 的相依。
  這個缺口 2026-08-21 之前一直存在，只是全螢幕工具頁沒有主題切換入口、切不了也就
  看不出來；切換鈕改為全站之後才顯現。
- **不可以用 `window.OpenSeadragon`**。它是 UMD 包裝，在打包環境走 `module.exports`
  分支、不會掛上全域，取 `.Point` 會丟 TypeError。請用 import 進來的命名空間。
- **覆蓋層的錯誤不可以用空 catch 吞掉**。平面模型圖曾因此從上線起一顆標記都沒畫出來，
  畫面只是「空的」，現場不會回報成故障。至少記到 console，整批失敗要顯示在畫面上。

### 上下游關係：3D建模系統是唯一的圖資來源

```
3D建模系統（modeler，DXF → renderNeon → floor_models.image_path）
        │
        ├─ 3D 模型圖      /v2/systems/structuremap/floor3d/
        ├─ 平面模型圖     /v2/systems/structuremap/floor2d/
        └─ 立體巡檢雲臺   /v2/systems/guardpatrol/map3d/
```

- **建模系統只有一個、檢視器有三個。上游改了，三頁都要一起確認**，反之新增檢視器
  也要回頭確認上游的產出符合下列假設。
- 檢視器對 `renderNeon` 產出的兩個硬性假設：**底是透明的**（該函式只 `clearRect`、
  從不填色），以及**線條顏色烘在圖檔裡**、無法在檢視器端用 CSS 或材質相乘改掉。
  淺色主題的黑線重畫（`recolourPlanCanvas`）就是建立在這兩點上。
- 改 `renderNeon` 的顏色、底色或 `TEXTURE_LONG_SIDE` 之前，請先讀該函式上方的註解。
  `recolourPlanCanvas` 已加保險絲：底圖若不透明會放棄重畫並在 console 留訊息，
  但畫面會退回青線，不是預期的黑線——**保險絲只防止畫面全黑，不會幫你同步**。
- 3D建模系統本身是**上傳與管理頁**，不是檢視器，因此維持 AppShell 版型，不套上面的
  全螢幕外殼；它的圖面只是匯入後的預覽。

## Do NOT
- Do **not** delete `system/plans/*` — those textures/DZI tiles are used live by
  `floor3d.html` and `b1plan.html`.
- Do **not** drop or truncate DB tables casually — `equipment`, `locations`,
  `floor_spaces`, inspection data are shared across dashboard/repair/materials.
- Do **not** delete rows from `users` or other protected master/history tables. Set
  `status='inactive'`; the permanent-data trigger intentionally rejects DELETE/TRUNCATE.
- Do **not** disable TLS or hardcode secrets beyond the already-public anon key.

## Git workflow
- Default branch `main` is what GitHub Pages deploys. Commit/push only what you
  intend to ship.
- After completing and verifying a requested fix, commit only the files related
  to that fix and push them to `origin/main` without waiting for a separate push
  instruction. Preserve unrelated working-tree changes and never include them.
- Multiple agents may push concurrently; if a push is rejected, do
  `git fetch origin main && git rebase origin/main` then push again.
- **Edge functions deploy themselves now.** `.github/workflows/deploy-edge-functions.yml`
  deploys only the functions changed by the push (type-checked with `deno check` first).
  Before it existed, `supabase/functions/**` changes shipped only when someone remembered
  to run `supabase functions deploy` by hand, and twice on 2026-08-20 the front end went
  live calling actions the deployed function did not have yet. Don't reintroduce a manual
  step; if a deploy must be rerun, use the workflow's `workflow_dispatch` input.
- Don't open a PR unless asked.

## Obsidian 開發紀錄

- 本專案的 Obsidian vault 是 repository 內的 `Obsidian/`；主要文件為 `04-開發與部署.md`、`05-待辦清單.md`、`06-發布前驗收表.md`、`07-資料庫備份與復原流程.md` 與 `08-資安告警原因與修正報告.md`。
- 每次完成程式、資料庫、資安或部署工作並取得驗證結果後，應在 `Obsidian/04-開發與部署.md` 追加一筆日期、變更摘要、驗證結果與 commit／workflow 證據；若待辦狀態有改變，同步更新 `Obsidian/05-待辦清單.md`。
- 資安事件與告警原因另同步至 `Obsidian/08-資安告警原因與修正報告.md`；備份／復原流程另同步至 `Obsidian/07-資料庫備份與復原流程.md`。
- Obsidian 只保存可公開於 repository 的開發紀錄，不得寫入 `SUPABASE_ACCESS_TOKEN`、service-role key、使用者密碼、Session、Cookie、私有 signed URL 或其他 Secret；必要時只記錄「已設定／已驗證」及遮蔽後的識別資訊。
- 若本工作階段沒有 Obsidian connector／技能，仍以 repository 內 Markdown 檔案完成同步；不要因技能未載入而跳過紀錄，也不要把 Secret 寫入 vault。
- `antigravity-obsidian` 技能的用途是連接／設定 Obsidian MCP，觸發詞是「連接 Obsidian」或「設定 Obsidian」；它不是每次開工都會自動寫入紀錄的 hook。一般開發任務完成後，代理仍必須直接更新上述 Markdown 檔案。
- MCP 註冊屬於本機 Codex 使用者設定，不放進公開 repository；本專案的公開同步來源固定是 `Obsidian/` 目錄。若 MCP 暫時不可用，直接以 Markdown 同步仍視為完成。
