'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { AppShell } from '@/components/AppShell';
import { getSupabase } from '@/lib/supabase';
import { invokeAdminApi } from '@/lib/admin-api';
import { passwordInputProps, passwordPolicyMessage, temporaryPassword } from '@/lib/password-policy';
import { usePasswordPolicy } from '@/lib/use-password-policy';
import { AdminHeader, AdminModal, type AdminAction, type AdminProps, errorMessage, fmtTime, PAGE_SIZE, Pager, roleLabel, type Row, StatusPill, userRole } from './shared';

const ACCOUNT_EXPORT_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const IMPORT_ROLE_ALIASES: Record<string, string> = {
  '一般使用者': 'reporter', '一般報修人員': 'reporter', reporter: 'reporter', inspector: 'reporter',
  '值班人員': 'duty', duty: 'duty',
  '派工管理員': 'dispatcher', dispatcher: 'dispatcher',
  '維修技術人員': 'technician', '維修人員': 'technician', maintenance: 'technician',
  '單位主管': 'unit_supervisor', 主管: 'unit_supervisor', supervisor: 'unit_supervisor',
  '系統管理員': 'sysadmin', 管理者: 'sysadmin', admin: 'sysadmin',
  '管理部主管': 'mgmt_supervisor', '管理部主管（已停用）': 'mgmt_supervisor', mgmt_supervisor: 'mgmt_supervisor',
};

function importText(value: unknown) {
  return String(value ?? '').replace(/\u00a0/g, ' ').trim();
}

function importKey(value: unknown) {
  return importText(value).replace(/[／]/g, '/').replace(/\s+/g, '').toLowerCase();
}

function accountKey(value: unknown) {
  const text = importText(value).toLowerCase();
  return /^\d+$/.test(text) ? text.replace(/^0+(?=\d)/, '') : text;
}

async function downloadWorkbook(workbook: any, filename: string) {
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: ACCOUNT_EXPORT_MIME });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type TemporaryPassword = { name: string; username: string; password: string };
type BatchCreateRow = {
  row_number: number;
  name: string;
  username: string;
  email: string;
  phone: string;
  dept_id: string | null;
  rbac_role: string;
  supervisor_id: string | null;
  password: string;
};
type BatchCreateResult = {
  success: number;
  skipped: number;
  failed: number;
  details: string[];
  created_usernames: string[];
};

export function UsersAdmin({ profile, module }: AdminProps) {
  const passwordPolicy = usePasswordPolicy();
  const [users, setUsers] = useState<Row[]>([]), [roles, setRoles] = useState<Row[]>([]), [departments, setDepartments] = useState<Row[]>([]), [applications, setApplications] = useState<Row[]>([]);
  const [busy, setBusy] = useState(true), [note, setNote] = useState(''), [query, setQuery] = useState(''), [status, setStatus] = useState('active'), [page, setPage] = useState(1);
  const [editor, setEditor] = useState<Row | null>(null), [passwordUser, setPasswordUser] = useState<Row | null>(null), [password, setPassword] = useState(''), [password2, setPassword2] = useState('');
  const [applicationReview, setApplicationReview] = useState<Row | null>(null);
  const [applicationsLoaded, setApplicationsLoaded] = useState(false);
  const [usersLoaded, setUsersLoaded] = useState(false);
  const [editorError, setEditorError] = useState('');
  const [batchBusy, setBatchBusy] = useState(false), [batchMessage, setBatchMessage] = useState(''), [batchDetails, setBatchDetails] = useState<string[]>([]), [temporaryPasswords, setTemporaryPasswords] = useState<TemporaryPassword[]>([]);
  const importFileRef = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    setBusy(true); setNote(''); setApplicationsLoaded(false); setUsersLoaded(false);
    try {
      const client = getSupabase();
      const [u, r, d, a] = await Promise.allSettled([
        client.from('users').select('user_id,auth_id,username,email,name,phone,department,dept_id,role,rbac_role,supervisor_id,status,created_at').order('name').limit(1000),
        client.from('roles').select('role_id,name,sort_order').order('sort_order'),
        client.from('departments').select('dept_id,parent_id,name,code,level,status,sort_order').order('sort_order'),
        invokeAdminApi<{ data?: Row[] }>('admin_list_account_applications'),
      ]);
      const failures: string[] = [];
      if (u.status === 'fulfilled' && !u.value.error) { setUsers(u.value.data || []); setUsersLoaded(true); }
      else failures.push(`人員：${errorMessage(u.status === 'rejected' ? u.reason : u.value.error, '載入失敗')}`);
      if (r.status === 'fulfilled' && !r.value.error) setRoles((r.value.data || []).filter(row => row.role_id !== 'mgmt_supervisor'));
      else failures.push(`角色：${errorMessage(r.status === 'rejected' ? r.reason : r.value.error, '載入失敗')}`);
      if (d.status === 'fulfilled' && !d.value.error) setDepartments(d.value.data || []);
      else failures.push(`單位：${errorMessage(d.status === 'rejected' ? d.reason : d.value.error, '載入失敗')}`);
      if (a.status === 'fulfilled') { setApplications(a.value.data || []); setApplicationsLoaded(true); }
      else { setApplications([]); failures.push(`待審申請：${errorMessage(a.reason, '載入失敗')}`); }
      if (failures.length) setNote(`部分資料載入失敗：${failures.join('；')}`);
    } catch (error) { setNote(`失敗：${errorMessage(error, '人員主檔載入失敗')}`); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const deptName = useCallback((id: unknown) => departments.find(row => row.dept_id === id)?.name || '—', [departments]);
  const supervisorName = useCallback((id: unknown) => users.find(row => row.user_id === id)?.name || '未指定', [users]);
  const activeDepartments = useMemo(() => departments.filter(dept => dept.status === 'active'), [departments]);
  const rootDepartmentId = useCallback((deptId: unknown) => {
    let current = activeDepartments.find(dept => String(dept.dept_id) === String(deptId || ''));
    const seen = new Set<string>();
    while (current?.parent_id && !seen.has(String(current.dept_id))) {
      seen.add(String(current.dept_id));
      current = activeDepartments.find(dept => String(dept.dept_id) === String(current?.parent_id || ''));
    }
    return current?.dept_id || '';
  }, [activeDepartments]);
  const secretaryReportsToDeputy = useCallback((memberDeptId: unknown, supervisorDeptId: unknown) => {
    const memberRootId = String(rootDepartmentId(memberDeptId) || ''), supervisorRootId = String(rootDepartmentId(supervisorDeptId) || '');
    const memberRoot = activeDepartments.find(dept => String(dept.dept_id) === memberRootId);
    const supervisorRoot = activeDepartments.find(dept => String(dept.dept_id) === supervisorRootId);
    const rootName = (dept: Row | undefined) => String(dept?.name || '').replace(/\s+/g, '');
    const rootCode = (dept: Row | undefined) => String(dept?.code || '').toUpperCase();
    return (rootCode(memberRoot) === 'SECRE' || rootName(memberRoot) === '秘書室')
      && (rootCode(supervisorRoot) === 'VGM' || ['副總經理', '副總經理室'].includes(rootName(supervisorRoot)));
  }, [activeDepartments, rootDepartmentId]);
  const supervisorMatchesDepartment = useCallback((supervisorDeptId: unknown, memberDeptId: unknown) => {
    const supervisorId = String(supervisorDeptId || '');
    if (!memberDeptId) return true;
    let current = activeDepartments.find(dept => String(dept.dept_id) === String(memberDeptId));
    const seen = new Set<string>();
    while (current && !seen.has(String(current.dept_id))) {
      if (String(current.dept_id) === supervisorId) return true;
      seen.add(String(current.dept_id));
      current = activeDepartments.find(dept => String(dept.dept_id) === String(current?.parent_id || ''));
    }
    return secretaryReportsToDeputy(memberDeptId, supervisorDeptId);
  }, [activeDepartments, secretaryReportsToDeputy]);
  const rootDepartments = useMemo(() => activeDepartments.filter(dept => !dept.parent_id), [activeDepartments]);
  const supervisors = useMemo(() => users.filter(user => user.status === 'active' && ['unit_supervisor', 'sysadmin'].includes(userRole(user))), [users]);
  const supervisorOptions = useCallback((memberDeptId: unknown, currentSupervisorId = '') => {
    const eligible = supervisors.filter(supervisor => {
      // 尚未選擇部／室時，不列出任意部門主管，避免誤把跨單位人員指定為直屬主管；
      // 系統管理員仍可跨單位協助處理例外帳號。
      if (userRole(supervisor) === 'sysadmin') return true;
      return Boolean(memberDeptId) && supervisorMatchesDepartment(supervisor.dept_id, memberDeptId);
    });
    if (currentSupervisorId && !eligible.some(supervisor => String(supervisor.user_id) === currentSupervisorId)) {
      // 現任主管已經不符規則（換了單位、被降級或停用）時仍要列出來，否則欄位會變空白、
      // 看不出原本掛的是誰；但一定要標記，不然它看起來跟正常選項一樣，
      // 管理員按下儲存才會被資料庫退回。
      // 從完整人員清單找現任主管，而不是只從合格清單找。若主管已被停用、
      // 降級或移到別的單位，仍要保留原值讓管理員看得見並改派，不可讓 select
      // 只剩空白值，造成「明明有主管卻被判定未指定」的誤解。
      const current = users.find(user => String(user.user_id) === currentSupervisorId);
      if (current) {
        const reason = current.status !== 'active'
          ? '帳號已停用'
          : !['unit_supervisor', 'sysadmin'].includes(userRole(current))
            ? '已不具主管角色'
            : '已不符所屬單位';
        return [...eligible, { ...current, __ineligible: true, __ineligibleReason: reason }];
      }
    }
    return eligible;
  }, [supervisors, users, supervisorMatchesDepartment]);
  const affectedDirectReports = useCallback((target: Row | null) => {
    if (!target?.user_id) return [] as Row[];
    const nextRole = String(target.rbac_role || 'reporter');
    return users.filter(user => user.status === 'active' && String(user.supervisor_id || '') === String(target.user_id)).filter(user => {
      if (!['unit_supervisor', 'sysadmin'].includes(nextRole)) return true;
      if (nextRole === 'sysadmin') return false;
      return !supervisorMatchesDepartment(target.dept_id, user.dept_id);
    });
  }, [users, supervisorMatchesDepartment]);
  const replacementSupervisorOptions = useCallback((target: Row | null, reports: Row[]) => supervisors.filter(supervisor => {
    if (!target?.user_id || String(supervisor.user_id) === String(target.user_id)) return false;
    if (userRole(supervisor) === 'sysadmin') return true;
    return reports.every(report => supervisorMatchesDepartment(supervisor.dept_id, report.dept_id));
  }), [supervisors, supervisorMatchesDepartment]);
  const pendingApplications = useMemo(() => applications.filter(application => application.status === 'pending'), [applications]);
  const filtered = useMemo(() => users.filter(user => {
    const q = query.trim().toLowerCase();
    return (!status || user.status === status) && (!q || [user.name, user.username, user.email, user.phone, user.department, deptName(user.dept_id), roleLabel(userRole(user), roles), supervisorName(user.supervisor_id)].some(value => String(value || '').toLowerCase().includes(q)));
  }), [users, roles, query, status, deptName, supervisorName]);
  useEffect(() => setPage(1), [query, status]);
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const userPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  useEffect(() => { if (page > userPages) setPage(userPages); }, [page, userPages]);
  const run = async (payload: AdminAction, success: string) => {
    setBusy(true); setNote('');
    try { const result = await invokeAdminApi<{ message?: string }>(payload.action, payload); setEditor(null); setApplicationReview(null); setPasswordUser(null); setPassword(''); setPassword2(''); await load(); setNote(result.message || success); }
    catch (error) { setNote(`失敗：${errorMessage(error)}`); setBusy(false); }
  };
  const openEditor = (value: Row) => { setEditorError(''); setEditor({ ...value, replacement_supervisor_id: '' }); };
  const closeEditor = () => { setEditor(null); setEditorError(''); };
  const saveUser = async () => {
    if (!editor) return;
    setEditorError('');
    const creating = !editor.user_id;
    if (!String(editor.name || '').trim() || !String(editor.username || '').trim()) { setEditorError('失敗：請填寫姓名與登入帳號'); return; }
    if (creating && !String(editor.email || '').trim()) { setEditorError('失敗：請填寫電子郵件'); return; }
    if (creating) {
      const passwordError = passwordPolicyMessage(String(editor.password || ''), passwordPolicy);
      if (passwordError) { setEditorError(`失敗：${passwordError}`); return; }
    }
    const selectedRole = String(editor.rbac_role || 'reporter');
    if (!['unit_supervisor', 'sysadmin'].includes(selectedRole) && !editor.supervisor_id) { setEditorError('失敗：一般人員必須指定直屬主管'); return; }
    // 與 admin-api validateSupervisor 及資料庫 guard_user_supervisor_hierarchy 同一條規則：
    // 主管必須在人員所屬單位或其上層部／室。先在前端擋，才不會送出去才被退回。
    if (!['unit_supervisor', 'sysadmin'].includes(selectedRole) && editor.supervisor_id) {
      const picked = users.find(supervisor => String(supervisor.user_id) === String(editor.supervisor_id));
      if (!picked || picked.status !== 'active' || !['unit_supervisor', 'sysadmin'].includes(userRole(picked))) {
        setEditorError('失敗：所選主管已不是啟用中的單位主管，請改派其他主管'); return;
      }
      if (userRole(picked) !== 'sysadmin' && !supervisorMatchesDepartment(picked.dept_id, editor.dept_id)) {
        setEditorError(`失敗：${String(picked.name || '所選主管')}屬於${deptName(picked.dept_id)}，不能管理此單位的人員，請改派其他主管`);
        return;
      }
    }
    const reportsToReassign = affectedDirectReports(editor);
    if (reportsToReassign.length > 0 && !editor.replacement_supervisor_id) {
      setEditorError(`失敗：此人原有 ${reportsToReassign.length} 位直屬人員，調整單位或角色前請選擇接任主管`);
      return;
    }
    if (reportsToReassign.length > 0) {
      const replacement = users.find(user => String(user.user_id) === String(editor.replacement_supervisor_id));
      if (!replacement || replacement.status !== 'active' || !['unit_supervisor', 'sysadmin'].includes(userRole(replacement)) || String(replacement.user_id) === String(editor.user_id)) {
        setEditorError('失敗：接任主管必須是另一位啟用中的單位主管或系統管理員');
        return;
      }
      if (userRole(replacement) !== 'sysadmin' && reportsToReassign.some(report => !supervisorMatchesDepartment(replacement.dept_id, report.dept_id))) {
        setEditorError('失敗：接任主管無法管理全部原直屬人員，請改選共同上層主管或系統管理員');
        return;
      }
    }
    setBusy(true); setNote('');
    try {
      const result = await invokeAdminApi<{ message?: string }>(creating ? 'admin_create_user' : 'admin_update_user', {
        action: creating ? 'admin_create_user' : 'admin_update_user', user_id: editor.user_id,
        name: String(editor.name).trim(), username: String(editor.username).trim(), email: String(editor.email || '').trim(),
        phone: String(editor.phone || '').trim(), dept_id: editor.dept_id || null, rbac_role: selectedRole,
        supervisor_id: editor.supervisor_id || null, replacement_supervisor_id: editor.replacement_supervisor_id || null,
        password: editor.password || undefined,
      });
      closeEditor();
      await load();
      setNote(result.message || (creating ? '帳號已建立' : '人員資料已更新'));
    } catch (error) {
      setEditorError(`失敗：${errorMessage(error)}`);
    } finally { setBusy(false); }
  };
  const departmentParts = (deptId: unknown) => {
    const rootId = String(rootDepartmentId(deptId) || '');
    const department = activeDepartments.find(row => String(row.dept_id) === String(deptId || ''));
    const root = activeDepartments.find(row => String(row.dept_id) === rootId);
    return [root?.name || department?.name || '未設定', department && String(department.dept_id) !== rootId ? department.name : ''];
  };
  const exportUsers = async () => {
    if (!users.length) { setBatchMessage('目前沒有可匯出的帳號資料'); setBatchDetails([]); return; }
    setBatchBusy(true); setBatchMessage(''); setBatchDetails([]);
    try {
      const ExcelJS = (await import('exceljs')).default;
      const workbook = new ExcelJS.Workbook();
      workbook.creator = '臺北農產公司'; workbook.company = '臺北農產公司'; workbook.title = '帳號管理清單';
      const sorted = [...users].sort((left, right) => {
        const statusOrder = (left.status === 'active' ? 0 : 1) - (right.status === 'active' ? 0 : 1);
        return statusOrder || String(left.name || '').localeCompare(String(right.name || ''), 'zh-Hant');
      });
      const sheet = workbook.addWorksheet('帳號清單');
      sheet.columns = [
        { header: '序號', key: 'seq', width: 8 }, { header: '姓名', key: 'name', width: 16 }, { header: '登入帳號', key: 'username', width: 18 },
        { header: '電子郵件', key: 'email', width: 30 }, { header: '聯絡電話', key: 'phone', width: 16 }, { header: '部／室', key: 'root', width: 18 },
        { header: '課／組／隊', key: 'child', width: 18 }, { header: '系統角色', key: 'role', width: 18 }, { header: '直屬主管', key: 'supervisor', width: 18 },
        { header: '狀態', key: 'status', width: 10 }, { header: '建立時間', key: 'createdAt', width: 22 },
      ];
      sorted.forEach((user, index) => {
        const [root, child] = departmentParts(user.dept_id);
        sheet.addRow({ seq: index + 1, name: user.name || '', username: user.username || '', email: user.email || '', phone: user.phone || '', root, child,
          role: roleLabel(userRole(user), roles), supervisor: ['unit_supervisor', 'sysadmin'].includes(userRole(user)) ? '—' : supervisorName(user.supervisor_id),
          status: user.status === 'active' ? '啟用' : '停用', createdAt: fmtTime(user.created_at) });
      });
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      sheet.autoFilter = { from: 'A1', to: `K${sorted.length + 1}` };
      const header = sheet.getRow(1);
      header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B6B8A' } };
      header.alignment = { horizontal: 'center', vertical: 'middle' };
      header.height = 24;
      sheet.eachRow((row, rowNumber) => { if (rowNumber > 1 && rowNumber % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F8FA' } }; });
      const summary = workbook.addWorksheet('統計摘要');
      const activeCount = sorted.filter(user => user.status === 'active').length;
      summary.addRows([
        ['臺北農產公司｜帳號統計摘要'], ['產製時間', fmtTime(new Date())], [], ['帳號總數', sorted.length, '啟用帳號', activeCount, '停用帳號', sorted.length - activeCount],
        [], ['角色分布', '人數'],
        ...Object.entries(sorted.reduce<Record<string, number>>((counts, user) => { const label = roleLabel(userRole(user), roles); counts[label] = (counts[label] || 0) + 1; return counts; }, {})).sort((a, b) => b[1] - a[1]).map(([label, count]) => [label, count]),
      ]);
      summary.mergeCells('A1:F1'); summary.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } }; summary.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17365D' } };
      summary.getRow(6).font = { bold: true, color: { argb: 'FFFFFFFF' } }; summary.getRow(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B6B8A' } }; summary.columns = [{ width: 24 }, { width: 14 }, { width: 16 }, { width: 14 }, { width: 16 }, { width: 14 }];
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      await downloadWorkbook(workbook, `帳號管理清單_${date}.xlsx`);
      setBatchMessage(`已匯出 ${sorted.length} 筆帳號資料（不含密碼）`);
    } catch (error) { setBatchMessage(`匯出失敗：${errorMessage(error, '帳號匯出失敗')}`); }
    finally { setBatchBusy(false); }
  };
  const downloadImportTemplate = async () => {
    setBatchBusy(true); setBatchMessage(''); setBatchDetails([]);
    try {
      const ExcelJS = (await import('exceljs')).default;
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('帳號匯入範本');
      const root = rootDepartments[0];
      const child = root ? activeDepartments.find(dept => String(dept.parent_id || '') === String(root.dept_id)) : undefined;
      const supervisor = supervisors[0];
      sheet.addRow(['姓名', '登入帳號', '電子郵件', '聯絡電話', '部／室', '課／組／隊', '系統角色', '直屬主管帳號', '初始密碼']);
      sheet.addRow(['請修改範例', 'example_user', 'example@example.com', '', root?.name || '', child?.name || '', roleLabel('reporter', roles), supervisor?.username || '', '']);
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B6B8A' } }; sheet.getRow(1).alignment = { horizontal: 'center' };
      sheet.addRow([]); sheet.addRow([`說明：姓名、登入帳號、電子郵件為必填；初始密碼留白時由系統產生臨時密碼。密碼規則：${passwordPolicy.hint}。匯出檔不包含密碼。`]);
      sheet.mergeCells('A4:I4'); sheet.getRow(4).font = { color: { argb: 'FF64748B' }, italic: true }; sheet.getRow(4).alignment = { wrapText: true };
      sheet.columns = [{ width: 16 }, { width: 20 }, { width: 30 }, { width: 16 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 20 }, { width: 14 }];
      await downloadWorkbook(workbook, '帳號匯入範本.xlsx');
      setBatchMessage('已下載帳號匯入範本，請先刪除範例列再填寫資料');
    } catch (error) { setBatchMessage(`範本下載失敗：${errorMessage(error, '無法建立匯入範本')}`); }
    finally { setBatchBusy(false); }
  };
  const copyTemporaryPassword = async (entry: TemporaryPassword) => {
    try { await navigator.clipboard.writeText(entry.password); setBatchMessage(`已複製「${entry.username}」的臨時密碼，請安全轉交本人`); }
    catch (error) { setBatchMessage(`複製失敗：${errorMessage(error, '瀏覽器不允許存取剪貼簿')}`); }
  };
  const importUsers = async (file: File) => {
    if (file.size > 5 * 1024 * 1024) { setBatchMessage('匯入失敗：檔案大小不可超過 5 MB'); return; }
    setBatchBusy(true); setBatchMessage('正在讀取匯入檔案…'); setBatchDetails([]); setTemporaryPasswords([]);
    const details: string[] = [];
    try {
      const ExcelJS = (await import('exceljs')).default;
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await file.arrayBuffer());
      const sheet = workbook.worksheets[0];
      if (!sheet) throw new Error('找不到工作表');
      const matrix: string[][] = [];
      sheet.eachRow({ includeEmpty: true }, row => { const values = Array.isArray(row.values) ? row.values.slice(1) : []; matrix.push(values.map(importText)); });
      const headerIndex = matrix.findIndex((row, rowIndex) => {
        const labels = row.map(importKey);
        const emailHeader = labels.includes('電子郵件') || labels.includes('email');
        const inferredEmail = row.some((label, column) => !label && matrix.slice(rowIndex + 1).some(data => /^[^@\s]+@[^@\s]+$/.test(importText(data[column]))));
        return labels.includes('姓名') && (labels.includes('登入帳號') || labels.includes('帳號')) && (emailHeader || inferredEmail);
      });
      if (headerIndex < 0) throw new Error('格式錯誤：找不到姓名、登入帳號與電子郵件欄位');
      const headers = matrix[headerIndex].map(importKey);
      const findHeader = (...names: string[]) => names.map(importKey).map(name => headers.indexOf(name)).find(index => index >= 0) ?? -1;
      const nameIndex = findHeader('姓名'); const usernameIndex = findHeader('登入帳號', '帳號');
      let emailIndex = findHeader('電子郵件', 'Email');
      if (emailIndex < 0) emailIndex = matrix[headerIndex].findIndex((label, column) => !importKey(label) && matrix.slice(headerIndex + 1).some(row => /^[^@\s]+@[^@\s]+$/.test(importText(row[column]))));
      const phoneIndex = findHeader('聯絡電話', '電話'); const rootIndex = findHeader('部／室', '部/室', '第一層部門'); const childIndex = findHeader('課／組／隊', '課/組/隊', '第二層部門');
      const roleIndex = findHeader('系統角色', '角色'); const supervisorIndex = findHeader('直屬主管帳號', '主管帳號', '直屬主管'); const passwordIndex = findHeader('初始密碼', '密碼');
      const roleMap = new Map<string, string>();
      roles.forEach(role => { roleMap.set(importKey(role.role_id), String(role.role_id)); roleMap.set(importKey(role.name), String(role.role_id)); });
      Object.entries(IMPORT_ROLE_ALIASES).forEach(([label, id]) => roleMap.set(importKey(label), id));
      const existingUsernames = new Set(users.map(user => accountKey(user.username)));
      const existingEmails = new Set(users.map(user => String(user.email || '').toLowerCase()));
      let success = 0; let skipped = 0; let failed = 0;
      const pendingRows: BatchCreateRow[] = [];
      const generated: TemporaryPassword[] = [];
      for (let index = headerIndex + 1; index < matrix.length; index += 1) {
        const row = matrix[index]; if (!row.some(Boolean)) continue;
        const rowNumber = index + 1; const value = (column: number) => column >= 0 ? importText(row[column]) : '';
        const name = value(nameIndex); const email = value(emailIndex).toLowerCase();
        const emailAccount = email.split('@')[0] || '';
        const rawUsername = value(usernameIndex);
        // 舊檔案若把帳號欄當成數字，Excel 會吃掉前導 0；Email 通常仍保留完整帳號，優先用它還原。
        const username = /^\d+$/.test(rawUsername) && /^\d+$/.test(emailAccount) && emailAccount.length > rawUsername.length ? emailAccount : rawUsername;
        if (!name || !username || !email) { details.push(`第 ${rowNumber} 列：缺少姓名、登入帳號或電子郵件，已跳過`); failed += 1; continue; }
        if (existingUsernames.has(accountKey(username)) || existingEmails.has(email)) { details.push(`第 ${rowNumber} 列「${username}」：帳號或電子郵件已存在，已跳過`); skipped += 1; continue; }
        const rootRaw = value(rootIndex); const childRaw = value(childIndex); const root = rootDepartments.find(dept => importKey(dept.name) === importKey(rootRaw));
        if (rootRaw && !root) { details.push(`第 ${rowNumber} 列「${username}」：找不到部／室「${rootRaw}」`); failed += 1; continue; }
        if (childRaw && !root) { details.push(`第 ${rowNumber} 列「${username}」：請先填寫部／室再指定課／組／隊`); failed += 1; continue; }
        const child = childRaw ? activeDepartments.find(dept => String(dept.parent_id || '') === String(root?.dept_id || '') && importKey(dept.name) === importKey(childRaw)) : undefined;
        if (childRaw && !child) { details.push(`第 ${rowNumber} 列「${username}」：課／組／隊「${childRaw}」不屬於指定部／室`); failed += 1; continue; }
        const deptId = child?.dept_id || root?.dept_id || null;
        const roleRaw = value(roleIndex); const selectedRole = roleMap.get(importKey(roleRaw || '一般報修人員'));
        if (!selectedRole || !roles.some(role => String(role.role_id) === selectedRole)) { details.push(`第 ${rowNumber} 列「${username}」：系統角色「${roleRaw}」無法辨識或已停用`); failed += 1; continue; }
        const supervisorRaw = value(supervisorIndex);
        const supervisor = supervisorRaw ? supervisors.find(user => accountKey(user.username) === accountKey(supervisorRaw) || importKey(user.name) === importKey(supervisorRaw)) : undefined;
        if (!['unit_supervisor', 'sysadmin'].includes(selectedRole) && (!supervisor || !supervisorMatchesDepartment(supervisor.dept_id, deptId))) { details.push(`第 ${rowNumber} 列「${username}」：請填寫所屬單位可管理的直屬主管帳號`); failed += 1; continue; }
        const passwordCell = value(passwordIndex);
        const generatedPassword = !passwordCell || passwordCell === '000000000';
        const password = generatedPassword ? temporaryPassword(passwordPolicy) : passwordCell; const passwordError = passwordPolicyMessage(password, passwordPolicy);
        if (passwordError) { details.push(`第 ${rowNumber} 列「${username}」：${passwordError}`); failed += 1; continue; }
        pendingRows.push({ row_number: rowNumber, name, username, email, phone: value(phoneIndex), dept_id: deptId,
          rbac_role: selectedRole, supervisor_id: supervisor?.user_id || null, password });
        existingUsernames.add(accountKey(username)); existingEmails.add(email);
        if (generatedPassword) generated.push({ name, username, password });
      }
      if (pendingRows.length > 0) {
        try {
          const response = await invokeAdminApi<BatchCreateResult & { data?: BatchCreateResult }>('admin_create_users_batch', { action: 'admin_create_users_batch', rows: pendingRows });
          // Edge Function 與 Node API 都會回傳 { ok, data, message }；統一取出 data，
          // 避免批次結果在不同部署路徑下被當成 0 筆。
          const result = response?.data && typeof response.data === 'object' ? response.data : response;
          success += Number(result?.success || 0); skipped += Number(result?.skipped || 0); failed += Number(result?.failed || 0);
          if (Array.isArray(result?.details)) details.push(...result.details);
          const created = new Set((result?.created_usernames || []).map(accountKey));
          setTemporaryPasswords(generated.filter(entry => created.has(accountKey(entry.username))));
        } catch (error) {
          const message = errorMessage(error, '批次建立帳號失敗');
          pendingRows.forEach(row => details.push(`第 ${row.row_number} 列「${row.username}」：${message}`));
          failed += pendingRows.length;
          setTemporaryPasswords([]);
        }
      }
      if (success > 0) await load();
      if (pendingRows.length === 0) setTemporaryPasswords([]);
      setBatchMessage(`匯入完成：成功 ${success} 筆、略過 ${skipped} 筆、失敗 ${failed} 筆`);
      setBatchDetails(details.slice(0, 80));
    } catch (error) { setBatchMessage(`匯入失敗：${errorMessage(error, '無法讀取匯入檔案')}`); setBatchDetails([]); }
    finally { setBatchBusy(false); }
  };
  const handleImportFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
    if (file) void importUsers(file);
  };
  return <AppShell profile={profile} title={module.title}>
    <AdminHeader module={module} busy={busy} note={note} onReload={load} action={<><span>{applicationsLoaded ? `待審申請 ${pendingApplications.length} 筆` : busy ? '待審申請載入中…' : '待審申請未載入'}</span><button className="primary-btn compact" onClick={() => openEditor({ rbac_role: 'reporter', status: 'active', department_root_id: '' })}>＋ 新增帳號</button></>}/>
    <section className="panel admin-panel users-batch-panel">
      <div className="users-batch-toolbar"><div><h2>帳號批次管理</h2><p>可下載範本、匯入 XLSX 或匯出目前帳號；匯出檔不包含密碼。</p></div><div className="users-batch-actions">
        <button className="secondary-btn compact" disabled={batchBusy} onClick={() => void downloadImportTemplate()}>下載匯入範本</button>
        <button className="secondary-btn compact" disabled={batchBusy || !users.length} onClick={() => void exportUsers()}>匯出帳號 XLSX</button>
        <button className="primary-btn compact" disabled={batchBusy} onClick={() => importFileRef.current?.click()}>{batchBusy ? '處理中…' : '匯入帳號 XLSX'}</button>
        <input ref={importFileRef} className="users-import-input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={handleImportFile}/>
      </div></div>
      <p className="users-batch-hint">欄位支援姓名、登入帳號、電子郵件、電話、部／室、課／組／隊、系統角色、直屬主管帳號；初始密碼留白會自動產生臨時密碼。</p>
      {batchMessage && <p className={`inline-message users-batch-message ${/失敗/.test(batchMessage) ? 'danger' : ''}`} role="status">{batchMessage}</p>}
      {batchDetails.length > 0 && <ul className="users-batch-details">{batchDetails.map((detail, index) => <li key={`${index}-${detail}`}>{detail}</li>)}</ul>}
      {temporaryPasswords.length > 0 && <div className="users-temp-passwords"><strong>本次匯入產生的臨時密碼</strong><span>密碼不直接顯示，請複製後安全轉交本人；離開頁面後即清除。</span><div>{temporaryPasswords.map(entry => <button className="secondary-btn compact" key={entry.username} onClick={() => void copyTemporaryPassword(entry)}>複製 {entry.name}（{entry.username}）</button>)}</div></div>}
    </section>
    {pendingApplications.length > 0 && <section className="panel admin-panel"><h2>帳號申請待審核</h2>
      <div className="responsive-table"><table><thead><tr><th>申請人</th><th>登入帳號</th><th>所屬單位</th><th>申請說明</th><th>申請時間</th><th>操作</th></tr></thead><tbody>{pendingApplications.map(application => <tr key={application.application_id}>
        <td><strong>{application.name}</strong><small>{application.email}{application.phone ? `｜${application.phone}` : ''}</small></td><td>{application.username}</td>
        <td>{deptName(application.dept_id)}</td><td>{application.reason || '—'}</td><td>{fmtTime(application.created_at)}</td>
        <td><button className="primary-btn compact" onClick={() => setApplicationReview({ ...application, rbac_role: 'reporter', supervisor_id: '', decision_note: '' })}>審核</button></td>
      </tr>)}</tbody></table></div>
    </section>}
    <section className="panel admin-panel"><div className="admin-toolbar"><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜尋姓名、帳號、電子郵件、單位或角色"/><select value={status} onChange={event => setStatus(event.target.value)}><option value="">全部狀態</option><option value="active">啟用</option><option value="inactive">停用</option></select><span>啟用 {users.filter(user => user.status === 'active').length}／停用 {users.filter(user => user.status === 'inactive').length}</span></div>
      <div className="responsive-table"><table><thead><tr><th>姓名</th><th>登入帳號</th><th>單位</th><th>角色</th><th>直屬主管</th><th>狀態</th><th>建立時間</th><th>操作</th></tr></thead><tbody>{rows.map(user => <tr key={user.user_id}><td><strong>{user.name}</strong><small>{user.email || '—'}</small></td><td>{user.username || '—'}</td><td>{deptName(user.dept_id) !== '—' ? deptName(user.dept_id) : user.department || '—'}</td><td>{roleLabel(userRole(user), roles)}</td><td>{['unit_supervisor', 'sysadmin'].includes(userRole(user)) ? '—' : supervisorName(user.supervisor_id)}</td><td><StatusPill value={user.status}/></td><td>{fmtTime(user.created_at)}</td><td><div className="admin-row-actions"><button onClick={() => openEditor({ ...user, rbac_role: userRole(user) })}>編輯</button><button onClick={() => setPasswordUser(user)}>重設密碼</button>{user.user_id !== profile.user_id && <button className={user.status === 'active' ? 'warn' : ''} onClick={() => window.confirm(`確定${user.status === 'active' ? '停用' : '啟用'}「${user.name}」？`) && void run({ action: 'admin_toggle_user', user_id: user.user_id, status: user.status === 'active' ? 'inactive' : 'active' }, user.status === 'active' ? '帳號已停用' : '帳號已啟用')}>{user.status === 'active' ? '停用' : '啟用'}</button>}{user.status === 'inactive' && !String(user.username || '').startsWith('deidentified-') && <button className="danger" onClick={() => window.confirm(`確定將「${user.name}」個資去識別化？此操作無法復原。`) && void run({ action: 'admin_deidentify_user', user_id: user.user_id }, '個資已去識別化')}>去識別化</button>}</div></td></tr>)}</tbody></table></div>
      {!busy && usersLoaded && rows.length === 0 && <p className="empty">查無符合條件的人員</p>}<Pager page={page} total={filtered.length} onPage={setPage}/>
    </section>
    {editor && (() => {
      const selectedRootId = String(editor.department_root_id || rootDepartmentId(editor.dept_id));
      const childDepartments = activeDepartments.filter(dept => String(dept.parent_id || '') === selectedRootId);
      const reportsToReassign = affectedDirectReports(editor);
      const replacementOptions = replacementSupervisorOptions(editor, reportsToReassign);
      return <AdminModal title={editor.user_id ? '編輯人員帳號' : '新增人員帳號'} onClose={closeEditor}>
        <div className="admin-form-grid">
          <label>姓名（必填）<input value={editor.name || ''} onChange={event => setEditor({ ...editor, name: event.target.value })}/></label>
          <label>登入帳號（必填）<input value={editor.username || ''} onChange={event => setEditor({ ...editor, username: event.target.value })}/></label>
          <label>電子郵件（{editor.user_id ? '唯讀' : '必填'}）<input type="email" readOnly={Boolean(editor.user_id)} value={editor.email || ''} onChange={event => setEditor({ ...editor, email: event.target.value })}/></label>
          <label>聯絡電話<input value={editor.phone || ''} onChange={event => setEditor({ ...editor, phone: event.target.value })}/></label>
          <label>部／室<select value={selectedRootId} onChange={event => setEditor({ ...editor, department_root_id: event.target.value, dept_id: event.target.value || null, supervisor_id: '', replacement_supervisor_id: '' })}><option value="">-- 未指定 --</option>{rootDepartments.map(dept => <option value={dept.dept_id} key={dept.dept_id}>{dept.name}</option>)}</select></label>
          <label>課／組／隊<select value={editor.dept_id || ''} disabled={!selectedRootId} onChange={event => setEditor({ ...editor, dept_id: event.target.value || null, supervisor_id: '', replacement_supervisor_id: '' })}><option value={selectedRootId}>整個部／室（未指定課／組）</option>{childDepartments.map(dept => <option value={dept.dept_id} key={dept.dept_id}>{dept.name}</option>)}</select>{selectedRootId && childDepartments.length === 0 && <small>此部／室目前沒有可選的課／組／隊。</small>}</label>
          <label>系統角色<select value={editor.rbac_role || 'reporter'} disabled={editor.user_id === profile.user_id} onChange={event => setEditor({ ...editor, rbac_role: event.target.value, supervisor_id: ['unit_supervisor', 'sysadmin'].includes(event.target.value) ? '' : editor.supervisor_id, replacement_supervisor_id: '' })}>{roles.map(role => <option key={role.role_id} value={role.role_id}>{role.name}</option>)}</select>{editor.user_id === profile.user_id && <small>為避免中斷管理權限，不可變更自己的角色</small>}</label>
          {!['unit_supervisor', 'sysadmin'].includes(String(editor.rbac_role || 'reporter')) && <label className="wide">直屬主管（必填）<select value={editor.supervisor_id || ''} onChange={event => setEditor({ ...editor, supervisor_id: event.target.value })}><option value="">{editor.dept_id ? '-- 請選擇 --' : '-- 請先選擇部／室 --'}</option>{supervisorOptions(editor.dept_id, String(editor.supervisor_id || '')).map(supervisor => <option key={supervisor.user_id} value={supervisor.user_id}>{supervisor.name}｜{deptName(supervisor.dept_id)}{supervisor.__ineligible ? `（${supervisor.__ineligibleReason || '不符合主管條件'}，請改派）` : ''}</option>)}</select>{!editor.dept_id && <small>請先選擇部／室，才會顯示該單位可管理的主管。</small>}</label>}
          {reportsToReassign.length > 0 && <label className="wide">原直屬人員改派主管（必填）<select value={editor.replacement_supervisor_id || ''} onChange={event => setEditor({ ...editor, replacement_supervisor_id: event.target.value })}><option value="">-- 請選擇接任主管 --</option>{replacementOptions.map(supervisor => <option key={supervisor.user_id} value={supervisor.user_id}>{supervisor.name}｜{deptName(supervisor.dept_id)}</option>)}</select><small>因單位或角色調整，原直屬人員 {reportsToReassign.map(report => report.name).join('、')} 將一併改派，所有變更會同時完成。</small></label>}
          {!editor.user_id && <label className="wide">初始密碼（{passwordPolicy.hint}）<input type="password" {...passwordInputProps(passwordPolicy)} value={editor.password || ''} onChange={event => setEditor({ ...editor, password: event.target.value })}/></label>}
        </div>
        {editorError && <p className="inline-message danger users-editor-error" role="alert" aria-live="assertive">{editorError}</p>}
        <footer><button className="secondary-btn" onClick={closeEditor}>取消</button><button className="primary-btn compact" disabled={busy} onClick={() => void saveUser()}>{busy ? '儲存中…' : '儲存'}</button></footer>
      </AdminModal>;
    })()}
    {applicationReview && <AdminModal title={`審核帳號申請｜${applicationReview.name}`} onClose={() => setApplicationReview(null)}><dl className="detail-grid"><div><dt>登入帳號</dt><dd>{applicationReview.username}</dd></div><div><dt>電子郵件</dt><dd>{applicationReview.email}</dd></div><div><dt>所屬單位</dt><dd>{deptName(applicationReview.dept_id)}</dd></div><div><dt>聯絡電話</dt><dd>{applicationReview.phone || '—'}</dd></div><div><dt>申請說明</dt><dd>{applicationReview.reason || '—'}</dd></div></dl><div className="admin-form-grid"><label>系統角色（管理員核定）<select value={applicationReview.rbac_role} onChange={event => setApplicationReview({ ...applicationReview, rbac_role: event.target.value, supervisor_id: ['unit_supervisor', 'sysadmin'].includes(event.target.value) ? '' : applicationReview.supervisor_id })}>{roles.map(role => <option key={role.role_id} value={role.role_id}>{role.name}</option>)}</select></label>{!['unit_supervisor', 'sysadmin'].includes(String(applicationReview.rbac_role)) && <label>直屬主管（必填）<select value={applicationReview.supervisor_id || ''} onChange={event => setApplicationReview({ ...applicationReview, supervisor_id: event.target.value })}><option value="">{applicationReview.dept_id ? '-- 請選擇 --' : '-- 請先確認所屬單位 --'}</option>{supervisorOptions(applicationReview.dept_id, String(applicationReview.supervisor_id || '')).map(supervisor => <option key={supervisor.user_id} value={supervisor.user_id}>{supervisor.name}｜{deptName(supervisor.dept_id)}</option>)}</select>{!applicationReview.dept_id && <small>此申請尚未指定所屬單位，請先補齊單位後再核准。</small>}</label>}<label className="wide">審核備註（退回時必填）<textarea rows={3} value={applicationReview.decision_note || ''} onChange={event => setApplicationReview({ ...applicationReview, decision_note: event.target.value })}/></label></div><footer><button className="secondary-btn" onClick={() => setApplicationReview(null)}>取消</button><button className="secondary-btn danger" disabled={busy} onClick={() => void run({ action: 'admin_reject_account_application', application_id: applicationReview.application_id, decision_note: applicationReview.decision_note || '' }, '帳號申請已退回')}>退回</button><button className="primary-btn compact" disabled={busy || (!['unit_supervisor', 'sysadmin'].includes(String(applicationReview.rbac_role)) && !applicationReview.supervisor_id)} onClick={() => void run({ action: 'admin_approve_account_application', application_id: applicationReview.application_id, rbac_role: applicationReview.rbac_role, supervisor_id: applicationReview.supervisor_id || null, decision_note: applicationReview.decision_note || '' }, '帳號已核准')}>核准並寄啟用連結</button></footer></AdminModal>}
    {passwordUser && <AdminModal title={`重設密碼｜${passwordUser.name}`} onClose={() => { setPasswordUser(null); setPassword(''); setPassword2(''); }}><div className="admin-form-grid"><label className="wide">新密碼（{passwordPolicy.hint}）<input type="password" {...passwordInputProps(passwordPolicy)} value={password} onChange={event => setPassword(event.target.value)}/></label><label className="wide">再次輸入新密碼<input type="password" {...passwordInputProps(passwordPolicy)} value={password2} onChange={event => setPassword2(event.target.value)}/></label></div><footer><button className="secondary-btn" onClick={() => { setPasswordUser(null); setPassword(''); setPassword2(''); }}>取消</button><button className="primary-btn compact" disabled={busy} onClick={() => { const passwordError = passwordPolicyMessage(password, passwordPolicy); if (passwordError) { setNote(`失敗：${passwordError}`); return; } if (password !== password2) { setNote('失敗：兩次密碼不一致'); return; } void run({ action: 'admin_reset_password', user_id: passwordUser.user_id, password }, '密碼已重設'); }}>確認重設</button></footer></AdminModal>}
  </AppShell>;
}
