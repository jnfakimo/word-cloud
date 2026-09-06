import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.2';
import { enforceDurableRateLimit, recordRateLimitDenial, securityRequestId } from '../_shared/security-monitor.ts';
import { passwordPolicyMessage } from '../_shared/password-policy.ts';
import { canonicalFloor } from '../_shared/floor.ts';
import { BOARD_NOTICE_ACTIONS, handleBoardNotices } from './board-notices.ts';

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
const ROLES = new Set(['reporter', 'duty', 'dispatcher', 'technician', 'unit_supervisor', 'sysadmin']);
// Node.js 與 Edge Function 共用同一支處理器；前端會先檢查此版本，
// 避免 Render 尚未更新時把新欄位送給舊後端而遺失。
const ADMIN_CONTRACT_VERSION = 2;
const PERMISSIONS = new Set(['create', 'update', 'delete', 'read', 'dispatch', 'close', 'sign', 'export', 'admin', 'sys_admin', 'sys_workorder', 'sys_guardpatrol', 'sys_handover', 'sys_equipment', 'sys_equipment_manage', 'sys_structuremap', 'sys_vehicle', 'sys_meetingroom', 'sys_officialdocs', 'sys_marketanalytics', 'sys_dashboard', 'sys_marketboard', 'marketanalytics_manage']);
const SAFE_SETTING_KEYS = new Set([
  'org_name', 'site_name', 'shifts', 'line_group_id', 'line_notify_anomaly', 'line_notify_repair',
  'line_notify_case', 'line_notify_security', 'line_notify_security_alerts', 'line_notify_error_threshold',
  'error_threshold_window_minutes', 'error_threshold_count', 'error_threshold_cooldown_minutes',
  'line_notify_patrol_timeout', 'fcm_notify_patrol_timeout',
  'patrol_timeout_rules',
]);
const FIXED_SHIFT_IDS = ['morning', 'afternoon', 'night'];
const FIXED_SHIFT_DEFAULTS = [
  { id: 'morning', label: '早班', start: '06:00', end: '14:00' },
  { id: 'afternoon', label: '中班', start: '14:00', end: '22:00' },
  { id: 'night', label: '夜班', start: '22:00', end: '06:00' },
];
const LEGACY_ROLE: Record<string, string> = { reporter: 'inspector', duty: 'maintenance', dispatcher: 'maintenance', technician: 'maintenance', unit_supervisor: 'supervisor', sysadmin: 'admin', inspector: 'inspector', maintenance: 'maintenance', supervisor: 'supervisor', admin: 'admin' };
const allowedOrigins = new Set(['https://jnfakimo.github.io', 'http://localhost:3000', 'http://127.0.0.1:3000']);
// 自架站常見於內網 IP（RFC1918）；放行反射 CORS，Bearer token 驗證仍是主要防線。
const PRIVATE_NET_ORIGIN = /^https?:\/\/(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})(?::\d{1,5})?$/;

function cors(req: Request) {
  const origin = req.headers.get('origin') || '';
  return { 'Access-Control-Allow-Origin': allowedOrigins.has(origin) || PRIVATE_NET_ORIGIN.test(origin) ? origin : 'https://jnfakimo.github.io', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' };
}
function reply(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
function clean(value: unknown, max = 500) { return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function id(value: unknown) { const result = clean(value, 80); return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result) ? result : ''; }
function status(value: unknown) { return value === 'inactive' ? 'inactive' : 'active'; }
function dbMessage(error: { code?: string; message?: string } | null, fallback: string) {
  const code = String(error?.code || '');
  if (code === '23505') return '資料已存在，請勿重複提交';
  if (code === '23503') return '關聯資料不存在，請先確認相關資料';
  if (code === '23514') {
    // 帳號階層觸發器會回傳已翻譯的業務訊息；保留它，讓管理員知道
    // 是哪一位主管或哪一項指派不符合，而不是只看到無法處理的通用錯誤。
    const message = clean(error?.message, 300);
    const knownRule = [
      '主管及系統管理員不可設定直屬主管', '啟用中的一般人員必須指定直屬主管',
      '啟用中的一般人員必須指定直屬課室主管', '直屬主管必須是啟用中的帳號',
      '直屬主管必須具備單位主管或系統管理員角色', '直屬主管必須具備課室主管或系統管理員角色',
      '直屬主管必須位於人員所屬單位或其上層部／室', '直屬主管必須與人員屬於同一單位',
      '這位主管底下還有', '此人原有', '接任主管不可設定為原主管本人',
      '接任主管必須是另一位啟用中的單位主管或系統管理員', '接任主管無法管理全部原直屬人員',
    ].find(prefix => message.includes(prefix));
    return knownRule ? message : '資料不符合系統規則';
  }
  if (code === '22P02') return '數值或格式不正確';
  if (code === '23502') return '缺少必填欄位';
  const message = clean(error?.message, 300);
  return message || fallback;
}
function safeDetails(value: unknown) { return value && typeof value === 'object' ? value : {}; }
function boolText(value: unknown) { return value === true || value === 'true' ? 'true' : 'false'; }
function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
function validTime(value: string) { return /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value); }
function normalizeFixedShifts(value: unknown) {
  const source = Array.isArray(value) ? value : [];
  const rows = source.map(item => {
    const row = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    return {
      id: clean(row.id, 20),
      label: clean(row.label, 40),
      start: clean(row.start, 8).slice(0, 5),
      end: clean(row.end, 8).slice(0, 5),
    };
  });
  return FIXED_SHIFT_DEFAULTS.map(fallback => {
    const current = rows.find(row => row.id === fallback.id);
    return {
      id: fallback.id,
      label: current?.label || fallback.label,
      start: current && validTime(current.start) ? current.start : fallback.start,
      end: current && validTime(current.end) ? current.end : fallback.end,
    };
  });
}
export async function handleAdminApiRequest(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'POST') return reply(req, { ok: false, message: '僅支援 POST' }, 405);
  const securityEventRequestId = securityRequestId();
  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return reply(req, { ok: false, message: '尚未登入' }, 401);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: authData, error: authError } = await admin.auth.getUser(token);
    if (authError || !authData.user) return reply(req, { ok: false, message: '登入狀態無效，請重新登入' }, 401);
    const globalRate = await enforceDurableRateLimit(admin, req, {
      subject: authData.user.id,
      scope: 'admin-api',
      requestId: securityEventRequestId,
    });
    if (globalRate.error) {
      console.error('admin-api rate limit failed:', globalRate.error.message);
      return reply(req, { ok: false, message: '安全限流服務暫時無法使用' }, 503);
    }
    if (!globalRate.allowed) {
      const { data: rateProfile } = await admin.from('users')
        .select('user_id,username,email,name').eq('auth_id', authData.user.id).maybeSingle();
      try {
        await recordRateLimitDenial(admin, req, {
          scope: 'admin-api', requestId: securityEventRequestId, profile: rateProfile,
          eventCount: globalRate.requestCount, title: '後台 API 異常流量已阻擋',
          historyAlreadyRecorded: globalRate.durable,
        });
      } catch (alertError) {
        console.error('admin-api rate-limit alert failed:', alertError instanceof Error ? alertError.message : String(alertError));
      }
      return reply(req, { ok: false, message: '請求過於頻繁，請稍後再試', request_id: securityEventRequestId }, 429);
    }
    const { data: profile, error: profileError } = await admin.from('users').select('user_id,auth_id,name,username,role,rbac_role,status').eq('auth_id', authData.user.id).eq('status', 'active').maybeSingle();
    if (profileError || !profile) return reply(req, { ok: false, message: '找不到啟用中的系統帳號' }, 403);
    const roleId = profile.rbac_role || (profile.role === 'admin' ? 'sysadmin' : profile.role);
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const action = clean(body.action, 50);
    if (!['admin_get_settings', 'admin_get_contract', 'admin_list_board_notices'].includes(action)) {
      const writeRate = await enforceDurableRateLimit(admin, req, {
        subject: authData.user.id,
        scope: 'admin-api:write',
        actorId: profile.user_id,
        requestId: securityEventRequestId,
      });
      if (writeRate.error) {
        console.error('admin-api:write rate limit failed:', writeRate.error.message);
        return reply(req, { ok: false, message: '安全限流服務暫時無法使用' }, 503);
      }
      if (!writeRate.allowed) {
        try {
          await recordRateLimitDenial(admin, req, {
            scope: 'admin-api:write', requestId: securityEventRequestId, profile,
            eventCount: writeRate.requestCount, title: '後台寫入操作異常頻繁，已阻擋',
            historyAlreadyRecorded: writeRate.durable,
          });
        } catch (alertError) {
          console.error('admin-api:write rate-limit alert failed:', alertError instanceof Error ? alertError.message : String(alertError));
        }
        return reply(req, { ok: false, message: '操作過於頻繁，請稍後再試', request_id: securityEventRequestId }, 429);
      }
    }
    const isAdmin = roleId === 'sysadmin' || profile.role === 'admin';
    if (!isAdmin && action !== 'admin_mark_notice') return reply(req, { ok: false, message: '僅限系統管理員執行此操作' }, 403);
    const userDb = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
    const audit = async (tableName: string, recordId: unknown, auditAction: 'insert' | 'update' | 'status_change', changes: unknown) => {
      const { error } = await admin.from('audit_logs').insert({ table_name: tableName, record_id: clean(recordId, 200) || 'unknown', action: auditAction, changes: safeDetails(changes), operator_id: profile.user_id, source: 'v2-admin' });
      if (error) console.warn('admin audit skipped:', error.message);
    };
    if (BOARD_NOTICE_ACTIONS.has(action)) {
      const result = await handleBoardNotices(admin, action, body, audit);
      return reply(req, result.body, result.status);
    }
    const departmentName = async (deptId: string | null) => {
      if (!deptId) return null;
      const { data } = await admin.from('departments').select('name').eq('dept_id', deptId).maybeSingle();
      return data?.name || null;
    };
    const supervisorWithinUnitHierarchy = async (memberDeptId: string | null, supervisorDeptId: string | null) => {
      const supervisorId = id(supervisorDeptId);
      let currentId = id(memberDeptId);
      const seen = new Set<string>();
      if (!supervisorId || !currentId) return true;
      while (currentId && !seen.has(currentId)) {
        if (currentId === supervisorId) return true;
        seen.add(currentId);
        const { data } = await admin.from('departments').select('parent_id').eq('dept_id', currentId).eq('status', 'active').maybeSingle();
        currentId = id(data?.parent_id);
      }
      return false;
    };
    const secretaryReportsToDeputy = async (memberDeptId: string | null, supervisorDeptId: string | null) => {
      const walkRoot = async (deptId: string | null) => {
        let currentId = id(deptId);
        const seen = new Set<string>();
        let root: Record<string, unknown> | null = null;
        while (currentId && !seen.has(currentId)) {
          seen.add(currentId);
          const { data } = await admin.from('departments').select('parent_id,code,name').eq('dept_id', currentId).eq('status', 'active').maybeSingle();
          if (!data) break;
          root = data as Record<string, unknown>;
          currentId = id(data.parent_id);
        }
        return root;
      };
      const memberRoot = await walkRoot(memberDeptId), supervisorRoot = await walkRoot(supervisorDeptId);
      const rootCode = (row: Record<string, unknown> | null) => clean(row?.code, 40).toUpperCase();
      const rootName = (row: Record<string, unknown> | null) => clean(row?.name, 100).replace(/\s+/g, '');
      return (rootCode(memberRoot) === 'SECRE' || rootName(memberRoot) === '秘書室')
        && (rootCode(supervisorRoot) === 'VGM' || ['副總經理', '副總經理室'].includes(rootName(supervisorRoot)));
    };
    const roleExists = async (rbacRole: string) => {
      const { data } = await admin.from('roles').select('role_id').eq('role_id', rbacRole).maybeSingle();
      return Boolean(data);
    };
    const validateSupervisor = async (supervisorId: string | null, deptId: string | null, rbacRole: string, targetUserId = '') => {
      if (['unit_supervisor', 'sysadmin'].includes(rbacRole)) return { supervisorId: null, message: '' };
      if (!supervisorId) return { supervisorId: null, message: '一般人員必須指定直屬主管' };
      if (supervisorId === targetUserId) return { supervisorId: null, message: '直屬主管不可設定為本人' };
      const { data: supervisor } = await admin.from('users')
        .select('user_id,dept_id,role,rbac_role,status')
        .eq('user_id', supervisorId).eq('status', 'active').maybeSingle();
      const supervisorRole = supervisor?.rbac_role || (supervisor?.role === 'admin' ? 'sysadmin' : supervisor?.role === 'supervisor' ? 'unit_supervisor' : supervisor?.role);
      if (!supervisor || !['unit_supervisor', 'sysadmin'].includes(String(supervisorRole || ''))) {
        return { supervisorId: null, message: '直屬主管必須是啟用中的單位主管或系統管理員' };
      }
      if (supervisorRole !== 'sysadmin' && deptId && supervisor.dept_id
        && !(await supervisorWithinUnitHierarchy(deptId, supervisor.dept_id))
        && !(await secretaryReportsToDeputy(deptId, supervisor.dept_id))) {
        return { supervisorId: null, message: '直屬主管必須位於人員所屬單位或其上層部／室' };
      }
      return { supervisorId, message: '' };
    };

    if (action === 'admin_get_contract') {
      return reply(req, { ok: true, data: { contract_version: ADMIN_CONTRACT_VERSION } });
    }

    if (action === 'admin_get_settings') {
      const keys = [...SAFE_SETTING_KEYS, 'line_channel_token'];
      const { data, error } = await admin.from('system_settings').select('key,value').in('key', keys);
      if (error) return reply(req, { ok: false, message: `系統設定載入失敗：${error.message}` }, 400);
      const settings = Object.fromEntries((data || []).map(row => [String(row.key), String(row.value ?? '')]));
      let shifts = normalizeFixedShifts([]);
      let patrolRules: unknown[] = [];
      try { shifts = normalizeFixedShifts(JSON.parse(settings.shifts || '[]')); } catch { /* 使用固定三班預設 */ }
      try { const parsed = JSON.parse(settings.patrol_timeout_rules || '[]'); if (Array.isArray(parsed)) patrolRules = parsed; } catch { /* 使用空規則 */ }
      const enabled = (key: string) => settings[key] === 'true';
      const securityLineEnabled = settings.line_notify_security_alerts !== undefined
        ? enabled('line_notify_security_alerts')
        : enabled('line_notify_security');
      return reply(req, { ok: true, data: {
        identity: { org_name: settings.org_name || '臺北農產運銷股份有限公司', site_name: settings.site_name || '第一果菜市場' },
        shifts: { shifts },
        line: {
          line_token_configured: Boolean(settings.line_channel_token),
          line_group_id: settings.line_group_id || '',
          line_notify_anomaly: enabled('line_notify_anomaly'),
          line_notify_repair: enabled('line_notify_repair'),
          line_notify_case: enabled('line_notify_case'),
          line_notify_security_alerts: securityLineEnabled,
          line_notify_security: securityLineEnabled,
          line_notify_error_threshold: enabled('line_notify_error_threshold'),
          error_threshold_window_minutes: boundedInteger(settings.error_threshold_window_minutes, 15, 1, 1440),
          error_threshold_count: boundedInteger(settings.error_threshold_count, 20, 1, 5000),
          error_threshold_cooldown_minutes: boundedInteger(settings.error_threshold_cooldown_minutes, 60, 1, 10080),
          line_notify_patrol_timeout: enabled('line_notify_patrol_timeout'),
          fcm_notify_patrol_timeout: enabled('fcm_notify_patrol_timeout'),
          patrol_timeout_rules: patrolRules,
        },
      } });
    }

    if (action === 'admin_save_identity') {
      const input = (body.identity && typeof body.identity === 'object' ? body.identity : body) as Record<string, unknown>;
      const orgName = clean(input.org_name, 160), siteName = clean(input.site_name, 160);
      if (!orgName || !siteName) return reply(req, { ok: false, message: '機構名稱與場所名稱皆為必填' }, 400);
      const updatedAt = new Date().toISOString();
      const { error } = await admin.from('system_settings').upsert([
        { key: 'org_name', value: orgName, updated_at: updatedAt },
        { key: 'site_name', value: siteName, updated_at: updatedAt },
      ], { onConflict: 'key' });
      if (error) return reply(req, { ok: false, message: `系統識別儲存失敗：${error.message}` }, 400);
      await audit('system_settings', 'identity', 'update', { org_name: orgName, site_name: siteName });
      return reply(req, { ok: true, data: { org_name: orgName, site_name: siteName } });
    }

    if (action === 'admin_save_shifts') {
      const source = Array.isArray(body.shifts) ? body.shifts : ((body.shifts as Record<string, unknown> | undefined)?.shifts || []);
      if (!Array.isArray(source) || source.length !== FIXED_SHIFT_IDS.length) return reply(req, { ok: false, message: '班別必須保留早班、中班、夜班三個固定流程' }, 400);
      const shifts = source.map(item => {
        const row = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
        return { id: clean(row.id, 20), label: clean(row.label, 40), start: clean(row.start, 5), end: clean(row.end, 5) };
      });
      if (new Set(shifts.map(row => row.id)).size !== 3 || FIXED_SHIFT_IDS.some(shiftId => !shifts.some(row => row.id === shiftId)) || shifts.some(row => !row.label || !validTime(row.start) || !validTime(row.end))) {
        return reply(req, { ok: false, message: '班別代碼不可變更，名稱必填，時間須為有效的 HH:MM' }, 400);
      }
      const orderedShifts = FIXED_SHIFT_IDS.map(shiftId => shifts.find(row => row.id === shiftId)!);
      const { error } = await admin.from('system_settings').upsert({ key: 'shifts', value: JSON.stringify(orderedShifts), updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (error) return reply(req, { ok: false, message: `班別設定儲存失敗：${error.message}` }, 400);
      await audit('system_settings', 'shifts', 'update', { shifts: orderedShifts });
      return reply(req, { ok: true, data: { shifts: orderedShifts } });
    }

    if (action === 'admin_save_line_settings') {
      const input = (body.line && typeof body.line === 'object' ? body.line : body) as Record<string, unknown>;
      const groupId = clean(input.line_group_id ?? input.group_id, 200);
      const newToken = clean(input.line_channel_token ?? input.channel_token ?? input.token, 1000);
      const { data: currentRows } = await admin.from('system_settings').select('key,value').in('key', [
        'line_channel_token', 'line_notify_anomaly', 'line_notify_repair', 'line_notify_case',
        'line_notify_security_alerts', 'line_notify_security', 'line_notify_error_threshold',
        'error_threshold_window_minutes', 'error_threshold_count', 'error_threshold_cooldown_minutes',
        'line_notify_patrol_timeout', 'fcm_notify_patrol_timeout', 'patrol_timeout_rules',
      ]);
      const currentSettings = Object.fromEntries((currentRows || []).map(row => [String(row.key), String(row.value ?? '')]));
      if (!groupId) return reply(req, { ok: false, message: 'LINE 群組 ID 為必填' }, 400);
      if (!newToken && !clean(currentSettings.line_channel_token, 1000)) return reply(req, { ok: false, message: '尚未設定 LINE Channel Token，請先輸入 Token' }, 400);
      let rawRules: unknown[] = [];
      if (Array.isArray(input.patrol_timeout_rules)) {
        rawRules = input.patrol_timeout_rules;
      } else {
        try {
          const currentRules = JSON.parse(currentSettings.patrol_timeout_rules || '[]');
          if (Array.isArray(currentRules)) rawRules = currentRules;
        } catch {
          rawRules = [];
        }
      }
      const securityLineEnabled = boolText(
        input.line_notify_security_alerts ?? input.line_notify_security ??
          currentSettings.line_notify_security_alerts ?? currentSettings.line_notify_security,
      );
      // 舊 V2 前端不會送出這些新欄位；部署窗口中必須保留 DB 現值，
      // 不可因一次舊版「儲存 LINE 設定」而意外關閉錯誤門檻監測。
      const errorThresholdEnabled = boolText(
        input.line_notify_error_threshold ?? currentSettings.line_notify_error_threshold ?? true,
      );
      const errorWindowMinutes = boundedInteger(
        input.error_threshold_window_minutes ?? currentSettings.error_threshold_window_minutes, 15, 1, 1440,
      );
      const errorThresholdCount = boundedInteger(
        input.error_threshold_count ?? currentSettings.error_threshold_count, 20, 1, 5000,
      );
      const errorCooldownMinutes = boundedInteger(
        input.error_threshold_cooldown_minutes ?? currentSettings.error_threshold_cooldown_minutes, 60, 1, 10080,
      );
      const patrolRules = rawRules.map((item, index) => {
        const row = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
        const days = Array.isArray(row.days) ? row.days.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6) : [];
        return { id: clean(row.id, 30) || `rule-${index + 1}`, label: clean(row.label, 60), start: clean(row.start, 5), end: clean(row.end, 5), days: [...new Set(days)], grace_minutes: Math.max(0, Math.min(1440, Number(row.grace_minutes || 0))) };
      });
      if (patrolRules.some(row => !row.label || !validTime(row.start) || !validTime(row.end) || !Number.isFinite(row.grace_minutes))) return reply(req, { ok: false, message: '巡檢逾時規則的名稱與有效時段為必填' }, 400);
      const rows = [
        { key: 'line_group_id', value: groupId },
        { key: 'line_notify_anomaly', value: boolText(input.line_notify_anomaly ?? currentSettings.line_notify_anomaly) },
        { key: 'line_notify_repair', value: boolText(input.line_notify_repair ?? currentSettings.line_notify_repair) },
        { key: 'line_notify_case', value: boolText(input.line_notify_case ?? currentSettings.line_notify_case) },
        // 正式真實來源為 line_notify_security_alerts；舊鍵同步寫入，
        // 確保 migration 尚未套用的短暫部署窗口仍不會分歧。
        { key: 'line_notify_security_alerts', value: securityLineEnabled },
        { key: 'line_notify_security', value: securityLineEnabled },
        { key: 'line_notify_error_threshold', value: errorThresholdEnabled },
        { key: 'error_threshold_window_minutes', value: String(errorWindowMinutes) },
        { key: 'error_threshold_count', value: String(errorThresholdCount) },
        { key: 'error_threshold_cooldown_minutes', value: String(errorCooldownMinutes) },
        { key: 'line_notify_patrol_timeout', value: boolText(input.line_notify_patrol_timeout ?? currentSettings.line_notify_patrol_timeout) },
        { key: 'fcm_notify_patrol_timeout', value: boolText(input.fcm_notify_patrol_timeout ?? currentSettings.fcm_notify_patrol_timeout) },
        { key: 'patrol_timeout_rules', value: JSON.stringify(patrolRules) },
      ].map(row => ({ ...row, updated_at: new Date().toISOString() }));
      if (newToken) rows.push({ key: 'line_channel_token', value: newToken, updated_at: new Date().toISOString() });
      const { error } = await admin.from('system_settings').upsert(rows, { onConflict: 'key' });
      if (error) return reply(req, { ok: false, message: `LINE 推播設定儲存失敗：${error.message}` }, 400);
      await audit('system_settings', 'line', 'update', { changed_keys: rows.map(row => row.key).filter(key => key !== 'line_channel_token'), token_replaced: Boolean(newToken) });
      return reply(req, { ok: true, data: { line_token_configured: true } });
    }

    if (action === 'admin_test_error_threshold_notification') {
      const windowMinutes = boundedInteger(body.window_minutes, 15, 1, 1440);
      const thresholdCount = boundedInteger(body.threshold_count, 20, 1, 5000);
      const cooldownMinutes = boundedInteger(body.cooldown_minutes, 60, 1, 10080);
      try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/error-threshold-check`, {
          method: 'POST',
          signal: AbortSignal.timeout(12000),
          headers: {
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            test: true,
            window_minutes: windowMinutes,
            threshold_count: thresholdCount,
            cooldown_minutes: cooldownMinutes,
          }),
        });
        const result = await response.json().catch(() => ({ ok: false, message: '通知服務回應格式無效' }));
        await audit('system_settings', 'error_threshold_test', 'status_change', {
          result: response.ok && result?.ok === true ? '送達' : '失敗',
          http_status: response.status,
          window_minutes: windowMinutes,
          threshold_count: thresholdCount,
          cooldown_minutes: cooldownMinutes,
        });
        if (!response.ok || result?.ok !== true) {
          return reply(req, { ok: false, message: clean(result?.message || result?.msg, 300) || '測試通知發送失敗' }, 502);
        }
        return reply(req, { ok: true, data: result, message: '測試通知已送達，不影響正式告警冷卻時間' });
      } catch (error) {
        await audit('system_settings', 'error_threshold_test', 'status_change', { result: '失敗', reason: '通知服務連線異常' });
        console.error('Error threshold notification test failed:', error instanceof Error ? error.message : String(error));
        return reply(req, { ok: false, message: '測試通知服務連線逾時或無法使用' }, 502);
      }
    }

    if (action === 'admin_list_account_applications') {
      const { data, error } = await admin.from('account_applications')
        .select('application_id,name,username,email,phone,dept_id,reason,status,decision_note,approved_role,approved_supervisor_id,created_at,decided_at,departments(name,code)')
        .order('created_at', { ascending: false }).limit(1000);
      if (error) return reply(req, { ok: false, message: dbMessage(error, '帳號申請載入失敗') }, 400);
      return reply(req, { ok: true, data: data || [] });
    }

    if (action === 'admin_approve_account_application') {
      const applicationId = id(body.application_id), rbacRole = clean(body.rbac_role, 40);
      const supervisorId = id(body.supervisor_id) || null, decisionNote = clean(body.decision_note, 1000) || null;
      if (!applicationId || (!ROLES.has(rbacRole) && !(await roleExists(rbacRole)))) {
        return reply(req, { ok: false, message: '帳號申請或角色設定無效' }, 400);
      }
      const { data: application } = await admin.from('account_applications')
        .select('application_id,name,username,email,phone,dept_id,reason,status')
        .eq('application_id', applicationId).maybeSingle();
      if (!application) return reply(req, { ok: false, message: '找不到指定的帳號申請' }, 404);
      if (application.status !== 'pending') return reply(req, { ok: false, message: '此帳號申請已完成審核' }, 409);
      const supervisorValidation = await validateSupervisor(supervisorId, application.dept_id, rbacRole);
      if (supervisorValidation.message) return reply(req, { ok: false, message: supervisorValidation.message }, 400);
      const [{ count: usernameCount }, { count: emailCount }] = await Promise.all([
        admin.from('users').select('user_id', { count: 'exact', head: true }).ilike('username', application.username),
        admin.from('users').select('user_id', { count: 'exact', head: true }).ilike('email', application.email),
      ]);
      if (Number(usernameCount || 0) + Number(emailCount || 0) > 0) {
        return reply(req, { ok: false, message: '登入帳號或電子郵件已存在，無法核准此申請' }, 409);
      }

      // 帳號核准時先建立一組測試用 8 位數臨時密碼，使用者仍可透過啟用連結
      // 設定正式密碼。以密碼學亂數取樣，避免批次核准時重複。
      const temporaryPassword = Array.from(crypto.getRandomValues(new Uint8Array(8)), value => String(value % 10)).join('');
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email: application.email, password: temporaryPassword, email_confirm: true,
        user_metadata: { name: application.name, username: application.username },
      });
      if (createError || !created.user) return reply(req, { ok: false, message: `Auth 帳號建立失敗：${createError?.message || '未知錯誤'}` }, 400);

      const profileData = {
        auth_id: created.user.id, name: application.name, username: application.username,
        email: application.email, phone: application.phone || null, dept_id: application.dept_id,
        department: await departmentName(application.dept_id), role: LEGACY_ROLE[rbacRole] ?? 'inspector',
        rbac_role: rbacRole, supervisor_id: supervisorValidation.supervisorId,
        permissions: {}, status: 'active', created_by: profile.user_id,
      };
      const { data: createdProfile, error: profileCreateError } = await admin.from('users')
        .insert(profileData).select('user_id').single();
      if (profileCreateError || !createdProfile) {
        await admin.auth.admin.deleteUser(created.user.id);
        return reply(req, { ok: false, message: dbMessage(profileCreateError, '人員主檔建立失敗') }, 400);
      }

      const now = new Date().toISOString();
      const { data: decided, error: decisionError } = await admin.from('account_applications').update({
        status: 'approved', decided_by: profile.user_id, decided_at: now, decision_note: decisionNote,
        approved_user_id: createdProfile.user_id, approved_role: rbacRole,
        approved_supervisor_id: supervisorValidation.supervisorId, updated_at: now,
      }).eq('application_id', applicationId).eq('status', 'pending').select('application_id').maybeSingle();
      if (decisionError || !decided) {
        await admin.from('users').update({ status: 'inactive' }).eq('user_id', createdProfile.user_id);
        await admin.auth.admin.updateUserById(created.user.id, { ban_duration: '876000h' });
        return reply(req, { ok: false, message: '帳號已建立但申請狀態同步失敗，帳號已安全停用，請洽系統維護人員' }, 500);
      }

      const publicAuth = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error: mailError } = await publicAuth.auth.resetPasswordForEmail(application.email, {
        redirectTo: 'https://jnfakimo.github.io/Inspection/v2/login/',
      });
      await audit('users', createdProfile.user_id, 'insert', {
        source: 'account_application', application_id: applicationId, name: application.name,
        username: application.username, email: application.email, dept_id: application.dept_id,
        rbac_role: rbacRole, supervisor_id: supervisorValidation.supervisorId,
        activation_email_sent: !mailError,
      });
      return reply(req, { ok: true, data: { user_id: createdProfile.user_id, activation_email_sent: !mailError }, message: mailError ? '帳號已核准，但啟用郵件寄送失敗；請由帳號管理重設密碼' : '帳號已核准，啟用連結已寄出' });
    }

    if (action === 'admin_reject_account_application') {
      const applicationId = id(body.application_id), decisionNote = clean(body.decision_note, 1000);
      if (!applicationId || !decisionNote) return reply(req, { ok: false, message: '退回帳號申請時必須填寫原因' }, 400);
      const now = new Date().toISOString();
      const { data, error } = await admin.from('account_applications').update({
        status: 'rejected', decided_by: profile.user_id, decided_at: now,
        decision_note: decisionNote, updated_at: now,
      }).eq('application_id', applicationId).eq('status', 'pending').select('application_id').maybeSingle();
      if (error) return reply(req, { ok: false, message: dbMessage(error, '帳號申請退回失敗') }, 400);
      if (!data) return reply(req, { ok: false, message: '此帳號申請已完成審核' }, 409);
      await audit('account_applications', applicationId, 'status_change', { before: 'pending', after: 'rejected', decision_note: decisionNote });
      return reply(req, { ok: true, message: '帳號申請已退回' });
    }

    if (action === 'admin_create_users_batch') {
      const source = Array.isArray(body.rows) ? body.rows : [];
      if (!source.length) return reply(req, { ok: false, message: '沒有可匯入的人員資料' }, 400);
      if (source.length > 200) return reply(req, { ok: false, message: '單次最多匯入 200 筆人員資料' }, 400);
      const { data: existing, error: existingError } = await admin.from('users').select('username,email').limit(5000);
      if (existingError) return reply(req, { ok: false, message: dbMessage(existingError, '人員資料載入失敗') }, 400);
      const existingUsernames = new Set((existing || []).map(row => clean(row.username, 64).toLowerCase()));
      const existingEmails = new Set((existing || []).map(row => clean(row.email, 200).toLowerCase()));
      const details: string[] = [], createdUsernames: string[] = [];
      let success = 0, skipped = 0, failed = 0;
      const addFailure = (rowNumber: number, username: string, message: string) => {
        details.push(`第 ${rowNumber} 列「${username || '未命名'}」：${message}`);
        failed += 1;
      };
      for (const [index, raw] of source.entries()) {
        const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        const rowNumber = Number.isInteger(Number(row.row_number)) && Number(row.row_number) > 0 ? Number(row.row_number) : index + 2;
        const name = clean(row.name, 100), username = clean(row.username, 64), email = clean(row.email, 200).toLowerCase();
        const phone = clean(row.phone, 50), deptId = id(row.dept_id) || null, rbacRole = clean(row.rbac_role, 40);
        const supervisorId = id(row.supervisor_id) || null, password = String(row.password || '');
        if (!name || !/^[A-Za-z0-9._-]{3,64}$/.test(username)) { addFailure(rowNumber, username, '姓名必填；登入帳號須為 3–64 個英數字、句點、底線或連字號'); continue; }
        if (!/^\S+@\S+\.\S+$/.test(email) || /[(),]/.test(email)) { addFailure(rowNumber, username, '電子郵件格式不正確'); continue; }
        if (existingUsernames.has(username.toLowerCase()) || existingEmails.has(email)) { details.push(`第 ${rowNumber} 列「${username}」：帳號或電子郵件已存在，已跳過`); skipped += 1; continue; }
        const passwordError = passwordPolicyMessage(password);
        if (passwordError) { addFailure(rowNumber, username, `初始${passwordError}`); continue; }
        if (!ROLES.has(rbacRole) && !(await roleExists(rbacRole))) { addFailure(rowNumber, username, '系統角色設定無效'); continue; }
        const supervisorValidation = await validateSupervisor(supervisorId, deptId, rbacRole);
        if (supervisorValidation.message) { addFailure(rowNumber, username, supervisorValidation.message); continue; }
        const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name, username } });
        if (createError || !created.user) { addFailure(rowNumber, username, '登入帳號建立失敗，請確認電子郵件未被使用'); continue; }
        const profileData = {
          auth_id: created.user.id, name, username, email, phone: phone || null, dept_id: deptId,
          department: await departmentName(deptId), role: LEGACY_ROLE[rbacRole] ?? 'inspector',
          rbac_role: rbacRole, supervisor_id: supervisorValidation.supervisorId, permissions: {}, status: 'active', created_by: profile.user_id,
        };
        const { data: createdProfile, error: profileError } = await admin.from('users').insert(profileData).select('user_id').single();
        if (profileError || !createdProfile) {
          await admin.auth.admin.deleteUser(created.user.id);
          addFailure(rowNumber, username, `人員主檔建立失敗：${dbMessage(profileError, '資料格式不符合規則')}`);
          continue;
        }
        await audit('users', createdProfile.user_id, 'insert', { name, username, email, dept_id: deptId, rbac_role: rbacRole, supervisor_id: supervisorValidation.supervisorId, status: 'active', source: 'batch-import' });
        existingUsernames.add(username.toLowerCase()); existingEmails.add(email); createdUsernames.push(username); success += 1;
      }
      return reply(req, { ok: true, data: { success, skipped, failed, details: details.slice(0, 200), created_usernames: createdUsernames }, message: `匯入完成：成功 ${success} 筆、略過 ${skipped} 筆、失敗 ${failed} 筆` });
    }

    if (action === 'admin_create_user') {
      const name = clean(body.name, 100), username = clean(body.username, 64), email = clean(body.email, 200).toLowerCase(), phone = clean(body.phone, 50), password = String(body.password || ''), rbacRole = clean(body.rbac_role, 40), deptId = id(body.dept_id) || null, supervisorId = id(body.supervisor_id) || null;
      if (!name || !/^[A-Za-z0-9._-]{3,64}$/.test(username)) return reply(req, { ok: false, message: '姓名必填；登入帳號須為 3–64 個英數字、句點、底線或連字號' }, 400);
      if (!/^\S+@\S+\.\S+$/.test(email) || /[(),]/.test(email)) return reply(req, { ok: false, message: 'Email 格式不正確' }, 400);
      const passwordError = passwordPolicyMessage(password);
      if (passwordError) return reply(req, { ok: false, message: `初始${passwordError}` }, 400);
      if (!ROLES.has(rbacRole) && !(await roleExists(rbacRole))) return reply(req, { ok: false, message: '角色設定無效' }, 400);
      const supervisorValidation = await validateSupervisor(supervisorId, deptId, rbacRole);
      if (supervisorValidation.message) return reply(req, { ok: false, message: supervisorValidation.message }, 400);
      const [{ count: usernameCount }, { count: emailCount }] = await Promise.all([admin.from('users').select('*', { count: 'exact', head: true }).eq('username', username), admin.from('users').select('*', { count: 'exact', head: true }).eq('email', email)]); const count = Number(usernameCount || 0) + Number(emailCount || 0);
      if (count) return reply(req, { ok: false, message: '登入帳號或 Email 已存在' }, 409);
      const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name, username } });
      if (createError || !created.user) return reply(req, { ok: false, message: `Auth 帳號建立失敗：${createError?.message || '未知錯誤'}` }, 400);
      const profileData = { auth_id: created.user.id, name, username, email, phone: phone || null, dept_id: deptId, department: await departmentName(deptId), role: LEGACY_ROLE[rbacRole] ?? 'inspector', rbac_role: rbacRole, supervisor_id: supervisorValidation.supervisorId, permissions: {}, status: 'active', created_by: profile.user_id };
      const { data, error } = await admin.from('users').insert(profileData).select('user_id').single();
      if (error) { await admin.auth.admin.deleteUser(created.user.id); return reply(req, { ok: false, message: `人員主檔建立失敗：${dbMessage(error, '資料格式不符合規則')}` }, 400); }
      await audit('users', data.user_id, 'insert', { name, username, email, dept_id: deptId, rbac_role: rbacRole, supervisor_id: supervisorValidation.supervisorId, status: 'active' });
      return reply(req, { ok: true, data });
    }

    if (action === 'admin_update_user') {
      const userId = id(body.user_id), name = clean(body.name, 100), username = clean(body.username, 64), phone = clean(body.phone, 50), rbacRole = clean(body.rbac_role, 40), deptId = id(body.dept_id) || null, supervisorId = id(body.supervisor_id) || null, replacementSupervisorId = id(body.replacement_supervisor_id) || null;
      if (!userId || !name || !/^[A-Za-z0-9._-]{3,64}$/.test(username) || (!ROLES.has(rbacRole) && !(await roleExists(rbacRole)))) return reply(req, { ok: false, message: '人員資料或角色設定無效' }, 400);
      const { data: before } = await admin.from('users').select('user_id,auth_id,name,username,phone,dept_id,department,role,rbac_role,supervisor_id,status').eq('user_id', userId).maybeSingle();
      if (!before) return reply(req, { ok: false, message: '找不到指定使用者' }, 404);
      if (userId === profile.user_id && rbacRole !== roleId) return reply(req, { ok: false, message: '不可變更目前登入管理員自己的角色' }, 400);
      const supervisorValidation = await validateSupervisor(supervisorId, deptId, rbacRole, userId);
      if (supervisorValidation.message) return reply(req, { ok: false, message: supervisorValidation.message }, 400);
      // 更新前檢查 username 是否與其他使用者重複（排除自己），避免重名帳號。
      const { count: usernameCount } = await admin.from('users').select('*', { count: 'exact', head: true }).eq('username', username).neq('user_id', userId);
      if (Number(usernameCount || 0) > 0) return reply(req, { ok: false, message: '登入帳號已存在' }, 409);
      // 單位、課室及角色輪調必須與原直屬人員改派同一交易完成；若任一步不合法，
      // PostgreSQL 會整筆回滾，避免只改到一半。個人 permissions 覆寫維持原值。
      const changes = { name, username, phone: phone || null, dept_id: deptId, department: await departmentName(deptId), role: LEGACY_ROLE[rbacRole] ?? 'inspector', rbac_role: rbacRole, supervisor_id: supervisorValidation.supervisorId };
      const { data: rotation, error } = await admin.rpc('admin_rotate_user_assignment', {
        p_user_id: userId, p_name: name, p_username: username, p_phone: phone,
        p_dept_id: deptId, p_department: changes.department, p_role: changes.role,
        p_rbac_role: rbacRole, p_supervisor_id: supervisorValidation.supervisorId,
        p_replacement_supervisor_id: replacementSupervisorId,
      });
      if (error) return reply(req, { ok: false, message: dbMessage(error, '人員資料更新失敗') }, 400);
      if (before.auth_id) {
        const { error: authError } = await admin.auth.admin.updateUserById(before.auth_id, { user_metadata: { name, username } });
        if (authError) console.warn('admin auth metadata sync failed:', authError.message);
      }
      const reassignedCount = Number((rotation as Record<string, unknown> | null)?.reassigned_count || 0);
      await audit('users', userId, 'update', { before, after: changes, replacement_supervisor_id: replacementSupervisorId, reassigned_count: reassignedCount });
      return reply(req, { ok: true, message: reassignedCount > 0 ? `人員資料已更新，並同步改派 ${reassignedCount} 位原直屬人員` : '人員資料已更新' });
    }

    if (action === 'admin_toggle_user') {
      const userId = id(body.user_id), nextStatus = status(body.status);
      if (!userId) return reply(req, { ok: false, message: '使用者識別碼無效' }, 400);
      if (userId === profile.user_id && nextStatus === 'inactive') return reply(req, { ok: false, message: '不可停用目前登入的管理員帳號' }, 400);
      const { data: before } = await admin.from('users').select('user_id,name,status,auth_id,dept_id,supervisor_id,role,rbac_role').eq('user_id', userId).maybeSingle();
      if (!before) return reply(req, { ok: false, message: '找不到指定使用者' }, 404);
      // 啟用前先用同一套主管規則檢查，避免只顯示資料庫約束錯誤；主管／系統
      // 管理員若留有歷史 supervisor_id，啟用時一併清除，維持帳號階層一致。
      const targetRole = String(before.rbac_role || (before.role === 'admin' ? 'sysadmin' : before.role === 'supervisor' ? 'unit_supervisor' : before.role === 'maintenance' ? 'technician' : before.role === 'inspector' ? 'reporter' : before.role) || 'reporter');
      if (nextStatus === 'active') {
        const supervisorValidation = await validateSupervisor(id(before.supervisor_id) || null, id(before.dept_id) || null, targetRole, userId);
        if (supervisorValidation.message) return reply(req, { ok: false, message: `帳號啟用失敗：${supervisorValidation.message}` }, 400);
      }
      // 任何仍掛著這位帳號的啟用人員都會失去可用主管；先要求改派，
      // 即使資料庫尚未套用主管異動觸發器也不會產生孤兒指派。
      if (nextStatus === 'inactive') {
        const { data: dependents, error: dependentError } = await admin.from('users')
          .select('name').eq('supervisor_id', userId).eq('status', 'active').order('name').limit(200);
        if (dependentError) return reply(req, { ok: false, message: '帳號狀態檢查失敗，請重新整理後再試' }, 400);
        if ((dependents || []).length > 0) {
          const names = (dependents || []).map(row => String(row.name || '')).filter(Boolean).join('、');
          return reply(req, { ok: false, message: `無法停用：此帳號仍是 ${dependents?.length || 0} 位啟用人員的直屬主管（${names.slice(0, 200)}），請先改派其他主管` }, 409);
        }
      }
      const changes = { status: nextStatus, ...(nextStatus === 'active' && ['unit_supervisor', 'sysadmin'].includes(targetRole) ? { supervisor_id: null } : {}) };
      const { error } = await admin.from('users').update(changes).eq('user_id', userId);
      if (error) return reply(req, { ok: false, message: dbMessage(error, '帳號狀態更新失敗') }, 400);
      // 同步停用/啟用 Supabase Auth，確保離職/停用帳號無法再登入或延續既有 session。
      if (before.auth_id) {
        const { error: banError } = await admin.auth.admin.updateUserById(before.auth_id, {
          ban_duration: nextStatus === 'inactive' ? '876000h' : 'none',
        });
        if (banError) console.warn('admin auth ban sync failed:', banError.message);
      }
      await audit('users', userId, 'status_change', { before: before.status, after: nextStatus });
      return reply(req, { ok: true });
    }

    if (action === 'admin_reset_password') {
      const userId = id(body.user_id), password = String(body.password || '');
      const passwordError = passwordPolicyMessage(password);
      if (!userId || passwordError) return reply(req, { ok: false, message: passwordError || '使用者識別碼無效' }, 400);
      const { data: target } = await admin.from('users').select('auth_id,name,status').eq('user_id', userId).maybeSingle();
      if (!target?.auth_id) return reply(req, { ok: false, message: '此帳號尚未連結 Supabase Auth' }, 400);
      if (target.status !== 'active') return reply(req, { ok: false, message: '已停用的帳號不可重設密碼，請先重新啟用' }, 409);
      const { error } = await admin.auth.admin.updateUserById(target.auth_id, { password });
      if (error) return reply(req, { ok: false, message: dbMessage(error, '密碼重設失敗') }, 400);
      await audit('users', userId, 'update', { event_type: 'password_reset', target_name: target.name });
      return reply(req, { ok: true });
    }

    if (action === 'admin_deidentify_user') {
      const userId = id(body.user_id);
      if (!userId || userId === profile.user_id) return reply(req, { ok: false, message: '不可對目前登入帳號執行去識別化' }, 400);
      const { data: target } = await admin.from('users').select('user_id,auth_id,name,status').eq('user_id', userId).maybeSingle();
      if (!target) return reply(req, { ok: false, message: '找不到指定使用者' }, 404);
      if (target.status !== 'inactive') return reply(req, { ok: false, message: '只能對已停用帳號執行去識別化' }, 400);
      const { error } = await userDb.rpc('deidentify_departed_user', { p_user_id: userId });
      if (error) return reply(req, { ok: false, message: `個資去識別化失敗：${error.message}` }, 400);
      if (target.auth_id) {
        const { error: authError } = await admin.auth.admin.updateUserById(target.auth_id, { email: `deidentified-${userId}@example.invalid`, password: crypto.randomUUID() + crypto.randomUUID(), user_metadata: { name: `已離職人員-${userId.slice(-4)}`, username: `deidentified-${userId}` } });
        if (authError) {
          await audit('users', userId, 'update', { event_type: 'pii_deidentified', previous_name: target.name, auth_sync_failed: true });
          return reply(req, { ok: false, message: '個資已於系統主檔去識別化，但 Auth 帳號同步失敗，請連絡系統管理員處理' }, 500);
        }
      }
      await audit('users', userId, 'update', { event_type: 'pii_deidentified', previous_name: target.name });
      return reply(req, { ok: true });
    }

    if (action === 'admin_set_permission') {
      const rbacRole = clean(body.role_id, 40), permission = clean(body.permission, 60);
      // 只接受真正的 true/'true'，避免字串 "false" 被 Boolean() 誤判為授予。
      const allowed = body.allowed === true || body.allowed === 'true';
      if (!PERMISSIONS.has(permission)) return reply(req, { ok: false, message: '權限代碼無效' }, 400);
      if (!ROLES.has(rbacRole) && !(await roleExists(rbacRole))) return reply(req, { ok: false, message: '角色不存在' }, 400);
      if (permission === 'sys_admin' && rbacRole !== 'sysadmin' && allowed) return reply(req, { ok: false, message: '後台管理權限只保留給系統管理員，不可委派' }, 400);
      if (rbacRole === 'sysadmin' && !allowed) return reply(req, { ok: false, message: '系統管理員的完整權限不可取消' }, 400);
      const { data: before } = await admin.from('role_permissions').select('allowed').eq('role_id', rbacRole).eq('perm', permission).maybeSingle();
      const { error } = await admin.from('role_permissions').upsert({ role_id: rbacRole, perm: permission, allowed }, { onConflict: 'role_id,perm' });
      if (error) return reply(req, { ok: false, message: `權限更新失敗：${error.message}` }, 400);
      const { error: inheritError } = await admin.from('users').update({ permissions: {} }).eq('rbac_role', rbacRole);
      if (inheritError) return reply(req, { ok: false, message: `角色權限已更新，但使用者繼承同步失敗：${inheritError.message}` }, 500);
      await audit('role_permissions', `${rbacRole}:${permission}`, 'update', { before: before?.allowed, after: allowed });
      return reply(req, { ok: true });
    }

    if (action === 'admin_assign_role') {
      const userId = id(body.user_id), rbacRole = clean(body.rbac_role, 40);
      if (!userId || (!ROLES.has(rbacRole) && !(await roleExists(rbacRole)))) return reply(req, { ok: false, message: '使用者或角色設定無效' }, 400);
      if (userId === profile.user_id) return reply(req, { ok: false, message: '不可變更目前登入管理員自己的角色' }, 400);
      const { data: before } = await admin.from('users').select('user_id,rbac_role,role,dept_id,supervisor_id,status').eq('user_id', userId).maybeSingle();
      if (!before) return reply(req, { ok: false, message: '找不到指定使用者' }, 404);
      if (!['unit_supervisor', 'sysadmin'].includes(rbacRole)) {
        const { data: directReports, error: directReportError } = await admin.from('users')
          .select('name').eq('supervisor_id', userId).eq('status', 'active').order('name').limit(200);
        if (directReportError) return reply(req, { ok: false, message: '人員主管關係檢查失敗，請重新整理後再試' }, 400);
        if ((directReports || []).length > 0) {
          const names = (directReports || []).map(row => String(row.name || '')).filter(Boolean).join('、');
          return reply(req, { ok: false, message: `此帳號仍有 ${directReports?.length || 0} 位直屬人員（${names.slice(0, 200)}）；請到帳號管理調整角色並選擇接任主管` }, 409);
        }
      }
      // 「使用者角色指派」也必須和帳號管理共用主管規則。升為主管時清除舊
      // supervisor_id；改為一般角色時保留既有主管，若已無效則明確提示改到
      // 帳號管理重新指派，避免角色頁把人員留在無法啟用的狀態。
      const requestedSupervisorId = ['unit_supervisor', 'sysadmin'].includes(rbacRole)
        ? null
        : id(body.supervisor_id) || id(before.supervisor_id) || null;
      let normalizedSupervisorId = requestedSupervisorId;
      if (before.status === 'active' || requestedSupervisorId) {
        const supervisorValidation = await validateSupervisor(requestedSupervisorId, id(before.dept_id) || null, rbacRole, userId);
        if (supervisorValidation.message) return reply(req, { ok: false, message: `使用者角色更新失敗：${supervisorValidation.message}；請到帳號管理指定所屬單位與直屬主管` }, 400);
        normalizedSupervisorId = supervisorValidation.supervisorId;
      }
      const changes = { rbac_role: rbacRole, role: LEGACY_ROLE[rbacRole] ?? 'inspector', supervisor_id: normalizedSupervisorId, permissions: {} };
      const { error } = await admin.from('users').update(changes).eq('user_id', userId);
      if (error) return reply(req, { ok: false, message: `使用者角色更新失敗：${error.message}` }, 400);
      await audit('users', userId, 'update', { before, after: changes });
      return reply(req, { ok: true });
    }

    if (action === 'admin_save_location') {
      const locationId = id(body.location_id), marketId = clean(body.market_id, 50), floor = canonicalFloor(clean(body.floor, 50)), area = clean(body.area, 120), detail = clean(body.detail, 200);
      const hasStatus = body.status !== undefined && body.status !== null;
      const nextStatus = status(body.status);
      const parseOrder = (key: string) => {
        const value = Number(body[key] ?? 0);
        return Number.isFinite(value) && value >= 0 && value <= 9999 ? value : NaN;
      };
      const floorOrder = parseOrder('floor_order');
      const areaOrder = parseOrder('area_order');
      const detailOrder = parseOrder('detail_order');
      if (!marketId || !floor || !area) return reply(req, { ok: false, message: '市場、樓層與區域為必填' }, 400);
      if ([floorOrder, areaOrder, detailOrder].some(v => Number.isNaN(v))) return reply(req, { ok: false, message: '排序值必須是 0–9999 的數字' }, 400);
      const values: Record<string, unknown> = { market_id: marketId, floor, floor_order: floorOrder, area, area_order: areaOrder, detail, detail_order: detailOrder };
      if (locationId) {
        const { data: before } = await admin.from('locations').select('*').eq('location_id', locationId).maybeSingle();
        if (!before) return reply(req, { ok: false, message: '找不到指定位置' }, 404);
        // 更新時未提供 status 就不更動，避免編輯已停用項目時被靜默重新啟用。
        if (hasStatus) values.status = nextStatus;
        const { error } = await admin.from('locations').update(values).eq('location_id', locationId);
        if (error) return reply(req, { ok: false, message: dbMessage(error, '位置更新失敗') }, 400);
        await audit('locations', locationId, 'update', { before, after: values }); return reply(req, { ok: true });
      }
      values.status = nextStatus;
      const { data, error } = await admin.from('locations').insert({ ...values, created_by: profile.user_id }).select('location_id').single();
      if (error) return reply(req, { ok: false, message: dbMessage(error, '位置新增失敗') }, 400);
      await audit('locations', data.location_id, 'insert', values); return reply(req, { ok: true, data });
    }

    if (action === 'admin_toggle_location') {
      const locationId = id(body.location_id), nextStatus = status(body.status);
      if (!locationId) return reply(req, { ok: false, message: '位置識別碼無效' }, 400);
      const { data: before } = await admin.from('locations').select('status').eq('location_id', locationId).maybeSingle();
      if (!before) return reply(req, { ok: false, message: '找不到指定位置' }, 404);
      const { error } = await admin.from('locations').update({ status: nextStatus }).eq('location_id', locationId);
      if (error) return reply(req, { ok: false, message: dbMessage(error, '位置狀態更新失敗') }, 400);
      await audit('locations', locationId, 'status_change', { before: before.status, after: nextStatus }); return reply(req, { ok: true });
    }

    if (action === 'admin_save_department') {
      const deptId = id(body.dept_id), parentId = id(body.parent_id) || null, name = clean(body.name, 120), code = clean(body.code, 60) || null;
      const hasStatus = body.status !== undefined && body.status !== null;
      const nextStatus = status(body.status);
      const sortOrder = Number(body.sort_order ?? 0);
      if (!name || (deptId && deptId === parentId)) return reply(req, { ok: false, message: '部門名稱或上層部門設定無效' }, 400);
      if (!Number.isFinite(sortOrder) || sortOrder < 0 || sortOrder > 9999) return reply(req, { ok: false, message: '排序值必須是 0–9999 的數字' }, 400);
      let level = 1;
      if (parentId) {
        const { data: parent } = await admin.from('departments').select('level,parent_id,status').eq('dept_id', parentId).maybeSingle();
        if (!parent || parent.status !== 'active' || Number(parent.level) !== 1 || parent.parent_id) return reply(req, { ok: false, message: '上層部門必須是啟用中的部／室' }, 400);
        if (deptId) { const { count } = await admin.from('departments').select('*', { count: 'exact', head: true }).eq('parent_id', deptId); if (count) return reply(req, { ok: false, message: '已有課／組／隊的部／室不可再改為課／組／隊' }, 400); }
        level = 2;
      }
      const values: Record<string, unknown> = { parent_id: parentId, name, code, level, sort_order: sortOrder };
      if (deptId) {
        const { data: before } = await admin.from('departments').select('*').eq('dept_id', deptId).maybeSingle();
        if (!before) return reply(req, { ok: false, message: '找不到指定部門' }, 404);
        // 更新時未提供 status 就不更動，避免編輯已停用部門時被靜默重新啟用。
        if (hasStatus) values.status = nextStatus;
        const { error } = await admin.from('departments').update(values).eq('dept_id', deptId);
        if (error) return reply(req, { ok: false, message: dbMessage(error, '部門更新失敗') }, 400);
        await audit('departments', deptId, 'update', { before, after: values }); return reply(req, { ok: true });
      }
      values.status = nextStatus;
      const { data, error } = await admin.from('departments').insert(values).select('dept_id').single();
      if (error) return reply(req, { ok: false, message: dbMessage(error, '部門新增失敗') }, 400); await audit('departments', data.dept_id, 'insert', values); return reply(req, { ok: true, data });
    }

    if (action === 'admin_toggle_department') {
      const deptId = id(body.dept_id), nextStatus = status(body.status);
      if (!deptId) return reply(req, { ok: false, message: '部門識別碼無效' }, 400);
      const { data: before } = await admin.from('departments').select('status').eq('dept_id', deptId).maybeSingle();
      if (!before) return reply(req, { ok: false, message: '找不到指定部門' }, 404);
      if (nextStatus === 'inactive') { const { count } = await admin.from('departments').select('*', { count: 'exact', head: true }).eq('parent_id', deptId).eq('status', 'active'); if (count) return reply(req, { ok: false, message: '請先停用所屬的課／組／隊，再停用此部／室' }, 400); }
      const { error } = await admin.from('departments').update({ status: nextStatus }).eq('dept_id', deptId);
      if (error) return reply(req, { ok: false, message: dbMessage(error, '部門狀態更新失敗') }, 400); await audit('departments', deptId, 'status_change', { before: before.status, after: nextStatus }); return reply(req, { ok: true });
    }

    if (action === 'admin_ack_alert') {
      const alertId = id(body.alert_id); if (!alertId) return reply(req, { ok: false, message: '告警識別碼無效' }, 400);
      const { data: before } = await admin.from('security_alerts').select('status,title').eq('alert_id', alertId).maybeSingle();
      if (!before) return reply(req, { ok: false, message: '找不到指定告警' }, 404);
      if (before.status !== 'open') return reply(req, { ok: false, message: '此告警已處理' }, 409);
      const { error } = await admin.from('security_alerts').update({ status: 'acknowledged', acknowledged_at: new Date().toISOString(), acknowledged_by: profile.user_id }).eq('alert_id', alertId).eq('status', 'open');
      if (error) return reply(req, { ok: false, message: dbMessage(error, '告警處理失敗') }, 400); await audit('security_alerts', alertId, 'status_change', { before: before.status, after: 'acknowledged', title: before.title }); return reply(req, { ok: true });
    }

    if (action === 'admin_mark_notice') {
      const rawNotifId = clean(body.notif_id, 80), notifId = id(rawNotifId);
      if (rawNotifId && !notifId) return reply(req, { ok: false, message: '通知識別碼無效' }, 400);
      let query = userDb.from('notifications').update({ is_read: true }).eq('recipient_id', profile.user_id).eq('is_read', false);
      if (notifId) query = query.eq('notif_id', notifId);
      const { data, error } = await query.select('notif_id');
      if (error) return reply(req, { ok: false, message: `通知更新失敗：${error.message}` }, 400);
      await audit('notifications', notifId || `recipient:${profile.user_id}`, 'status_change', { event_type: notifId ? 'mark_read' : 'mark_all_read', count: data?.length || 0 });
      return reply(req, { ok: true, data: { count: data?.length || 0 } });
    }

    if (action === 'admin_create_role') {
      const roleId = clean(body.role_id, 40).toLowerCase(), name = clean(body.name, 80);
      if (!/^[a-z0-9_]{2,40}$/.test(roleId) || !name) return reply(req, { ok: false, message: '角色代碼須為 2–40 個小寫英數字或底線，且名稱不可空白' }, 400);
      if (ROLES.has(roleId) || roleId === 'admin' || roleId === 'supervisor' || roleId === 'maintenance' || roleId === 'inspector') {
        return reply(req, { ok: false, message: '此角色代碼為系統保留角色，不可建立' }, 409);
      }
      const { data: existing } = await admin.from('roles').select('role_id').eq('role_id', roleId).maybeSingle();
      if (existing) return reply(req, { ok: false, message: '角色代碼已存在' }, 409);
      const { data: maxRow } = await admin.from('roles').select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle();
      const { data, error } = await admin.from('roles').insert({ role_id: roleId, name, sort_order: Number(maxRow?.sort_order || 0) + 10 }).select('role_id').single();
      if (error) return reply(req, { ok: false, message: `角色建立失敗：${error.message}` }, 400);
      await audit('roles', roleId, 'insert', { role_id: roleId, name });
      return reply(req, { ok: true, data });
    }

    if (action === 'admin_update_role') {
      const roleId = clean(body.role_id, 40).toLowerCase(), name = clean(body.name, 80);
      if (!/^[a-z0-9_]{2,40}$/.test(roleId) || !name) return reply(req, { ok: false, message: '角色代碼與名稱格式無效' }, 400);
      const { data: before } = await admin.from('roles').select('role_id,name,sort_order').eq('role_id', roleId).maybeSingle();
      if (!before) return reply(req, { ok: false, message: '找不到指定角色' }, 404);
      const { error } = await admin.from('roles').update({ name }).eq('role_id', roleId);
      if (error) return reply(req, { ok: false, message: `角色更新失敗：${error.message}` }, 400);
      await audit('roles', roleId, 'update', { before: before.name, after: name });
      return reply(req, { ok: true });
    }

    return reply(req, { ok: false, message: '不支援的後台管理動作' }, 400);
  } catch (error) {
    console.error('admin-api failed', error instanceof Error ? error.message : String(error));
    return reply(req, { ok: false, message: '後台管理 API 處理失敗，請稍後再試' }, 500);
  }
}

// Supabase Edge Functions remain available as a migration fallback. The
// Render Node.js service imports this same handler, so both runtimes enforce
// the exact same validation, RBAC, rate limits, and audit rules.
if (denoRuntime?.serve) denoRuntime.serve(handleAdminApiRequest);
