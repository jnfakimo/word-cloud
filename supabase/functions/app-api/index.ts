import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.112.2';
import { enforceDurableRateLimit, recordRateLimitDenial } from '../_shared/security-monitor.ts';
import { passwordPolicyMessage } from '../_shared/password-policy.ts';
import { canonicalFloor } from '../_shared/floor.ts';
import { clientIpFromRequest } from '../_shared/client-ip.ts';
import { readMarketBoardNotices } from './market-board-notices.ts';

type PortableRuntime = {
  env?: { get: (name: string) => string | undefined };
  serve?: (handler: (request: Request) => Promise<Response>) => unknown;
};

const denoRuntime = (globalThis as typeof globalThis & { Deno?: PortableRuntime }).Deno;
const nodeEnvironment = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env;

function requiredEnvironment(name: string) {
  const value = denoRuntime?.env?.get(name) || nodeEnvironment?.[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const SUPABASE_URL = requiredEnvironment('SUPABASE_URL');
const SERVICE_ROLE_KEY = requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY');
const ANON_KEY = requiredEnvironment('SUPABASE_ANON_KEY');

const allowedOrigins = new Set([
  'https://jnfakimo.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  ...(denoRuntime?.env?.get('APP_ALLOWED_ORIGINS') || nodeEnvironment?.APP_ALLOWED_ORIGINS || '')
    .split(',').map(origin => origin.trim()).filter(Boolean),
]);
// 自架站常見於內網 IP（RFC1918）。放行這些來源反射 CORS，讓地端 IIS／反向
// 代理不必逐一設 APP_ALLOWED_ORIGINS；Bearer token 驗證仍是主要防線。
const PRIVATE_NET_ORIGIN = /^https?:\/\/(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})(?::\d{1,5})?$/;

function cors(req: Request) {
  const origin = req.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': allowedOrigins.has(origin) || PRIVATE_NET_ORIGIN.test(origin) ? origin : 'https://jnfakimo.github.io',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function reply(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function text(value: unknown, max = 500) {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function id(value: unknown) {
  const result = text(value, 80);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result) ? result : '';
}

function isUuid(value: unknown) {
  return id(value) !== '';
}

// 嚴格驗證 YYYY-MM-DD 且為真實存在的日期，避免 2026-13-99 這類假格式進 DB。
function validISODate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// 將常見 PostgreSQL 錯誤碼轉成使用者看得懂的中文訊息，避免把內部表名/約束名洩漏給前端。
function dbMessage(error: { code?: string; message?: string } | null, fallback: string) {
  const code = String(error?.code || '');
  if (code === '23505') return '資料已存在，請勿重複提交';
  if (code === '23503') return '關聯資料不存在，請先確認相關資料';
  if (code === '23514') return '資料不符合系統規則';
  if (code === '22P02') return '數值或格式不正確';
  if (code === '42501') return '沒有執行此操作的權限';
  const message = text(error?.message, 300);
  return message || fallback;
}

function relationName(value: unknown) {
  const relation = Array.isArray(value) ? value[0] : value;
  if (!relation || typeof relation !== 'object' || !('name' in relation)) return '';
  return text((relation as { name?: unknown }).name, 200);
}

type DepartmentNode = {
  dept_id?: unknown;
  parent_id?: unknown;
  name?: unknown;
  level?: unknown;
  code?: unknown;
};

function departmentKey(value: unknown) {
  return text(value, 200).replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function buildDepartmentPaths(rows: DepartmentNode[]) {
  const byId = new Map<string, DepartmentNode>();
  rows.forEach(row => {
    const deptId = id(row.dept_id);
    if (deptId) byId.set(deptId, row);
  });
  const pathCache = new Map<string, string>();
  const pathForId = (value: unknown) => {
    const deptId = id(value);
    if (!deptId) return '';
    const cached = pathCache.get(deptId);
    if (cached) return cached;
    const names: string[] = [];
    const visited = new Set<string>();
    let currentId = deptId;
    let guard = 0;
    while (currentId && guard++ < 20 && !visited.has(currentId)) {
      visited.add(currentId);
      const current = byId.get(currentId);
      if (!current) break;
      const name = text(current.name, 100);
      if (name) names.unshift(name);
      currentId = id(current.parent_id);
    }
    const path = names.join(' / ');
    if (path) pathCache.set(deptId, path);
    return path;
  };
  const rootForId = (value: unknown) => {
    const startId = id(value);
    if (!startId) return null;
    const visited = new Set<string>();
    let currentId = startId;
    let current: DepartmentNode | null = null;
    let guard = 0;
    while (currentId && guard++ < 20 && !visited.has(currentId)) {
      visited.add(currentId);
      current = byId.get(currentId) || null;
      if (!current) break;
      const parentId = id(current.parent_id);
      if (!parentId) break;
      currentId = parentId;
    }
    return current;
  };
  const byName = new Map<string, string>();
  rows.forEach(row => {
    const name = text(row.name, 100);
    if (!name) return;
    const path = pathForId(row.dept_id) || name;
    byName.set(departmentKey(name), path);
  });
  return { byId, byName, pathForId, rootForId };
}

function formatDepartment(value: unknown, byName: Map<string, string>) {
  const raw = text(value, 200);
  if (!raw) return '';
  const parts = raw.split(/\s*(?:\/|／|｜|\|)\s*/).map(part => text(part, 100)).filter(Boolean);
  if (parts.length > 1) return parts.join(' / ');
  return byName.get(departmentKey(raw)) || raw;
}

function extractFileExt(name: string, fallback: string) {
  const match = text(name, 80).toLowerCase().match(/\.([a-z0-9]{2,8})$/);
  return match ? match[1] : fallback;
}

function nextRequestRequestId() {
  const source = globalThis.crypto;
  if (source && typeof source.randomUUID === 'function') return source.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function taipeiDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const get = (type: string) => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}${get('month')}${get('day')}`;
}

function taipeiRocDateKey(value = new Date()) {
  const gregorian = taipeiDateKey(value);
  const rocYear = Number(gregorian.slice(0, 4)) - 1911;
  return `${String(rocYear).padStart(3, '0')}${gregorian.slice(4)}`;
}

async function nextOfficialDocumentNo(db: SupabaseClient, dateKey: string, minimumSerial = 1) {
  const prefix = text(dateKey, 7);
  const { data, error } = await db.from('official_documents')
    .select('document_no').like('document_no', `${prefix}%`).limit(2000);
  if (error) throw error;
  const highest = (data || []).reduce((max, row) => {
    const value = String(row.document_no || '');
    if (!new RegExp(`^${prefix}\\d{4}$`).test(value)) return max;
    return Math.max(max, Number(value.slice(-4)) || 0);
  }, 0);
  const serial = Math.max(highest + 1, minimumSerial);
  if (serial > 9999) throw new Error('今日公文編號已達 9999 號，請聯絡系統管理員');
  return `${prefix}${String(serial).padStart(4, '0')}`;
}

function extractClientIp(req: Request) {
  return clientIpFromRequest(req);
}

function normalizeFloorFields(row: Record<string, unknown>) {
  const next = { ...row };
  if ('floor' in next) next.floor = canonicalFloor(next.floor) || null;
  if ('floor_id' in next) next.floor_id = canonicalFloor(next.floor_id) || null;
  return next;
}

// 稽核寫入改由後端負責：與業務操作同一次請求完成，前端無法略過，
// source 標記為 app-api 以便與 V1 直寫的紀錄區分。
type AuditClient = {
  from: (table: string) => {
    insert: (values: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }>;
  };
};
/**
 * 報修案件的統計圖卡——報修案件頁（workorder_list）與維修系統入口（module_data）
 * 共用這一份定義。
 *
 * 兩點刻意的設計：
 * 1. 單一來源。原本兩邊各算各的、又都取「出現次數最多的前 3 個狀態」，同一批資料
 *    在兩個頁面會顯示不同的圖卡，資料一變還會自己換掉。
 * 2. 自己查一次，不吃呼叫端已取回的資料列。module_data 上限 100 筆、workorder_list
 *    上限 500 筆，案件數超過 100 之後兩頁的數字就會靜默地對不起來。
 *
 * 新增或調整圖卡只要改這裡，兩個頁面自動一致。
 */
async function repairRequestSummary(db: SupabaseClient) {
  const { data, error } = await db.from('repair_requests').select('status,urgency,created_at').limit(5000);
  if (error) throw error;
  const rows = (data || []) as Array<Record<string, unknown>>;
  const statusOf = (row: Record<string, unknown>) => String(row.status ?? '');
  const urgencyOf = (row: Record<string, unknown>) => String(row.urgency ?? '');
  const SETTLED = new Set(['closed', 'completed']);
  const taipeiDay = (value: unknown) => {
    const parsed = Date.parse(String(value ?? ''));
    return Number.isFinite(parsed)
      ? new Date(parsed).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })
      : '';
  };
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  // 依案件生命週期排序：新增 → 急迫 → 指派 → 處理 → 結案 → 取消，
  // 一整列讀下來就是流程本身。
  return [
    { label: '目前資料', value: rows.length },
    { label: '今日增加案件', value: rows.filter(row => taipeiDay(row.created_at) === today).length },
    { label: '急迫性案件', value: rows.filter(row =>
        (urgencyOf(row) === 'urgent' || urgencyOf(row) === 'high') && !SETTLED.has(statusOf(row))).length },
    { label: '已指派', value: rows.filter(row => statusOf(row) === 'assigned').length },
    { label: '處理中', value: rows.filter(row => statusOf(row) === 'in_progress').length },
    { label: '已結案', value: rows.filter(row => statusOf(row) === 'closed').length },
    { label: '已取消', value: rows.filter(row => statusOf(row) === 'cancelled').length },
  ];
}

type MarketFieldDefinition = {
  key: string;
  label: string;
  kind: 'dimension' | 'measure';
  unit?: string;
  aggregation?: 'sum' | 'avg' | 'weighted_avg' | 'min' | 'max';
  weight_key?: string;
  required?: boolean;
  hidden?: boolean;
  filterable?: boolean;
};

function marketFieldDefinitions(value: unknown): MarketFieldDefinition[] {
  const source = Array.isArray(value) ? value : [];
  return source.map(item => {
    const row = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const key = text(row.key, 60).toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
    const kind: MarketFieldDefinition['kind'] = row.kind === 'measure' ? 'measure' : 'dimension';
    const aggregation = ['sum', 'avg', 'weighted_avg', 'min', 'max'].includes(String(row.aggregation))
      ? String(row.aggregation) as MarketFieldDefinition['aggregation'] : kind === 'measure' ? 'sum' : undefined;
    const weightKey = text(row.weight_key, 60).toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
    return {
      key, label: text(row.label, 100) || key, kind,
      unit: text(row.unit, 40) || undefined, aggregation,
      weight_key: aggregation === 'weighted_avg' && /^[a-z][a-z0-9_-]{0,59}$/.test(weightKey) ? weightKey : undefined,
      required: row.required === true,
      hidden: typeof row.hidden === 'boolean' ? row.hidden : undefined,
      filterable: typeof row.filterable === 'boolean' ? row.filterable : undefined,
    };
  }).filter(field => /^[a-z][a-z0-9_-]{0,59}$/.test(field.key));
}

function marketJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function marketSimulationJsonObject(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  return JSON.stringify(object).length <= 100_000 ? object : null;
}

function marketPermissionEnabled(value: unknown) {
  return value === true || (typeof value === 'string' && value.toLowerCase() === 'true');
}

function marketNumeric(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

async function marketImportExternalKey(sourceId: string, observedOn: string, dimensions: Record<string, string>, naturalKeyFields: string[]) {
  const payload = [sourceId, observedOn, ...naturalKeyFields.map(key => `${key}=${dimensions[key] || ''}`)].join('\u001f');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return `market-import:${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

type MarketAggregate = {
  dimensions: Record<string, string>;
  values: Record<string, number | null>;
};

function marketDateRange(value: unknown, fallback: string) {
  const candidate = text(value, 10);
  return validISODate(candidate) ? candidate : fallback;
}

const DASHBOARD_MARKETS = ['第一市場', '第二市場'] as const;
const DASHBOARD_CATEGORIES = ['蔬菜', '水果'] as const;
type DashboardMarket = typeof DASHBOARD_MARKETS[number];
type DashboardCategory = typeof DASHBOARD_CATEGORIES[number];
type DashboardRotationItem = {
  market: DashboardMarket;
  category: DashboardCategory;
  item: string;
  enabled: boolean;
  sortOrder: number;
};
type DashboardMarketRotation = {
  sourceId: string;
  autoStepSeconds: number;
  cardsPerGroup: number;
  items: DashboardRotationItem[];
};

function dashboardMarketRotationConfig(value: unknown): DashboardMarketRotation {
  const root = marketJsonObject(value);
  const raw = marketJsonObject(root.market_rotation);
  const marketSet = new Set<string>(DASHBOARD_MARKETS);
  const categorySet = new Set<string>(DASHBOARD_CATEGORIES);
  const seen = new Map<string, number>();
  const items: DashboardRotationItem[] = [];
  (Array.isArray(raw.items) ? raw.items : []).forEach((entry, index) => {
    const row = marketJsonObject(entry);
    const market = text(row.market, 20);
    const category = text(row.category, 20);
    const item = text(row.item, 160);
    if (!marketSet.has(market) || !categorySet.has(category) || !item) return;
    const key = `${market}::${category}::${item}`;
    const parsedOrder = Number(row.sort_order);
    const normalizedItem: DashboardRotationItem = {
      market: market as DashboardMarket,
      category: category as DashboardCategory,
      item,
      enabled: row.enabled !== false,
      sortOrder: Number.isFinite(parsedOrder) ? Math.max(0, Math.min(9999, Math.round(parsedOrder))) : (index + 1) * 10,
    };
    const existingIndex = seen.get(key);
    if (existingIndex !== undefined) { items[existingIndex] = normalizedItem; return; }
    if (items.length >= 96) return;
    seen.set(key, items.length);
    items.push(normalizedItem);
  });
  const autoStepSeconds = Number(raw.auto_step_seconds);
  const cardsPerGroup = Number(raw.cards_per_group);
  return {
    sourceId: id(raw.source_id),
    autoStepSeconds: Number.isFinite(autoStepSeconds) ? Math.max(2, Math.min(30, autoStepSeconds)) : 3.5,
    cardsPerGroup: Number.isFinite(cardsPerGroup) ? Math.max(4, Math.min(24, Math.round(cardsPerGroup))) : 12,
    items: items.sort((left, right) => left.sortOrder - right.sortOrder),
  };
}

function dashboardMarketShiftDate(value: string, offset: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

type MarketBoardResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; message: string; status: number };

// SYS-12「長官模式」公開看板的資料組裝。同時給登入版（dashboard_market_rotation
// view:'board'）與免登入版（action:'market_board_public'）使用，兩邊都只讀既有正式
// 行情，不新增資料表。與輪播共用來源解析邏輯，但各自取自己需要的 rollup。
async function buildMarketBoardPayload(
  admin: SupabaseClient,
  options: { publicView?: boolean } = {},
): Promise<MarketBoardResult> {
  let widgetConfig: Record<string, unknown> = {};
  let refreshSeconds = 60;
  const layoutResult = await admin.from('dashboard_layouts')
    .select('published_version_id').eq('layout_code', 'operations_main').eq('status', 'active').maybeSingle();
  if (layoutResult.error) console.warn('market board layout lookup failed:', layoutResult.error.message);
  if (layoutResult.data?.published_version_id) {
    const widgetResult = await admin.from('dashboard_layout_items')
      .select('config,refresh_seconds').eq('version_id', layoutResult.data.published_version_id)
      .eq('widget_key', 'market_snapshot').maybeSingle();
    if (widgetResult.error) console.warn('market board widget lookup failed:', widgetResult.error.message);
    if (widgetResult.data) {
      widgetConfig = marketJsonObject(widgetResult.data.config);
      const parsedRefresh = Number(widgetResult.data.refresh_seconds);
      if (Number.isFinite(parsedRefresh)) refreshSeconds = Math.max(15, Math.min(86400, Math.round(parsedRefresh)));
    }
  }
  const rotation = dashboardMarketRotationConfig(widgetConfig);

  const sourceResult = await admin.from('market_data_sources')
    .select('source_id,source_code,source_name,field_definitions,config')
    .eq('status', 'active').order('source_name').limit(200);
  if (sourceResult.error) {
    console.error('market board source lookup failed:', sourceResult.error.message);
    return { ok: false, message: '市場行情資料來源暫時無法讀取', status: 503 };
  }
  const sourceCandidates = (sourceResult.data || []) as Array<Record<string, unknown>>;
  const isDecisionSource = (row: Record<string, unknown>) => (
    text(row.source_code, 60) !== 'market_demo' && marketJsonObject(row.config).is_demo !== true
  );
  const source = sourceCandidates.find(row => rotation.sourceId && text(row.source_id, 80) === rotation.sourceId && isDecisionSource(row))
    || sourceCandidates.find(row => {
      const config = marketJsonObject(row.config);
      return isDecisionSource(row) && config.is_default === true && config.is_actual === true;
    })
    || sourceCandidates.find(row => isDecisionSource(row) && marketJsonObject(row.config).is_actual === true)
    || sourceCandidates.find(isDecisionSource);
  if (!source) return { ok: false, message: '尚未設定可供市場看板使用的正式市場行情資料來源', status: 503 };

  const sourceId = id(source.source_id);
  const fields = marketFieldDefinitions(source.field_definitions);
  const fieldMap = new Map(fields.map(field => [field.key, field]));
  const dimensions = new Set(fields.filter(field => field.kind === 'dimension').map(field => field.key));
  const measures = ['quantity', 'average_price', 'high_price', 'low_price'].filter(key => fieldMap.get(key)?.kind === 'measure');
  if (!['market', 'category', 'item'].every(key => dimensions.has(key)) || !measures.includes('quantity') || !measures.includes('average_price')) {
    return { ok: false, message: '正式行情資料缺少市場、大類、品項、成交量或平均價欄位', status: 503 };
  }

  const rangeResult = await admin.rpc('market_source_date_ranges');
  if (rangeResult.error) {
    console.error('market board date range failed:', rangeResult.error.message);
    return { ok: false, message: '市場行情交易日期暫時無法讀取', status: 503 };
  }
  const range = ((rangeResult.data || []) as Array<Record<string, unknown>>).find(row => text(row.source_id, 80) === sourceId);
  const latestDate = text(range?.latest_observed_on, 10);
  const previousDate = text(range?.previous_observed_on, 10);
  if (!validISODate(latestDate) || !validISODate(previousDate)) {
    return { ok: false, message: '市場行情尚未建立最新與前一交易日的比較資料', status: 503 };
  }

  const currentFrom = dashboardMarketShiftDate(latestDate, -6);
  const compareFrom = dashboardMarketShiftDate(latestDate, -13);
  const compareTo = dashboardMarketShiftDate(latestDate, -7);
  const primaryRollup = await admin.rpc('market_analysis_rollup', {
    p_source_id: sourceId,
    p_from: currentFrom,
    p_to: latestDate,
    p_compare_from: compareFrom,
    p_compare_to: compareTo,
    p_dimensions: ['market', 'category', 'item'],
    p_measures: measures,
    p_filters: {},
    p_include_group_daily: true,
  });
  if (primaryRollup.error) {
    const missingRollup = ['PGRST202', '42883'].includes(String(primaryRollup.error.code || ''))
      || /market_analysis_rollup.*(?:not find|not found|does not exist)/i.test(String(primaryRollup.error.message || ''));
    console.error('market board rollup failed:', primaryRollup.error.message);
    return {
      ok: false,
      message: missingRollup ? '市場行情彙總功能尚未完成設定，請先套用資料庫效能更新' : '市場行情彙總資料暫時無法讀取，請稍後再試',
      status: 503,
    };
  }
  const rollup = marketJsonObject(primaryRollup.data);
  const rollupRows = (key: string) => (
    Array.isArray(rollup[key])
      ? (rollup[key] as unknown[]).filter(item => item && typeof item === 'object').map(item => item as Record<string, unknown>)
      : []
  );
  const rollupValues = (value: unknown) => {
    const raw = marketJsonObject(value);
    return Object.fromEntries(measures.map(measure => [measure, marketNumeric(raw[measure])]));
  };
  const dailyAggregates = [
    ...rollupRows('current_group_daily'),
    ...rollupRows('compare_group_daily'),
  ].flatMap(row => {
    const observedOn = text(row.observed_on, 10);
    const rowDimensions = marketJsonObject(row.dimensions);
    if (!validISODate(observedOn)) return [];
    return [{
      observed_on: observedOn,
      dimensions: {
        market: text(rowDimensions.market, 20) || '未分類',
        category: text(rowDimensions.category, 20) || '未分類',
        item: text(rowDimensions.item, 160) || '未分類',
      },
      values: rollupValues(row.values),
    }];
  });
  const aggregateKey = (row: MarketAggregate) => [row.dimensions.market, row.dimensions.category, row.dimensions.item].join('::');
  const currentAggregates = dailyAggregates.filter(row => row.observed_on === latestDate && row.dimensions.item !== '未分類');
  const previousAggregates = dailyAggregates.filter(row => row.observed_on === previousDate);
  const previousByKey = new Map(previousAggregates.map(row => [aggregateKey(row), row]));

  const boardMarkets = DASHBOARD_MARKETS as readonly string[];
  const boardCategories = DASHBOARD_CATEGORIES as readonly string[];
  const weightedSummary = (rows: MarketAggregate[]) => {
    let quantity = 0, priceWeight = 0, totalValue = 0;
    for (const row of rows) {
      const qty = row.values.quantity ?? 0;
      const price = row.values.average_price;
      quantity += qty;
      if (price !== null && qty > 0) { priceWeight += price * qty; totalValue += price * qty; }
    }
    return {
      average_price: quantity > 0 ? Number((priceWeight / quantity).toFixed(2)) : null,
      quantity,
      total_value: quantity > 0 ? Math.round(totalValue) : null,
    };
  };
  const groupsSummary = DASHBOARD_MARKETS.flatMap(market => DASHBOARD_CATEGORIES.map(category => ({
    market,
    category,
    current: weightedSummary(currentAggregates.filter(row => row.dimensions.market === market && row.dimensions.category === category)),
    previous: weightedSummary(previousAggregates.filter(row => (
      row.dimensions.market === market && row.dimensions.category === category && row.dimensions.item !== '未分類'
    ))),
  })));

  // 全場均價大表需要上／中／下價；rollup RPC 一次最多 4 個 measure，因此針對
  // 「最新交易日 vs 前一交易日」單獨取一次價格 rollup，成交量沿用上面的彙總。
  const priceMeasures = ['average_price', 'high_price', 'middle_price', 'low_price']
    .filter(key => fieldMap.get(key)?.kind === 'measure').slice(0, 4);
  const priceRollup = await admin.rpc('market_analysis_rollup', {
    p_source_id: sourceId,
    p_from: latestDate,
    p_to: latestDate,
    p_compare_from: previousDate,
    p_compare_to: previousDate,
    // item_key 是匯入時保存的全國統一品名代碼（同品名多代碼以「|」串接），
    // 全場均價大表以此當「品名代碼」欄；rollup 最多 4 個維度，這裡剛好用滿。
    p_dimensions: ['market', 'category', 'item', 'item_key'],
    p_measures: priceMeasures,
    p_filters: {},
    p_include_group_daily: false,
  });
  if (priceRollup.error) {
    console.error('market board price rollup failed:', priceRollup.error.message);
    return { ok: false, message: '市場行情彙總資料暫時無法讀取，請稍後再試', status: 503 };
  }
  const priceRollupObject = marketJsonObject(priceRollup.data);
  const priceGroupRows = (key: string) => (
    Array.isArray(priceRollupObject[key])
      ? (priceRollupObject[key] as unknown[]).filter(entry => entry && typeof entry === 'object').map(entry => entry as Record<string, unknown>)
      : []
  );
  const priceValues = (value: unknown) => {
    const raw = marketJsonObject(value);
    return Object.fromEntries(priceMeasures.map(measure => [measure, marketNumeric(raw[measure])]));
  };
  const groupDimensionKey = (value: unknown) => {
    const raw = marketJsonObject(value);
    return `${text(raw.market, 20)}::${text(raw.category, 20)}::${text(raw.item, 160)}`;
  };
  const boardCurrentByKey = new Map<string, Record<string, number | null>>(priceGroupRows('current_groups').map(row => [groupDimensionKey(row.dimensions), priceValues(row.values)]));
  const boardCompareByKey = new Map<string, Record<string, number | null>>(priceGroupRows('compare_groups').map(row => [groupDimensionKey(row.dimensions), priceValues(row.values)]));
  // 品名代碼全國統一，同一品名在兩市場、兩交易日應為同一組代碼；以最新交易日優先。
  const itemCodes = (value: unknown) => text(marketJsonObject(value).item_key, 120)
    .split('|').map(code => code.trim()).filter(code => /^[A-Za-z0-9]+$/.test(code));
  const boardCodeByKey = new Map<string, string[]>();
  for (const row of [...priceGroupRows('compare_groups'), ...priceGroupRows('current_groups')]) {
    const codes = itemCodes(row.dimensions);
    if (codes.length) boardCodeByKey.set(groupDimensionKey(row.dimensions), codes);
  }
  const quantityByKey = new Map(currentAggregates.map(row => [
    `${row.dimensions.market}::${row.dimensions.category}::${row.dimensions.item}`,
    row.values.quantity ?? null,
  ]));

  const tableMap = new Map<string, { item: string; category: string; code: string; codes: string[]; cells: Record<string, unknown> }>();
  const registerCell = (market: string, category: string, item: string) => {
    if (!boardCategories.includes(category) || !boardMarkets.includes(market) || item === '未分類') return;
    const dimensionKey = `${market}::${category}::${item}`;
    const current = boardCurrentByKey.get(dimensionKey);
    const compare = boardCompareByKey.get(dimensionKey);
    if (!current && !compare) return;
    const rowKey = `${category}::${item}`;
    const entry = tableMap.get(rowKey) || { item, category, code: '', codes: [], cells: {} };
    const codes = boardCodeByKey.get(dimensionKey);
    if (codes && !entry.codes.length) {
      entry.codes = codes;
      entry.code = codes.join('、');
    }
    const avg = current?.average_price ?? null;
    const prevAvg = compare?.average_price ?? null;
    const change = avg !== null && prevAvg !== null ? Number((avg - prevAvg).toFixed(2)) : null;
    const changePct = avg !== null && prevAvg !== null && prevAvg !== 0
      ? Number(((avg - prevAvg) / Math.abs(prevAvg) * 100).toFixed(2)) : null;
    entry.cells[market] = {
      prev_avg: prevAvg, avg, change, change_pct: changePct,
      high: current?.high_price ?? null,
      middle: current?.middle_price ?? null,
      low: current?.low_price ?? null,
      quantity: quantityByKey.get(dimensionKey) ?? null,
    };
    tableMap.set(rowKey, entry);
  };
  const dimensionKeys = new Set<string>();
  boardCurrentByKey.forEach((_value, key) => dimensionKeys.add(key));
  boardCompareByKey.forEach((_value, key) => dimensionKeys.add(key));
  dimensionKeys.forEach(key => {
    const parts = key.split('::');
    registerCell(parts[0] ?? '', parts[1] ?? '', parts[2] ?? '');
  });
  // 依品類、品名代碼（全國統一，數字在前英文在後，與北農官網行情表同序）、品名排序；
  // 沒有代碼的列排在該品類最後。
  const compareCodes = (left: string[], right: string[]) => {
    if (!left.length || !right.length) return Number(!left.length) - Number(!right.length);
    return left[0].localeCompare(right[0], 'en', { numeric: true, sensitivity: 'base' });
  };
  const tableRows = [...tableMap.values()]
    .sort((left, right) => (
      left.category.localeCompare(right.category, 'zh-Hant')
      || compareCodes(left.codes, right.codes)
      || left.item.localeCompare(right.item, 'zh-Hant')
    ))
    .map(({ codes: _codes, ...row }) => row)
    .slice(0, 250);

  // 量價趨勢：取近一個多月的每日總量與加權均價（daily grain，只含有交易的日子）。
  // 前端提供近 7／14 日與近一月切換，這裡一次給足最多約 24 個交易日的點。
  const trendRollup = await admin.rpc('market_analysis_rollup', {
    p_source_id: sourceId,
    p_from: dashboardMarketShiftDate(latestDate, -34),
    p_to: latestDate,
    p_compare_from: null,
    p_compare_to: null,
    p_dimensions: ['market'],
    p_measures: ['quantity', 'average_price'],
    p_filters: {},
    p_include_group_daily: false,
  });
  if (trendRollup.error) console.warn('market board trend rollup failed:', trendRollup.error.message);
  const trendDaily = Array.isArray(marketJsonObject(trendRollup.data).current_daily)
    ? marketJsonObject(trendRollup.data).current_daily as unknown[]
    : [];
  const trend = trendDaily
    .map(entry => {
      const row = marketJsonObject(entry);
      const values = marketJsonObject(row.values);
      const quantity = marketNumeric(values.quantity) ?? 0;
      const averagePrice = marketNumeric(values.average_price);
      return {
        observed_on: text(row.observed_on, 10),
        quantity,
        average_price: averagePrice === null ? null : Number(averagePrice.toFixed(2)),
      };
    })
    .filter(point => validISODate(point.observed_on))
    .sort((left, right) => left.observed_on.localeCompare(right.observed_on))
    .slice(-24);

  // 登入版跑馬燈沿用通知中心的最新內容（給現場人員看）。免登入公開版只顯示
  // 明確標記給看板的訊息（event='board_notice'），不把內部派工／公文通知投到大螢幕。
  const noticeResult = await readMarketBoardNotices(admin, Boolean(options.publicView));
  if (noticeResult.error) console.warn('market board notices lookup failed:', noticeResult.error.message);
  const seenNotice = new Set<string>();
  const notices = ((noticeResult.data || []) as Array<Record<string, unknown>>)
    .map(row => ({ title: text(row.title, 120), body: text(row.body, 200), created_at: text(row.created_at, 40) }))
    .filter(row => {
      if (!row.title && !row.body) return false;
      const dedupeKey = `${row.title}|${row.body}`;
      if (seenNotice.has(dedupeKey)) return false;
      seenNotice.add(dedupeKey);
      return true;
    })
    .slice(0, 15);

  return {
    ok: true,
    data: {
      source: {
        source_id: sourceId,
        source_code: text(source.source_code, 60),
        source_name: text(source.source_name, 120),
      },
      latest_date: latestDate,
      previous_date: previousDate,
      auto_step_seconds: rotation.autoStepSeconds,
      refresh_seconds: refreshSeconds,
      markets: DASHBOARD_MARKETS,
      categories: DASHBOARD_CATEGORIES,
      groups_summary: groupsSummary,
      table: { markets: DASHBOARD_MARKETS, rows: tableRows },
      trend,
      notices,
    },
  };
}

async function writeAudit(
  db: AuditClient, operatorId: string, table: string, recordId: string,
  auditAction: 'insert' | 'update' | 'status_change', before: unknown, after: unknown,
) {
  const { error } = await db.from('audit_logs').insert({
    table_name: table, record_id: String(recordId), action: auditAction,
    changes: { before, after }, operator_id: operatorId, source: 'app-api',
  });
  // 稽核失敗不應讓已完成的業務操作回報為失敗，僅記錄於函式日誌。
  if (error) console.warn('audit write skipped:', error.message);
}

type OfficialDocumentActor = {
  user_id: string;
  name: string;
  role: string;
  dept_id?: string | null;
  department?: string | null;
  supervisor_id?: string | null;
};

const OFFICIAL_MANAGER_ROLES = new Set(['sysadmin', 'admin', 'dispatcher', 'duty']);
const OFFICIAL_PEOPLE_VIEWER_ROLES = new Set([...OFFICIAL_MANAGER_ROLES, 'unit_supervisor', 'mgmt_supervisor']);
const OFFICIAL_APPROVAL_UNIT_CODES = new Set(['BOARD', 'GM', 'VGM', 'SECRE']);
const OFFICIAL_APPROVAL_UNIT_NAMES = new Set(['董事長室', '總經理室', '副總經理', '副總經理室', '秘書室']);
const OFFICIAL_SECRETARY_UNIT_CODES = new Set(['SECRE']);
const OFFICIAL_SECRETARY_UNIT_NAMES = new Set(['秘書室']);
const OFFICIAL_DEPUTY_GM_UNIT_CODES = new Set(['VGM']);
const OFFICIAL_DEPUTY_GM_UNIT_NAMES = new Set(['副總經理', '副總經理室']);
const officialDocumentUnitCapabilities = (unit: { name?: unknown; code?: unknown } | null | undefined) => {
  const code = text(unit?.code, 40).toUpperCase();
  const name = text(unit?.name, 100).replace(/\s+/g, '');
  const isSecretary = code === 'SECRE' || name === '秘書室';
  const canApprove = OFFICIAL_APPROVAL_UNIT_CODES.has(code) || OFFICIAL_APPROVAL_UNIT_NAMES.has(name);
  return { canApprove, canCoSign: !canApprove || isSecretary };
};
const officialDocumentPeopleViewer = (actor: OfficialDocumentActor, sysadmin: boolean) => {
  if (sysadmin || OFFICIAL_PEOPLE_VIEWER_ROLES.has(String(actor.role || ''))) return true;
  const permissions = (actor as OfficialDocumentActor & { permissions?: Record<string, unknown> }).permissions || {};
  return permissions.official_document_people_view === true
    || permissions['officialdocs.people'] === true;
};

function departmentScope(rows: Array<{ dept_id?: unknown; parent_id?: unknown }>, rootId: unknown) {
  const root = id(rootId);
  const scope = new Set<string>();
  if (!root) return scope;
  scope.add(root);
  let changed = true;
  while (changed) {
    changed = false;
    rows.forEach(row => {
      const deptId = id(row.dept_id);
      const parentId = id(row.parent_id);
      if (deptId && parentId && scope.has(parentId) && !scope.has(deptId)) {
        scope.add(deptId);
        changed = true;
      }
    });
  }
  return scope;
}

// 公文流程節點以第一階「部／室」保存，但人員通常掛在其下的課／組／隊。
// 所有收文、簽收與通知都以這個範圍判斷，避免只比對根部門 ID 讓子單位人員永遠收不到。
function departmentContains(rows: Array<{ dept_id?: unknown; parent_id?: unknown }>, rootId: unknown, memberId: unknown) {
  const member = id(memberId);
  return Boolean(member && departmentScope(rows, rootId).has(member));
}

function departmentRole(value: { role?: unknown; rbac_role?: unknown } | null | undefined) {
  return text(value?.rbac_role || ({ admin: 'sysadmin', supervisor: 'unit_supervisor' } as Record<string, string>)[String(value?.role || '')] || value?.role, 40);
}

function namedDepartment(unit: { code?: unknown; name?: unknown } | null | undefined, codes: Set<string>, names: Set<string>) {
  const code = text(unit?.code, 40).toUpperCase();
  const name = text(unit?.name, 100).replace(/\s+/g, '');
  return Boolean((code && codes.has(code)) || (name && names.has(name)));
}

const officialDocumentEvent = async (
  db: SupabaseClient,
  actor: OfficialDocumentActor,
  documentId: string,
  action: string,
  idempotencyKey: string,
  fields: Record<string, unknown> = {},
) => {
  const { data, error } = await db.from('official_document_events').insert({
    document_id: documentId,
    actor_id: actor.user_id,
    actor_name: actor.name,
    actor_role: actor.role,
    actor_dept_id: actor.dept_id || null,
    actor_dept_name: actor.department || null,
    action,
    idempotency_key: idempotencyKey,
    ...fields,
  }).select('event_id').maybeSingle();
  if (error && String(error.code) === '23505') {
    const existing = await db.from('official_document_events').select('event_id').eq('idempotency_key', idempotencyKey).maybeSingle();
    return { duplicate: true, data: existing.data || null };
  }
  if (error) throw error;
  return { duplicate: false, data };
};

async function officialDocumentNotification(
  db: SupabaseClient,
  documentId: string,
  stepId: string | null,
  recipientId: string,
  notificationType: string,
  title: string,
  body: string,
  dueAt: string | null = null,
) {
  const row = { document_id: documentId, step_id: stepId, recipient_id: recipientId, notification_type: notificationType, title, body, due_at: dueAt };
  const { error } = await db.from('official_document_notifications').upsert(row, { onConflict: 'document_id,step_id,recipient_id,notification_type', ignoreDuplicates: true });
  if (error) console.warn('official document notification skipped:', error.message);
  const { error: legacyError } = await db.from('notifications').insert({
    recipient_id: recipientId, event: `official_document_${notificationType}`, title, body, document_id: documentId,
  });
  if (legacyError) console.warn('shared notification skipped:', legacyError.message);
}

async function countQuery(query: PromiseLike<{ count: number | null; error: { message: string } | null }>) {
  const result = await query;
  if (result.error) console.warn('Count query skipped:', result.error.message);
  return result.error ? 0 : (result.count || 0);
}

type ModuleSource={table:string;permission:string;title:string;order?:string;columns:Array<[string,string]>;filter?:[string,string]};
const source=(table:string,permission:string,title:string,columns:Array<[string,string]>,order?:string,filter?:[string,string]):ModuleSource=>({table,permission,title,columns,order,filter});
const MODULE_SOURCES:Record<string,ModuleSource>={
  'admin/users':source('users','admin','人員帳號',[['username','帳號'],['name','姓名'],['department','單位'],['role','基本角色'],['rbac_role','RBAC 角色'],['status','狀態'],['created_at','建立時間']],'created_at'),
  'admin/permissions':source('role_permissions','admin','角色權限',[['role_id','角色'],['perm','權限代碼'],['allowed','允許']]),
  'admin/locations':source('locations','admin','場域位置',[['floor','樓層'],['area','區域'],['detail','細部位置'],['status','狀態'],['created_at','建立時間']],'floor_order'),
  'admin/audit':source('audit_logs','admin','操作稽核',[['operated_at','操作時間'],['table_name','資源'],['action','動作'],['source','來源'],['operator_id','操作人員']],'operated_at'),
  'admin/alerts':source('security_alerts','admin','資安告警',[['last_seen_at','最後發生'],['severity','等級'],['title','標題'],['actor_identifier','操作帳號'],['event_count','次數'],['status','狀態']],'last_seen_at'),
  'admin/notices':source('notifications','admin','通知中心',[['created_at','時間'],['title','標題'],['body','內容'],['is_read','已讀']],'created_at'),
  'admin/layouts':source('dashboard_layouts','admin','戰情版面',[['layout_code','版面代碼'],['layout_name','版面名稱'],['status','狀態'],['updated_at','更新時間']],'updated_at'),
  'workorder/requests':source('repair_requests','workorder','報修案件',[['created_at','報修時間'],['req_no','案件編號'],['reporter','報修人'],['department','單位'],['fault_location','故障位置'],['fault_desc','故障說明'],['urgency','急迫度'],['status','狀態']],'created_at'),
  'workorder/dispatch':source('repair_requests','workorder','派工作業',[['request_id','案件識別碼'],['updated_at','更新時間'],['req_no','案件編號'],['fault_location','位置'],['fault_desc','故障說明'],['assignee_id','指派人員'],['desired_finish','期望完成'],['status','狀態']],'updated_at'),
  'workorder/orders':source('maintenance_orders','workorder','維修工單',[['created_at','建立時間'],['order_id','工單 ID'],['request_id','報修 ID'],['assignee_id','維修人員'],['start_time','開始'],['finish_time','完成'],['status','狀態'],['result_desc','處理結果']],'created_at'),
  'workorder/attachments':source('repair_attachments','workorder','維修附件',[['uploaded_at','上傳時間'],['request_id','報修 ID'],['order_id','工單 ID'],['file_name','檔名'],['file_path','儲存路徑'],['kind','類型']],'uploaded_at'),
  'workorder/analytics':source('repair_requests','workorder','維修分析資料',[['created_at','報修時間'],['req_no','案件編號'],['department','單位'],['fault_type','故障類型'],['urgency','急迫度'],['status','狀態']],'created_at'),
  'guardpatrol/checkins':source('checkin_logs','guardpatrol','巡邏打卡',[['checkin_at','打卡時間'],['user_name','巡檢人員'],['floor_id','樓層'],['label','巡邏點'],['target_type','類型'],['checkin_source','簽到方式']],'checkin_at'),
  'guardpatrol/points':source('plan_markers','guardpatrol','巡邏點清單',[['floor_id','樓層'],['label','巡邏點'],['kind','類型'],['note','巡檢說明'],['status','狀態'],['updated_at','更新時間']],'updated_at',['kind','patrol']),
  'guardpatrol/shifts':source('patrol_shifts','guardpatrol','巡檢排班',[['shift_date','日期'],['name','班別'],['start_time','開始'],['end_time','結束'],['assigned_user_ids','排定人員']],'shift_date'),
  'guardpatrol/notifications':source('patrol_timeout_notifications','guardpatrol','逾時推播',[['shift_date','日期'],['shift_name','班別'],['expected_count','應巡'],['checked_count','已巡'],['unchecked_count','未巡'],['status','狀態'],['sent_at','發送時間']],'shift_date'),
  'guardpatrol/records':source('inspection_records','guardpatrol','設備巡檢',[['inspect_time','巡檢時間'],['equipment_id','設備'],['inspector_id','巡檢人員'],['location_point','位置'],['run_status','結果'],['abnormal_note','異常說明']],'inspect_time'),
  'guardpatrol/map3d':source('plan_markers','guardpatrol','3D 巡檢點',[['floor_id','樓層'],['label','名稱'],['kind','類型'],['x','X'],['y','Y'],['status','狀態']],'floor_id'),
  'handover/records':source('handover_records','handover','交接紀錄',[['shift_date','日期'],['shift_type','班別'],['issues','異常事項'],['pending','待辦'],['notes','備註'],['status','狀態'],['created_at','建立時間']],'shift_date'),
  'handover/open-items':source('handover_records','handover','未結事項',[['shift_date','日期'],['shift_type','班別'],['pending','待辦'],['issues','異常事項'],['status','狀態']],'shift_date'),
  'handover/equipment':source('equipment','handover','設備概況',[['asset_code','資產碼'],['name','設備'],['floor','樓層'],['category','分類'],['status','狀態'],['next_maintenance_on','下次保養']],'name'),
  'equipment/assets':source('equipment','equipment','設備主檔',[['asset_code','資產碼'],['name','設備名稱'],['category','分類'],['floor','樓層'],['brand','廠牌'],['model','型號'],['criticality','關鍵度'],['status','狀態']],'name'),
  'equipment/plans':source('equipment_maintenance_plans','equipment','保養排程',[['equipment_id','設備'],['item_name','保養項目'],['maintenance_type','類型'],['cycle_text','週期'],['next_due_on','下次日期'],['responsible_name','負責人'],['status','狀態']],'next_due_on'),
  'equipment/records':source('equipment_maintenance_records','equipment','維修履歷',[['performed_on','日期'],['equipment_id','設備'],['record_type','類型'],['technician','技術人員'],['maintenance_cost','維護費用'],['result','結果']],'performed_on'),
  'equipment/contracts':source('equipment_contracts','equipment','維護合約',[['equipment_id','設備'],['contract_no','合約編號'],['vendor','廠商'],['starts_on','開始'],['ends_on','結束'],['status','狀態']],'ends_on'),
  'equipment/documents':source('equipment_documents','equipment','設備文件',[['equipment_id','設備'],['document_type','類型'],['title','文件'],['file_url','檔案位置'],['created_at','建立時間']],'created_at'),
  'equipment/costs':source('equipment_annual_costs','equipment','年度成本',[['fiscal_year','年度'],['equipment_id','設備'],['repair_cost','維修費'],['maintenance_cost','保養費'],['parts_cost','零件費'],['downtime_loss','停機損失']],'fiscal_year'),
  'equipment/monitoring':source('equipment_monitor_events','equipment','中央監控事件',[['occurred_at','發生時間'],['equipment_id','設備'],['event_code','事件代碼'],['title','事件'],['severity','等級'],['message','內容'],['event_state','狀態']],'occurred_at'),
  'equipment/materials':source('materials','equipment','材料主檔',[['material_code','材料碼'],['material_name','材料名稱'],['category_id','分類'],['unit','單位'],['current_stock','庫存'],['status','狀態'],['updated_at','更新時間']],'material_name'),
  'structuremap/areas':source('floor_spaces','structuremap','區域位置表',[['floor','樓層'],['space_name','空間'],['note','備註'],['status','狀態'],['updated_at','更新時間']],'floor_order'),
  'structuremap/markers':source('plan_markers','structuremap','整合標記',[['floor_id','樓層'],['kind','類型'],['label','名稱'],['equipment_id','設備'],['repair_id','報修'],['status','狀態']],'floor_id'),
  'structuremap/floor2d':source('plan_markers','structuremap','2D 平面標記',[['floor_id','樓層'],['label','名稱'],['kind','類型'],['x','X'],['y','Y'],['color','顏色']],'floor_id'),
  'structuremap/floor3d':source('floor_models','structuremap','3D 樓層模型',[['floor_id','樓層'],['name','模型名稱'],['image_path','平面材質'],['level','樓層高度'],['updated_at','更新時間']],'floor_id'),
  'structuremap/models':source('floor_models','structuremap','模型管理',[['floor_id','樓層'],['name','模型名稱'],['image_path','平面材質'],['bbox','模型範圍'],['updated_at','更新時間']],'updated_at'),
  'structuremap/relations':source('locations','structuremap','專案關係資料',[['floor','樓層'],['area','區域'],['detail','細部位置'],['status','狀態']],'floor_order'),
  'vehicle/requests':source('vehicle_dispatch_requests','vehicle','派車申請',[['application_date','申請日'],['request_no','申請編號'],['applicant_name','申請人'],['trip_date','用車日'],['destination_location','目的地'],['trip_purpose','用途'],['plate_no','車號'],['driver_name','駕駛'],['status','狀態']],'application_date'),
  'vehicle/vehicles':source('official_vehicles','vehicle','公務車輛',[['plate_no','車號'],['vehicle_name','車名'],['brand','廠牌'],['model','型號'],['seats','座位'],['current_odometer','目前里程'],['status','狀態']],'plate_no'),
  'vehicle/drivers':source('vehicle_dispatch_drivers','vehicle','駕駛人員',[['user_id','人員 ID'],['active','啟用'],['assigned_by','設定人員'],['assigned_at','設定時間'],['updated_at','更新時間']],'updated_at'),
  'vehicle/managers':source('vehicle_dispatch_managers','vehicle','派車管理員',[['user_id','人員 ID'],['active','啟用'],['assigned_by','設定人員'],['assigned_at','設定時間'],['updated_at','更新時間']],'updated_at'),
  'vehicle/logs':source('vehicle_dispatch_logs','vehicle','派車紀錄',[['created_at','時間'],['request_id','申請 ID'],['from_status','原狀態'],['to_status','新狀態'],['action','動作'],['note','備註']],'created_at'),
  'meetingroom/bookings':source('meeting_bookings','meetingroom','會議預約',[['booking_date','日期'],['booking_no','預約編號'],['purpose','用途'],['start_time','開始'],['end_time','結束'],['status','狀態'],['created_at','建立時間']],'booking_date'),
  'meetingroom/rooms':source('meeting_rooms','meetingroom','會議室主檔',[['name','會議室'],['capacity','容量'],['floor','樓層'],['note','備註'],['status','狀態']],'name'),
  'meetingroom/changes':source('meeting_booking_change_requests','meetingroom','變更申請',[['created_at','申請時間'],['target_booking_id','原預約'],['requested_meeting_name','申請會議'],['reason','原因'],['status','狀態']],'created_at'),
  'meetingroom/notifications':source('meeting_booking_notifications','meetingroom','預約提醒',[['created_at','建立時間'],['booking_id','預約'],['notification_type','類型'],['sent_at','發送時間'],['status','狀態']],'created_at'),
};

// SYS-05 設備八模組寫入的欄位白名單（對應 equipment-workspace.tsx 的 SPECS.fields）。
type EquipmentFieldType = 'text' | 'number' | 'boolean';
type EquipmentTableConfig = { pk: string; createdBy?: string; updatedBy?: string; fields: Record<string, { type?: EquipmentFieldType }> };
const EQUIPMENT_TABLES: Record<string, EquipmentTableConfig> = {
  equipment: {
    pk: 'equipment_id', createdBy: 'created_by', updatedBy: 'updated_by',
    fields: {
      asset_code: {}, name: {}, category: {}, floor: {}, location: {}, department: {},
      brand: {}, model: {}, serial_no: {}, manufactured_year: { type: 'number' },
      installed_on: {}, accepted_on: {}, service_life_y: { type: 'number' }, voltage: {},
      power_kw: { type: 'number' }, criticality: {}, status: {}, original_manufacturer: {},
      original_contact: {}, original_phone: {}, distributor: {}, distributor_contact: {},
      distributor_phone: {}, warranty_from: {}, warranty_until: {}, has_maintenance_contract: { type: 'boolean' },
      maintenance_vendor: {}, maintenance_cycle: {}, last_maintenance_on: {}, next_maintenance_on: {},
      responsible_name: {}, emergency_phone: {}, remarks: {},
    },
  },
  equipment_maintenance_plans: {
    pk: 'plan_id', createdBy: 'created_by', updatedBy: 'updated_by',
    fields: {
      equipment_id: {}, item_name: {}, maintenance_type: {}, cycle_text: {},
      interval_value: { type: 'number' }, interval_unit: {}, responsible_name: {},
      last_performed_on: {}, next_due_on: {}, last_result: {}, status: {}, note: {},
    },
  },
  equipment_maintenance_records: {
    pk: 'record_id', createdBy: 'created_by',
    fields: {
      equipment_id: {}, record_type: {}, performed_on: {}, technician: {}, result: {},
      fault_description: {}, fault_cause: {}, action_taken: {}, replacement_parts: {},
      downtime_hours: { type: 'number' }, maintenance_cost: { type: 'number' },
      parts_cost: { type: 'number' }, downtime_loss: { type: 'number' }, next_due_on: {}, note: {},
    },
  },
  equipment_contracts: {
    pk: 'contract_id', createdBy: 'created_by', updatedBy: 'updated_by',
    fields: {
      equipment_id: {}, vendor: {}, contract_no: {}, contact_name: {}, contact_phone: {},
      starts_on: {}, ends_on: {}, sla_hours: { type: 'number' }, contract_amount: { type: 'number' },
      status: {}, service_scope: {}, note: {},
    },
  },
  equipment_documents: {
    pk: 'document_id', createdBy: 'uploaded_by',
    fields: {
      equipment_id: {}, document_type: {}, title: {}, version: {}, effective_on: {},
      expires_on: {}, is_current: { type: 'boolean' }, file_url: {}, note: {},
    },
  },
  equipment_annual_costs: {
    pk: 'annual_cost_id', createdBy: 'created_by', updatedBy: 'updated_by',
    fields: {
      equipment_id: {}, fiscal_year: { type: 'number' }, source: {},
      repair_cost: { type: 'number' }, maintenance_cost: { type: 'number' },
      parts_cost: { type: 'number' }, downtime_loss: { type: 'number' }, note: {},
    },
  },
  materials: {
    pk: 'material_id', createdBy: 'created_by', updatedBy: 'updated_by',
    fields: {
      category_id: {}, material_code: {}, material_name: {}, material_alias: {},
      sub_category: {}, material_type: {}, floor: {}, brand: {}, manufacturer: {}, model: {},
      specification: {}, unit: {}, size: {}, voltage: {}, power: {}, supplier: {},
      purchase_price: { type: 'number' }, status: {},
    },
  },
};

export async function handleAppApiRequest(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'POST') return reply(req, { ok: false, message: 'Method not allowed' }, 405);
  const securityEventRequestId = nextRequestRequestId();

  try {
    const authorization = req.headers.get('authorization') || '';
    const token = authorization.replace(/^Bearer\s+/i, '').trim();

    // SYS-12 市場公開看板：免登入的唯讀行情。只回聚合行情與看板訊息，走 IP 限流，
    // 不觸及任何使用者資料。必須放在使用者驗證之前。
    const publicAction = text((await req.clone().json().catch(() => ({})))?.action, 40);
    if (publicAction === 'market_board_public') {
      const publicAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
      // 公開看板可能被整個辦公室的多台裝置共用一個對外 IP，用較寬的 app-api
      // 額度（60 次/分）而不是 dashboard 的 12 次/分，避免正常投放被誤擋。
      const publicRate = await enforceDurableRateLimit(publicAdmin, req, {
        subject: `market-board-public:${extractClientIp(req) || 'unknown'}`,
        scope: 'app-api',
        requestId: securityEventRequestId,
      });
      if (publicRate.error) {
        console.error('market board public rate limit failed:', publicRate.error.message);
        return reply(req, { ok: false, message: '安全限流服務暫時無法使用' }, 503);
      }
      if (!publicRate.allowed) {
        return reply(req, { ok: false, message: '請求過於頻繁，請稍後再試', request_id: securityEventRequestId }, 429);
      }
      const board = await buildMarketBoardPayload(publicAdmin, { publicView: true });
      return board.ok ? reply(req, { ok: true, data: board.data }) : reply(req, { ok: false, message: board.message }, board.status);
    }

    if (!token) return reply(req, { ok: false, message: '未登入' }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: authData, error: authError } = await admin.auth.getUser(token);
    if (authError || !authData.user) return reply(req, { ok: false, message: '登入狀態無效' }, 401);

    const globalRate = await enforceDurableRateLimit(admin, req, {
      subject: authData.user.id,
      scope: 'app-api',
      requestId: securityEventRequestId,
    });
    if (globalRate.error) {
      console.error('app-api rate limit failed:', globalRate.error.message);
      return reply(req, { ok: false, message: '安全限流服務暫時無法使用' }, 503);
    }
    if (!globalRate.allowed) {
      const { data: rateProfile } = await admin.from('users')
        .select('user_id,username,email,name').eq('auth_id', authData.user.id).maybeSingle();
      try {
        await recordRateLimitDenial(admin, req, {
          scope: 'app-api', requestId: securityEventRequestId, profile: rateProfile,
          eventCount: globalRate.requestCount,
          historyAlreadyRecorded: globalRate.durable,
          title: 'API 異常流量已阻擋',
        });
      } catch (alertError) {
        console.error('app-api rate-limit alert failed:', alertError instanceof Error ? alertError.message : String(alertError));
      }
      return reply(req, { ok: false, message: '請求過於頻繁，請稍後再試', request_id: securityEventRequestId }, 429);
    }

    const { data: profile, error: profileError } = await admin.from('users')
      .select('user_id,username,email,name,phone,department,dept_id,role,rbac_role,supervisor_id,status,permissions')
      .eq('auth_id', authData.user.id).eq('status', 'active').maybeSingle();
    if (profileError || !profile) return reply(req, { ok: false, message: '找不到啟用中的系統帳號' }, 403);
    // users.department 只是依 dept_id 從 departments 查出來後寫回的副本，兩者可能不同步。
    // 以 dept_id 解析完整組織路徑，讓頁首與報修表單都顯示一階／二階單位（例如「管理部 / 總務課」）。
    if (profile.dept_id || text(profile.department, 100)) {
      const { data: departmentRows } = await admin.from('departments')
        .select('dept_id,parent_id,name').eq('status', 'active').limit(5000);
      const departmentPaths = buildDepartmentPaths((departmentRows || []) as DepartmentNode[]);
      const path = departmentPaths.pathForId(profile.dept_id)
        || formatDepartment(profile.department, departmentPaths.byName);
      if (path) profile.department = path;
    }
    if (!text(profile.department, 100) && profile.dept_id) {
      const { data: dept } = await admin.from('departments').select('name').eq('dept_id', profile.dept_id).maybeSingle();
      if (dept?.name) profile.department = dept.name;
    }

    const roleId = profile.rbac_role || ({ admin: 'sysadmin', supervisor: 'unit_supervisor', maintenance: 'technician', inspector: 'reporter' } as Record<string, string>)[profile.role] || profile.role;
    const isSysadmin = roleId === 'sysadmin' || profile.role === 'admin';
    const { data: permissions } = await admin.from('role_permissions').select('perm,allowed').eq('role_id', roleId).eq('allowed', true);
    const allowedSystems = new Set((permissions || []).filter(row => String(row.perm).startsWith('sys_')).map(row => String(row.perm).replace(/^sys_/, '')));
    const can = (system: string) => isSysadmin || allowedSystems.has(system);
    const isAdmin = profile.role === 'admin' || ['admin', 'sysadmin'].includes(String(profile.rbac_role || ''));
    const roleCanManageMarket = (permissions || []).some(row => String(row.perm) === 'marketanalytics_manage');

    const userDb = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const body = await req.json().catch(() => ({}));
    const action = text(body.action, 40);
    const actionScope = ({
      module_data: 'app-api:module_data',
      dashboard: 'app-api:dashboard',
      inspections: 'app-api:inspections',
      equipment_map: 'app-api:equipment_map',
      update_personal_profile: 'admin-api:write',
      change_password: 'admin-api:write',
      open_inspection_cycle: 'admin-api:write',
      create_cost_record: 'admin-api:write',
      save_official_vehicle: 'admin-api:write',
      vehicle_create_request: 'admin-api:write',
      vehicle_roster_update: 'admin-api:write',
      vehicle_roster_remove_all: 'admin-api:write',
      patrol_shift_delete: 'admin-api:write',
      handover_save: 'admin-api:write',
      equipment_save: 'admin-api:write',
      area_save: 'admin-api:write',
      marker_save: 'admin-api:write',
      field_pilot_save: 'admin-api:write',
      save_floor_model: 'admin-api:write',
      move_structuremap_marker: 'admin-api:write',
      guardpatrol_checkin: 'patrol-checkin',
      // 沿用已部署的限流範圍；專用名稱需另行改 DB function，不能讓新功能
      // 因未知 scope 被整體拒絕。寫入仍套用既有較嚴格的 admin-api:write 門檻。
      official_documents: 'app-api',
      official_document_create: 'admin-api:write',
      official_document_action: 'admin-api:write',
      workorder_list: 'app-api',
      workorder_prepare_upload: 'app-api',
      workorder_options: 'app-api',
      workorder_detail: 'app-api',
      workorder_create_request: 'admin-api:write',
      workorder_workflow: 'admin-api:write',
      market_catalog: 'app-api',
      market_dimension_catalog: 'app-api',
      market_analysis: 'app-api',
      dashboard_market_rotation: 'app-api:dashboard',
      market_simulation_list: 'app-api',
      market_simulation_save: 'admin-api:write',
      market_source_save: 'admin-api:write',
      market_template_save: 'admin-api:write',
      market_import_rows: 'admin-api:write',
    } as Record<string, string>)[action];
    if (actionScope) {
      const actionRate = await enforceDurableRateLimit(admin, req, {
        subject: authData.user.id,
        scope: actionScope,
        actorId: profile.user_id,
        requestId: securityEventRequestId,
      });
      if (actionRate.error) {
        console.error(`${actionScope} rate limit failed:`, actionRate.error.message);
        return reply(req, { ok: false, message: '安全限流服務暫時無法使用' }, 503);
      }
      if (!actionRate.allowed) {
        try {
          await recordRateLimitDenial(admin, req, {
            scope: actionScope,
            requestId: securityEventRequestId,
            profile,
            eventCount: actionRate.requestCount,
            historyAlreadyRecorded: actionRate.durable,
            title: '功能請求異常頻繁，已阻擋',
          });
        } catch (alertError) {
          console.error(`${actionScope} rate-limit alert failed:`, alertError instanceof Error ? alertError.message : String(alertError));
        }
        return reply(req, { ok: false, message: '請求過於頻繁，請稍後再試', request_id: securityEventRequestId }, 429);
      }
    }

    if (action === 'profile') {
      return reply(req, { ok: true, data: { ...profile, email: profile.email || authData.user.email || '', allowed_systems: isSysadmin ? ['*'] : [...allowedSystems] } });
    }

    if (action === 'update_personal_profile') {
      const name = text(body.name, 100);
      const phone = text(body.phone, 40);
      if (name.length < 2) return reply(req, { ok: false, message: '姓名至少需要 2 個字元' }, 400);
      if (phone && !/^[0-9()#+*\-\s]{4,40}$/.test(phone)) return reply(req, { ok: false, message: '聯絡電話格式不正確' }, 400);
      const before = { name: profile.name, phone: profile.phone || null };
      const { data: updated, error } = await admin.from('users')
        .update({ name, phone: phone || null })
        .eq('user_id', profile.user_id).eq('status', 'active')
        .select('user_id,username,email,name,phone,department,role,rbac_role,status').single();
      if (error || !updated) return reply(req, { ok: false, message: '個人資料更新失敗' }, 500);
      await writeAudit(admin, profile.user_id, 'users', profile.user_id, 'update', before, { name: updated.name, phone: updated.phone });
      return reply(req, { ok: true, data: { ...updated, email: updated.email || authData.user.email || '', allowed_systems: isSysadmin ? ['*'] : [...allowedSystems] } });
    }

    if (action === 'change_password') {
      const password = String(body.password || '');
      const passwordError = passwordPolicyMessage(password);
      if (passwordError) return reply(req, { ok: false, message: passwordError }, 400);
      const { error } = await admin.auth.admin.updateUserById(authData.user.id, { password });
      if (error) return reply(req, { ok: false, message: '密碼更新失敗，請確認密碼格式後再試' }, 400);
      await writeAudit(admin, profile.user_id, 'users', profile.user_id, 'update', null, { event_type: 'password_change' });
      return reply(req, { ok: true, message: '密碼已更新' });
    }

    // ---- SYS-09 公文傳送流程 ---------------------------------------------
    // 2026-08-26：公文動作由 Edge／Node 共用這份 handler，部署時兩端需同步更新。
    // 公文流程的讀寫集中在這裡，前端不直接取得服務角色。每個動作都重新檢查
    // 目前節點、部室與角色，並以狀態條件更新避免兩個視窗同時收文／簽收。
    if (action === 'official_documents') {
      if (!can('officialdocs')) return reply(req, { ok: false, message: '目前角色沒有公文傳送系統權限' }, 403);
      const lookup = text(body.lookup, 200).toLocaleLowerCase();
      const [documentResult, departmentResult, peopleResult] = await Promise.all([
        admin.from('official_documents').select('document_id,document_no,document_type,subject,originator_id,originator_dept_id,responsible_dept_id,responsible_user_id,status,current_step_id,barcode_value,created_at,updated_at,closed_at').order('updated_at', { ascending: false }).limit(500),
        admin.from('departments').select('dept_id,parent_id,name,code,level').eq('status', 'active').order('sort_order').order('name').limit(500),
        admin.from('users').select('user_id,name,dept_id,role,rbac_role,supervisor_id,department').eq('status', 'active').order('name').limit(1000),
      ]);
      if (documentResult.error) throw documentResult.error;
      if (departmentResult.error) throw departmentResult.error;
      if (peopleResult.error) throw peopleResult.error;
      const allDocuments = (documentResult.data || []) as Array<Record<string, unknown>>;
      const allDepartments = (departmentResult.data || []) as Array<Record<string, unknown>>;
      const rootDepartments = allDepartments.filter(row => !id(row.parent_id));
      const departmentPaths = buildDepartmentPaths(allDepartments as DepartmentNode[]);
      const allPeople = (peopleResult.data || []) as Array<Record<string, unknown>>;
      const actor = { ...profile, role: roleId, permissions: profile.permissions || {} } as OfficialDocumentActor & { permissions?: Record<string, unknown> };
      const peopleViewer = officialDocumentPeopleViewer(actor, isSysadmin);
      const actorScope = departmentScope(allDepartments, profile.dept_id);
      const scopeRootIds = isAdmin
        ? new Set(rootDepartments.map(row => id(row.dept_id)).filter(Boolean))
        : new Set(Array.from(actorScope).map(deptId => id(departmentPaths.rootForId(deptId)?.dept_id)).filter(Boolean));
      const visibleRootDepartments = rootDepartments.filter(row => scopeRootIds.has(id(row.dept_id)));
      const currentRootDepartment = departmentPaths.rootForId(profile.dept_id);
      const routingScopeCache = new Map<string, Set<string>>();
      const routingScope = (unitId: unknown) => {
        const key = id(unitId);
        if (!key) return new Set<string>();
        const cached = routingScopeCache.get(key);
        if (cached) return cached;
        const scope = departmentScope(allDepartments, key);
        routingScopeCache.set(key, scope);
        return scope;
      };
      const rootUnit = (deptId: unknown) => departmentPaths.rootForId(deptId) as Record<string, unknown> | null;
      const isSecretaryUnit = (deptId: unknown) => namedDepartment(rootUnit(deptId), OFFICIAL_SECRETARY_UNIT_CODES, OFFICIAL_SECRETARY_UNIT_NAMES);
      const isDeputyGmUnit = (deptId: unknown) => namedDepartment(rootUnit(deptId), OFFICIAL_DEPUTY_GM_UNIT_CODES, OFFICIAL_DEPUTY_GM_UNIT_NAMES);
      const actorSupervisor = allPeople.find(person => id(person.user_id) === id(profile.supervisor_id));
      const delegatedApprovalForActor = (step: Record<string, unknown> | null | undefined) => Boolean(
        step?.step_type === 'approval'
        && isSecretaryUnit(profile.dept_id)
        && isDeputyGmUnit(step.unit_id)
        && actorSupervisor
        && ['unit_supervisor', 'sysadmin'].includes(departmentRole(actorSupervisor))
        && departmentContains(allDepartments, step.unit_id, actorSupervisor.dept_id),
      );
      const ids = allDocuments.map(row => id(row.document_id)).filter(Boolean);
      const steps: Array<Record<string, unknown>> = [];
      const events: Array<Record<string, unknown>> = [];
      for (let index = 0; index < ids.length; index += 100) {
        const chunk = ids.slice(index, index + 100);
        const [stepResult, eventResult] = await Promise.all([
          admin.from('official_document_steps').select('step_id,document_id,step_no,step_type,unit_id,unit_name,status,sent_by,sent_at,received_by,received_at,completed_by,completed_at,note,created_at').in('document_id', chunk).order('step_no'),
          admin.from('official_document_events').select('event_id,document_id,step_id,action,from_status,to_status,actor_id,actor_name,actor_role,actor_dept_name,target_unit_id,note,details,occurred_at').in('document_id', chunk).order('occurred_at'),
        ]);
        if (stepResult.error) throw stepResult.error;
        if (eventResult.error) throw eventResult.error;
        steps.push(...((stepResult.data || []) as Array<Record<string, unknown>>));
        events.push(...((eventResult.data || []) as Array<Record<string, unknown>>));
      }
      const stepsByDocument = new Map<string, Array<Record<string, unknown>>>();
      steps.forEach(step => { const key = id(step.document_id); if (!key) return; const list = stepsByDocument.get(key) || []; list.push(step); stepsByDocument.set(key, list); });
      const eventsByDocument = new Map<string, Array<Record<string, unknown>>>();
      events.forEach(event => { const key = id(event.document_id); if (!key) return; const list = eventsByDocument.get(key) || []; list.push(event); eventsByDocument.set(key, list); });
      const visible = allDocuments.filter(row => {
        const documentId = id(row.document_id);
        const documentSteps = stepsByDocument.get(documentId) || [];
        const currentDocumentStep = documentSteps.find(step => String(step.step_id || '') === String(row.current_step_id || ''));
        // 收文／簽收是目前節點的單位作業；只要登入者屬於該部／室或其子單位，
        // 即使不是主管或公文管理角色，也必須看得到這筆待處理公文。
        const incomingForActor = Boolean(
          currentDocumentStep && profile.dept_id
          && routingScope(currentDocumentStep.unit_id).has(String(profile.dept_id)),
        ) || delegatedApprovalForActor(currentDocumentStep);
        const originatorUnitForActor = Boolean(
          row.status === 'awaiting_originator' && profile.dept_id && row.originator_dept_id
          && id(departmentPaths.rootForId(row.originator_dept_id)?.dept_id)
          && id(departmentPaths.rootForId(profile.dept_id)?.dept_id)
          && id(departmentPaths.rootForId(row.originator_dept_id)?.dept_id)
            === id(departmentPaths.rootForId(profile.dept_id)?.dept_id),
        );
        const inUnitScope = peopleViewer && (isAdmin || actorScope.has(String(row.originator_dept_id || ''))
          || documentSteps.some(step => actorScope.has(String(step.unit_id || ''))));
        const ownDocument = String(row.originator_id || '') === String(profile.user_id);
        const textMatch = !lookup || [row.document_no, row.subject, row.barcode_value].some(value => String(value || '').toLocaleLowerCase().includes(lookup));
        return textMatch && (isAdmin || incomingForActor || originatorUnitForActor || inUnitScope || ownDocument);
      });
      const visiblePeople = isAdmin
        ? allPeople
        : peopleViewer
          ? allPeople.filter(row => actorScope.has(String(row.dept_id || '')))
          : allPeople.filter(row => String(row.user_id) === String(profile.user_id));
      const names = new Map<string, string>(visiblePeople.map(row => [String(row.user_id), text(row.name, 100)]));
      return reply(req, { ok: true, data: {
        documents: visible.map(row => ({
          ...row,
          originator_name: names.get(String(row.originator_id)) || '',
          originator_department: departmentPaths.pathForId(row.originator_dept_id) || null,
          originator_root_department: text(departmentPaths.rootForId(row.originator_dept_id)?.name, 100) || null,
          originator_root_department_id: id(departmentPaths.rootForId(row.originator_dept_id)?.dept_id) || null,
          steps: stepsByDocument.get(id(row.document_id)) || [],
          events: eventsByDocument.get(id(row.document_id)) || [],
        })),
        // 路由下拉選單只需要第一階部／室；名稱可供所有 SYS-09 使用者選擇，
        // 第二階單位仍只回傳目前帳號所屬範圍，避免人員資料跨單位曝光。
        departments: allDepartments.filter(row => isAdmin || !id(row.parent_id) || actorScope.has(id(row.dept_id))),
        scope_root_departments: visibleRootDepartments,
        current_root_department: currentRootDepartment ? {
          dept_id: id(currentRootDepartment.dept_id),
          parent_id: id(currentRootDepartment.parent_id) || null,
          name: text(currentRootDepartment.name, 100),
          code: text(currentRootDepartment.code, 100) || null,
          level: Number(currentRootDepartment.level || 1),
        } : null,
        actor_supervisor_dept_id: id(actorSupervisor?.dept_id) || null,
        people: visiblePeople.map(row => ({
          ...row,
          department: departmentPaths.pathForId(row.dept_id) || formatDepartment(row.department, departmentPaths.byName) || null,
          department_root: text(departmentPaths.rootForId(row.dept_id)?.name, 100) || null,
          department_root_id: id(departmentPaths.rootForId(row.dept_id)?.dept_id) || null,
          department_level: Number(departmentPaths.byId.get(id(row.dept_id))?.level || 0) || (id(departmentPaths.byId.get(id(row.dept_id))?.parent_id) ? 2 : 1),
        })),
      } });
    }

    if (action === 'official_document_create') {
      if (!can('officialdocs')) return reply(req, { ok: false, message: '目前角色沒有公文傳送系統權限' }, 403);
      const createActor = { ...profile, role: roleId } as OfficialDocumentActor;
      const subject = text(body.subject, 300);
      if (!subject) return reply(req, { ok: false, message: '公文主旨不可空白' }, 400);
      const rawDocumentNo = String(body.document_no ?? '').trim();
      if (rawDocumentNo.length > 100) return reply(req, { ok: false, message: '文號不可超過 100 個字元' }, 400);
      if (/[\u0000-\u001f\u007f]/.test(rawDocumentNo)) return reply(req, { ok: false, message: '文號不可包含控制字元或換行' }, 400);
      const requestedDocumentNo = rawDocumentNo;
      const documentType = text(body.document_type, 20) || 'official_document';
      if (!['official_document', 'purchase_order', 'other'].includes(documentType)) return reply(req, { ok: false, message: '文件類別不正確' }, 400);
      const responsibleDeptId = id(body.responsible_dept_id) || id(profile.dept_id);
      const responsibleUserId = id(body.responsible_user_id) || id(profile.user_id);
      const accessibleDepartments = departmentScope((await admin.from('departments').select('dept_id,parent_id').eq('status', 'active')).data || [], profile.dept_id);
      if (!isAdmin && !accessibleDepartments.has(responsibleDeptId)) return reply(req, { ok: false, message: '只能選擇登入者部／室所屬的課／組／隊' }, 403);
      const responsiblePerson = await admin.from('users').select('user_id,dept_id,status').eq('user_id', responsibleUserId).eq('status', 'active').maybeSingle();
      if (responsiblePerson.error) throw responsiblePerson.error;
      if (!responsiblePerson.data || id(responsiblePerson.data.dept_id) !== responsibleDeptId) return reply(req, { ok: false, message: '承辦人員不屬於所選課／組／隊' }, 400);
      const documentId = nextRequestRequestId();
      const dateKey = taipeiRocDateKey();
      let serialHint = 1;
      let documentNo = requestedDocumentNo;
      let barcode = '';
      let createdData: Record<string, unknown> | null = null;
      let lastCreateError: { code?: string; message?: string } | null = null;
      const maximumAttempts = requestedDocumentNo ? 1 : 1000;
      for (let attemptNo = 0; attemptNo < maximumAttempts && !createdData; attemptNo += 1) {
        if (!requestedDocumentNo) documentNo = await nextOfficialDocumentNo(admin, dateKey, serialHint);
        barcode = documentNo;
        const created = await admin.from('official_documents').insert({
          document_id: documentId,
          document_no: documentNo,
          document_type: documentType,
          subject,
          originator_id: profile.user_id,
          originator_dept_id: profile.dept_id || null,
          responsible_dept_id: responsibleDeptId,
          responsible_user_id: responsibleUserId,
          status: 'draft',
          barcode_value: barcode,
        }).select('document_id,document_no,subject,status,barcode_value,created_at').single();
        if (!created.error && created.data) {
          createdData = created.data as Record<string, unknown>;
          break;
        }
        lastCreateError = created.error;
        if (String(created.error?.code) !== '23505') throw created.error;
        if (requestedDocumentNo) return reply(req, { ok: false, message: '此文號已存在，請確認後輸入其他文號' }, 409);
        serialHint = Number(documentNo.slice(-4)) + 1;
      }
      if (!createdData) {
        if (lastCreateError) throw lastCreateError;
        return reply(req, { ok: false, message: '今日公文編號已達 9999 號，請聯絡系統管理員' }, 409);
      }
      await officialDocumentEvent(admin, createActor, documentId, 'create', `${documentId}:create`, { to_status: 'draft', note: '建立公文' });
      await officialDocumentEvent(admin, createActor, documentId, 'barcode_generated', `${documentId}:barcode`, { to_status: 'draft', note: '建立公文文號', details: { barcode_value: barcode } });
      return reply(req, { ok: true, data: createdData });
    }

    if (action === 'official_document_action') {
      if (!can('officialdocs')) return reply(req, { ok: false, message: '目前角色沒有公文傳送系統權限' }, 403);
      const documentId = id(body.document_id);
      const documentAction = text(body.document_action, 40);
      const note = text(body.note, 1000) || null;
      const idempotencyKey = text(body.idempotency_key, 120) || nextRequestRequestId();
      const targetUnitId = id(body.target_unit_id);
      const documentResult = await admin.from('official_documents').select('document_id,document_no,subject,originator_id,originator_dept_id,status,current_step_id,barcode_value').eq('document_id', documentId).maybeSingle();
      if (documentResult.error) throw documentResult.error;
      const document = documentResult.data as Record<string, unknown> | null;
      if (!document) return reply(req, { ok: false, message: '找不到這筆公文' }, 404);
      const prior = await admin.from('official_document_events').select('event_id,action,to_status').eq('idempotency_key', idempotencyKey).maybeSingle();
      if (prior.data) return reply(req, { ok: true, data: { duplicate: true, status: document.status, event_id: prior.data.event_id } });
      const stepResult = await admin.from('official_document_steps').select('step_id,document_id,step_no,step_type,unit_id,unit_name,status,sent_at,received_at,completed_at').eq('document_id', documentId).order('step_no', { ascending: false });
      if (stepResult.error) throw stepResult.error;
      const steps = (stepResult.data || []) as Array<Record<string, unknown>>;
      const currentStep = steps.find(step => String(step.step_id) === String(document.current_step_id)) || null;
      const role = roleId;
      const actor = { ...profile, role } as OfficialDocumentActor;
      const departmentsForScope = await admin.from('departments').select('dept_id,parent_id,name,code').eq('status', 'active').limit(1000);
      if (departmentsForScope.error) throw departmentsForScope.error;
      const departmentRows = (departmentsForScope.data || []) as Array<Record<string, unknown>>;
      const rootDepartmentId = (deptId: unknown) => {
        let current = id(deptId);
        const seen = new Set<string>();
        while (current && !seen.has(current)) {
          seen.add(current);
          const row = departmentRows.find(item => id(item.dept_id) === current);
          const parent = id(row?.parent_id);
          if (!parent) return current;
          current = parent;
        }
        return id(deptId);
      };
      const sameUnit = (unitId: unknown, memberId: unknown) => departmentContains(departmentRows, unitId, memberId)
        || departmentContains(departmentRows, memberId, unitId);
      const sameRootUnit = (unitId: unknown, memberId: unknown) => {
        const left = rootDepartmentId(unitId);
        const right = rootDepartmentId(memberId);
        return Boolean(left && right && left === right);
      };
      const departmentAtRoot = (deptId: unknown) => {
        let current = id(deptId);
        const seen = new Set<string>();
        let row: Record<string, unknown> | null = null;
        while (current && !seen.has(current)) {
          seen.add(current);
          row = departmentRows.find(item => id(item.dept_id) === current) || null;
          const parent = id(row?.parent_id);
          if (!parent) return row;
          current = parent;
        }
        return row;
      };
      const isSecretaryUnit = (deptId: unknown) => namedDepartment(departmentAtRoot(deptId), OFFICIAL_SECRETARY_UNIT_CODES, OFFICIAL_SECRETARY_UNIT_NAMES);
      const isDeputyGmUnit = (deptId: unknown) => namedDepartment(departmentAtRoot(deptId), OFFICIAL_DEPUTY_GM_UNIT_CODES, OFFICIAL_DEPUTY_GM_UNIT_NAMES);
      const supervisorResult = profile.supervisor_id
        ? await admin.from('users').select('user_id,dept_id,role,rbac_role,status').eq('user_id', profile.supervisor_id).eq('status', 'active').maybeSingle()
        : { data: null, error: null };
      if (supervisorResult.error) throw supervisorResult.error;
      const actorSupervisor = supervisorResult.data as Record<string, unknown> | null;
      const delegatedApprovalReceiver = Boolean(
        currentStep?.step_type === 'approval'
        && isSecretaryUnit(profile.dept_id)
        && isDeputyGmUnit(currentStep.unit_id)
        && actorSupervisor
        && ['unit_supervisor', 'sysadmin'].includes(departmentRole(actorSupervisor))
        && departmentContains(departmentRows, currentStep.unit_id, actorSupervisor.dept_id),
      );
      // 流程所屬部／室及其子單位的人員都能接續已完成的節點；跨單位仍由這道檢查擋下。
      const documentInActorScope = isAdmin || sameRootUnit(document.originator_dept_id, profile.dept_id)
        || steps.some(step => sameUnit(step.unit_id, profile.dept_id));
      const canOperateDocument = documentInActorScope;
      const inCurrentUnit = Boolean(currentStep && departmentContains(departmentRows, currentStep.unit_id, profile.dept_id));
      const canReceiveCurrentStep = inCurrentUnit || delegatedApprovalReceiver;
      const inOriginatorUnit = sameRootUnit(document.originator_dept_id, profile.dept_id);
      const isOriginator = String(document.originator_id) === String(profile.user_id);
      const fail = (message: string, status = 409) => reply(req, { ok: false, message }, status);
      const updateDocument = async (fromStatus: string | string[], patch: Record<string, unknown>) => {
        const statuses = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
        const result = await admin.from('official_documents').update({ ...patch, updated_at: new Date().toISOString() }).eq('document_id', documentId).in('status', statuses).select('status,current_step_id,updated_at').maybeSingle();
        if (result.error) throw result.error;
        if (!result.data) return null;
        return result.data as Record<string, unknown>;
      };
      const updateStep = async (fromStatus: string, patch: Record<string, unknown>) => {
        if (!currentStep) return null;
        const result = await admin.from('official_document_steps').update(patch).eq('step_id', currentStep.step_id).eq('status', fromStatus).select('step_id,status').maybeSingle();
        if (result.error) throw result.error;
        return result.data as Record<string, unknown> | null;
      };
      const unitResult = targetUnitId
        ? await admin.from('departments').select('dept_id,name,code,parent_id').eq('dept_id', targetUnitId).eq('status', 'active').is('parent_id', null).maybeSingle()
        : { data: null, error: null };
      if (unitResult.error) throw unitResult.error;
      if (targetUnitId && !unitResult.data) return fail('找不到指定的有效部／室', 400);
      const unitName = text(unitResult.data?.name, 100);
      const unitCapability = officialDocumentUnitCapabilities(unitResult.data);
      const eventFields = (fromStatus: string | null, toStatus: string | null, stepId: string | null = currentStep ? String(currentStep.step_id) : null) => ({
        step_id: stepId,
        from_status: fromStatus,
        to_status: toStatus,
        target_unit_id: targetUnitId || (currentStep ? currentStep.unit_id : null),
        note,
      });
      const activeUsersForUnit = async (unitId: string, includeSecretaryDelegates = false) => {
        const recipientDeptIds = Array.from(departmentScope(departmentRows, unitId));
        if (!recipientDeptIds.length) return [] as Array<Record<string, unknown>>;
        const result = await admin.from('users').select('user_id,dept_id,supervisor_id,role,rbac_role').eq('status', 'active').limit(1000);
        if (result.error) throw result.error;
        const rows = (result.data || []) as Array<Record<string, unknown>>;
        const targetSupervisorIds = new Set(rows
          .filter(row => recipientDeptIds.includes(id(row.dept_id)) && ['unit_supervisor', 'sysadmin'].includes(departmentRole(row)))
          .map(row => id(row.user_id)).filter(Boolean));
        return rows.filter(row => recipientDeptIds.includes(id(row.dept_id)) || (
          includeSecretaryDelegates
          && isSecretaryUnit(row.dept_id)
          && isDeputyGmUnit(unitId)
          && targetSupervisorIds.has(id(row.supervisor_id))
        )).map(row => ({ user_id: row.user_id }));
      };
      if (documentAction === 'send_co_sign') {
        if (!canOperateDocument) return fail('只有公文所屬部／室人員可以送出會辦', 403);
        if (!targetUnitId) return fail('請選擇下一個會辦部／室', 400);
        if (!unitCapability.canCoSign) return fail('董事長室、總經理室與副總經理室只能作為陳核單位；秘書室可會辦也可陳核', 400);
        if (!['draft', 'ready_for_next'].includes(String(document.status))) return fail('目前狀態不可送出會辦');
        if (currentStep && (currentStep.step_type !== 'co_sign' || currentStep.status !== 'completed')) return fail('前一個流程節點尚未完成');
        const stepNo = steps.reduce((max, step) => Math.max(max, Number(step.step_no) || 0), 0) + 1;
        const createdStep = await admin.from('official_document_steps').insert({ document_id: documentId, step_no: stepNo, step_type: 'co_sign', unit_id: targetUnitId, unit_name: unitName, status: 'sent', sent_by: profile.user_id, sent_at: new Date().toISOString(), note }).select('step_id,step_no,status,unit_id,unit_name,sent_at').single();
        if (createdStep.error) throw createdStep.error;
        const nextStatus = 'awaiting_co_sign';
        const updated = await updateDocument(['draft', 'ready_for_next'], { status: nextStatus, current_step_id: createdStep.data.step_id });
        if (!updated) return fail('公文狀態已被其他視窗更新，請重新整理');
        const event = await officialDocumentEvent(admin, actor, documentId, 'send_co_sign', idempotencyKey, eventFields(String(document.status), nextStatus, String(createdStep.data.step_id)));
        const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const recipients = await activeUsersForUnit(targetUnitId);
        for (const recipient of recipients) await officialDocumentNotification(admin, documentId, String(createdStep.data.step_id), String(recipient.user_id), 'new_step', '有新的公文會辦待收文', `${document.document_no}｜${document.subject}`, dueAt);
        return reply(req, { ok: true, data: { status: nextStatus, step: createdStep.data, event_id: event.data?.event_id } });
      }

      if (documentAction === 'send_approval') {
        if (!canOperateDocument) return fail('只有公文所屬部／室人員可以送出陳核', 403);
        if (!targetUnitId) return fail('請選擇陳核部／室', 400);
        if (!unitCapability.canApprove) return fail('陳核僅能送至董事長室、總經理室、副總經理室或秘書室', 400);
        // 條件是「沒有還沒完成的會辦」，不是「完全沒有節點」：退回補正後狀態回到 draft，
        // 但既有節點還留在時間軸上，用 steps.length === 0 會讓補正過的公文永遠送不出陳核
        // （前端在 draft 仍會顯示可按的「送出陳核」，使用者會直接卡死）。
        const pendingCoSign = steps.some(step => step.step_type === 'co_sign' && step.status !== 'completed');
        if (String(document.status) !== 'ready_for_next' && !(String(document.status) === 'draft' && !pendingCoSign)) return fail('所有會辦完成後才能送出陳核');
        if (currentStep && (currentStep.step_type !== 'co_sign' || currentStep.status !== 'completed')) return fail('前一個會辦節點尚未完成');
        const stepNo = steps.reduce((max, step) => Math.max(max, Number(step.step_no) || 0), 0) + 1;
        const createdStep = await admin.from('official_document_steps').insert({ document_id: documentId, step_no: stepNo, step_type: 'approval', unit_id: targetUnitId, unit_name: unitName, status: 'sent', sent_by: profile.user_id, sent_at: new Date().toISOString(), note }).select('step_id,step_no,status,unit_id,unit_name,sent_at').single();
        if (createdStep.error) throw createdStep.error;
        const nextStatus = 'awaiting_approval';
        const updated = await updateDocument(['draft', 'ready_for_next'], { status: nextStatus, current_step_id: createdStep.data.step_id });
        if (!updated) return fail('公文狀態已被其他視窗更新，請重新整理');
        const event = await officialDocumentEvent(admin, actor, documentId, 'send_approval', idempotencyKey, eventFields(String(document.status), nextStatus, String(createdStep.data.step_id)));
        const dueAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
        const recipients = await activeUsersForUnit(targetUnitId, true);
        for (const recipient of recipients) await officialDocumentNotification(admin, documentId, String(createdStep.data.step_id), String(recipient.user_id), 'new_step', '有新的公文陳核待收文', `${document.document_no}｜${document.subject}`, dueAt);
        return reply(req, { ok: true, data: { status: nextStatus, step: createdStep.data, event_id: event.data?.event_id } });
      }

      if (documentAction === 'receive') {
        if (!currentStep || !inCurrentUnit) return fail('只有目前收文部／室的人員可以收文', 403);
        if (currentStep.status !== 'sent') return fail('這個流程節點已收文，請勿重複操作');
        const receivedAt = new Date().toISOString();
        const autoComplete = currentStep.step_type === 'co_sign';
        const updatedStep = await updateStep('sent', autoComplete
          ? { status: 'completed', received_by: profile.user_id, received_at: receivedAt, completed_by: profile.user_id, completed_at: receivedAt }
          : { status: 'received', received_by: profile.user_id, received_at: receivedAt });
        if (!updatedStep) return fail('這筆公文已被其他人收文，請重新整理');
        if (autoComplete) {
          const nextStatus = 'ready_for_next';
          const updated = await updateDocument('awaiting_co_sign', { status: nextStatus, current_step_id: currentStep.step_id });
          if (!updated) return fail('公文狀態已被其他視窗更新，請重新整理');
          const receiveEvent = await officialDocumentEvent(admin, actor, documentId, 'receive', idempotencyKey, eventFields('awaiting_co_sign', 'awaiting_co_sign'));
          const completeEvent = await officialDocumentEvent(admin, actor, documentId, 'co_sign_complete', `${idempotencyKey}:complete`, eventFields('awaiting_co_sign', nextStatus));
          return reply(req, { ok: true, data: { status: nextStatus, event_id: completeEvent.data?.event_id || receiveEvent.data?.event_id, auto_completed: true } });
        }
        const event = await officialDocumentEvent(admin, actor, documentId, 'receive', idempotencyKey, eventFields(String(document.status), String(document.status)));
        return reply(req, { ok: true, data: { status: document.status, event_id: event.data?.event_id } });
      }

      if (documentAction === 'co_sign_complete') {
        if (!currentStep || currentStep.step_type !== 'co_sign' || !inCurrentUnit) return fail('只有目前會辦部／室的人員可以完成會辦', 403);
        // 舊版畫面仍可能送出第二個完成動作；收文已自動完成時安全回傳目前狀態，
        // 不再要求使用者再按一次按鈕，也不新增重複事件。
        if (currentStep.status === 'completed' && String(document.status) === 'ready_for_next') {
          return reply(req, { ok: true, data: { status: 'ready_for_next', already_completed: true } });
        }
        if (currentStep.status !== 'received') return fail('完成會辦前請先收文');
        const updatedStep = await updateStep('received', { status: 'completed', completed_by: profile.user_id, completed_at: new Date().toISOString(), note });
        if (!updatedStep) return fail('這個會辦節點已被完成，請重新整理');
        const nextStatus = 'ready_for_next';
        const updated = await updateDocument('awaiting_co_sign', { status: nextStatus, current_step_id: currentStep.step_id });
        if (!updated) return fail('公文狀態已被其他視窗更新，請重新整理');
        const event = await officialDocumentEvent(admin, actor, documentId, 'co_sign_complete', idempotencyKey, eventFields('awaiting_co_sign', nextStatus));
        return reply(req, { ok: true, data: { status: nextStatus, event_id: event.data?.event_id } });
      }

      if (documentAction === 'approval_receive') {
        if (!currentStep || currentStep.step_type !== 'approval' || !canReceiveCurrentStep) return fail('只有目前陳核部／室或其指定收文人員可以簽收', 403);
        if (currentStep.status !== 'sent') return fail('這筆公文已簽收，請勿重複操作');
        const updatedStep = await updateStep('sent', { status: 'received', received_by: profile.user_id, received_at: new Date().toISOString() });
        if (!updatedStep) return fail('這筆公文已被其他人簽收，請重新整理');
        const event = await officialDocumentEvent(admin, actor, documentId, 'approval_receive', idempotencyKey, eventFields(String(document.status), String(document.status)));
        return reply(req, { ok: true, data: { status: document.status, event_id: event.data?.event_id } });
      }

      if (documentAction === 'approve' || documentAction === 'return') {
        if (!currentStep || currentStep.step_type !== 'approval' || !inCurrentUnit) return fail('只有目前陳核部／室的人員可以核決', 403);
        if (currentStep.status !== 'received') return fail('核決前請先完成陳核簽收');
        const nextStatus = documentAction === 'approve' ? 'awaiting_originator' : 'returned';
        const updatedStep = await updateStep('received', { status: documentAction === 'approve' ? 'completed' : 'returned', completed_by: profile.user_id, completed_at: new Date().toISOString(), note });
        if (!updatedStep) return fail('這筆公文已被其他人核決，請重新整理');
        const updated = await updateDocument('awaiting_approval', { status: nextStatus, current_step_id: currentStep.step_id });
        if (!updated) return fail('公文狀態已被其他視窗更新，請重新整理');
        const event = await officialDocumentEvent(admin, actor, documentId, documentAction, idempotencyKey, eventFields('awaiting_approval', nextStatus));
        const title = documentAction === 'approve' ? '公文已核決，請創文單位簽收' : '公文退回，請原申請人補正重送';
        const recipients = documentAction === 'approve' && document.originator_dept_id
          ? await activeUsersForUnit(rootDepartmentId(document.originator_dept_id))
          : [{ user_id: document.originator_id }];
        for (const recipient of recipients) {
          await officialDocumentNotification(admin, documentId, String(currentStep.step_id), String(recipient.user_id), documentAction === 'approve' ? 'approved' : 'returned', title, `${document.document_no}｜${document.subject}${note ? `｜${note}` : ''}`);
        }
        return reply(req, { ok: true, data: { status: nextStatus, event_id: event.data?.event_id } });
      }

      if (documentAction === 'resubmit') {
        if (!isOriginator) return fail('只有原申請人可以補正重送', 403);
        if (String(document.status) !== 'returned') return fail('目前沒有可補正的退回公文');
        const updated = await updateDocument('returned', { status: 'draft', current_step_id: null, closed_at: null });
        if (!updated) return fail('這筆公文已被重新送出，請重新整理');
        const event = await officialDocumentEvent(admin, actor, documentId, 'resubmit', idempotencyKey, eventFields('returned', 'draft', null));
        return reply(req, { ok: true, data: { status: 'draft', event_id: event.data?.event_id } });
      }

      if (documentAction === 'originator_receive') {
        if (!isOriginator && !inOriginatorUnit) return fail('只有創文部／室人員可以簽收公文', 403);
        if (String(document.status) !== 'awaiting_originator') return fail('目前沒有待收訖的核決公文');
        const updated = await updateDocument('awaiting_originator', { status: 'closed', closed_at: new Date().toISOString() });
        if (!updated) return fail('這筆公文已完成收訖，請勿重複操作');
        const event = await officialDocumentEvent(admin, actor, documentId, 'originator_receive', idempotencyKey, eventFields('awaiting_originator', 'closed', null));
        return reply(req, { ok: true, data: { status: 'closed', event_id: event.data?.event_id } });
      }

      if (documentAction === 'barcode_generate') {
        if (!canOperateDocument && !isOriginator) return fail('只有公文所屬部／室人員可以產生文號', 403);
        const currentBarcode = text(document.barcode_value, 200);
        if (currentBarcode) return reply(req, { ok: true, data: { status: document.status, barcode_value: currentBarcode, duplicate: true } });
        const barcode = text(document.document_no, 100);
        const updated = await admin.from('official_documents').update({ barcode_value: barcode, updated_at: new Date().toISOString() }).eq('document_id', documentId).is('barcode_value', null).select('barcode_value').maybeSingle();
        if (updated.error) throw updated.error;
        const event = await officialDocumentEvent(admin, actor, documentId, 'barcode_generated', idempotencyKey, { ...eventFields(String(document.status), String(document.status), null), details: { barcode_value: barcode } });
        return reply(req, { ok: true, data: { status: document.status, barcode_value: updated.data?.barcode_value || barcode, event_id: event.data?.event_id } });
      }

      return fail('公文流程動作無效', 400);
    }

    if (action === 'dashboard_market_rotation') {
      if (!can('dashboard') && !can('marketanalytics') && !can('marketboard')) {
        return reply(req, { ok: false, message: '目前角色沒有戰情儀表板、市場營運分析或市場公開看板系統權限' }, 403);
      }
      const requestedView = text(body.view, 20);
      const view = requestedView === 'trend' ? 'trend' : requestedView === 'board' ? 'board' : 'cards';
      if (view === 'board') {
        const board = await buildMarketBoardPayload(admin);
        return board.ok ? reply(req, { ok: true, data: board.data }) : reply(req, { ok: false, message: board.message }, board.status);
      }
      let widgetConfig: Record<string, unknown> = {};
      let refreshSeconds = 60;
      const layoutResult = await admin.from('dashboard_layouts')
        .select('published_version_id').eq('layout_code', 'operations_main').eq('status', 'active').maybeSingle();
      if (layoutResult.error) console.warn('dashboard market layout lookup failed:', layoutResult.error.message);
      if (layoutResult.data?.published_version_id) {
        const widgetResult = await admin.from('dashboard_layout_items')
          .select('config,refresh_seconds').eq('version_id', layoutResult.data.published_version_id)
          .eq('widget_key', 'market_snapshot').maybeSingle();
        if (widgetResult.error) console.warn('dashboard market widget lookup failed:', widgetResult.error.message);
        if (widgetResult.data) {
          widgetConfig = marketJsonObject(widgetResult.data.config);
          const parsedRefresh = Number(widgetResult.data.refresh_seconds);
          if (Number.isFinite(parsedRefresh)) refreshSeconds = Math.max(15, Math.min(86400, Math.round(parsedRefresh)));
        }
      }
      const rotation = dashboardMarketRotationConfig(widgetConfig);

      const sourceResult = await admin.from('market_data_sources')
        .select('source_id,source_code,source_name,field_definitions,config')
        .eq('status', 'active').order('source_name').limit(200);
      if (sourceResult.error) {
        console.error('dashboard market source lookup failed:', sourceResult.error.message);
        return reply(req, { ok: false, message: '市場行情資料來源暫時無法讀取' }, 503);
      }
      const sourceCandidates = (sourceResult.data || []) as Array<Record<string, unknown>>;
      const isDecisionSource = (row: Record<string, unknown>) => (
        text(row.source_code, 60) !== 'market_demo' && marketJsonObject(row.config).is_demo !== true
      );
      const source = sourceCandidates.find(row => rotation.sourceId && text(row.source_id, 80) === rotation.sourceId && isDecisionSource(row))
        || sourceCandidates.find(row => {
          const config = marketJsonObject(row.config);
          return isDecisionSource(row) && config.is_default === true && config.is_actual === true;
        })
        || sourceCandidates.find(row => isDecisionSource(row) && marketJsonObject(row.config).is_actual === true)
        || sourceCandidates.find(isDecisionSource);
      if (!source) return reply(req, { ok: false, message: '尚未設定可供戰情儀表板使用的正式市場行情資料來源' }, 503);

      const sourceId = id(source.source_id);
      const fields = marketFieldDefinitions(source.field_definitions);
      const fieldMap = new Map(fields.map(field => [field.key, field]));
      const dimensions = new Set(fields.filter(field => field.kind === 'dimension').map(field => field.key));
      const measures = ['quantity', 'average_price', 'high_price', 'low_price'].filter(key => fieldMap.get(key)?.kind === 'measure');
      if (!['market', 'category', 'item'].every(key => dimensions.has(key)) || !measures.includes('quantity') || !measures.includes('average_price')) {
        return reply(req, { ok: false, message: '正式行情資料缺少市場、大類、品項、成交量或平均價欄位' }, 503);
      }

      const rangeResult = await admin.rpc('market_source_date_ranges');
      if (rangeResult.error) {
        console.error('dashboard market date range failed:', rangeResult.error.message);
        return reply(req, { ok: false, message: '市場行情交易日期暫時無法讀取' }, 503);
      }
      const range = ((rangeResult.data || []) as Array<Record<string, unknown>>)
        .find(row => text(row.source_id, 80) === sourceId);
      const latestDate = text(range?.latest_observed_on, 10);
      const previousDate = text(range?.previous_observed_on, 10);
      if (!validISODate(latestDate) || !validISODate(previousDate)) {
        return reply(req, { ok: false, message: '市場行情尚未建立最新與前一交易日的比較資料' }, 503);
      }

      const requestedMarket = text(body.market, 20);
      const requestedCategory = text(body.category, 20);
      const requestedItem = text(body.item, 160);
      const currentFrom = dashboardMarketShiftDate(latestDate, -6);
      const compareFrom = dashboardMarketShiftDate(latestDate, -13);
      const compareTo = dashboardMarketShiftDate(latestDate, -7);
      const rollupResult = await admin.rpc('market_analysis_rollup', {
        p_source_id: sourceId,
        p_from: currentFrom,
        p_to: latestDate,
        p_compare_from: compareFrom,
        p_compare_to: compareTo,
        p_dimensions: ['market', 'category', 'item'],
        p_measures: measures,
        p_filters: {},
        p_include_group_daily: true,
      });
      if (rollupResult.error) {
        const missingRollup = ['PGRST202', '42883'].includes(String(rollupResult.error.code || ''))
          || /market_analysis_rollup.*(?:not find|not found|does not exist)/i.test(String(rollupResult.error.message || ''));
        console.error('dashboard market rollup failed:', rollupResult.error.message);
        return reply(req, {
          ok: false,
          message: missingRollup
            ? '市場行情彙總功能尚未完成設定，請先套用資料庫效能更新'
            : '市場行情彙總資料暫時無法讀取，請稍後再試',
        }, 503);
      }

      const rollup = marketJsonObject(rollupResult.data);
      const rollupRows = (key: string) => (
        Array.isArray(rollup[key])
          ? (rollup[key] as unknown[]).filter(item => item && typeof item === 'object')
            .map(item => item as Record<string, unknown>)
          : []
      );
      const rollupValues = (value: unknown) => {
        const raw = marketJsonObject(value);
        return Object.fromEntries(measures.map(measure => [measure, marketNumeric(raw[measure])]));
      };
      const dailyAggregates = [
        ...rollupRows('current_group_daily'),
        ...rollupRows('compare_group_daily'),
      ].flatMap(row => {
        const observedOn = text(row.observed_on, 10);
        const rowDimensions = marketJsonObject(row.dimensions);
        if (!validISODate(observedOn)) return [];
        return [{
          observed_on: observedOn,
          dimensions: {
            market: text(rowDimensions.market, 20) || '未分類',
            category: text(rowDimensions.category, 20) || '未分類',
            item: text(rowDimensions.item, 160) || '未分類',
          },
          values: rollupValues(row.values),
        }];
      });
      const aggregateKey = (row: MarketAggregate) => [
        row.dimensions.market,
        row.dimensions.category,
        row.dimensions.item,
      ].join('::');
      const dailyAggregateKey = (observedOn: string, market: string, category: string, item: string) => (
        [observedOn, market, category, item].join('::')
      );
      const dailyByKey = new Map(dailyAggregates.map(row => [
        dailyAggregateKey(row.observed_on, row.dimensions.market, row.dimensions.category, row.dimensions.item),
        row,
      ]));
      const currentAggregates = dailyAggregates
        .filter(row => row.observed_on === latestDate && row.dimensions.item !== '未分類');
      const previousAggregates = dailyAggregates.filter(row => row.observed_on === previousDate);
      const previousByKey = new Map(previousAggregates.map(row => [aggregateKey(row), row]));
      const configuredItems = rotation.items.filter(item => item.enabled);

      const groups = DASHBOARD_MARKETS.flatMap(market => DASHBOARD_CATEGORIES.map(category => {
        const inGroup = currentAggregates.filter(row => row.dimensions.market === market && row.dimensions.category === category)
          .sort((left, right) => (right.values.quantity || 0) - (left.values.quantity || 0));
        const currentByItem = new Map(inGroup.map(row => [row.dimensions.item, row]));
        const pinned = configuredItems.filter(item => item.market === market && item.category === category)
          .slice(0, rotation.cardsPerGroup);
        const availablePinned: Array<{ item: string; current?: MarketAggregate; configured: boolean }> = [];
        const unavailablePinned: Array<{ item: string; current?: MarketAggregate; configured: boolean }> = [];
        pinned.forEach(item => {
          const current = currentByItem.get(item.item);
          const comparison = previousByKey.get(`${market}::${category}::${item.item}`);
          (current || comparison ? availablePinned : unavailablePinned).push({ item: item.item, current, configured: true });
        });
        const selected = [...availablePinned];
        const seen = new Set(pinned.map(item => item.item));
        for (const row of inGroup) {
          if (selected.length >= rotation.cardsPerGroup) break;
          if (seen.has(row.dimensions.item)) continue;
          seen.add(row.dimensions.item);
          selected.push({ item: row.dimensions.item, current: row, configured: false });
        }
        for (const missing of unavailablePinned) {
          if (selected.length >= rotation.cardsPerGroup) break;
          selected.push(missing);
        }
        const cards = selected.map(selection => {
          const key = `${market}::${category}::${selection.item}`;
          const comparison = previousByKey.get(key);
          return {
            key, market, category, item: selection.item, configured: selection.configured,
            price: marketNumeric(selection.current?.values.average_price),
            previous_price: marketNumeric(comparison?.values.average_price),
            quantity: marketNumeric(selection.current?.values.quantity),
            high_price: marketNumeric(selection.current?.values.high_price),
            low_price: marketNumeric(selection.current?.values.low_price),
          };
        });
        return { key: `${market}::${category}`, market, category, cards };
      }));

      const sourceSummary = {
        source_id: sourceId,
        source_code: text(source.source_code, 60),
        source_name: text(source.source_name, 120),
      };
      const trendFor = (market: string, category: string, item: string) => {
        const series = Array.from({ length: 7 }, (_, index) => {
          const observedOn = dashboardMarketShiftDate(currentFrom, index);
          const compareObservedOn = dashboardMarketShiftDate(compareFrom, index);
          const current = dailyByKey.get(dailyAggregateKey(observedOn, market, category, item))?.values || {};
          const comparison = dailyByKey.get(dailyAggregateKey(compareObservedOn, market, category, item))?.values || {};
          return { observed_on: observedOn, compare_observed_on: compareObservedOn, values: current, compare_values: comparison };
        });
        return { periods: { from: currentFrom, to: latestDate, compare_from: compareFrom, compare_to: compareTo }, series };
      };
      if (view === 'cards') {
        return reply(req, { ok: true, data: {
          source: sourceSummary,
          latest_date: latestDate,
          previous_date: previousDate,
          auto_step_seconds: rotation.autoStepSeconds,
          refresh_seconds: refreshSeconds,
          cards_per_slide: 4,
          cards_per_group: rotation.cardsPerGroup,
          groups: groups.map(group => ({
            ...group,
            cards: group.cards.map(card => ({ ...card, trend: trendFor(card.market, card.category, card.item) })),
          })),
        } });
      }

      if (!(DASHBOARD_MARKETS as readonly string[]).includes(requestedMarket)
        || !(DASHBOARD_CATEGORIES as readonly string[]).includes(requestedCategory)
        || !requestedItem) {
        return reply(req, { ok: false, message: '單品趨勢的市場、大類或品項不正確' }, 400);
      }
      const selectedGroup = groups.find(group => group.market === requestedMarket && group.category === requestedCategory);
      if (!selectedGroup?.cards.some(card => card.item === requestedItem)) {
        return reply(req, { ok: false, message: '此品項不在目前發布的戰情輪播清單中' }, 403);
      }
      return reply(req, { ok: true, data: {
        source: sourceSummary,
        ...trendFor(requestedMarket, requestedCategory, requestedItem),
      } });
    }

    if (action === 'market_catalog') {
      if (!can('marketanalytics')) return reply(req, { ok: false, message: '目前角色沒有市場營運分析系統權限' }, 403);
      const [sourceResult, templateResult, rangeResult] = await Promise.all([
        admin.from('market_data_sources').select('source_id,source_code,source_name,source_type,endpoint_url,field_definitions,config,status,updated_at').eq('status', 'active').order('source_name').limit(200),
        admin.from('market_analysis_templates').select('template_id,template_code,template_name,description,source_id,dimensions,measures,chart_type,default_config,status,updated_at').eq('status', 'active').order('template_name').limit(200),
        admin.rpc('market_source_date_ranges'),
      ]);
      if (sourceResult.error || templateResult.error || rangeResult.error) {
        console.error('market catalog query failed:', sourceResult.error?.message || templateResult.error?.message || rangeResult.error?.message);
        return reply(req, { ok: false, message: '市場行情資料尚未完成設定，請先套用市場分析資料庫腳本' }, 503);
      }
      const rangeRows = (rangeResult.data || []) as Array<Record<string, unknown>>;
      const ranges = new Map<string, Record<string, unknown>>(rangeRows.map(row => [String(row.source_id), row]));
      const sources = (sourceResult.data || []).map((row: Record<string, unknown>) => {
        const range = ranges.get(String(row.source_id));
        if (!range?.latest_observed_on) return row;
        const latest = text(range.latest_observed_on, 10);
        const previous = text(range.previous_observed_on, 10);
        return { ...row, config: {
          ...marketJsonObject(row.config),
          period_from: text(range.first_observed_on, 10), period_to: latest, latest_observed_on: latest,
          default_from: latest, default_to: latest,
          ...(previous ? { default_compare_from: previous, default_compare_to: previous } : {}),
        } };
      });
      return reply(req, { ok: true, data: { sources, templates: templateResult.data || [] } });
    }

    if (action === 'market_dimension_catalog') {
      if (!can('marketanalytics')) return reply(req, { ok: false, message: '目前角色沒有市場營運分析系統權限' }, 403);
      const sourceId = id(body.source_id);
      const sourceResult = await admin.from('market_data_sources').select('source_id,field_definitions,config').eq('source_id', sourceId).eq('status', 'active').maybeSingle();
      if (sourceResult.error || !sourceResult.data) return reply(req, { ok: false, message: '找不到可用的市場行情資料來源' }, 404);
      const allDimensions = marketFieldDefinitions(sourceResult.data.field_definitions)
        .filter(field => field.kind === 'dimension' && field.hidden !== true && field.filterable !== false);
      const dimensions = allDimensions.slice(0, 8);
      const dimensionKeys = new Set(allDimensions.map(field => field.key));
      const rawFilters = marketJsonObject(body.filters);
      const catalogFilters = Object.fromEntries(Object.entries(rawFilters)
        .filter(([key, value]) => dimensionKeys.has(key) && typeof value === 'string')
        .map(([key, value]) => [key, text(value, 200)] as const)
        .filter(([, value]) => Boolean(value))
        .slice(0, 8));
      const results = await Promise.all(dimensions.map(async field => {
        const filters = Object.fromEntries(Object.entries(catalogFilters).filter(([key]) => key !== field.key));
        const filteredResult = await admin.rpc('market_dimension_values_filtered', {
          p_source_id: sourceId, p_dimension: field.key, p_filters: filters, p_limit: 500,
        });
        if (!filteredResult.error) return { field, result: filteredResult };
        const missingFilteredRpc = ['PGRST202', '42883'].includes(String(filteredResult.error.code || ''))
          || /market_dimension_values_filtered.*(?:not find|not found|does not exist)/i.test(String(filteredResult.error.message || ''));
        if (!missingFilteredRpc) return { field, result: filteredResult };
        const fallbackResult = await admin.rpc('market_dimension_values', { p_source_id: sourceId, p_dimension: field.key, p_limit: 500 });
        return { field, result: fallbackResult };
      }));
      const failed = results.find(item => item.result.error);
      if (failed) {
        console.error('market dimension catalog failed:', failed.result.error?.message);
        return reply(req, { ok: false, message: '市場行情篩選選項尚未完成設定，仍可直接輸入篩選文字' }, 503);
      }
      return reply(req, { ok: true, data: { options: Object.fromEntries(results.map(item => [
        item.field.key,
        (item.result.data || []).map((row: Record<string, unknown>) => ({ value: text(row.value, 200), count: Number(row.point_count) || 0 })).filter((row: { value: string }) => row.value),
      ])) } });
    }

    if (action === 'market_analysis') {
      if (!can('marketanalytics')) return reply(req, { ok: false, message: '目前角色沒有市場營運分析系統權限' }, 403);
      const sourceId = id(body.source_id);
      let sourceResult;
      if (sourceId) {
        sourceResult = await admin.from('market_data_sources')
          .select('source_id,source_code,source_name,field_definitions')
          .eq('source_id', sourceId).eq('status', 'active').maybeSingle();
      } else {
        // 未指定來源的中央戰情摘要只使用明確標記的預設來源，避免名稱排序剛好
        // 取到示範資料；舊環境尚未設定預設來源時才退回第一個啟用來源。
        const preferred = await admin.from('market_data_sources')
          .select('source_id,source_code,source_name,field_definitions')
          .eq('status', 'active').contains('config', { is_default: true }).order('source_name').limit(1).maybeSingle();
        sourceResult = preferred.data || preferred.error
          ? preferred
          : await admin.from('market_data_sources')
            .select('source_id,source_code,source_name,field_definitions')
            .eq('status', 'active').order('source_name').limit(1).maybeSingle();
      }
      if (sourceResult.error || !sourceResult.data) return reply(req, { ok: false, message: '找不到可用的市場行情資料來源' }, 404);
      const source = sourceResult.data as Record<string, unknown>;
      const fields = marketFieldDefinitions(source.field_definitions);
      const dimensionKeys = fields.filter(field => field.kind === 'dimension').map(field => field.key);
      const measureKeys = fields.filter(field => field.kind === 'measure').map(field => field.key);
      const hasRequestedDimensions = Array.isArray(body.dimensions);
      const hasRequestedMeasures = Array.isArray(body.measures);
      const dimensionInput: unknown[] = Array.isArray(body.dimensions) ? body.dimensions : [];
      const measureInput: unknown[] = Array.isArray(body.measures) ? body.measures : [];
      const requestedDimensions: string[] = dimensionInput.map((value: unknown) => text(value, 60).toLowerCase()).filter((key: string) => dimensionKeys.includes(key)).slice(0, 4);
      const requestedMeasures: string[] = measureInput.map((value: unknown) => text(value, 60).toLowerCase()).filter((key: string) => measureKeys.includes(key)).slice(0, 4);
      const dimensions: string[] = hasRequestedDimensions ? [...new Set(requestedDimensions)] : dimensionKeys.slice(0, 2);
      const measures: string[] = hasRequestedMeasures ? [...new Set(requestedMeasures)] : measureKeys.slice(0, 2);
      const rawFilters = marketJsonObject(body.filters);
      const filterEntries = dimensionKeys.map(key => [key, text(rawFilters[key], 200)] as const).filter(([, value]) => Boolean(value));
      if (filterEntries.length > 4) return reply(req, { ok: false, message: '單次最多套用 4 個資料內容篩選，請移除較次要的篩選條件' }, 400);
      const filters = Object.fromEntries(filterEntries);
      if (!measures.length) return reply(req, { ok: false, message: '資料來源至少需要一個可分析的數值欄位' }, 400);
      const nowISO = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
      const from = marketDateRange(body.from, nowISO);
      const to = marketDateRange(body.to, from);
      const compareFrom = marketDateRange(body.compare_from, from);
      const compareTo = marketDateRange(body.compare_to, to);
      if (from > to || compareFrom > compareTo) return reply(req, { ok: false, message: '分析期間起訖日期不正確' }, 400);
      const rangeDays = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
      const compareRangeDays = Math.round((Date.parse(`${compareTo}T00:00:00Z`) - Date.parse(`${compareFrom}T00:00:00Z`)) / 86400000) + 1;
      if (rangeDays > 366 || compareRangeDays > 366) return reply(req, { ok: false, message: '單次分析期間與比較期間最多 366 天' }, 400);
      if (rangeDays !== compareRangeDays) return reply(req, { ok: false, message: '分析期間與比較期間必須使用相同天數' }, 400);
      const rollupResult = await admin.rpc('market_analysis_rollup', {
        p_source_id: source.source_id,
        p_from: from,
        p_to: to,
        p_compare_from: compareFrom,
        p_compare_to: compareTo,
        p_dimensions: dimensions,
        p_measures: measures,
        p_filters: filters,
        p_include_group_daily: false,
      });
      if (rollupResult.error) {
        const missingRollup = ['PGRST202', '42883'].includes(String(rollupResult.error.code || ''))
          || /market_analysis_rollup.*(?:not find|not found|does not exist)/i.test(String(rollupResult.error.message || ''));
        console.error('market analysis rollup failed:', rollupResult.error.message);
        return reply(req, {
          ok: false,
          message: missingRollup
            ? '市場行情彙總功能尚未完成設定，請先套用資料庫效能更新'
            : '市場行情分析資料彙總失敗，請稍後再試',
        }, 503);
      }

      const rollup = marketJsonObject(rollupResult.data);
      const rollupArray = (key: string) => (
        Array.isArray(rollup[key])
          ? (rollup[key] as unknown[]).filter(item => item && typeof item === 'object')
            .map(item => item as Record<string, unknown>)
          : []
      );
      const rollupValues = (value: unknown, includeNulls = true) => {
        const raw = marketJsonObject(value);
        return Object.fromEntries(measures.flatMap(measure => {
          const numeric = marketNumeric(raw[measure]);
          return includeNulls || numeric !== null ? [[measure, numeric] as const] : [];
        }));
      };
      const rollupDimensions = (value: unknown) => {
        const raw = marketJsonObject(value);
        return Object.fromEntries(dimensions.map(key => [key, text(raw[key], 160) || '未分類']));
      };
      const counts = marketJsonObject(rollup.counts);
      const currentCount = Math.max(0, Math.round(Number(counts.current) || 0));
      const compareCount = Math.max(0, Math.round(Number(counts.compare) || 0));
      const current = rollupArray('current_groups').map(row => ({
        dimensions: rollupDimensions(row.dimensions),
        values: rollupValues(row.values),
      }));
      const comparison = rollupArray('compare_groups').map(row => ({
        dimensions: rollupDimensions(row.dimensions),
        values: rollupValues(row.values),
      }));
      const marketGroupKey = (row: MarketAggregate) => JSON.stringify(dimensions.map(key => row.dimensions[key] || '未分類'));
      const compareByKey = new Map(comparison.map(row => [marketGroupKey(row), row]));
      const currentGroupKeys = new Set(current.map(marketGroupKey));
      const rows = current.map(row => {
        const key = marketGroupKey(row);
        const other = compareByKey.get(key);
        const values: Record<string, number | null> = {};
        const compareValues: Record<string, number | null> = {};
        const changes: Record<string, number | null> = {};
        measures.forEach(measure => {
          const currentValue = row.values[measure] ?? null;
          const compareValue = other?.values[measure] ?? null;
          values[measure] = currentValue;
          compareValues[measure] = compareValue;
          changes[measure] = currentValue !== null && compareValue !== null ? currentValue - compareValue : null;
        });
        return { dimensions: row.dimensions, values, compare_values: compareValues, changes, current_count: currentCount, compare_count: compareCount };
      });
      comparison.forEach(row => {
        const key = marketGroupKey(row);
        if (currentGroupKeys.has(key)) return;
        rows.push({
          dimensions: row.dimensions,
          values: {},
          compare_values: rollupValues(row.values),
          changes: {},
          current_count: currentCount,
          compare_count: compareCount,
        });
      });
      const rankMeasure = measures[0];
      rows.sort((left, right) => Math.max(Math.abs(Number(right.values[rankMeasure]) || 0), Math.abs(Number(right.compare_values[rankMeasure]) || 0))
        - Math.max(Math.abs(Number(left.values[rankMeasure]) || 0), Math.abs(Number(left.compare_values[rankMeasure]) || 0)));
      const totalGroupCount = rows.length;
      const returnedGroupCount = Math.min(totalGroupCount, 500);
      const groupsTruncated = returnedGroupCount < totalGroupCount;
      const totalsCurrent = rollupValues(rollup.current_totals, false);
      const totalsCompare = rollupValues(rollup.compare_totals, false);

      const marketSummary = dimensionKeys.includes('market')
        ? (() => {
          const currentByMarket = rollupArray('current_market').map(row => ({
            market: text(row.market, 160) || '未分類市場',
            values: rollupValues(row.values, false),
          }));
          const compareByMarket = new Map(rollupArray('compare_market').map(row => [
            text(row.market, 160) || '未分類市場',
            rollupValues(row.values, false),
          ]));
          const currentMarkets = new Set(currentByMarket.map(row => row.market));
          const result = currentByMarket.map(row => ({
            market: row.market,
            values: row.values,
            compare_values: compareByMarket.get(row.market) || {},
          }));
          compareByMarket.forEach((values, market) => {
            if (!currentMarkets.has(market)) result.push({ market, values: {}, compare_values: values });
          });
          return result;
        })()
        : [];

      const dailyValues = (key: string) => new Map<string, Record<string, number | null>>(
        rollupArray(key).flatMap(row => {
          const observedOn = text(row.observed_on, 10);
          return validISODate(observedOn) ? [[observedOn, rollupValues(row.values)] as const] : [];
        }),
      );
      const currentDaily = dailyValues('current_daily');
      const compareDaily = dailyValues('compare_daily');
      const emptyValues = () => Object.fromEntries(measures.map(measure => [measure, null]));
      // 圖表以「區間第 N 天」對齊；沒有交易資料的日期保留 null，不補成 0。
      const series = Array.from({ length: rangeDays }, (_, offset) => {
        const observedOn = dashboardMarketShiftDate(from, offset);
        const candidateCompareOn = dashboardMarketShiftDate(compareFrom, offset);
        const compareObservedOn = candidateCompareOn <= compareTo ? candidateCompareOn : null;
        return {
          observed_on: observedOn,
          compare_observed_on: compareObservedOn,
          values: currentDaily.get(observedOn) || emptyValues(),
          compare_values: compareObservedOn ? compareDaily.get(compareObservedOn) || emptyValues() : emptyValues(),
        };
      });
      const latestCandidate = text(rollup.latest_observed_on, 10);
      const latestObservedOn = validISODate(latestCandidate) ? latestCandidate : null;
      const totalsChanges = Object.fromEntries(measures.map(measure => {
        const currentValue = totalsCurrent[measure];
        const compareValue = totalsCompare[measure];
        return [
          measure,
          currentValue !== null && currentValue !== undefined
            && compareValue !== null && compareValue !== undefined
            && Number.isFinite(currentValue) && Number.isFinite(compareValue)
            ? currentValue - compareValue
            : null,
        ];
      }));
      return reply(req, { ok: true, data: {
        source: { source_id: source.source_id, source_code: source.source_code, source_name: source.source_name }, filters,
        fields, dimensions, measures, periods: { from, to, compare_from: compareFrom, compare_to: compareTo },
        totals: { values: totalsCurrent, compare_values: totalsCompare, changes: totalsChanges },
        counts: { current: currentCount, compare: compareCount },
        quality: {
          latest_observed_on: latestObservedOn,
          current_loaded_count: currentCount,
          compare_loaded_count: compareCount,
          is_truncated: false,
          total_group_count: totalGroupCount,
          returned_group_count: returnedGroupCount,
          groups_truncated: groupsTruncated,
        },
        series, market_summary: marketSummary,
        rows: rows.slice(0, returnedGroupCount),
      } });
    }

    if (action === 'market_simulation_list') {
      const canManageMarket = isSysadmin || roleCanManageMarket || marketPermissionEnabled((profile.permissions as Record<string, unknown> | null)?.marketanalytics_manage) || marketPermissionEnabled((profile.permissions as Record<string, unknown> | null)?.admin);
      if (!can('marketanalytics') && !canManageMarket) return reply(req, { ok: false, message: '目前角色沒有市場營運分析系統權限' }, 403);
      const sourceResult = await admin.from('market_data_sources').select('source_id,source_code,config').eq('status', 'active');
      if (sourceResult.error) return reply(req, { ok: false, message: '市場行情來源暫時無法讀取' }, 503);
      const decisionSourceIds = (sourceResult.data || []).filter(source => source.source_code !== 'market_demo'
        && marketJsonObject(source.config).is_demo !== true).map(source => String(source.source_id));
      if (!decisionSourceIds.length) return reply(req, { ok: true, data: [] });
      let query = admin.from('market_simulation_runs')
        .select('simulation_id,name,source_id,period_from,period_to,base_totals,assumptions,projected_totals,created_by,created_at,status')
        .in('source_id', decisionSourceIds).order('created_at', { ascending: false }).limit(50);
      if (!canManageMarket) query = query.eq('created_by', profile.user_id);
      const result = await query;
      if (result.error) {
        console.error('market simulation list failed:', result.error.message);
        return reply(req, { ok: false, message: '市場模擬紀錄尚未完成設定，請先套用市場模擬資料庫腳本' }, 503);
      }
      return reply(req, { ok: true, data: result.data || [] });
    }

    if (action === 'market_simulation_save') {
      const canManageMarket = isSysadmin || roleCanManageMarket || marketPermissionEnabled((profile.permissions as Record<string, unknown> | null)?.marketanalytics_manage) || marketPermissionEnabled((profile.permissions as Record<string, unknown> | null)?.admin);
      if (!can('marketanalytics') && !canManageMarket) return reply(req, { ok: false, message: '目前角色沒有市場營運分析系統權限' }, 403);
      const name = text(body.name, 120);
      const sourceId = id(body.source_id);
      const periodFrom = text(body.period_from, 10);
      const periodTo = text(body.period_to, 10);
      if (!name) return reply(req, { ok: false, message: '請輸入模擬情境名稱' }, 400);
      if (!sourceId) return reply(req, { ok: false, message: '請選擇有效的市場行情資料來源' }, 400);
      if (!validISODate(periodFrom) || !validISODate(periodTo) || periodFrom > periodTo) {
        return reply(req, { ok: false, message: '模擬期間起訖日期不正確，請使用 YYYY-MM-DD' }, 400);
      }
      const rangeDays = Math.round((Date.parse(`${periodTo}T00:00:00Z`) - Date.parse(`${periodFrom}T00:00:00Z`)) / 86400000) + 1;
      if (rangeDays > 366) return reply(req, { ok: false, message: '單次模擬期間最多 366 天' }, 400);
      const baseTotals = marketSimulationJsonObject(body.base_totals);
      const assumptions = marketSimulationJsonObject(body.assumptions);
      const projectedTotals = marketSimulationJsonObject(body.projected_totals);
      if (!baseTotals || !assumptions || !projectedTotals) {
        return reply(req, { ok: false, message: '基準合計、模擬假設與推估合計必須是有效的資料物件，且單項不得超過 100 KB' }, 400);
      }
      const sourceResult = await admin.from('market_data_sources').select('source_id').eq('source_id', sourceId).maybeSingle();
      if (sourceResult.error || !sourceResult.data) return reply(req, { ok: false, message: '找不到指定的市場行情資料來源' }, 404);
      const status = body.status === 'draft' ? 'draft' : 'completed';
      const result = await admin.from('market_simulation_runs').insert({
        name, source_id: sourceId, period_from: periodFrom, period_to: periodTo,
        base_totals: baseTotals, assumptions, projected_totals: projectedTotals,
        created_by: profile.user_id, status,
      }).select('simulation_id,name,source_id,period_from,period_to,base_totals,assumptions,projected_totals,created_by,created_at,status').single();
      if (result.error || !result.data) return reply(req, { ok: false, message: dbMessage(result.error, '市場模擬紀錄儲存失敗') }, 400);
      await writeAudit(admin, profile.user_id, 'market_simulation_runs', String(result.data.simulation_id), 'insert', null, result.data);
      return reply(req, { ok: true, data: result.data });
    }

    if (action === 'market_source_save') {
      const canManageMarket = isSysadmin || roleCanManageMarket || marketPermissionEnabled((profile.permissions as Record<string, unknown> | null)?.marketanalytics_manage) || marketPermissionEnabled((profile.permissions as Record<string, unknown> | null)?.admin);
      if (!canManageMarket) return reply(req, { ok: false, message: '只有市場分析管理者可以修改資料來源' }, 403);
      const sourceId = id(body.source_id);
      const sourceCode = text(body.source_code, 60).toLowerCase();
      const sourceName = text(body.source_name, 120);
      const sourceType = text(body.source_type, 20) || 'manual';
      let fields = marketFieldDefinitions(body.field_definitions);
      if (!/^[a-z][a-z0-9_-]{1,59}$/.test(sourceCode) || !sourceName) return reply(req, { ok: false, message: '資料來源代碼與名稱不可空白，代碼需使用英文字母、數字、底線或連字號' }, 400);
      if (!['manual', 'csv', 'json', 'api'].includes(sourceType)) return reply(req, { ok: false, message: '資料來源類型不正確' }, 400);
      if (!fields.some(field => field.kind === 'dimension') || !fields.some(field => field.kind === 'measure')) return reply(req, { ok: false, message: '資料來源至少需要一個分類欄位與一個數值欄位' }, 400);
      const fieldKeys = fields.map(field => field.key);
      if (new Set(fieldKeys).size !== fieldKeys.length) return reply(req, { ok: false, message: '欄位代碼不可重複，請合併或重新命名重複欄位' }, 400);
      const measureKeys = new Set(fields.filter(field => field.kind === 'measure').map(field => field.key));
      const invalidWeightedField = fields.find(field => field.aggregation === 'weighted_avg'
        && (!field.weight_key || field.weight_key === field.key || !measureKeys.has(field.weight_key)));
      if (invalidWeightedField) return reply(req, { ok: false, message: `「${invalidWeightedField.label}」使用加權平均時，必須指定另一個已定義的數值欄位作為權重` }, 400);
      if (sourceId) {
        const currentSource = await admin.from('market_data_sources').select('field_definitions').eq('source_id', sourceId).maybeSingle();
        if (currentSource.error || !currentSource.data) return reply(req, { ok: false, message: '找不到要更新的市場行情資料來源' }, 404);
        const currentFields = new Map(marketFieldDefinitions(currentSource.data.field_definitions).map(field => [field.key, field]));
        fields = fields.map(field => {
          const current = currentFields.get(field.key);
          return {
            ...field,
            hidden: field.hidden ?? current?.hidden,
            filterable: field.filterable ?? current?.filterable,
          };
        });
      }
      const payload: Record<string, unknown> = { source_code: sourceCode, source_name: sourceName, source_type: sourceType, endpoint_url: text(body.endpoint_url, 500) || null, field_definitions: fields, status: body.status === 'inactive' ? 'inactive' : 'active', updated_at: new Date().toISOString() };
      // 更新時若前端沒有送 config，保留資料庫中的既有設定；只有明確送出
      // config 才覆寫。新增來源仍以空物件作為安全預設值。
      if (!sourceId || Object.prototype.hasOwnProperty.call(body, 'config')) payload.config = marketJsonObject(body.config);
      const result = sourceId
        ? await admin.from('market_data_sources').update(payload).eq('source_id', sourceId).select('source_id,source_code,source_name,source_type,endpoint_url,field_definitions,config,status,updated_at').maybeSingle()
        : await admin.from('market_data_sources').insert({ ...payload, created_by: profile.user_id }).select('source_id,source_code,source_name,source_type,endpoint_url,field_definitions,config,status,updated_at').single();
      if (result.error || !result.data) return reply(req, { ok: false, message: dbMessage(result.error, '資料來源儲存失敗') }, 400);
      await writeAudit(admin, profile.user_id, 'market_data_sources', String(result.data.source_id), sourceId ? 'update' : 'insert', null, result.data);
      return reply(req, { ok: true, data: result.data });
    }

    if (action === 'market_template_save') {
      const canManageMarket = isSysadmin || roleCanManageMarket || marketPermissionEnabled((profile.permissions as Record<string, unknown> | null)?.marketanalytics_manage) || marketPermissionEnabled((profile.permissions as Record<string, unknown> | null)?.admin);
      if (!canManageMarket) return reply(req, { ok: false, message: '只有市場分析管理者可以修改分析模板' }, 403);
      const templateId = id(body.template_id);
      const templateCode = text(body.template_code, 60).toLowerCase();
      const templateName = text(body.template_name, 120);
      const dimensions: string[] = Array.isArray(body.dimensions) ? body.dimensions.map((value: unknown) => text(value, 60).toLowerCase()).filter((value: string) => Boolean(value)).slice(0, 8) : [];
      const measures: string[] = Array.isArray(body.measures) ? body.measures.map((value: unknown) => text(value, 60).toLowerCase()).filter((value: string) => Boolean(value)).slice(0, 8) : [];
      const chartType = ['bar', 'pie', 'doughnut', 'line', 'area', 'table', 'cards'].includes(text(body.chart_type, 20)) ? text(body.chart_type, 20) : 'bar';
      if (!/^[a-z][a-z0-9_-]{1,59}$/.test(templateCode) || !templateName || !measures.length) return reply(req, { ok: false, message: '模板代碼、名稱與至少一個分析指標為必填' }, 400);
      const sourceId = id(body.source_id) || null;
      if (sourceId) {
        const sourceResult = await admin.from('market_data_sources').select('field_definitions').eq('source_id', sourceId).eq('status', 'active').maybeSingle();
        if (sourceResult.error || !sourceResult.data) return reply(req, { ok: false, message: '找不到模板使用的市場行情資料來源' }, 404);
        const sourceFields = marketFieldDefinitions(sourceResult.data.field_definitions);
        const visibleDimensionKeys = new Set(sourceFields.filter(field => field.kind === 'dimension' && field.hidden !== true).map(field => field.key));
        const sourceMeasureKeys = new Set(sourceFields.filter(field => field.kind === 'measure').map(field => field.key));
        if (dimensions.some(key => !visibleDimensionKeys.has(key))) return reply(req, { ok: false, message: '模板包含不存在或不可顯示的分析維度，請重新選擇' }, 400);
        if (measures.some(key => !sourceMeasureKeys.has(key))) return reply(req, { ok: false, message: '模板包含不存在的分析指標，請重新選擇' }, 400);
      }
      const payload = { template_code: templateCode, template_name: templateName, description: text(body.description, 500) || null, source_id: sourceId, dimensions, measures, chart_type: chartType, default_config: marketJsonObject(body.default_config), status: body.status === 'inactive' ? 'inactive' : 'active', updated_at: new Date().toISOString() };
      const result = templateId
        ? await admin.from('market_analysis_templates').update(payload).eq('template_id', templateId).select('template_id,template_code,template_name,description,source_id,dimensions,measures,chart_type,default_config,status,updated_at').maybeSingle()
        : await admin.from('market_analysis_templates').insert({ ...payload, created_by: profile.user_id }).select('template_id,template_code,template_name,description,source_id,dimensions,measures,chart_type,default_config,status,updated_at').single();
      if (result.error || !result.data) return reply(req, { ok: false, message: dbMessage(result.error, '分析模板儲存失敗') }, 400);
      await writeAudit(admin, profile.user_id, 'market_analysis_templates', String(result.data.template_id), templateId ? 'update' : 'insert', null, result.data);
      return reply(req, { ok: true, data: result.data });
    }

    if (action === 'market_import_rows') {
      const canManageMarket = isSysadmin || roleCanManageMarket || marketPermissionEnabled((profile.permissions as Record<string, unknown> | null)?.marketanalytics_manage) || marketPermissionEnabled((profile.permissions as Record<string, unknown> | null)?.admin);
      if (!canManageMarket) return reply(req, { ok: false, message: '只有市場分析管理者可以匯入行情資料' }, 403);
      const sourceId = id(body.source_id);
      const sourceResult = await admin.from('market_data_sources').select('source_id,field_definitions,config').eq('source_id', sourceId).eq('status', 'active').maybeSingle();
      if (sourceResult.error || !sourceResult.data) return reply(req, { ok: false, message: '找不到可匯入的資料來源' }, 404);
      const fields = marketFieldDefinitions(sourceResult.data.field_definitions);
      const dimensions = fields.filter(field => field.kind === 'dimension');
      const measures = fields.filter(field => field.kind === 'measure');
      const dimensionKeys = new Set(dimensions.map(field => field.key));
      const sourceConfig = marketJsonObject((sourceResult.data as unknown as Record<string, unknown>).config);
      const configuredNaturalKeys = Array.isArray(sourceConfig.natural_key_fields)
        ? (sourceConfig.natural_key_fields as unknown[]).map(value => text(value, 60)).filter(key => dimensionKeys.has(key))
        : [];
      const naturalKeyFields = configuredNaturalKeys.length ? [...new Set(configuredNaturalKeys)] : dimensions.map(field => field.key);
      const inputRows: unknown[] = Array.isArray(body.rows) ? body.rows : [];
      if (!inputRows.length) return reply(req, { ok: false, message: '沒有可匯入的資料列' }, 400);
      if (inputRows.length > 2000) return reply(req, { ok: false, message: '單次最多匯入 2,000 筆行情資料；為避免漏匯，請將檔案分批後再試。' }, 413);
      let rows: Array<Record<string, unknown>>;
      try {
        rows = await Promise.all(inputRows.map(async (item: unknown, index: number) => {
          const row = marketJsonObject(item);
          const observedOn = text(row.observed_on, 10);
          if (!validISODate(observedOn)) throw new Error(`第 ${index + 1} 列日期格式不正確`);
          const rawDimensions = marketJsonObject(row.dimensions), rawMeasures = marketJsonObject(row.measures);
          const normalizedDimensions = Object.fromEntries(dimensions.map(field => [field.key, text(rawDimensions[field.key], 200)]).filter(([, value]) => value));
          const normalizedMeasures: Record<string, number> = {};
          measures.forEach(field => { const value = marketNumeric(rawMeasures[field.key]); if (value !== null) normalizedMeasures[field.key] = value; });
          const requiredMissing = dimensions.filter(field => field.required && !normalizedDimensions[field.key]);
          if (requiredMissing.length) throw new Error(`第 ${index + 1} 列缺少${requiredMissing.map(field => field.label).join('、')}`);
          const externalKey = text(row.external_key, 200) || await marketImportExternalKey(sourceId, observedOn, normalizedDimensions, naturalKeyFields);
          return { observed_on: observedOn, dimensions: normalizedDimensions, measures: normalizedMeasures, metadata: marketJsonObject(row.metadata), external_key: externalKey };
        }));
        const keyRows = new Map<string, number>();
        rows.forEach((row, index) => {
          const key = String(row.external_key);
          const previousIndex = keyRows.get(key);
          if (previousIndex !== undefined) throw new Error(`同一批第 ${previousIndex + 1} 列與第 ${index + 1} 列的日期及分類欄位重複；請先合併該筆行情後再匯入。`);
          keyRows.set(key, index);
        });
        const result = await admin.rpc('market_import_data_points', { p_source_id: sourceId, p_rows: rows, p_imported_by: profile.user_id });
        if (result.error) return reply(req, { ok: false, message: dbMessage(result.error, '行情資料匯入失敗') }, 400);
        const counts = Array.isArray(result.data) ? result.data[0] as Record<string, unknown> | undefined : undefined;
        const inserted = Number(counts?.inserted_count) || 0;
        const updated = Number(counts?.updated_count) || 0;
        await writeAudit(admin, profile.user_id, 'market_data_points', sourceId, 'insert', null, { inserted, updated, row_count: rows.length });
        return reply(req, { ok: true, data: { imported: inserted + updated, inserted, updated } });
      } catch (error) {
        return reply(req, { ok: false, message: error instanceof Error ? error.message : '行情資料格式不正確' }, 400);
      }
    }

    if (action === 'module_data') {
      const systemKey=text(body.system,40),moduleKey=text(body.module,40);
      const config=MODULE_SOURCES[`${systemKey}/${moduleKey}`];
      if(!config)return reply(req,{ok:false,message:'找不到指定的 V2 子系統'},404);
      if(!can(config.permission))return reply(req,{ok:false,message:'目前角色沒有此系統權限'},403);
      const selectColumns=config.columns.map(column=>column[0]);
      if(systemKey==='guardpatrol'&&moduleKey==='records'){
        selectColumns.push('equipment(name)','users!inspection_records_inspector_id_fkey(name)');
      }
      // API 不提供整表下載；畫面分頁仍由前端保留，但單次回傳最多 100 筆。
      let query=userDb.from(config.table).select(selectColumns.join(',')).limit(100);
      if(config.filter)query=query.eq(config.filter[0],config.filter[1]);
      if(config.order)query=query.order(config.order,{ascending:false});
      const {data,error}=await query;
      if(error){console.error('module_data query failed',config.table,error.message);return reply(req,{ok:false,message:`${config.title}資料讀取失敗`},500);}
      const rows=((data||[]) as unknown as Array<Record<string,unknown>>).map(row=>{
        if(systemKey!=='guardpatrol'||moduleKey!=='records')return normalizeFloorFields(row);
        const equipmentName=relationName(row.equipment);
        const inspectorName=relationName(row.users);
        return normalizeFloorFields({...row,equipment_id:equipmentName||row.equipment_id,inspector_id:inspectorName||row.inspector_id});
      });
      if (systemKey === 'workorder' && moduleKey === 'requests') {
        const departmentResult = await userDb.from('departments')
          .select('dept_id,parent_id,name').eq('status', 'active').limit(5000);
        if (departmentResult.error) console.warn('Department path lookup skipped:', departmentResult.error.message);
        const departmentPaths = buildDepartmentPaths((departmentResult.data || []) as DepartmentNode[]);
        rows.forEach(row => { row.department = formatDepartment(row.department, departmentPaths.byName); });
      }
      const statusCounts=new Map<string,number>();
      rows.forEach(row=>{const status=text(row.status||row.run_status,50);if(status)statusCounts.set(status,(statusCounts.get(status)||0)+1)});
      const summary = systemKey === 'workorder' && moduleKey === 'requests'
        ? await repairRequestSummary(userDb)
        : [{label:'目前資料',value:rows.length},...[...statusCounts.entries()].slice(0,3).map(([label,value])=>({label,value}))];
      return reply(req,{ok:true,data:{title:config.title,table:config.table,columns:config.columns.map(([key,label])=>({key,label})),rows,summary}});
    }

    if (action === 'workorder_list') {
      if (!can('workorder')) return reply(req, { ok: false, message: '目前角色沒有維修系統權限' }, 403);
      const moduleKey = text(body.module, 20);
      if (!['requests', 'dispatch', 'orders'].includes(moduleKey)) {
        return reply(req, { ok: false, message: '維修子系統參數無效' }, 400);
      }
      const requests = await userDb.from('repair_requests').select('*')
        .order('updated_at', { ascending: false }).limit(500);
      if (requests.error) throw requests.error;
      const departmentResult = await userDb.from('departments')
        .select('dept_id,parent_id,name').eq('status', 'active').limit(5000);
      if (departmentResult.error) console.warn('Department path lookup skipped:', departmentResult.error.message);
      const departmentPaths = buildDepartmentPaths((departmentResult.data || []) as DepartmentNode[]);
      let rows: Array<Record<string, unknown>> = ((requests.data || []) as Array<Record<string, unknown>>).map(row => ({
        ...row,
        department: formatDepartment(row.department, departmentPaths.byName),
      } as Record<string, unknown>));
      if (moduleKey !== 'requests' && rows.length) {
        const requestIds = rows.map(row => text(row.request_id, 80)).filter(Boolean);
        const latestOrders = new Map<string, Record<string, unknown>>();
        // in() 查詢會直接拼進 URL，超過約 200 筆就可能超過代理層 8KB 上限，故分批查詢。
        for (let index = 0; index < requestIds.length; index += 100) {
          const chunk = requestIds.slice(index, index + 100);
          const { data, error } = await userDb.from('maintenance_orders')
            .select('order_id,request_id,assignee_id,status,created_at')
            .in('request_id', chunk).order('created_at', { ascending: false }).limit(1000);
          if (error) throw error;
          for (const order of (data || []) as Array<Record<string, unknown>>) {
            const requestId = text(order.request_id, 80);
            if (requestId && !latestOrders.has(requestId)) latestOrders.set(requestId, order);
          }
        }
        const assigneeIds = [...new Set([...latestOrders.values()].map(order => text(order.assignee_id, 80)).filter(Boolean))];
        const names = new Map<string, string>();
        for (let index = 0; index < assigneeIds.length; index += 100) {
          const chunk = assigneeIds.slice(index, index + 100);
          const { data, error } = await userDb.from('users').select('user_id,name').in('user_id', chunk);
          if (error) throw error;
          for (const person of (data || []) as Array<Record<string, unknown>>) {
            names.set(String(person.user_id), text(person.name, 100));
          }
        }
        rows = rows.map(row => {
          const order = latestOrders.get(text(row.request_id, 80));
          const assigneeId = text(order?.assignee_id || row.assignee_id, 80);
          return {
            ...row,
            order_id: order?.order_id || null,
            order_status: order?.status || null,
            assignee_id: assigneeId || null,
            assignee_name: names.get(assigneeId) || '',
          };
        });
      }
      const statusCounts = new Map<string, number>();
      rows.forEach(row => {
        const status = text(row.status, 50);
        if (status) statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
      });
      const titles: Record<string, string> = { requests: '報修案件', dispatch: '派工作業', orders: '維修工單' };
      return reply(req, { ok: true, data: {
        title: titles[moduleKey],
        table: 'repair_requests',
        rows,
        summary: await repairRequestSummary(userDb),
      } });
    }

    if (action === 'workorder_options') {
      if (!can('workorder')) return reply(req, { ok: false, message: '目前角色沒有維修系統權限' }, 403);
      const [people, equipment, departments, contact, locations] = await Promise.all([
        userDb.from('users').select('user_id,name,department,dept_id,role,rbac_role').eq('status', 'active').order('name').limit(500),
        userDb.from('equipment').select('equipment_id,name,asset_code,location,category').neq('status', 'retired').order('name').limit(500),
        userDb.from('departments').select('dept_id,parent_id,name').eq('status', 'active').order('sort_order').limit(200),
        userDb.from('users').select('phone,department').eq('user_id', profile.user_id).maybeSingle(),
        // 報修建立時要能綁場域位置，位置分析頁才有資料來源。
        userDb.from('locations').select('location_id,market_id,floor,area,detail,floor_order,area_order,detail_order,markets(name)')
          .eq('status', 'active').order('floor_order').order('area_order').order('detail_order').limit(2000),
      ]);
      if (people.error) throw people.error;
      if (equipment.error) throw equipment.error;
      if (departments.error) throw departments.error;
      if (contact.error) throw contact.error;
      if (locations.error) throw locations.error;
      const departmentPaths = buildDepartmentPaths((departments.data || []) as DepartmentNode[]);
      const technicians = (people.data || []).filter(row => {
        const role = text(row.rbac_role || row.role, 40);
        return role === 'technician' || role === 'maintenance';
      }).map(row => ({
        user_id: String(row.user_id),
        name: text(row.name, 100),
        department: departmentPaths.pathForId(row.dept_id)
          || formatDepartment(row.department, departmentPaths.byName) || null,
      })).filter(row => row.user_id && row.name);
      const departmentOptions = [...new Set((departments.data || [])
        .map(row => departmentPaths.pathForId(row.dept_id) || text(row.name, 100))
        .filter(Boolean))];
      return reply(req, { ok: true, data: {
        technicians,
        equipment: equipment.data || [],
        departments: departmentOptions,
        locations: locations.data || [],
        contact: {
          phone: text(contact.data?.phone, 40),
          department: text(profile.department, 100) || formatDepartment(contact.data?.department, departmentPaths.byName),
        },
      } });
    }

    if (action === 'workorder_detail') {
      if (!can('workorder')) return reply(req, { ok: false, message: '目前角色沒有維修系統權限' }, 403);
      const requestId = text(body.request_id, 80);
      const requestNo = text(body.req_no, 80);
      if (requestId && !/^[0-9a-f-]{36}$/i.test(requestId)) return reply(req, { ok: false, message: '報修案件識別碼無效' }, 400);
      if (!requestId && !requestNo) return reply(req, { ok: false, message: '找不到報修案件識別碼' }, 400);
      let requestQuery = userDb.from('repair_requests').select('*,equipment(name,category,qr_code)');
      requestQuery = requestId ? requestQuery.eq('request_id', requestId) : requestQuery.eq('req_no', requestNo);
      const requestResult = await requestQuery.limit(1).maybeSingle();
      if (requestResult.error) throw requestResult.error;
      if (!requestResult.data) return reply(req, { ok: false, message: '找不到這筆報修案件' }, 404);
      const fullRequestId = String(requestResult.data.request_id);
      const departmentResult = await userDb.from('departments')
        .select('dept_id,parent_id,name').eq('status', 'active').limit(5000);
      const departmentPaths = buildDepartmentPaths((departmentResult.data || []) as DepartmentNode[]);
      const detailRequest = {
        ...(requestResult.data as Record<string, unknown>),
        department: formatDepartment(requestResult.data.department, departmentPaths.byName),
      };
      const [orderResult, attachmentsResult, logsResult] = await Promise.all([
        userDb.from('maintenance_orders').select('*,users:assignee_id(name)').eq('request_id', fullRequestId)
          .order('created_at', { ascending: false }).limit(1).maybeSingle(),
        userDb.from('repair_attachments').select('*').eq('request_id', fullRequestId).order('uploaded_at', { ascending: true }),
        userDb.from('case_status_log').select('*').eq('request_id', fullRequestId).order('created_at', { ascending: true }),
      ]);
      const warnings: string[] = [];
      if (departmentResult.error) warnings.push('單位資訊暫時無法載入');
      if (orderResult.error) warnings.push(`維修工單：${text(orderResult.error.message, 300)}`);
      if (attachmentsResult.error) warnings.push(`附件：${text(attachmentsResult.error.message, 300)}`);
      if (logsResult.error) warnings.push(`處理歷程：${text(logsResult.error.message, 300)}`);
      const attachments = ((attachmentsResult.data || []) as Array<Record<string, unknown>>).map(item => ({ ...item }));
      if (attachments.length) {
        const paths = attachments.map(item => text(item.file_path, 1000)).filter(Boolean);
        const signedResult = await userDb.storage.from('repair-files').createSignedUrls(paths, 3600);
        if (signedResult.error) warnings.push(`附件網址：${text(signedResult.error.message, 300)}`);
        const signedMap = new Map((signedResult.data || []).map(item => [item.path, item.signedUrl]));
        attachments.forEach(item => { item.signed_url = signedMap.get(text(item.file_path, 1000)) || ''; });
      }
      // 完工回報寫入的費用要能顯示在處理歷程上，否則使用者看不出這張單花了多少。
      let costs: Array<Record<string, unknown>> = [];
      const detailOrderId = orderResult.data?.order_id;
      if (detailOrderId) {
        const costResult = await userDb.from('cost_records')
          .select('cost_id,cost_type,amount,cost_date,note')
          .eq('order_id', detailOrderId).order('cost_date');
        if (costResult.error) warnings.push(`費用紀錄：${text(costResult.error.message, 300)}`);
        else costs = costResult.data || [];
      }
      return reply(req, { ok: true, data: {
        request: detailRequest,
        order: orderResult.data || null,
        attachments,
        logs: logsResult.data || [],
        costs,
        warnings,
      } });
    }

    if (action === 'workorder_prepare_upload') {
      if (!can('workorder')) return reply(req, { ok: false, message: '目前角色沒有維修系統權限' }, 403);
      const reqBody = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
      const requestPayload = reqBody.request && typeof reqBody.request === 'object' && !Array.isArray(reqBody.request)
        ? reqBody.request as Record<string, unknown>
        : {};
      const locationPhoto = reqBody.location_photo && typeof reqBody.location_photo === 'object' && !Array.isArray(reqBody.location_photo)
        ? reqBody.location_photo as Record<string, unknown>
        : {};
      const equipmentPhoto = reqBody.equipment_photo && typeof reqBody.equipment_photo === 'object' && !Array.isArray(reqBody.equipment_photo)
        ? reqBody.equipment_photo as Record<string, unknown>
        : {};
      const locationFileName = text(locationPhoto.name, 200);
      const equipmentFileName = text(equipmentPhoto.name, 200);
      const locationFileType = text(locationPhoto.type, 80).toLowerCase();
      const equipmentFileType = text(equipmentPhoto.type, 80).toLowerCase();
      if (!locationFileName || !equipmentFileName) return reply(req, { ok: false, message: '照片檔名不可為空' }, 400);
      if (!/^(image\/(?:jpeg|png|webp|heic))$/i.test(locationFileType) || !/^(image\/(?:jpeg|png|webp|heic))$/i.test(equipmentFileType)) {
        return reply(req, { ok: false, message: '照片類型必須是 JPEG、PNG、WebP 或 HEIC' }, 400);
      }
      const locationFileSize = Number(locationPhoto.size);
      const equipmentFileSize = Number(equipmentPhoto.size);
      if (!Number.isFinite(locationFileSize) || locationFileSize <= 0 || locationFileSize > 10 * 1024 * 1024) return reply(req, { ok: false, message: '故障位置照片大小限制 10MB' }, 400);
      if (!Number.isFinite(equipmentFileSize) || equipmentFileSize <= 0 || equipmentFileSize > 10 * 1024 * 1024) return reply(req, { ok: false, message: '維修設備照片大小限制 10MB' }, 400);

      const requestId = nextRequestRequestId();
      const reqNoResult = await admin.rpc('gen_req_no');
      if (reqNoResult.error || !reqNoResult.data) return reply(req, { ok: false, message: '無法產生報修單號，請稍後再試' }, 503);
      const reqNo = text(reqNoResult.data, 40);
      const requestSnapshot = {
        request_id: requestId,
        req_no: reqNo,
        // V2 表單是直接通報；沿用 repair_requests 既有合法來源值。
        source: 'direct',
        reporter: text(requestPayload.reporter, 100) || profile.name,
        phone: text(requestPayload.phone, 40) || null,
        department: text(requestPayload.department, 100) || text(profile.department, 100) || null,
        equipment_id: /^[0-9a-f-]{36}$/i.test(text(requestPayload.equipment_id, 80)) ? text(requestPayload.equipment_id, 80) : null,
        equipment_category: text(requestPayload.equipment_category, 120) || null,
        fault_location: text(requestPayload.fault_location, 200) || null,
        fault_type: text(requestPayload.fault_type, 80) || null,
        urgency: text(requestPayload.urgency, 20) || 'normal',
        fault_desc: text(requestPayload.fault_desc, 2000),
        mobile: text(requestPayload.mobile, 40) || null,
        status: 'pending',
        created_by: profile.user_id,
      };
      if (!requestSnapshot.req_no) return reply(req, { ok: false, message: '無法建立報修單號，請稍後再試' }, 500);
      if (!requestSnapshot.fault_desc) return reply(req, { ok: false, message: '故障描述不可空白' }, 400);
      if (!requestSnapshot.mobile) return reply(req, { ok: false, message: '手機號碼為必填欄位' }, 400);

      const locationPath = `${requestId}/location_${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${extractFileExt(locationFileName, 'jpg')}`;
      const equipmentPath = `${requestId}/equipment_${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${extractFileExt(equipmentFileName, 'jpg')}`;
      const [locationUpload, equipmentUpload] = await Promise.all([
        admin.storage.from('repair-files').createSignedUploadUrl(locationPath),
        admin.storage.from('repair-files').createSignedUploadUrl(equipmentPath),
      ]);

      if (locationUpload.error || !locationUpload.data || !locationUpload.data.path || !locationUpload.data.token) {
        return reply(req, { ok: false, message: text(locationUpload.error?.message, 300) || '故障位置照片上傳授權建立失敗' }, 500);
      }
      if (equipmentUpload.error || !equipmentUpload.data || !equipmentUpload.data.path || !equipmentUpload.data.token) {
        return reply(req, { ok: false, message: text(equipmentUpload.error?.message, 300) || '維修設備照片上傳授權建立失敗' }, 500);
      }

      return reply(req, { ok: true, data: {
        request_snapshot: requestSnapshot,
        uploads: {
          location: {
            path: locationUpload.data.path,
            token: locationUpload.data.token,
          },
          equipment: {
            path: equipmentUpload.data.path,
            token: equipmentUpload.data.token,
          },
        },
      } });
    }

    if (action === 'workorder_create_request') {
      if (!can('workorder')) return reply(req, { ok: false, message: '目前角色沒有維修系統權限' }, 403);
      const reqBody = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
      const requestData = reqBody.request && typeof reqBody.request === 'object' && !Array.isArray(reqBody.request)
        ? reqBody.request as Record<string, unknown>
        : {};
      const requestId = text(requestData.request_id, 80);
      const reqNo = text(requestData.req_no, 80);
      const locationPath = text(reqBody.location_file_path, 1000);
      const equipmentPath = text(reqBody.equipment_file_path, 1000);
      const locationFileName = text(reqBody.location_file_name, 120);
      const equipmentFileName = text(reqBody.equipment_file_name, 120);
      if (!/^[0-9a-f-]{36}$/i.test(requestId)) return reply(req, { ok: false, message: '報修案件識別碼無效' }, 400);
      if (!reqNo) return reply(req, { ok: false, message: '報修單號不可為空' }, 400);
      if (!locationPath || !equipmentPath) return reply(req, { ok: false, message: '上傳檔案資訊不完整' }, 400);
      if (!locationPath.startsWith(`${requestId}/`) || !equipmentPath.startsWith(`${requestId}/`)) return reply(req, { ok: false, message: '上傳檔案路徑不符案件' }, 400);
      if (!locationFileName || !equipmentFileName) return reply(req, { ok: false, message: '上傳檔名不完整' }, 400);
      // create 端重新驗證業務必填欄位，不信任 prepare 階段的 snapshot，
      // 防止攻擊者走完 prepare 後在 create 階段竄改欄位。
      if (!text(requestData.fault_desc, 2000)) return reply(req, { ok: false, message: '故障描述不可空白' }, 400);
      if (!text(requestData.mobile, 40)) return reply(req, { ok: false, message: '手機號碼為必填欄位' }, 400);
      if (!['normal', 'urgent', 'emergency'].includes(text(requestData.urgency, 20))) return reply(req, { ok: false, message: '急迫度設定無效' }, 400);

      const uploadedList = await admin.storage.from('repair-files').list(requestId);
      if (uploadedList.error) return reply(req, { ok: false, message: text(uploadedList.error.message, 300) || '驗證附件上傳結果失敗' }, 503);
      const uploadedSet = new Set((uploadedList.data || []).map(item => text((item as { name: string }).name, 500)));
      const uploadedLocationFile = locationPath.split('/').pop();
      const uploadedEquipmentFile = equipmentPath.split('/').pop();
      if (!uploadedSet.has(uploadedLocationFile || '') || !uploadedSet.has(uploadedEquipmentFile || '')) {
        return reply(req, { ok: false, message: '附件尚未完成上傳，請重新上傳' }, 409);
      }

      const [existingRequest] = await Promise.all([
        admin.from('repair_requests').select('request_id').eq('request_id', requestId).maybeSingle(),
      ]);
      if (existingRequest.error) return reply(req, { ok: false, message: text(existingRequest.error.message, 300) || '檢查現有資料失敗' }, 500);
      if (existingRequest.data) return reply(req, { ok: false, message: '此報修案件已提交，請勿重複送出' }, 409);

      const [existingReqNo] = await Promise.all([
        admin.from('repair_requests').select('request_id').eq('req_no', reqNo).maybeSingle(),
      ]);
      if (existingReqNo.error) return reply(req, { ok: false, message: text(existingReqNo.error.message, 300) || '檢查報修單號失敗' }, 500);
      if (existingReqNo.data) return reply(req, { ok: false, message: '報修單號重複，請稍後再試' }, 409);

      const requestRow = {
        request_id: requestId,
        req_no: reqNo,
        // V2 表單是直接通報；沿用 repair_requests 既有合法來源值。
        source: 'direct',
        reporter: text(requestData.reporter, 100) || profile.name,
        phone: text(requestData.phone, 40) || null,
        department: text(requestData.department, 100) || text(profile.department, 100) || null,
        equipment_id: /^[0-9a-f-]{36}$/i.test(text(requestData.equipment_id, 80)) ? text(requestData.equipment_id, 80) : null,
        equipment_category: text(requestData.equipment_category, 120) || null,
        fault_location: text(requestData.fault_location, 200) || null,
        // fault_location 保留現場自由描述，location_id 綁場域位置主檔供彙總統計。
        location_id: /^[0-9a-f-]{36}$/i.test(text(requestData.location_id, 80)) ? text(requestData.location_id, 80) : null,
        fault_type: text(requestData.fault_type, 80) || null,
        urgency: text(requestData.urgency, 20) || 'normal',
        fault_desc: text(requestData.fault_desc, 2000),
        mobile: text(requestData.mobile, 40) || null,
        status: 'pending',
        created_by: profile.user_id,
      };
      const attachmentsRows = [
        { request_id: requestId, kind: 'location_photo', file_path: locationPath, file_name: locationFileName, uploaded_by: profile.user_id },
        { request_id: requestId, kind: 'equipment_photo', file_path: equipmentPath, file_name: equipmentFileName, uploaded_by: profile.user_id },
      ];
      const logRow = {
        request_id: requestId,
        order_id: null,
        from_status: null,
        to_status: 'pending',
        note: '報修人建立報修',
        operator_id: profile.user_id,
        operator_name: profile.name,
      };
      const createResponse = await admin.from('repair_requests').insert(requestRow).select('request_id,req_no').single();
      if (createResponse.error) {
        await admin.storage.from('repair-files').remove([locationPath, equipmentPath]);
        return reply(req, { ok: false, message: text(createResponse.error.message, 300) || '建立報修失敗' }, 400);
      }
      const created = createResponse.data;

      // 補償路徑不再 DELETE（repair_requests 受永久資料保護 trigger 禁止刪除），
      // 改將該單標記為 cancelled 並清理已上傳檔案，避免殘留孤立的 pending 單。
      const rollback = async () => {
        await admin.storage.from('repair-files').remove([locationPath, equipmentPath]);
        await admin.from('repair_requests').update({ status: 'cancelled' }).eq('request_id', requestId);
      };
      const initLog = await admin.from('case_status_log').insert(logRow);
      if (initLog.error) {
        await rollback();
        return reply(req, { ok: false, message: text(initLog.error.message, 300) || '建立歷程失敗' }, 400);
      }

      const attachmentInsert = await admin.from('repair_attachments').insert(attachmentsRows).select('attach_id').limit(10);
      if (attachmentInsert.error) {
        await rollback();
        return reply(req, { ok: false, message: text(attachmentInsert.error.message, 300) || '建立附件失敗' }, 400);
      }

      return reply(req, { ok: true, data: created });
    }

    if (action === 'workorder_workflow') {
      if (!can('workorder')) return reply(req, { ok: false, message: '目前角色沒有維修系統權限' }, 403);
      const requestId = text(body.request_id, 80);
      const workflowAction = text(body.workflow_action, 40);
      const allowedActions = new Set(['dispatch', 'engineer_accept', 'engineer_start', 'engineer_complete', 'reporter_accept', 'supervisor_accept', 'cancel']);
      if (!/^[0-9a-f-]{36}$/i.test(requestId)) return reply(req, { ok: false, message: '報修案件識別碼無效' }, 400);
      if (!allowedActions.has(workflowAction)) return reply(req, { ok: false, message: '維修流程動作無效' }, 400);
      const rawPayload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
        ? body.payload as Record<string, unknown>
        : {};
      const payload: Record<string, unknown> = {};
      const completionCost: { parts_cost?: number; labor_cost?: number } = {};
      if (workflowAction === 'dispatch') {
        const technician = text(rawPayload.technician, 80);
        if (technician && !/^[0-9a-f-]{36}$/i.test(technician)) return reply(req, { ok: false, message: '維修人員識別碼無效' }, 400);
        payload.technician = technician || null;
        payload.vendor = text(rawPayload.vendor, 200) || null;
        for (const key of ['expected_arrival', 'expected_finish'] as const) {
          const value = text(rawPayload[key], 40);
          if (value && Number.isNaN(Date.parse(value))) return reply(req, { ok: false, message: '派工日期時間格式無效' }, 400);
          payload[key] = value || null;
        }
        payload.work_content = text(rawPayload.work_content, 1000) || null;
        payload.need_shutdown = rawPayload.need_shutdown === true;
        payload.need_approval = rawPayload.need_approval === true;
      } else if (workflowAction === 'engineer_complete') {
        payload.fault_cause = text(rawPayload.fault_cause, 1000);
        payload.handle_method = text(rawPayload.handle_method, 2000);
        payload.parts_used = text(rawPayload.parts_used, 1000) || null;
        payload.materials = text(rawPayload.materials, 1000) || null;
        const laborHours = rawPayload.labor_hours === null || rawPayload.labor_hours === '' ? null : Number(rawPayload.labor_hours);
        if (laborHours !== null && (!Number.isFinite(laborHours) || laborHours < 0 || laborHours > 100000)) {
          return reply(req, { ok: false, message: '工時必須是零以上的數字' }, 400);
        }
        payload.labor_hours = laborHours;
        // 費用不進 apply_repair_workflow 的 payload，流程推進成功後另外呼叫
        // record_repair_completion_cost 寫入 cost_records，介接設備生命週期成本。
        for (const key of ['parts_cost', 'labor_cost'] as const) {
          const raw = rawPayload[key];
          if (raw === null || raw === undefined || raw === '') continue;
          const value = Number(raw);
          if (!Number.isFinite(value) || value < 0 || value > 9999999999) {
            return reply(req, { ok: false, message: '費用必須是零以上的數字' }, 400);
          }
          completionCost[key] = value;
        }
        payload.note = text(rawPayload.note, 1000) || null;
      }
      const { data, error } = await userDb.rpc('apply_repair_workflow', {
        p_request_id: requestId,
        p_action: workflowAction,
        p_payload: payload,
      });
      if (error) return reply(req, { ok: false, message: text(error.message, 500) || '維修流程更新失敗' }, 400);

      // 完工是現場事實，費用寫入失敗不回滾流程——費用可以事後在費用統計頁補登，
      // 但把完工擋下來會讓工程師卡在現場。失敗只回報警告。
      let costWarning = '';
      if (workflowAction === 'engineer_complete'
          && (completionCost.parts_cost !== undefined || completionCost.labor_cost !== undefined)) {
        const { error: costError } = await userDb.rpc('record_repair_completion_cost', {
          p_request_id: requestId,
          p_parts_cost: completionCost.parts_cost ?? null,
          p_labor_cost: completionCost.labor_cost ?? null,
        });
        if (costError) {
          console.error('record_repair_completion_cost failed:', costError.message);
          costWarning = '，但費用未寫入費用系統，請至費用統計頁補登';
        }
      }
      return reply(req, { ok: true, data, message: costWarning ? `已完工${costWarning}` : undefined });
    }

    if (action === 'dashboard') {
      const since = new Date(Date.now() - 30 * 86400_000).toISOString();
      const [equipment, inspections, abnormal, openRepairs, trendResult, repairsResult, recentResult] = await Promise.all([
        countQuery(userDb.from('equipment').select('*', { count: 'exact', head: true }).neq('status', 'retired')),
        countQuery(userDb.from('inspection_records').select('*', { count: 'exact', head: true }).gte('inspect_time', since)),
        countQuery(userDb.from('inspection_records').select('*', { count: 'exact', head: true }).gte('inspect_time', since).eq('run_status', 'abnormal')),
        countQuery(userDb.from('repair_requests').select('*', { count: 'exact', head: true }).neq('status', 'closed')),
        userDb.from('inspection_records').select('record_id,inspect_time,run_status').gte('inspect_time', since).order('inspect_time').limit(5000),
        userDb.from('repair_requests').select('request_id,req_no,fault_location,status,created_at').order('created_at', { ascending: false }).limit(8),
        userDb.from('inspection_records').select('record_id,inspect_time,run_status,equipment(name)').order('inspect_time', { ascending: false }).limit(8),
      ]);
      const buckets = new Map<string, { date: string; total: number; abnormal: number }>();
      if (trendResult.error) console.warn('dashboard trend query failed:', trendResult.error.message);
      if (repairsResult.error) console.warn('dashboard repairs query failed:', repairsResult.error.message);
      if (recentResult.error) console.warn('dashboard recent query failed:', recentResult.error.message);
      for (let offset = 29; offset >= 0; offset--) {
        const date = new Date(Date.now() - offset * 86400_000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
        buckets.set(date, { date, total: 0, abnormal: 0 });
      }
      for (const row of trendResult.data || []) {
        const date = new Date(row.inspect_time).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
        const bucket = buckets.get(date);
        if (bucket) { bucket.total += 1; if (row.run_status === 'abnormal') bucket.abnormal += 1; }
      }
      const recentInspections = (recentResult.data || []).map((row) => ({
        ...row,
        equipment_name: Array.isArray(row.equipment) ? row.equipment[0]?.name : (row.equipment as { name?: string } | null)?.name,
      }));
      return reply(req, { ok: true, data: {
        metrics: { equipment, inspections, abnormal, open_repairs: openRepairs, completion_rate: inspections ? Math.round((inspections - abnormal) / inspections * 1000) / 10 : 100 },
        inspection_trend: [...buckets.values()], recent_repairs: repairsResult.data || [], recent_inspections: recentInspections,
      } });
    }

    if (action === 'inspections') {
      if (!can('guardpatrol')) return reply(req, { ok: false, message: '目前角色沒有巡檢系統權限' }, 403);
      const [records, equipment, locations] = await Promise.all([
        userDb.from('inspection_records').select('record_id,inspect_time,run_status,light_status,abnormal_note,location_point,equipment(name,asset_code,floor),users!inspection_records_inspector_id_fkey(name)').order('inspect_time', { ascending: false }).limit(200),
        userDb.from('equipment').select('equipment_id,name,asset_code,floor').neq('status', 'retired').order('name').limit(1000),
        // 建立巡檢時要能綁場域位置，位置分析頁才有資料來源。
        userDb.from('locations').select('location_id,market_id,floor,area,detail,floor_order,area_order,detail_order,markets(name)')
          .eq('status', 'active').order('floor_order').order('area_order').order('detail_order').limit(2000),
      ]);
      if (records.error) throw records.error;
      if (equipment.error) throw equipment.error;
      if (locations.error) throw locations.error;
      const normalizeNested = (row: Record<string, unknown>) => {
        const relation = row.equipment;
        const equipmentRow = Array.isArray(relation)
          ? relation.map(item => normalizeFloorFields(item as Record<string, unknown>))
          : relation && typeof relation === 'object'
            ? normalizeFloorFields(relation as Record<string, unknown>)
            : relation;
        return normalizeFloorFields({ ...row, equipment: equipmentRow });
      };
      return reply(req, { ok: true, data: {
        rows: (records.data || []).map(row => normalizeNested(row as Record<string, unknown>)),
        equipment: (equipment.data || []).map(row => normalizeFloorFields(row as Record<string, unknown>)),
        locations: (locations.data || []).map(row => normalizeFloorFields(row as Record<string, unknown>)),
      } });
    }

    if (action === 'create_inspection') {
      if (!can('guardpatrol')) return reply(req, { ok: false, message: '目前角色沒有新增巡檢權限' }, 403);
      const equipmentId = text(body.equipment_id, 80);
      const runStatus = body.run_status === 'abnormal' ? 'abnormal' : 'normal';
      if (!/^[0-9a-f-]{36}$/i.test(equipmentId)) return reply(req, { ok: false, message: '請選擇有效設備' }, 400);
      const abnormalNote = text(body.abnormal_note, 1000);
      if (runStatus === 'abnormal' && !abnormalNote) return reply(req, { ok: false, message: '異常巡檢必須填寫說明' }, 400);
      // location_point 是自由文字、無法統計；location_id 綁到場域位置主檔，
      // 位置分析頁才有資料來源。兩者並存：前者記現場描述，後者供彙總。
      const locationId = text(body.location_id, 80);
      const { data, error } = await userDb.from('inspection_records').insert({
        equipment_id: equipmentId, inspector_id: profile.user_id, run_status: runStatus,
        light_status: runStatus === 'abnormal' ? 'red' : 'green',
        location_point: text(body.location_point, 240) || null, abnormal_note: abnormalNote || null,
        location_id: /^[0-9a-f-]{36}$/i.test(locationId) ? locationId : null,
      }).select('record_id').single();
      if (error) throw error;
      return reply(req, { ok: true, data });
    }

    if (action === 'guardpatrol_checkin') {
      if (!can('guardpatrol')) return reply(req, { ok: false, message: '目前角色沒有巡邏系統權限' }, 403);

      const targetType = text(body.target_type, 20);
      const targetId = text(body.target_id, 80);
      if (targetType !== 'marker' || !/^[0-9a-f-]{36}$/i.test(targetId)) {
        return reply(req, { ok: false, message: '巡邏點資料格式不正確' }, 400);
      }

      const { data: marker, error: markerError } = await admin
        .from('plan_markers')
        .select('marker_id,floor_id,label,kind,status')
        .eq('marker_id', targetId)
        .maybeSingle();
      if (markerError) throw markerError;
      if (!marker || marker.kind !== 'patrol' || marker.status !== 'active') {
        return reply(req, { ok: false, message: '此巡邏點已停用或不存在' }, 404);
      }

      const recentSince = new Date(Date.now() - 5 * 60_000).toISOString();
      const { data: recent, error: recentError } = await admin
        .from('checkin_logs')
        .select('checkin_id,checkin_at')
        .eq('user_id', profile.user_id)
        .eq('target_type', targetType)
        .eq('target_id', targetId)
        .gte('checkin_at', recentSince)
        .order('checkin_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (recentError) throw recentError;
      if (recent) return reply(req, { ok: false, message: '本巡邏點五分鐘內已完成簽到', data: { duplicate: true, event: recent } }, 409);

      const event = {
        target_type: targetType,
        target_id: targetId,
        floor_id: marker.floor_id || null,
        label: text(marker.label, 200) || '未命名巡檢點',
        user_id: profile.user_id,
        user_name: text(profile.name, 160) || text(profile.username, 160) || '巡檢人員',
        checkin_source: 'v2-dashboard',
        auth_level: 'server',
        verification_method: 'password_session',
        source_ip: extractClientIp(req),
        user_agent: text(req.headers.get('user-agent'), 1000) || null,
      };

      const { data: inserted, error: insertError } = await admin
        .from('checkin_logs')
        .insert(event)
        .select('checkin_id,checkin_at,target_type,target_id,floor_id,label,user_id,user_name,checkin_source,auth_level,verification_method')
        .single();
      if (insertError) throw insertError;
      await writeAudit(admin, profile.user_id, 'checkin_logs', inserted.checkin_id, 'insert', null, inserted);
      return reply(req, { ok: true, data: { event: inserted } });
    }

    if (action === 'open_inspection_cycle') {
      if (!isAdmin || !can('guardpatrol')) return reply(req, { ok: false, message: '只有巡檢系統管理者可以開啟週期' }, 403);
      const cycleType = text(body.cycle_type, 20);
      if (!['daily', 'shift', 'weekly'].includes(cycleType)) return reply(req, { ok: false, message: '週期類型無效' }, 400);
      const { data, error } = await userDb.rpc('open_inspection_cycle', { p_cycle_type: cycleType });
      if (error) throw error;
      return reply(req, { ok: true, data: { cycle_id: data } });
    }

    if (action === 'create_cost_record') {
      if (!can('workorder') || !isAdmin) {
        return reply(req, { ok: false, message: '目前角色沒有新增費用權限' }, 403);
      }
      const equipmentId = text(body.equipment_id, 80);
      const costType = text(body.cost_type, 20);
      const vendor = text(body.vendor, 200) || null;
      const note = text(body.note, 1000) || null;
      const costDate = text(body.cost_date, 10);
      const amount = Number(body.amount);
      if (!/^[0-9a-f-]{36}$/i.test(equipmentId)) return reply(req, { ok: false, message: '設備識別碼無效' }, 400);
      if (!['purchase', 'outsource', 'parts', 'labor', 'other'].includes(costType)) return reply(req, { ok: false, message: '費用類型無效' }, 400);
      if (!Number.isFinite(amount) || amount < 0 || amount > 9999999999) return reply(req, { ok: false, message: '金額必須介於 0 至 9,999,999,999' }, 400);
      if (!validISODate(costDate)) return reply(req, { ok: false, message: '日期格式無效' }, 400);
      const { data, error } = await userDb.from('cost_records').insert({
        equipment_id: equipmentId, cost_type: costType, vendor, cost_date: costDate,
        amount, note, created_by: profile.user_id,
      }).select('cost_id').single();
      if (error) throw error;
      return reply(req, { ok: true, data });
    }

    if (action === 'save_official_vehicle') {
      if (!can('vehicle')) return reply(req, { ok: false, message: '目前角色沒有車輛主檔權限' }, 403);
      const isFleetManager = isAdmin || (await userDb.from('vehicle_dispatch_managers').select('user_id').eq('user_id', profile.user_id).eq('active', true).maybeSingle()).data;
      if (!isFleetManager) return reply(req, { ok: false, message: '只有派車管理者可以維護車輛主檔' }, 403);
      const vehicleId = text(body.vehicle_id, 80);
      const plateNo = text(body.plate_no, 40);
      const seats = Number(body.seats);
      const odometer = Number(body.current_odometer);
      if (!plateNo || !Number.isInteger(seats) || seats < 1 || seats > 100 || !Number.isFinite(odometer) || odometer < 0 || odometer > 999999999) {
        return reply(req, { ok: false, message: '車號、座位數或里程資料無效' }, 400);
      }
      const payload = {
        plate_no: plateNo, vehicle_name: text(body.vehicle_name, 120) || null,
        brand: text(body.brand, 120) || null, model: text(body.model, 120) || null,
        seats, current_odometer: odometer, status: body.status === 'inactive' ? 'inactive' : 'active',
        note: text(body.note, 1000) || null,
      };
      if (vehicleId) {
        if (!/^[0-9a-f-]{36}$/i.test(vehicleId)) return reply(req, { ok: false, message: '車輛識別碼無效' }, 400);
        const { data, error } = await userDb.from('official_vehicles').update(payload).eq('vehicle_id', vehicleId).select('vehicle_id').maybeSingle();
        if (error) throw error;
        if (!data) return reply(req, { ok: false, message: '找不到車輛' }, 404);
        return reply(req, { ok: true, data: { vehicle_id: vehicleId, created: false } });
      }
      const { data, error } = await userDb.from('official_vehicles').insert({ ...payload, created_by: profile.user_id }).select('vehicle_id').single();
      if (error) throw error;
      return reply(req, { ok: true, data: { vehicle_id: data.vehicle_id, created: true } });
    }

    if (action === 'vehicle_create_request') {
      if (!can('vehicle')) return reply(req, { ok: false, message: '目前角色沒有派車系統權限' }, 403);
      const tripDate = text(body.trip_date, 10);
      const departure = text(body.planned_departure_time, 5), returnTime = text(body.planned_return_time, 5);
      const origin = text(body.origin_location, 200), destination = text(body.destination_location, 200);
      const purpose = text(body.trip_purpose, 500);
      const passengerCount = Number(body.passenger_count);
      const timePattern = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
      if (!validISODate(tripDate)) return reply(req, { ok: false, message: '用車日期格式無效' }, 400);
      if (!timePattern.test(departure) || !timePattern.test(returnTime) || returnTime <= departure) return reply(req, { ok: false, message: '起訖時間必須有效且回程晚於出發' }, 400);
      if (!origin || !destination || !purpose) return reply(req, { ok: false, message: '出發地、目的地與用途皆為必填' }, 400);
      if (!Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 99) return reply(req, { ok: false, message: '搭乘人數必須為 1–99 的整數' }, 400);
      const payload = {
        applicant_id: profile.user_id, applicant_name: text(profile.name, 160) || text(profile.username, 160),
        applicant_department: text(profile.department, 200) || null,
        trip_date: tripDate, planned_departure_time: departure, planned_return_time: returnTime,
        origin_location: origin, destination_location: destination, trip_purpose: purpose,
        passenger_count: passengerCount, applicant_phone: text(body.applicant_phone, 50) || null,
        applicant_note: text(body.applicant_note, 500) || null, status: 'pending_approval',
      };
      const { data, error } = await userDb.from('vehicle_dispatch_requests').insert(payload).select('request_id').single();
      if (error) {
        const raw = String(error.message || '');
        if (/exclusion constraint|23P01|overlap/i.test(raw)) return reply(req, { ok: false, message: '該時段已有其他派車申請，請改選其他時段' }, 409);
        if (/預計出發時間已經過去|past/i.test(raw)) return reply(req, { ok: false, message: '預計出發時間已經過去，請選擇目前時間之後的時段' }, 400);
        throw error;
      }
      await writeAudit(userDb, profile.user_id, 'vehicle_dispatch_requests', data.request_id, 'insert', null, payload);
      return reply(req, { ok: true, data });
    }

    if (action === 'vehicle_roster_update') {
      if (!can('vehicle') || !isAdmin) return reply(req, { ok: false, message: '只有管理者可以維護派車名單' }, 403);
      const rosterTable = text(body.table, 60);
      if (rosterTable !== 'vehicle_dispatch_drivers' && rosterTable !== 'vehicle_dispatch_managers') return reply(req, { ok: false, message: '名單類型無效' }, 400);
      const targetUser = text(body.user_id, 80);
      if (!/^[0-9a-f-]{36}$/i.test(targetUser)) return reply(req, { ok: false, message: '人員識別碼無效' }, 400);
      const remove = body.remove === true;
      const active = remove ? false : body.active === true;
      const { data: before, error: readError } = await userDb.from(rosterTable).select('user_id,active,assigned_by').eq('user_id', targetUser).maybeSingle();
      if (readError) throw readError;
      if (remove && !before) return reply(req, { ok: false, message: '找不到指定的名單人員' }, 404);
      const payload: Record<string, unknown> = { user_id: targetUser, active, updated_at: new Date().toISOString() };
      if (!before) payload.assigned_by = profile.user_id;
      const { data, error } = await userDb.from(rosterTable).upsert(payload, { onConflict: 'user_id' }).select('user_id').single();
      if (error) throw error;
      await writeAudit(userDb, profile.user_id, rosterTable, targetUser, before ? 'status_change' : 'insert', before || null, { active, removed: remove });
      return reply(req, { ok: true, data });
    }

    if (action === 'vehicle_roster_remove_all') {
      if (!can('vehicle') || !isAdmin) return reply(req, { ok: false, message: '只有管理者可以維護派車名單' }, 403);
      const rosterTable = text(body.table, 60);
      if (rosterTable !== 'vehicle_dispatch_drivers' && rosterTable !== 'vehicle_dispatch_managers') return reply(req, { ok: false, message: '名單類型無效' }, 400);
      const { data: before, error: readError } = await userDb.from(rosterTable)
        .select('user_id,active,assigned_by').eq('active', true);
      if (readError) throw readError;
      if (!before?.length) return reply(req, { ok: true, data: [], count: 0 });
      const updatedAt = new Date().toISOString();
      const { data, error } = await userDb.from(rosterTable).update({ active: false, updated_at: updatedAt })
        .eq('active', true).select('user_id');
      if (error) throw error;
      await Promise.all((before as Array<Record<string, unknown>>).map(row => writeAudit(
        userDb, profile.user_id, rosterTable, String(row.user_id), 'status_change', row,
        { active: false, removed: true },
      )));
      return reply(req, { ok: true, data: data || [], count: data?.length || 0 });
    }

    if (action === 'patrol_shift_delete') {
      if (!can('guardpatrol') || !isAdmin) return reply(req, { ok: false, message: '只有巡邏系統管理者可以刪除班別' }, 403);
      const scope = text(body.scope, 20);
      if (scope === 'template') {
        const templateId = text(body.template_id, 80);
        if (!/^[0-9a-f-]{36}$/i.test(templateId)) return reply(req, { ok: false, message: '班別範本識別碼無效' }, 400);
        const { data: before, error: readError } = await userDb.from('patrol_shift_template').select('template_id,name,status').eq('template_id', templateId).maybeSingle();
        if (readError) throw readError;
        if (!before) return reply(req, { ok: false, message: '找不到指定的班別範本' }, 404);
        const { error } = await userDb.from('patrol_shift_template').update({ status: 'inactive' }).eq('template_id', templateId);
        if (error) throw error;
        await writeAudit(userDb, profile.user_id, 'patrol_shift_template', templateId, 'status_change', { status: before.status }, { status: 'inactive' });
        return reply(req, { ok: true });
      }
      if (scope === 'date') {
        const shiftId = text(body.shift_id, 80);
        if (!/^[0-9a-f-]{36}$/i.test(shiftId)) return reply(req, { ok: false, message: '班別識別碼無效' }, 400);
        const { data: before, error: readError } = await userDb.from('patrol_shifts').select('shift_id,name,assigned_user_ids').eq('shift_id', shiftId).maybeSingle();
        if (readError) throw readError;
        if (!before) return reply(req, { ok: false, message: '找不到指定的班別' }, 404);
        // patrol_shifts 受資料庫保護無法 DELETE 且無 status 欄位，故以名稱前綴隱藏（與前端同規則）。
        // 名稱加上隨機後綴，避免同日同班別重複刪除時撞 idx_patrol_shifts_date_name 唯一索引。
        const hiddenName = `[已刪除] ${before.name} ${nextRequestRequestId().slice(0, 8)}`;
        const { error } = await userDb.from('patrol_shifts').update({ name: hiddenName, assigned_user_ids: [] }).eq('shift_id', shiftId);
        if (error) throw error;
        // 指派人員會被清空且無法從別處還原，before 必須連同人員一起留存才救得回來。
        await writeAudit(userDb, profile.user_id, 'patrol_shifts', shiftId, 'update',
          { name: before.name, assigned_user_ids: before.assigned_user_ids },
          { name: hiddenName, assigned_user_ids: [] });
        return reply(req, { ok: true });
      }
      return reply(req, { ok: false, message: '刪除範圍無效' }, 400);
    }

    if (action === 'handover_save') {
      if (!can('handover')) return reply(req, { ok: false, message: '目前角色沒有電子交接簿權限' }, 403);
      const kind = text(body.kind, 30);

      if (kind === 'record') {
        const shiftDate = text(body.shift_date, 10), shiftType = text(body.shift_type, 20);
        if (!validISODate(shiftDate)) return reply(req, { ok: false, message: '交接日期格式無效' }, 400);
        const handoverBy = id(body.handover_by), takeoverBy = id(body.takeover_by);
        const status = body.status === 'confirmed' ? 'confirmed' : 'draft';
        if (status === 'confirmed') {
          if (!handoverBy || !takeoverBy) return reply(req, { ok: false, message: '送出交接必須同時指定交接人與接班人' }, 400);
          if (handoverBy !== profile.user_id) return reply(req, { ok: false, message: '交接人必須是目前登入的帳號，禁止代替他人送出' }, 403);
          if (handoverBy === takeoverBy) return reply(req, { ok: false, message: '交接人與接班人不可為同一人' }, 400);
        }
        const deptId = id(body.dept_id) || null;
        const payload = {
          shift_date: shiftDate, shift_type: shiftType, dept_id: deptId,
          handover_by: handoverBy || null, takeover_by: takeoverBy || null,
          eq_normal: Number(body.eq_normal) || 0, eq_abnormal: Number(body.eq_abnormal) || 0,
          issues: text(body.issues, 20000) || null, pending: text(body.pending, 20000) || null,
          notes: text(body.notes, 2000) || null, status, confirmed_at: null, confirmed_by: null,
          created_by: profile.user_id,
        };
        const { data, error } = await userDb.from('handover_records').insert(payload).select('record_id').single();
        if (error) {
          const raw = String(error.message || '');
          if (/row-level security/i.test(raw)) return reply(req, { ok: false, message: '沒有建立交接單的權限（需要電子交接簿系統權限）' }, 403);
          if (/已經結束|不能建立過去班次/i.test(raw)) return reply(req, { ok: false, message: '所選交接日期與班別已經結束，不能建立過去班次的交接單' }, 400);
          throw error;
        }
        await writeAudit(userDb, profile.user_id, 'handover_records', data.record_id, 'insert', null, payload);
        return reply(req, { ok: true, data });
      }

      if (kind === 'receive') {
        const recordId = id(body.record_id);
        if (!recordId) return reply(req, { ok: false, message: '交接單識別碼無效' }, 400);
        const { data: before, error: readError } = await userDb.from('handover_records')
          .select('record_id,status,takeover_by').eq('record_id', recordId).maybeSingle();
        if (readError) throw readError;
        if (!before) return reply(req, { ok: false, message: '找不到指定的交接單' }, 404);
        if (String(before.takeover_by) !== profile.user_id) return reply(req, { ok: false, message: '你不是這筆交接單指定的接班人' }, 403);
        if (before.status !== 'confirmed') return reply(req, { ok: false, message: '這筆交接單目前狀態不可接收' }, 409);
        const { data: updated, error } = await userDb.from('handover_records')
          .update({ confirmed_by: profile.user_id, confirmed_at: new Date().toISOString() })
          .eq('record_id', recordId).eq('status', 'confirmed').select('record_id,confirmed_at').maybeSingle();
        if (error) throw error;
        if (!updated) return reply(req, { ok: false, message: '這筆交接單已被處理，請重新整理' }, 409);
        // 交接狀態仍是 confirmed（DB 無 'done' 狀態），接收完成以 confirmed_at 為準，
        // 稽核記錄更新而非不存在的狀態轉換。
        await writeAudit(userDb, profile.user_id, 'handover_records', recordId, 'update',
          { status: 'confirmed' }, { status: 'confirmed', confirmed_by: profile.user_id, confirmed_at: updated.confirmed_at });
        return reply(req, { ok: true });
      }

      if (kind === 'create_case') {
        const caseNo = text(body.case_no, 40), title = text(body.title, 300), shiftType = text(body.shift_type, 20);
        const anomalyCategory = text(body.anomaly_category, 100);
        if (!caseNo || !title || !shiftType || !anomalyCategory) return reply(req, { ok: false, message: '案件編號、標題、班別與異常大類為必填' }, 400);
        let incidentTime: string | null = null;
        if (body.incident_time !== null && body.incident_time !== undefined && body.incident_time !== '') {
          const parsed = Date.parse(String(body.incident_time));
          if (Number.isNaN(parsed)) return reply(req, { ok: false, message: '事件發生時間格式無效' }, 400);
          incidentTime = new Date(parsed).toISOString();
        }
        const payload = {
          case_no: caseNo, title, shift_type: shiftType,
          reporter: text(body.reporter, 160) || null,
          reporter_unit: text(body.reporter_unit, 200) || null,
          incident_time: incidentTime,
          incident_location: text(body.incident_location, 300) || null,
          anomaly_category: anomalyCategory,
          anomaly_sub: text(body.anomaly_sub, 100) || null, anomaly_other: text(body.anomaly_other, 300) || null,
          description: text(body.description, 5000) || null, action_taken: text(body.action_taken, 5000) || null,
          followup: text(body.followup, 5000) || null, note: text(body.note, 2000) || null,
          status: 'open', created_by: profile.user_id,
        };
        const { data, error } = await userDb.from('handover_cases').insert(payload).select('case_id').single();
        if (error) throw error;
        await writeAudit(userDb, profile.user_id, 'handover_cases', data.case_id, 'insert', null, payload);
        return reply(req, { ok: true, data });
      }

      if (kind === 'add_attachment') {
        const caseId = id(body.case_id);
        const fileName = text(body.file_name, 160), storagePath = text(body.storage_path, 300);
        const fileSize = Number(body.file_size);
        if (!caseId || !fileName || !storagePath || !Number.isFinite(fileSize) || fileSize < 0 || fileSize > 10 * 1024 * 1024) {
          return reply(req, { ok: false, message: '附件資料格式無效' }, 400);
        }
        const { data, error } = await userDb.from('handover_case_attachments').insert({
          case_id: caseId, file_name: fileName, file_type: text(body.file_type, 100) || null,
          file_size: fileSize, storage_path: storagePath, uploaded_by: profile.user_id,
        }).select('attachment_id').single();
        if (error) throw error;
        await writeAudit(userDb, profile.user_id, 'handover_case_attachments', data.attachment_id, 'insert', null, { case_id: caseId, file_name: fileName, file_size: fileSize });
        return reply(req, { ok: true, data });
      }

      return reply(req, { ok: false, message: '交接簿操作類型無效' }, 400);
    }

    if (action === 'equipment_save') {
      if (!can('equipment')) return reply(req, { ok: false, message: '目前角色沒有設備系統權限' }, 403);
      const kind = text(body.kind, 30);

      if (kind === 'ack_event') {
        const eventId = id(body.event_id);
        if (!eventId) return reply(req, { ok: false, message: '事件識別碼無效' }, 400);
        const { data: before, error: readError } = await userDb.from('equipment_monitor_events').select('event_id,event_state,title').eq('event_id', eventId).maybeSingle();
        if (readError) throw readError;
        if (!before) return reply(req, { ok: false, message: '找不到指定事件' }, 404);
        if (before.event_state !== 'open') return reply(req, { ok: false, message: '此事件已被確認或已解除' }, 409);
        const { data: updated, error } = await userDb.from('equipment_monitor_events')
          .update({ event_state: 'acknowledged', acknowledged_at: new Date().toISOString(), acknowledged_by: profile.user_id })
          .eq('event_id', eventId).eq('event_state', 'open').select('event_id').maybeSingle();
        if (error) throw error;
        if (!updated) return reply(req, { ok: false, message: '此事件已被處理，請重新整理' }, 409);
        await writeAudit(userDb, profile.user_id, 'equipment_monitor_events', eventId, 'status_change', { event_state: before.event_state }, { event_state: 'acknowledged', title: before.title });
        return reply(req, { ok: true });
      }

      if (kind === 'save') {
        const table = text(body.table, 60);
        const tableConfig = EQUIPMENT_TABLES[table];
        if (!tableConfig) return reply(req, { ok: false, message: '設備資料表無效' }, 400);
        const raw = body.payload && typeof body.payload === 'object' ? body.payload as Record<string, unknown> : {};
        const payload: Record<string, unknown> = {};
        for (const [key, field] of Object.entries(tableConfig.fields)) {
          if (!(key in raw)) continue;
          const value = raw[key];
          if (field.type === 'number') {
            if (value === null || value === '') {
              payload[key] = null;
            } else {
              const parsed = Number(value);
              if (!Number.isFinite(parsed)) return reply(req, { ok: false, message: `欄位「${key}」必須是數字` }, 400);
              payload[key] = parsed;
            }
          } else if (field.type === 'boolean') {
            payload[key] = value === true || value === 'true';
          } else {
            payload[key] = key === 'floor' ? (canonicalFloor(value) || null) : (text(value, 2000) || null);
          }
        }
        if (Object.keys(payload).length === 0) return reply(req, { ok: false, message: '沒有可儲存的欄位資料' }, 400);
        const pkValue = id(body.id);
        if (pkValue) {
          if (tableConfig.updatedBy) payload[tableConfig.updatedBy] = profile.user_id;
          const { data: before, error: readError } = await userDb.from(table).select(tableConfig.pk).eq(tableConfig.pk, pkValue).maybeSingle();
          if (readError) throw readError;
          if (!before) return reply(req, { ok: false, message: '找不到指定的資料' }, 404);
          const { error } = await userDb.from(table).update(payload).eq(tableConfig.pk, pkValue);
          if (error) throw error;
          await writeAudit(userDb, profile.user_id, table, pkValue, 'update', null, payload);
          return reply(req, { ok: true });
        }
        if (tableConfig.createdBy) payload[tableConfig.createdBy] = profile.user_id;
        const { data, error } = await userDb.from(table).insert(payload).select(tableConfig.pk).single();
        if (error) throw error;
        await writeAudit(userDb, profile.user_id, table, String((data as unknown as Record<string, unknown>)[tableConfig.pk]), 'insert', null, payload);
        return reply(req, { ok: true, data });
      }

      return reply(req, { ok: false, message: '設備操作類型無效' }, 400);
    }

    if (action === 'field_pilot_save') {
      if (!can('handover')) return reply(req, { ok: false, message: '目前角色沒有交接系統權限' }, 403);
      const raw = body.payload && typeof body.payload === 'object' ? body.payload as Record<string, unknown> : {};
      const payload: Record<string, unknown> = {};
      for (const key of ['record_date', 'shift_code', 'shift_start', 'shift_end', 'handover_by', 'instruction', 'notes', 'updated_at']) {
        if (!(key in raw)) continue;
        payload[key] = text(raw[key], 4000) || null;
      }
      for (const key of ['items', 'attachments']) {
        if (!(key in raw)) continue;
        payload[key] = Array.isArray(raw[key]) ? JSON.parse(JSON.stringify(raw[key])) : null;
      }
      if (!payload['record_date'] || !payload['shift_code']) return reply(req, { ok: false, message: '請輸入日期與班別' }, 400);
      // 主管批示欄位（status/reviewed_at/reviewed_by/supervisor_note）只有管理者能寫，
      // 避免一般使用者自審自批；reviewed_by 一律以登入者為準，不接受客戶端指定。
      if (isAdmin) {
        if ('status' in raw) {
          const nextStatus = text(raw['status'], 20);
          if (!['draft', 'submitted', 'reviewed', 'closed'].includes(nextStatus)) {
            return reply(req, { ok: false, message: '交接狀態值無效' }, 400);
          }
          payload['status'] = nextStatus;
        }
        if ('reviewed_at' in raw) payload['reviewed_at'] = text(raw['reviewed_at'], 40) || null;
        if ('supervisor_note' in raw) payload['supervisor_note'] = text(raw['supervisor_note'], 4000) || null;
        if (payload['status'] === 'reviewed') payload['reviewed_by'] = profile.user_id;
      } else {
        const clientStatus = text(raw['status'], 20);
        if (clientStatus && !['draft', 'submitted'].includes(clientStatus)) {
          return reply(req, { ok: false, message: '只有管理者可以執行主管批示' }, 403);
        }
        if (clientStatus) payload['status'] = clientStatus;
      }
      // record_id 不寫入 payload：upsert 以 (record_date, shift_code) 定位，防止客戶端覆寫他人 PK。
      try {
        const { data, error } = await userDb.from('handover_field_pilot_records').upsert(payload, { onConflict: 'record_date,shift_code' }).select('record_id').maybeSingle();
        if (error) throw error;
        const savedId = String((data as unknown as Record<string, unknown>)?.record_id ?? '');
        await writeAudit(userDb, profile.user_id, 'handover_field_pilot_records', savedId, 'insert', null, payload);
        return reply(req, { ok: true, data });
      } catch (error) {
        const e = error as { code?: string; message?: string };
        if (String(e.code) === '42P01' || String(e.message).includes('handover_field_pilot_records')) {
          return reply(req, { ok: false, message: '尚未建立現場試用資料表，請先執行 handover_field_pilot_schema.sql' }, 500);
        }
        throw error;
      }
    }

    if (action === 'equipment_map') {
      if (!can('structuremap') && !can('equipment')) return reply(req, { ok: false, message: '目前角色沒有設備圖臺權限' }, 403);
      const [equipment, markers, locations] = await Promise.all([
        userDb.from('equipment').select('equipment_id,name,asset_code,category,status,floor,location,location_id').order('floor').order('name').limit(2000),
        userDb.from('plan_markers').select('marker_id,equipment_id,floor_id,x,y,label').limit(5000),
        userDb.from('locations').select('location_id,area,detail,floor').limit(2000),
      ]);
if (equipment.error) throw equipment.error;
      if (markers.error) console.warn('equipment_map markers failed:', markers.error.message);
      if (locations.error) console.warn('equipment_map locations failed:', locations.error.message);
      return reply(req, { ok: true, data: {
        equipment: (equipment.data || []).map(row => ({ ...row, floor: canonicalFloor(row.floor) })),
        markers: markers.error ? [] : (markers.data || []).map(row => {
          const floorId = canonicalFloor(row.floor_id);
          return { ...row, floor_id: floorId, floor: floorId };
        }),
        locations: locations.error ? [] : (locations.data || []).map(row => ({
          ...row,
          floor: canonicalFloor(row.floor),
          name: [row.area, row.detail].filter(Boolean).join(' / '),
        })),
      } });
    }

    if (action === 'save_floor_model') {
      if (!can('structuremap')) return reply(req, { ok: false, message: '目前角色沒有設備圖臺權限' }, 403);
      const floorId = canonicalFloor(text(body.floor_id, 20));
      const name = text(body.name, 100);
      const imagePath = text(body.image_path, 100);
      const bboxSource = body.bbox && typeof body.bbox === 'object' ? body.bbox as Record<string, unknown> : {};
      const bbox = {
        mnx: Number(bboxSource.mnx), mny: Number(bboxSource.mny),
        mxx: Number(bboxSource.mxx), mxy: Number(bboxSource.mxy),
        w: Number(bboxSource.w), h: Number(bboxSource.h),
      };
      if (!/^[A-Z0-9_-]{1,20}$/.test(floorId)) return reply(req, { ok: false, message: '樓層代號格式無效' }, 400);
      if (!name) return reply(req, { ok: false, message: '樓層名稱不可空白' }, 400);
      if (imagePath !== `${floorId}.png`) return reply(req, { ok: false, message: '模型檔案路徑無效' }, 400);
      if (Object.values(bbox).some(value => !Number.isFinite(value)) || bbox.w <= 0 || bbox.h <= 0) {
        return reply(req, { ok: false, message: '模型繪圖範圍無效' }, 400);
      }
      const { data: before, error: readError } = await userDb.from('floor_models')
        .select('floor_id,name,image_path,bbox,updated_at').eq('floor_id', floorId).maybeSingle();
      if (readError) throw readError;
      const payload = { floor_id: floorId, name, image_path: imagePath, bbox, updated_at: new Date().toISOString() };
      const { data, error } = await userDb.from('floor_models').upsert(payload, { onConflict: 'floor_id' }).select('floor_id').single();
      if (error) throw error;
      await writeAudit(userDb, profile.user_id, 'floor_models', floorId, before ? 'update' : 'insert', before, payload);
      return reply(req, { ok: true, data });
    }

    if (action === 'area_save') {
      if (!can('structuremap')) return reply(req, { ok: false, message: '目前角色沒有場域結構圖權限' }, 403);
      const kind = text(body.kind, 30);

      if (kind === 'deactivate') {
        const spaceId = id(body.space_id);
        if (!spaceId) return reply(req, { ok: false, message: '空間識別碼無效' }, 400);
        const { data: markers } = await userDb.from('plan_markers').select('marker_id').eq('space_id', spaceId).eq('status', 'active').limit(1);
        if (markers && markers.length) return reply(req, { ok: false, message: '此空間已於「整合標記系統」使用中，請先停用該標記後再操作' }, 409);
        const { data: before, error: readError } = await userDb.from('floor_spaces').select('space_id,space_name,status').eq('space_id', spaceId).maybeSingle();
        if (readError) throw readError;
        if (!before) return reply(req, { ok: false, message: '找不到指定的空間' }, 404);
        const { error } = await userDb.from('floor_spaces').update({ status: 'inactive' }).eq('space_id', spaceId);
        if (error) throw error;
        await writeAudit(userDb, profile.user_id, 'floor_spaces', spaceId, 'status_change', { status: before.status }, { status: 'inactive', space_name: before.space_name });
        return reply(req, { ok: true });
      }

      if (kind === 'deactivate_many') {
        const spaceIds: string[] = (Array.isArray(body.space_ids) ? body.space_ids as unknown[] : []).map((v: unknown) => id(v)).filter(Boolean);
        if (!spaceIds.length) return reply(req, { ok: false, message: '沒有可停用的空間' }, 400);
        const used = new Set<string>();
        for (let index = 0; index < spaceIds.length; index += 50) {
          const chunk = spaceIds.slice(index, index + 50);
          const { data: markers } = await userDb.from('plan_markers').select('space_id').in('space_id', chunk).eq('status', 'active');
          (markers || []).forEach(row => used.add(String(row.space_id)));
        }
        const removable = spaceIds.filter(s => !used.has(s));
        if (!removable.length) return reply(req, { ok: false, message: '所有空間都已於「整合標記系統」使用中，無法停用' }, 409);
        for (let index = 0; index < removable.length; index += 50) {
          const chunk = removable.slice(index, index + 50);
          const { error } = await userDb.from('floor_spaces').update({ status: 'inactive' }).in('space_id', chunk);
          if (error) throw error;
        }
        await writeAudit(userDb, profile.user_id, 'floor_spaces', removable.join(','), 'status_change', null, { status: 'inactive' });
        return reply(req, { ok: true, data: { removable, usedCount: spaceIds.length - removable.length } });
      }

      if (kind === 'import') {
        const rows = Array.isArray(body.rows) ? body.rows : [];
        if (!rows.length) return reply(req, { ok: false, message: '沒有可匯入的資料' }, 400);
        const cleanRows: Record<string, unknown>[] = [];
        for (const raw of rows) {
          if (!raw || typeof raw !== 'object') continue;
          const row = raw as Record<string, unknown>;
          const marketId = text(row.market_id, 40);
          const floor = canonicalFloor(text(row.floor, 20));
          const floorOrderValue = row.floor_order === undefined || row.floor_order === null ? null : Number(row.floor_order);
          const spaceName = text(row.space_name, 120);
          if (!marketId || !floor || !spaceName) continue;
          cleanRows.push({ market_id: marketId, floor, floor_order: Number.isFinite(floorOrderValue) ? floorOrderValue : null, space_name: spaceName });
        }
        if (!cleanRows.length) return reply(req, { ok: false, message: '匯入資料皆無效' }, 400);
        // 先以 (market_id, floor, space_name) 預先過濾已存在的資料，降低撞 unique 的機率，
        // 剩餘資料仍分批插入，部分失敗時回報數量讓使用者知道哪些未匯入。
        const existing = new Set<string>();
        for (let index = 0; index < cleanRows.length; index += 50) {
          const chunk = cleanRows.slice(index, index + 50);
          const floors = [...new Set(chunk.map(r => text(r.floor, 20)).filter(Boolean))];
          const { data: found } = await userDb.from('floor_spaces')
            .select('market_id,floor,space_name').in('floor', floors);
          (found || []).forEach((row) => existing.add(`${text(row.market_id, 40)}|${text(row.floor, 20)}|${text(row.space_name, 120)}`));
        }
        const toInsert = cleanRows.filter(row => !existing.has(`${text(row.market_id, 40)}|${text(row.floor, 20)}|${text(row.space_name, 120)}`));
        if (!toInsert.length) return reply(req, { ok: false, message: '匯入資料皆已存在' }, 409);
        let inserted = 0;
        let failed = 0;
        for (let index = 0; index < toInsert.length; index += 50) {
          const chunk = toInsert.slice(index, index + 50);
          const { error } = await userDb.from('floor_spaces').insert(chunk);
          if (error) {
            if (String(error.code) === '23505') { failed += chunk.length; continue; }
            throw error;
          }
          inserted += chunk.length;
        }
        await writeAudit(userDb, profile.user_id, 'floor_spaces', `import:${inserted}`, 'insert', null, { count: inserted, failed });
        return reply(req, { ok: true, data: { inserted, skipped: cleanRows.length - inserted, failed } });
      }

      if (kind === 'save') {
        const raw = body.payload && typeof body.payload === 'object' ? body.payload as Record<string, unknown> : {};
        const payload: Record<string, unknown> = {};
        for (const key of ['market_id', 'floor', 'floor_order', 'space_name', 'status', 'note']) {
          if (!(key in raw)) continue;
          const value = raw[key];
          if (key === 'floor_order') {
            const parsed = Number(value);
            payload[key] = (value === null || value === '' || !Number.isFinite(parsed)) ? null : parsed;
          } else {
            payload[key] = key === 'floor' ? (canonicalFloor(value) || null) : (text(value, 2000) || null);
          }
        }
        if (!payload['market_id'] || !payload['floor'] || !payload['space_name']) return reply(req, { ok: false, message: '請輸入樓層與空間名稱' }, 400);
        const spaceId = id(body.space_id);
        if (spaceId) {
          const { data: before, error: readError } = await userDb.from('floor_spaces').select('space_id').eq('space_id', spaceId).maybeSingle();
          if (readError) throw readError;
          if (!before) return reply(req, { ok: false, message: '找不到指定的空間' }, 404);
          const { error } = await userDb.from('floor_spaces').update(payload).eq('space_id', spaceId);
          if (error) throw error;
          await writeAudit(userDb, profile.user_id, 'floor_spaces', spaceId, 'update', null, payload);
          return reply(req, { ok: true });
        }
        const { data, error } = await userDb.from('floor_spaces').insert(payload).select('space_id').single();
        if (error) {
          if (String(error.code) === '23505') return reply(req, { ok: false, message: '該樓層已有相同空間名稱' }, 409);
          throw error;
        }
        await writeAudit(userDb, profile.user_id, 'floor_spaces', String((data as unknown as Record<string, unknown>).space_id), 'insert', null, payload);
        return reply(req, { ok: true, data });
      }

      return reply(req, { ok: false, message: '區域位置表操作類型無效' }, 400);
    }

    if (action === 'marker_save') {
      if (!can('structuremap')) return reply(req, { ok: false, message: '目前角色沒有場域結構圖權限' }, 403);
      const kind = text(body.kind, 30);

      if (kind === 'deactivate') {
        const markerId = id(body.marker_id);
        if (!markerId) return reply(req, { ok: false, message: '標記識別碼無效' }, 400);
        const { data: before, error: readError } = await userDb.from('plan_markers').select('marker_id,status').eq('marker_id', markerId).maybeSingle();
        if (readError) throw readError;
        if (!before) return reply(req, { ok: false, message: '找不到指定的標記' }, 404);
        const { error } = await userDb.from('plan_markers').update({ status: 'inactive' }).eq('marker_id', markerId);
        if (error) throw error;
        await writeAudit(userDb, profile.user_id, 'plan_markers', markerId, 'status_change', { status: before.status }, { status: 'inactive' });
        return reply(req, { ok: true });
      }

      if (kind === 'save') {
        const raw = body.payload && typeof body.payload === 'object' ? body.payload as Record<string, unknown> : {};
        const payload: Record<string, unknown> = {};
        for (const key of ['floor_id', 'x', 'y', 'kind', 'label', 'equipment_id', 'space_id', 'repair_id', 'note', 'status']) {
          if (!(key in raw)) continue;
          const value = raw[key];
          if (key === 'x' || key === 'y') {
            const parsed = Number(value);
            payload[key] = (value === null || value === '' || !Number.isFinite(parsed)) ? null : parsed;
          } else {
            payload[key] = key === 'floor_id' ? (canonicalFloor(value) || null) : (text(value, 2000) || null);
          }
        }
        if (payload['x'] !== null && payload['x'] !== undefined && (Number(payload['x']) < 0 || Number(payload['x']) > 1)) return reply(req, { ok: false, message: '標記座標須介於 0 到 1' }, 400);
        if (payload['y'] !== null && payload['y'] !== undefined && (Number(payload['y']) < 0 || Number(payload['y']) > 1)) return reply(req, { ok: false, message: '標記座標須介於 0 到 1' }, 400);
        if (!payload['floor_id'] || !payload['kind'] || !payload['label']) return reply(req, { ok: false, message: '請輸入樓層、標記類型與名稱' }, 400);
        const markerId = id(body.marker_id);
        if (markerId) {
          const { data: before, error: readError } = await userDb.from('plan_markers').select('marker_id').eq('marker_id', markerId).maybeSingle();
          if (readError) throw readError;
          if (!before) return reply(req, { ok: false, message: '找不到指定的標記' }, 404);
          const { error } = await userDb.from('plan_markers').update(payload).eq('marker_id', markerId);
          if (error) throw error;
          await writeAudit(userDb, profile.user_id, 'plan_markers', markerId, 'update', null, payload);
          return reply(req, { ok: true });
        }
        const { data, error } = await userDb.from('plan_markers').insert(payload).select('marker_id').single();
        if (error) throw error;
        await writeAudit(userDb, profile.user_id, 'plan_markers', String((data as unknown as Record<string, unknown>).marker_id), 'insert', null, payload);
        return reply(req, { ok: true, data });
      }

      return reply(req, { ok: false, message: '標記操作類型無效' }, 400);
    }

    if (action === 'move_structuremap_marker') {
      if (!can('structuremap')) return reply(req, { ok: false, message: '目前角色沒有設備圖臺權限' }, 403);
      const markerId = text(body.marker_id, 80);
      const x = Number(body.x), y = Number(body.y);
      if (!/^[0-9a-f-]{36}$/i.test(markerId)) return reply(req, { ok: false, message: '標記識別碼無效' }, 400);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1 || y > 1) {
        return reply(req, { ok: false, message: '座標必須是 0–1 之間的數字' }, 400);
      }
      const { data: before, error: readError } = await userDb.from('plan_markers')
        .select('marker_id,floor_id,x,y,label').eq('marker_id', markerId).maybeSingle();
      if (readError) throw readError;
      if (!before) return reply(req, { ok: false, message: '找不到指定標記' }, 404);
      const { error } = await userDb.from('plan_markers')
        .update({ x, y, updated_at: new Date().toISOString() }).eq('marker_id', markerId);
      if (error) throw error;
      await writeAudit(userDb, profile.user_id, 'plan_markers', markerId, 'update', { x: before.x, y: before.y }, { x, y });
      return reply(req, { ok: true, data: { marker_id: markerId, x, y } });
    }

    // ---- SYS-08 會議室預約 ----------------------------------------------
    // 鏡射 public.is_admin()：role='admin' 或 rbac_role in ('admin','sysadmin')。
    // profile 查詢已限定 status='active'，故此處不必再判斷。
    if (action === 'meeting_check_in') {
      if (!can('meetingroom')) return reply(req, { ok: false, message: '目前角色沒有會議室系統權限' }, 403);
      const bookingId = text(body.booking_id, 80);
      if (!/^[0-9a-f-]{36}$/i.test(bookingId)) return reply(req, { ok: false, message: '預約識別碼無效' }, 400);

      const { data: booking, error: readError } = await userDb.from('meeting_bookings')
        .select('booking_id,status,booking_date,start_time,end_time').eq('booking_id', bookingId).maybeSingle();
      if (readError) throw readError;
      if (!booking) return reply(req, { ok: false, message: '找不到這筆預約' }, 404);
      if (booking.status !== 'booked') return reply(req, { ok: false, message: '這筆預約目前狀態不可報到' }, 409);

      // 報到時段檢查原本只存在於 V1 前端（canCheckIn），資料庫沒有這道約束。
      // 這裡明確以 Asia/Taipei (+08:00) 解析，不依賴函式執行環境的時區。
      const now = Date.now();
      const startAt = Date.parse(`${booking.booking_date}T${booking.start_time}+08:00`);
      const endAt = Date.parse(`${booking.booking_date}T${booking.end_time}+08:00`);
      if (Number.isNaN(startAt) || Number.isNaN(endAt)) return reply(req, { ok: false, message: '預約時間資料異常' }, 409);
      if (now < startAt || now > endAt) return reply(req, { ok: false, message: '目前不在會議時段內，無法報到' }, 409);

      // 併帶 status 條件，避免兩個分頁同時按下造成重複報到。
      const { data: updated, error } = await userDb.from('meeting_bookings')
        .update({ status: 'checked_in', checked_in_at: new Date().toISOString() })
        .eq('booking_id', bookingId).eq('status', 'booked').select('booking_id').maybeSingle();
      if (error) throw error;
      if (!updated) return reply(req, { ok: false, message: '這筆預約已被處理，請重新整理' }, 409);

      await writeAudit(userDb, profile.user_id, 'meeting_bookings', bookingId, 'update',
        { status: booking.status }, { status: 'checked_in' });
      return reply(req, { ok: true, data: { booking_id: bookingId, status: 'checked_in' } });
    }

    if (action === 'meeting_save_room') {
      if (!can('meetingroom')) return reply(req, { ok: false, message: '目前角色沒有會議室系統權限' }, 403);
      if (!isAdmin) return reply(req, { ok: false, message: '只有管理者可以維護會議室主檔' }, 403);

      const name = text(body.name, 120);
      if (!name) return reply(req, { ok: false, message: '請輸入會議室名稱' }, 400);
      const status = body.status === 'inactive' ? 'inactive' : 'active';
      const floor = canonicalFloor(text(body.floor, 40)) || null;
      const note = text(body.note, 500) || null;
      let capacity: number | null = null;
      if (body.capacity !== null && body.capacity !== undefined && body.capacity !== '') {
        const parsed = Number(body.capacity);
        if (!Number.isInteger(parsed) || parsed < 0) return reply(req, { ok: false, message: '容量請填 0 以上的整數' }, 400);
        capacity = parsed;
      }
      const payload = { name, capacity, floor, status, note };

      const roomId = text(body.room_id, 80);
      if (roomId) {
        if (!/^[0-9a-f-]{36}$/i.test(roomId)) return reply(req, { ok: false, message: '會議室識別碼無效' }, 400);
        const { data: before, error: readError } = await userDb.from('meeting_rooms')
          .select('room_id,name,capacity,floor,status,note').eq('room_id', roomId).maybeSingle();
        if (readError) throw readError;
        if (!before) return reply(req, { ok: false, message: '找不到這間會議室' }, 404);
        const { error } = await userDb.from('meeting_rooms').update(payload).eq('room_id', roomId);
        if (error) throw error;
        await writeAudit(userDb, profile.user_id, 'meeting_rooms', roomId, 'update', before, payload);
        return reply(req, { ok: true, data: { room_id: roomId, created: false } });
      }

      const { data, error } = await userDb.from('meeting_rooms')
        .insert({ ...payload, created_by: profile.user_id }).select('room_id').single();
      if (error) throw error;
      await writeAudit(userDb, profile.user_id, 'meeting_rooms', data.room_id, 'insert', null, payload);
      return reply(req, { ok: true, data: { room_id: data.room_id, created: true } });
    }

    return reply(req, { ok: false, message: '不支援的 API 動作' }, 400);
  } catch (error) {
    console.error('app-api failed', error instanceof Error ? error.message : String(error));
    return reply(req, { ok: false, message: 'API 處理失敗，請稍後再試' }, 500);
  }
}

// Supabase Edge Functions continue to use this adapter during the migration.
// The Node.js service imports the same handler, so authentication and business
// rules remain identical in both runtimes.
if (denoRuntime?.serve) denoRuntime.serve(handleAppApiRequest);
