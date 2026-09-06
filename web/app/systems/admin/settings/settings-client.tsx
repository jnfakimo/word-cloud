'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { AppShell } from '@/components/AppShell';
import { AuthGate } from '@/components/AuthGate';
import { TimeSelect } from '@/components/TimeSelect';
import { invokeAdminApi } from '@/lib/admin-api';
import { getSupabase } from '@/lib/supabase';
import type { Profile } from '@/types/app';
import styles from './settings.module.css';

type SectionKey = 'identity' | 'departments' | 'shifts' | 'line' | 'api';
type Notice = { kind: 'success' | 'error' | 'info'; text: string } | null;

type Shift = {
  id: string;
  label: string;
  start: string;
  end: string;
};

type Department = {
  dept_id: string;
  parent_id: string | null;
  name: string;
  code: string | null;
  level: number;
  sort_order: number;
  status: 'active' | 'inactive';
};

type DepartmentEditor = {
  dept_id?: string;
  parent_id: string;
  name: string;
  code: string;
  sort_order: number;
  status: 'active' | 'inactive';
};

type IdentitySettings = {
  orgName: string;
  siteName: string;
};

type LineSettings = {
  tokenDraft: string;
  tokenConfigured: boolean;
  groupId: string;
  notifyInspect: boolean;
  notifyRepair: boolean;
  notifyCase: boolean;
  notifySecurity: boolean;
  errorThresholdEnabled: boolean;
  errorThresholdWindowMinutes: number;
  errorThresholdCount: number;
  errorThresholdCooldownMinutes: number;
};

type SettingsSnapshot = {
  identity: IdentitySettings;
  shifts: Shift[];
  line: Omit<LineSettings, 'tokenDraft'>;
};

type SettingsCard = {
  id: string;
  title: string;
  english: string;
  description: string;
  icon: string;
  accent: string;
  section?: SectionKey;
  href?: string;
};

const defaultShifts: Shift[] = [
  { id: 'morning', label: '早班', start: '06:00', end: '14:00' },
  { id: 'afternoon', label: '中班', start: '14:00', end: '22:00' },
  { id: 'night', label: '夜班', start: '22:00', end: '06:00' },
];

const cards: SettingsCard[] = [
  {
    id: 'SYS-01',
    title: '系統識別',
    english: 'SYSTEM IDENTITY',
    description: '設定組織與場域名稱，供全系統品牌列與文件共用。',
    icon: '/Inspection/assets/system-icons-v20260901/admin-icon.png',
    accent: 'var(--icon-sky)',
    section: 'identity',
  },
  {
    id: 'SYS-02',
    title: '組織架構',
    english: 'ORGANIZATION',
    description: '維護兩層式部門樹、代碼、排序與啟用狀態。',
    icon: '/Inspection/assets/system-icons-v20260901/account-icon.png',
    accent: '#3977e8',
    section: 'departments',
  },
  {
    id: 'SYS-03',
    title: '班別管理',
    english: 'SHIFT MANAGEMENT',
    description: '維護早、中、夜班等班別名稱與跨日作業時段。',
    icon: '/Inspection/assets/system-icons-v20260901/handover-icon.png',
    accent: '#00a86b',
    section: 'shifts',
  },
  {
    id: 'SYS-04',
    title: 'LINE 推播',
    english: 'LINE NOTIFICATION',
    description: '管理群組、通知事件及測試推播；Token 永不回顯。',
    icon: '/Inspection/assets/system-icons-v20260901/guardpatrol-line-push-icon.png',
    accent: '#7657d6',
    section: 'line',
  },
  {
    id: 'SYS-05',
    title: '圖資專案設定',
    english: 'MAP PROJECT',
    description: '統一管理 3D 建模、平面圖、3D 圖、標記與巡檢雲臺的共用圖資。',
    icon: '/Inspection/assets/system-icons-v20260901/equipment-icon.png',
    accent: '#d14e78',
    href: '/systems/structuremap/models/',
  },
  {
    id: 'SYS-06',
    title: '權限管理 RBAC',
    english: 'ROLE ACCESS CONTROL',
    description: '前往角色與系統權限矩陣，控管功能存取範圍。',
    icon: '/Inspection/assets/system-icons-v20260901/account-icon.png',
    accent: '#d98b00',
    href: '/systems/admin/permissions/',
  },
  {
    id: 'SYS-07',
    title: '整合 API 文件',
    english: 'INTEGRATION API',
    description: '檢視核心連線、共用鍵值及十一項系統整合邊界。',
    icon: '/Inspection/assets/system-icons-v20260901/admin-icon.png',
    accent: 'var(--icon-sky)',
    section: 'api',
  },
  {
    id: 'SYS-08',
    title: '通知中心',
    english: 'NOTICE CENTER',
    description: '前往通知收件匣，查看個人通知與已讀狀態。',
    icon: '/Inspection/assets/system-icons-v20260901/audit-icon.png',
    accent: '#64748b',
    href: '/systems/admin/notices/',
  },
];

const integrationItems = [
  ['01', '電子交接簿', '交接紀錄、待辦案件與案件歷程'],
  ['02', '巡檢管理', '巡檢紀錄、異常結果與打卡資料'],
  ['03', '預防保養', '保養週期、計畫與執行結果'],
  ['04', '設備管理 CMMS', '設備主檔、生命週期與維修關聯'],
  ['05', '人員排班', '人員、部門與班別識別資料'],
  ['06', '門禁', '依人員與部門識別交換授權資料'],
  ['07', 'ERP', '工單、成本及資產代碼交換'],
  ['08', '採購', '物料、請購與供應商資料銜接'],
  ['09', '倉儲庫存', '材料主檔、庫存異動與領用資料'],
  ['10', 'BI 戰情', '以唯讀查詢提供營運指標與彙總'],
  ['11', '中央監控 BMS／SCADA', '設備告警與量測事件交換'],
] as const;

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOf(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function booleanOf(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return fallback;
}

function settingsMap(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value
        .map(item => recordOf(item))
        .filter(item => typeof item.key === 'string')
        .map(item => [item.key as string, item.value]),
    );
  }
  return recordOf(value);
}

function normalizeShifts(value: unknown): Shift[] {
  let source = value;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source) as unknown;
    } catch {
      return defaultShifts.map(shift => ({ ...shift }));
    }
  }
  if (!Array.isArray(source)) return defaultShifts.map(shift => ({ ...shift }));
  const shifts = source
    .map(item => recordOf(item))
    .map(item => ({
      id: stringOf(item.id).trim(),
      label: stringOf(item.label).trim(),
      start: stringOf(item.start).trim().slice(0, 5),
      end: stringOf(item.end).trim().slice(0, 5),
    }))
    .filter(item => item.id || item.label || item.start || item.end);
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

  // 舊版曾允許任意新增班別，正式資料可能仍殘留額外或重複的 ID。
  // V2 儲存端只接受固定三班，因此載入時先依固定 ID 整理，避免畫面帶著
  // 第四、第五筆舊資料，造成使用者無論怎麼改時間都無法通過儲存驗證。
  return defaultShifts.map(fallback => {
    const current = shifts.find(shift => shift.id === fallback.id);
    if (!current) return { ...fallback };
    return {
      id: fallback.id,
      label: current.label || fallback.label,
      start: timePattern.test(current.start) ? current.start : fallback.start,
      end: timePattern.test(current.end) ? current.end : fallback.end,
    };
  });
}

function numberOf(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSettings(result: unknown): SettingsSnapshot {
  const outer = recordOf(result);
  const payload = Object.keys(recordOf(outer.data)).length ? recordOf(outer.data) : outer;
  const flat = {
    ...settingsMap(payload.settings),
    ...payload,
  };
  const identity = recordOf(payload.identity);
  const shiftContainer = recordOf(payload.shifts);
  const line = recordOf(payload.line);
  const rawShifts = Array.isArray(payload.shifts)
    ? payload.shifts
    : shiftContainer.shifts ?? flat.shifts;

  return {
    identity: {
      orgName: stringOf(identity.org_name ?? flat.org_name, '臺北農產公司'),
      siteName: stringOf(identity.site_name ?? flat.site_name, '第一果菜市場'),
    },
    shifts: normalizeShifts(rawShifts),
    line: {
      tokenConfigured: booleanOf(
        line.line_token_configured ?? line.token_configured ?? flat.line_token_configured,
        false,
      ),
      groupId: stringOf(line.line_group_id ?? flat.line_group_id),
      notifyInspect: booleanOf(
        line.line_notify_anomaly ?? flat.line_notify_anomaly ?? line.line_notify_inspect ?? flat.line_notify_inspect,
      ),
      notifyRepair: booleanOf(line.line_notify_repair ?? flat.line_notify_repair),
      notifyCase: booleanOf(line.line_notify_case ?? flat.line_notify_case),
      notifySecurity: booleanOf(
        line.line_notify_security_alerts ?? flat.line_notify_security_alerts ?? line.line_notify_security ?? flat.line_notify_security,
        true,
      ),
      // 資安監測在資料庫與排程端預設為啟用。Node API 滾動部署期間若
      // 暫時尚未回傳新欄位，畫面也必須與實際保護狀態一致，避免管理員
      // 誤以為告警已關閉，或儲存其他 LINE 設定時反向把它關掉。
      errorThresholdEnabled: booleanOf(line.line_notify_error_threshold ?? flat.line_notify_error_threshold, true),
      errorThresholdWindowMinutes: numberOf(line.error_threshold_window_minutes ?? flat.error_threshold_window_minutes, 15),
      errorThresholdCount: numberOf(line.error_threshold_count ?? flat.error_threshold_count, 20),
      errorThresholdCooldownMinutes: numberOf(line.error_threshold_cooldown_minutes ?? flat.error_threshold_cooldown_minutes, 60),
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '發生未預期錯誤，請稍後再試。';
}

function isAdministrator(profile: Profile): boolean {
  return [profile.rbac_role, profile.role].some(role => role === 'sysadmin' || role === 'admin');
}

function SettingsWorkspace({ profile }: { profile: Profile }) {
  const [section, setSection] = useState<SectionKey | null>(null);
  const [identity, setIdentity] = useState<IdentitySettings>({
    orgName: '臺北農產公司',
    siteName: '第一果菜市場',
  });
  const [shifts, setShifts] = useState<Shift[]>(defaultShifts.map(shift => ({ ...shift })));
  const [line, setLine] = useState<LineSettings>({
    tokenDraft: '',
    tokenConfigured: false,
    groupId: '',
    notifyInspect: false,
    notifyRepair: false,
    notifyCase: false,
    notifySecurity: true,
    errorThresholdEnabled: true,
    errorThresholdWindowMinutes: 15,
    errorThresholdCount: 20,
    errorThresholdCooldownMinutes: 60,
  });
  const [departments, setDepartments] = useState<Department[]>([]);
  const [departmentEditor, setDepartmentEditor] = useState<DepartmentEditor | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const loadSettings = useCallback(async () => {
    const result = await invokeAdminApi<unknown>('admin_get_settings');
    const snapshot = normalizeSettings(result);
    setIdentity(snapshot.identity);
    setShifts(snapshot.shifts);
    setLine(current => ({ ...snapshot.line, tokenDraft: current.tokenDraft }));
  }, []);

  const loadDepartments = useCallback(async () => {
    const { data, error } = await getSupabase().from('departments')
      .select('dept_id,parent_id,name,code,level,sort_order,status').order('sort_order').order('name');
    if (error) throw new Error('部門資料載入失敗，請重新整理或確認帳號權限');
    setDepartments(
      (data || []).map((row: Record<string, unknown>) => ({
        dept_id: String(row.dept_id),
        parent_id: row.parent_id ? String(row.parent_id) : null,
        name: String(row.name ?? ''),
        code: row.code ? String(row.code) : null,
        level: Number(row.level ?? 1),
        sort_order: Number(row.sort_order ?? 0),
        status: row.status === 'inactive' ? 'inactive' : 'active',
      })),
    );
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    const [settingsResult, departmentResult] = await Promise.allSettled([
      loadSettings(),
      loadDepartments(),
    ]);
    const errors = [settingsResult, departmentResult]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => messageOf(result.reason));
    if (errors.length) {
      setNotice({ kind: 'error', text: `部分設定載入失敗：${errors.join('；')}` });
    }
    setLoading(false);
  }, [loadDepartments, loadSettings]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const roots = useMemo(
    () => departments.filter(department => !department.parent_id),
    [departments],
  );

  const orphanDepartments = useMemo(() => {
    const ids = new Set(departments.map(department => department.dept_id));
    return departments.filter(department => department.parent_id && !ids.has(department.parent_id));
  }, [departments]);

  const saveIdentity = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const orgName = identity.orgName.trim();
    const siteName = identity.siteName.trim();
    if (!orgName || !siteName) {
      setNotice({ kind: 'error', text: '組織名稱與場域名稱皆為必填。' });
      return;
    }
    setBusy('identity');
    try {
      await invokeAdminApi('admin_save_identity', { org_name: orgName, site_name: siteName });
      setIdentity({ orgName, siteName });
      setNotice({ kind: 'success', text: '系統識別已儲存，其他頁面重新載入後會套用新名稱。' });
    } catch (error) {
      setNotice({ kind: 'error', text: `系統識別儲存失敗：${messageOf(error)}` });
    } finally {
      setBusy(null);
    }
  };

  const saveShifts = async () => {
    const normalized = shifts.map(shift => ({
      id: shift.id.trim(),
      label: shift.label.trim(),
      start: shift.start.trim(),
      end: shift.end.trim(),
    }));
    const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    if (normalized.some(shift => !shift.id || !shift.label || !shift.start || !shift.end)) {
      setNotice({ kind: 'error', text: '請完整填寫每個班別的名稱、ID、開始與結束時間。' });
      return;
    }
    const fixedShiftIds = ['morning', 'afternoon', 'night'];
    if (normalized.length !== 3 || fixedShiftIds.some(id => !normalized.some(shift => shift.id === id))) {
      setNotice({ kind: 'error', text: '早班、中班、夜班為固定流程，班別 ID 不可新增、刪除或變更。' });
      return;
    }
    if (normalized.some(shift => !timePattern.test(shift.start) || !timePattern.test(shift.end))) {
      setNotice({ kind: 'error', text: '班別時間須為有效的 24 小時 HH:MM 格式。' });
      return;
    }
    setBusy('shifts');
    try {
      await invokeAdminApi('admin_save_shifts', { shifts: normalized });
      setShifts(normalized);
      setNotice({ kind: 'success', text: '班別設定已儲存，跨日班別可使用晚於開始時間的隔日結束時間。' });
    } catch (error) {
      setNotice({ kind: 'error', text: `班別設定儲存失敗：${messageOf(error)}` });
    } finally {
      setBusy(null);
    }
  };

  const saveLineSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const groupId = line.groupId.trim();
    const token = line.tokenDraft.trim();
    if (!groupId) {
      setNotice({ kind: 'error', text: '請填寫 LINE Group ID。' });
      return;
    }
    const windowMinutes = Math.trunc(line.errorThresholdWindowMinutes);
    const thresholdCount = Math.trunc(line.errorThresholdCount);
    const cooldownMinutes = Math.trunc(line.errorThresholdCooldownMinutes);
    if (windowMinutes < 5 || windowMinutes > 60 || thresholdCount < 1 || thresholdCount > 5000 || cooldownMinutes < 5 || cooldownMinutes > 1440) {
      setNotice({ kind: 'error', text: '錯誤爆量統計視窗須為 5–60 分鐘、門檻須為 1–5000 筆、冷卻時間須為 5–1440 分鐘。' });
      return;
    }
    const payload: Record<string, unknown> = {
      line_group_id: groupId,
      line_notify_anomaly: line.notifyInspect,
      line_notify_repair: line.notifyRepair,
      line_notify_case: line.notifyCase,
      line_notify_security_alerts: line.notifySecurity,
      line_notify_error_threshold: line.errorThresholdEnabled,
      error_threshold_window_minutes: windowMinutes,
      error_threshold_count: thresholdCount,
      error_threshold_cooldown_minutes: cooldownMinutes,
    };
    if (token) payload.line_channel_token = token;

    setBusy('line');
    try {
      await invokeAdminApi('admin_save_line_settings', payload);
      setLine(current => ({
        ...current,
        groupId,
        tokenDraft: '',
        tokenConfigured: current.tokenConfigured || Boolean(token),
        errorThresholdWindowMinutes: windowMinutes,
        errorThresholdCount: thresholdCount,
        errorThresholdCooldownMinutes: cooldownMinutes,
      }));
      setNotice({
        kind: 'success',
        text: token ? 'LINE 設定與新 Token 已儲存；Token 已立即從畫面清除。' : 'LINE 設定已儲存；既有 Token 保持不變。',
      });
    } catch (error) {
      setNotice({ kind: 'error', text: `LINE 設定儲存失敗：${messageOf(error)}` });
    } finally {
      setBusy(null);
    }
  };

  const testLinePush = async () => {
    setBusy('line-test');
    setNotice({ kind: 'info', text: '正在傳送 LINE 測試訊息…' });
    try {
      const data = await invokeAdminApi<{ ok?: boolean; msg?: string; message?: string }>('admin_test_line_notification');
      if (!data?.ok) throw new Error(data?.msg || data?.message || '地端服務未回傳成功狀態');
      setNotice({ kind: 'success', text: '測試訊息已送出，請至設定的 LINE 群組確認。' });
    } catch (error) {
      setNotice({ kind: 'error', text: `LINE 測試推播失敗：${messageOf(error)}` });
    } finally {
      setBusy(null);
    }
  };

  const testErrorThresholdPush = async () => {
    const windowMinutes = Math.trunc(line.errorThresholdWindowMinutes);
    const thresholdCount = Math.trunc(line.errorThresholdCount);
    const cooldownMinutes = Math.trunc(line.errorThresholdCooldownMinutes);
    if (windowMinutes < 5 || windowMinutes > 60 || thresholdCount < 1 || thresholdCount > 5000 || cooldownMinutes < 5 || cooldownMinutes > 1440) {
      setNotice({ kind: 'error', text: '請先輸入有效設定：統計視窗 5–60 分鐘、門檻 1–5000 筆、冷卻 5–1440 分鐘。' });
      return;
    }
    setBusy('error-threshold-test');
    setNotice({ kind: 'info', text: '正在測試錯誤爆量告警與 LINE 投遞…' });
    try {
      const result = await invokeAdminApi<Record<string, unknown>>('admin_test_error_threshold_notification', {
        window_minutes: windowMinutes,
        threshold_count: thresholdCount,
        cooldown_minutes: cooldownMinutes,
      });
      const payload = recordOf(recordOf(result).data);
      const ok = booleanOf(payload.ok, false) && booleanOf(recordOf(result).ok, false);
      if (!ok) throw new Error(stringOf(payload.message ?? payload.msg ?? recordOf(result).message, '測試未成功'));
      setNotice({ kind: 'success', text: '測試訊息已送出，未影響正式告警冷卻；請至 LINE 群組確認。' });
    } catch (error) {
      setNotice({ kind: 'error', text: `錯誤爆量測試失敗：${messageOf(error)}` });
    } finally {
      setBusy(null);
    }
  };

  const openDepartmentEditor = (department?: Department, parentId = '') => {
    if (department) {
      setDepartmentEditor({
        dept_id: department.dept_id,
        parent_id: department.parent_id ?? '',
        name: department.name,
        code: department.code ?? '',
        sort_order: department.sort_order,
        status: department.status,
      });
      return;
    }
    const siblings = departments.filter(item => (item.parent_id ?? '') === parentId);
    const nextOrder = siblings.length
      ? Math.max(...siblings.map(item => item.sort_order)) + 10
      : 10;
    setDepartmentEditor({
      parent_id: parentId,
      name: '',
      code: '',
      sort_order: nextOrder,
      status: 'active',
    });
  };

  const saveDepartment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!departmentEditor) return;
    const name = departmentEditor.name.trim();
    const parent = departments.find(item => item.dept_id === departmentEditor.parent_id);
    const hasChildren = departmentEditor.dept_id
      ? departments.some(item => item.parent_id === departmentEditor.dept_id)
      : false;
    if (!name) {
      setNotice({ kind: 'error', text: '部門名稱為必填。' });
      return;
    }
    if (parent?.parent_id) {
      setNotice({ kind: 'error', text: '組織架構最多兩層，課／組／隊不可再新增下層單位。' });
      return;
    }
    if (hasChildren && departmentEditor.parent_id) {
      setNotice({ kind: 'error', text: '已有課／組／隊的部／室不可改掛至其他部／室。' });
      return;
    }
    setBusy('department-save');
    if (
      departmentEditor.status === 'inactive' &&
      departmentEditor.dept_id &&
      departments.some(item => item.parent_id === departmentEditor.dept_id && item.status === 'active')
    ) {
      setNotice({ kind: 'error', text: '此部／室仍有啟用中的課／組／隊，請先停用課／組／隊。' });
      return;
    }
    try {
      await invokeAdminApi('admin_save_department', {
        dept_id: departmentEditor.dept_id,
        parent_id: departmentEditor.parent_id || null,
        name,
        code: departmentEditor.code.trim(),
        sort_order: Number(departmentEditor.sort_order) || 0,
        status: departmentEditor.status,
      });
      await loadDepartments();
      setDepartmentEditor(null);
      setNotice({
        kind: 'success',
        text: departmentEditor.dept_id ? '部門資料已更新。' : '部門已新增。',
      });
    } catch (error) {
      setNotice({ kind: 'error', text: `部門儲存失敗：${messageOf(error)}` });
    } finally {
      setBusy(null);
    }
  };

  const toggleDepartment = async (department: Department) => {
    const nextStatus: Department['status'] = department.status === 'active' ? 'inactive' : 'active';
    if (
      nextStatus === 'inactive' &&
      departments.some(item => item.parent_id === department.dept_id && item.status === 'active')
    ) {
      setNotice({ kind: 'error', text: '此部／室仍有啟用中的課／組／隊，請先停用課／組／隊。' });
      return;
    }
    if (!window.confirm(`確定${nextStatus === 'inactive' ? '停用' : '啟用'}「${department.name}」？`)) {
      return;
    }
    setBusy(`department-${department.dept_id}`);
    try {
      await invokeAdminApi('admin_toggle_department', {
        dept_id: department.dept_id,
        status: nextStatus,
      });
      await loadDepartments();
      setNotice({ kind: 'success', text: `部門已${nextStatus === 'inactive' ? '停用' : '啟用'}。` });
    } catch (error) {
      setNotice({ kind: 'error', text: `部門狀態更新失敗：${messageOf(error)}` });
    } finally {
      setBusy(null);
    }
  };

  const departmentRow = (department: Department, child = false) => (
    <div
      className={`${styles.departmentRow} ${child ? styles.departmentChild : ''} ${department.status === 'inactive' ? styles.inactive : ''}`}
      key={department.dept_id}
    >
      <div className={styles.departmentIdentity}>
        <span className={styles.treeMark} aria-hidden="true">{child ? '└' : '◆'}</span>
        <div>
          <strong>{department.name}</strong>
          <small>{department.code || '未設定代碼'} · 排序 {department.sort_order}</small>
        </div>
      </div>
      <span className={department.status === 'active' ? styles.statusActive : styles.statusInactive}>
        {department.status === 'active' ? '啟用' : '停用'}
      </span>
      <div className={styles.rowActions}>
        {!child && department.status === 'active' ? (
          <button type="button" onClick={() => openDepartmentEditor(undefined, department.dept_id)}>
            新增課／組／隊
          </button>
        ) : null}
        <button type="button" onClick={() => openDepartmentEditor(department)}>編輯</button>
        <button
          type="button"
          className={department.status === 'active' ? styles.warnButton : undefined}
          disabled={busy === `department-${department.dept_id}`}
          onClick={() => void toggleDepartment(department)}
        >
          {department.status === 'active' ? '停用' : '啟用'}
        </button>
      </div>
    </div>
  );

  const goToSection = (nextSection: SectionKey) => {
    setSection(nextSection);
    setNotice(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const renderIdentity = () => (
    <form className={styles.formPanel} onSubmit={saveIdentity}>
      <div className={styles.panelHeading}>
        <div>
          <h3>系統識別</h3>
          <p>這兩個名稱會提供共用品牌列與支援頁面使用。</p>
        </div>
        <span className={styles.codeBadge}>SYS-01</span>
      </div>
      <div className={styles.formGrid}>
        <label>
          <span>組織名稱</span>
          <input
            value={identity.orgName}
            maxLength={120}
            required
            onChange={event => setIdentity(current => ({ ...current, orgName: event.target.value }))}
          />
        </label>
        <label>
          <span>場域名稱</span>
          <input
            value={identity.siteName}
            maxLength={120}
            required
            onChange={event => setIdentity(current => ({ ...current, siteName: event.target.value }))}
          />
        </label>
      </div>
      <div className={styles.formActions}>
        <button className={styles.primaryButton} disabled={busy === 'identity'} type="submit">
          {busy === 'identity' ? '儲存中…' : '儲存系統識別'}
        </button>
      </div>
    </form>
  );

  const renderDepartments = () => (
    <section className={styles.formPanel}>
      <div className={styles.panelHeading}>
        <div>
          <h3>組織架構</h3>
          <p>採部／室與課／組／隊兩層式樹狀管理；歷史資料使用軟停用，不刪除部門。</p>
        </div>
        <div className={styles.headingActions}>
          <span className={styles.codeBadge}>SYS-02</span>
          <button className={styles.primaryButton} type="button" onClick={() => openDepartmentEditor()}>
            ＋ 新增部／室
          </button>
        </div>
      </div>
      <div className={styles.departmentTree}>
        {roots.length ? roots.map(root => (
          <div className={styles.departmentBranch} key={root.dept_id}>
            {departmentRow(root)}
            {departments
              .filter(item => item.parent_id === root.dept_id)
              .map(child => departmentRow(child, true))}
          </div>
        )) : <div className={styles.emptyState}>目前沒有部門資料，請先新增部／室。</div>}
        {orphanDepartments.length ? (
          <div className={styles.orphanGroup}>
            <strong>找不到上層部門的資料</strong>
            {orphanDepartments.map(item => departmentRow(item, true))}
          </div>
        ) : null}
      </div>
    </section>
  );

  const renderShifts = () => (
    <section className={styles.formPanel}>
      <div className={styles.panelHeading}>
        <div>
          <h3>班別管理</h3>
          <p>保留 V1 的班別結構與跨日表示方式，供電子交接簿等流程共用。</p>
        </div>
        <span className={styles.codeBadge}>SYS-03</span>
      </div>
      <div className={styles.shiftList}>
        {shifts.map((shift, index) => (
          <div className={styles.shiftRow} key={shift.id}>
            <label>
              <span>班別名稱</span>
              <input
                value={shift.label}
                maxLength={40}
                placeholder="例：早班"
                onChange={event => setShifts(current => current.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, label: event.target.value } : item,
                ))}
              />
            </label>
            <label>
              <span>班別 ID</span>
              <input
                value={shift.id}
                maxLength={40}
                placeholder="morning"
                readOnly
                aria-readonly="true"
              />
            </label>
            <label>
              <span>開始</span>
              <TimeSelect
                value={shift.start}
                onChange={event => setShifts(current => current.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, start: event.target.value } : item,
                ))}
              />
            </label>
            <label>
              <span>結束</span>
              <TimeSelect
                value={shift.end}
                onChange={event => setShifts(current => current.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, end: event.target.value } : item,
                ))}
              />
            </label>
          </div>
        ))}
      </div>
      <p className={styles.helperText}>早班、中班、夜班及其 ID 為固定流程；可調整顯示名稱與時段。22:00 至 06:00 表示跨日。</p>
      <div className={styles.formActions}>
        <button className={styles.primaryButton} disabled={busy === 'shifts'} type="button" onClick={() => void saveShifts()}>
          {busy === 'shifts' ? '儲存中…' : '儲存班別設定'}
        </button>
      </div>
    </section>
  );

  const renderLine = () => (
    <form className={styles.formPanel} onSubmit={saveLineSettings}>
      <div className={styles.panelHeading}>
        <div>
          <h3>LINE 推播通知</h3>
          <p>Token 僅能覆寫、永不回顯；輸入框留白即保留既有 Token。</p>
        </div>
        <div className={styles.headingActions}>
          <span className={line.tokenConfigured ? styles.secretReady : styles.secretMissing}>
            {line.tokenConfigured ? 'Token 已設定' : 'Token 尚未設定'}
          </span>
          <span className={styles.codeBadge}>SYS-04</span>
        </div>
      </div>
      <div className={styles.formGrid}>
        <label>
          <span>Channel Access Token</span>
          <input
            type="password"
            value={line.tokenDraft}
            autoComplete="new-password"
            spellCheck={false}
            placeholder={line.tokenConfigured ? '留白以保留既有 Token' : '首次設定請輸入 Token'}
            onChange={event => setLine(current => ({ ...current, tokenDraft: event.target.value }))}
          />
          <small>系統不會將已儲存的 Token 傳回瀏覽器，也不提供畫面清除密鑰。</small>
        </label>
        <label>
          <span>LINE Group ID</span>
          <input
            value={line.groupId}
            maxLength={160}
            required
            spellCheck={false}
            placeholder="Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            onChange={event => setLine(current => ({ ...current, groupId: event.target.value }))}
          />
          <small>將 Bot 加入群組並傳送訊息後，可於 Edge Function 日誌確認 groupId。</small>
        </label>
      </div>
      <fieldset className={styles.toggleGroup}>
        <legend>通知事件</legend>
        {([
          ['notifyInspect', '巡檢異常通知', '巡檢結果出現異常時推播'],
          ['notifyRepair', '報修單通知', '建立或更新報修單時推播'],
          ['notifyCase', '異常案件通知', '案件建立及重要狀態變更時推播'],
          ['notifySecurity', '資安告警', '大量讀取或系統探測告警推播'],
        ] as const).map(([key, label, description]) => (
          <label className={styles.toggleRow} key={key}>
            <span>
              <strong>{label}</strong>
              <small>{description}</small>
            </span>
            <input
              type="checkbox"
              checked={line[key]}
              onChange={event => setLine(current => ({ ...current, [key]: event.target.checked }))}
            />
          </label>
        ))}
      </fieldset>
      <fieldset className={styles.thresholdGroup}>
        <legend>錯誤爆量告警</legend>
        <label className={styles.toggleRow}>
          <span>
            <strong>啟用錯誤爆量告警</strong>
            <small>統計瀏覽器錯誤紀錄，達門檻時建立永久資安告警並發送 LINE。</small>
          </span>
          <input
            type="checkbox"
            checked={line.errorThresholdEnabled}
            onChange={event => setLine(current => ({ ...current, errorThresholdEnabled: event.target.checked }))}
          />
        </label>
        <div className={styles.thresholdGrid}>
          <label>
            <span>統計視窗（分鐘）</span>
            <input type="number" min={5} max={60} step={1} value={line.errorThresholdWindowMinutes} onChange={event => setLine(current => ({ ...current, errorThresholdWindowMinutes: Number(event.target.value) }))} />
            <small>計算最近幾分鐘內的錯誤筆數。</small>
          </label>
          <label>
            <span>觸發門檻（筆）</span>
            <input type="number" min={1} max={5000} step={1} value={line.errorThresholdCount} onChange={event => setLine(current => ({ ...current, errorThresholdCount: Number(event.target.value) }))} />
            <small>視窗內達此筆數即建立告警。</small>
          </label>
          <label>
            <span>通知冷卻（分鐘）</span>
            <input type="number" min={5} max={1440} step={1} value={line.errorThresholdCooldownMinutes} onChange={event => setLine(current => ({ ...current, errorThresholdCooldownMinutes: Number(event.target.value) }))} />
            <small>同一波異常再次通知前的等待時間。</small>
          </label>
        </div>
        <p className={styles.helperText}>建議值：15 分鐘內 20 筆，冷卻 60 分鐘。測試只驗證 LINE 投遞，不會計入正式流量或冷卻。</p>
      </fieldset>
      <div className={styles.formActions}>
        <button className={styles.primaryButton} disabled={busy === 'line'} type="submit">
          {busy === 'line' ? '儲存中…' : '儲存 LINE 設定'}
        </button>
        <button
          className={styles.secondaryButton}
          disabled={busy === 'line-test' || busy === 'line'}
          type="button"
          onClick={() => void testLinePush()}
        >
          {busy === 'line-test' ? '傳送中…' : '傳送測試訊息'}
        </button>
        <button
          className={styles.secondaryButton}
          disabled={busy === 'error-threshold-test' || busy === 'line'}
          type="button"
          onClick={() => void testErrorThresholdPush()}
        >
          {busy === 'error-threshold-test' ? '測試中…' : '測試錯誤爆量告警'}
        </button>
      </div>
    </form>
  );

  const renderApiDocs = () => (
    <section className={styles.apiPanel}>
      <div className={styles.panelHeading}>
        <div>
          <h3>整合 API 文件</h3>
          <p>沿用 V1 的 Supabase REST／RPC 整合邊界；所有存取仍受 JWT、RLS 與最小權限控管。</p>
        </div>
        <span className={styles.codeBadge}>SYS-07</span>
      </div>

      <div className={styles.apiGrid}>
        <article>
          <h4>核心連線</h4>
          <dl className={styles.definitionList}>
            <div><dt>REST Base URL</dt><dd><code>https://qztffronusdhgxhjjubt.supabase.co/rest/v1</code></dd></div>
            <div><dt>API Key Header</dt><dd><code>apikey: &lt;Supabase anon key&gt;</code></dd></div>
            <div><dt>使用者授權</dt><dd><code>Authorization: Bearer &lt;user JWT&gt;</code></dd></div>
            <div><dt>資料格式</dt><dd><code>Content-Type: application/json</code></dd></div>
          </dl>
          <p className={styles.securityNote}>瀏覽器只使用公開 anon key；實際資料範圍由登入者 JWT 與 PostgreSQL RLS 決定。</p>
        </article>
        <article>
          <h4>共用主鍵／關聯鍵</h4>
          <ul className={styles.keyList}>
            <li><code>equipment_id</code>（UUID）／<code>asset_code</code>（設備資產碼）</li>
            <li><code>req_no</code>（報修單號）</li>
            <li><code>wo_no</code>（維修工單號）</li>
            <li><code>location_id</code>（位置識別碼）</li>
            <li><code>dept_id</code>（部門識別碼）</li>
          </ul>
          <p className={styles.securityNote}>跨系統關聯應優先使用 UUID；對外單據交換可同時保留可讀單號。</p>
        </article>
      </div>

      <div className={styles.webhookWarning} role="note">
        <strong>Webhook 為預留介面</strong>
        <span>V1 文件中的 Webhook 尚未啟用，現階段不可視為正式上線端點；事件推送需另行定義簽章、重送及稽核規格。</span>
      </div>

      <div className={styles.integrationHeading}>
        <h4>十一項整合範圍</h4>
        <span>REST／RPC 依各系統最小權限開放</span>
      </div>
      <div className={styles.integrationGrid}>
        {integrationItems.map(([id, title, description]) => (
          <article className={styles.integrationCard} key={id}>
            <span>{id}</span>
            <div><strong>{title}</strong><p>{description}</p></div>
          </article>
        ))}
      </div>
    </section>
  );

  const renderDetail = () => {
    if (!section) return null;
    return (
      <>
        <div className={styles.detailNav}>
          <button type="button" onClick={() => { setSection(null); setNotice(null); }}>
            ← 返回系統設定
          </button>
          <button type="button" onClick={() => void loadAll()} disabled={loading}>
            {loading ? '重新載入中…' : '重新載入'}
          </button>
        </div>
        {section === 'identity' ? renderIdentity() : null}
        {section === 'departments' ? renderDepartments() : null}
        {section === 'shifts' ? renderShifts() : null}
        {section === 'line' ? renderLine() : null}
        {section === 'api' ? renderApiDocs() : null}
      </>
    );
  };

  return (
    <AppShell profile={profile} title="系統設定">
      <div className={styles.page}>
        <div className={styles.breadcrumbs}>
          <Link href="/systems/admin/">後台管理</Link>
          <span>/</span>
          <strong>系統設定</strong>
        </div>

        {notice ? (
          <div className={`${styles.notice} ${styles[notice.kind]}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
            {notice.text}
          </div>
        ) : null}

        {section ? renderDetail() : (
          <>
            <section className={styles.hero}>
              <div>
                <span>CONFIG V2</span>
                <h2>系統設定</h2>
                <p>沿用 V1 固定順序與設定流程，集中管理識別、組織、班別、推播及整合入口。</p>
              </div>
              <button type="button" onClick={() => void loadAll()} disabled={loading}>
                {loading ? '設定載入中…' : '重新載入設定'}
              </button>
            </section>

            <section className={styles.cardGrid} aria-label="系統設定功能">
              {cards.map(card => {
                const cardStyle = { '--settings-accent': card.accent } as CSSProperties;
                const content = (
                  <>
                    <span className={styles.cardCode}>{card.id}</span>
                    <span className={styles.cardIcon} aria-hidden="true"><img src={card.icon} alt="" /></span>
                    <h3>{card.title}</h3>
                    <small>{card.english}</small>
                    <p>{card.description}</p>
                    <b>{card.href ? '前往功能 →' : '開啟設定 →'}</b>
                  </>
                );
                return card.href ? (
                  <Link className={styles.card} href={card.href} key={card.id} style={cardStyle}>
                    {content}
                  </Link>
                ) : (
                  <button
                    className={styles.card}
                    key={card.id}
                    style={cardStyle}
                    type="button"
                    onClick={() => card.section && goToSection(card.section)}
                  >
                    {content}
                  </button>
                );
              })}
            </section>
          </>
        )}

        {departmentEditor ? (
          <div className={styles.modalBackdrop} role="presentation" onMouseDown={event => {
            if (event.target === event.currentTarget) setDepartmentEditor(null);
          }}>
            <form className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="department-dialog-title" onSubmit={saveDepartment}>
              <div className={styles.modalHeading}>
                <div>
                  <span>SYS-02</span>
                  <h3 id="department-dialog-title">{departmentEditor.dept_id ? '編輯部門' : '新增部門'}</h3>
                </div>
                <button type="button" aria-label="關閉" onClick={() => setDepartmentEditor(null)}>×</button>
              </div>
              <label>
                <span>部門名稱</span>
                <input
                  autoFocus
                  maxLength={120}
                  required
                  value={departmentEditor.name}
                  onChange={event => setDepartmentEditor(current => current ? ({ ...current, name: event.target.value }) : null)}
                />
              </label>
              <label>
                <span>部門代碼</span>
                <input
                  maxLength={60}
                  value={departmentEditor.code}
                  onChange={event => setDepartmentEditor(current => current ? ({ ...current, code: event.target.value }) : null)}
                />
              </label>
              <label>
                <span>上層部門</span>
                <select
                  value={departmentEditor.parent_id}
                  onChange={event => setDepartmentEditor(current => current ? ({ ...current, parent_id: event.target.value }) : null)}
                >
                  <option value="">部／室</option>
                  {roots
                    .filter(root => (
                      root.dept_id !== departmentEditor.dept_id &&
                      (root.status === 'active' || root.dept_id === departmentEditor.parent_id)
                    ))
                    .map(root => <option value={root.dept_id} key={root.dept_id}>{root.name}</option>)}
                </select>
              </label>
              <label>
                <span>排序</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={departmentEditor.sort_order}
                  onChange={event => setDepartmentEditor(current => current ? ({ ...current, sort_order: Number(event.target.value) }) : null)}
                />
              </label>
              <label>
                <span>狀態</span>
                <select
                  value={departmentEditor.status}
                  onChange={event => setDepartmentEditor(current => current ? ({ ...current, status: event.target.value === 'inactive' ? 'inactive' : 'active' }) : null)}
                >
                  <option value="active">啟用</option>
                  <option value="inactive">停用</option>
                </select>
              </label>
              <div className={styles.modalActions}>
                <button type="button" onClick={() => setDepartmentEditor(null)}>取消</button>
                <button className={styles.primaryButton} disabled={busy === 'department-save'} type="submit">
                  {busy === 'department-save' ? '儲存中…' : '儲存部門'}
                </button>
              </div>
            </form>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}

function SettingsGate({ profile }: { profile: Profile }) {
  if (!isAdministrator(profile)) {
    return (
      <AppShell profile={profile} title="系統設定">
        <div className={styles.denied}>
          <span>403</span>
          <h2>無法存取系統設定</h2>
          <p>此頁僅限 sysadmin 或 admin 角色使用。</p>
          <Link href="/systems/admin/">返回後台管理</Link>
        </div>
      </AppShell>
    );
  }
  return <SettingsWorkspace profile={profile} />;
}

export function SettingsClient() {
  return <AuthGate>{profile => <SettingsGate profile={profile} />}</AuthGate>;
}
