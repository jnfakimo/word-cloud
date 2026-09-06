import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-cron-secret',
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
});
const safeEqual = (a: string, b: string) => {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
};
const text = (value: unknown, max = 500) => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const SECRETARY_UNIT_CODES = new Set(['SECRE']);
const SECRETARY_UNIT_NAMES = new Set(['秘書室']);
const DEPUTY_GM_UNIT_CODES = new Set(['VGM']);
const DEPUTY_GM_UNIT_NAMES = new Set(['副總經理', '副總經理室']);

async function authorized(req: Request, db: any) {
  const secret = Deno.env.get('CRON_SECRET') || '';
  if (secret && safeEqual(req.headers.get('x-cron-secret') || '', secret)) return true;
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  const { data: auth } = await db.auth.getUser(token);
  if (!auth.user) return false;
  const { data: rawUser } = await db.from('users').select('role,rbac_role,status').eq('auth_id', auth.user.id).maybeSingle();
  const user = rawUser as { role?: string | null; rbac_role?: string | null; status?: string | null } | null;
  return user?.status === 'active' && (user.role === 'admin' || ['admin', 'sysadmin'].includes(String(user.rbac_role || '')));
}

type UserRow = { user_id: string; name: string; dept_id: string | null; supervisor_id: string | null; role: string | null; rbac_role: string | null; };
type DeptRow = { dept_id: string; parent_id: string | null; name: string; code: string | null; };

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply({ ok: false, message: 'Method not allowed' }, 405);
  try {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    if (!await authorized(req, db)) return reply({ ok: false, message: 'Unauthorized' }, 401);
    const body = await req.json().catch(() => ({}));
    const settingsResult = await db.from('system_settings').select('key,value').in('key', ['official_doc_receive_due_minutes', 'official_doc_approval_due_minutes']);
    const settings = new Map((settingsResult.data || []).map(row => [String(row.key), Number(row.value)]));
    const receiveMinutes = Number.isFinite(settings.get('official_doc_receive_due_minutes')) && (settings.get('official_doc_receive_due_minutes') || 0) > 0 ? settings.get('official_doc_receive_due_minutes')! : 60;
    const approvalMinutes = Number.isFinite(settings.get('official_doc_approval_due_minutes')) && (settings.get('official_doc_approval_due_minutes') || 0) > 0 ? settings.get('official_doc_approval_due_minutes')! : 480;
    const [documentsResult, departmentsResult, usersResult] = await Promise.all([
      db.from('official_documents').select('document_id,document_no,subject,status,originator_id,originator_dept_id,current_step_id'),
      db.from('departments').select('dept_id,parent_id,name,code').eq('status', 'active'),
      db.from('users').select('user_id,name,dept_id,supervisor_id,role,rbac_role').eq('status', 'active'),
    ]);
    if (documentsResult.error) throw documentsResult.error;
    if (departmentsResult.error) throw departmentsResult.error;
    if (usersResult.error) throw usersResult.error;
    const departments = (departmentsResult.data || []) as DeptRow[];
    const users = (usersResult.data || []) as UserRow[];
    const departmentRoot = (deptId: string | null) => {
      let currentId = deptId || '';
      const seen = new Set<string>();
      let row: DeptRow | null = null;
      while (currentId && !seen.has(currentId)) {
        seen.add(currentId);
        row = departments.find(department => department.dept_id === currentId) || null;
        if (!row?.parent_id) return row;
        currentId = row.parent_id;
      }
      return row;
    };
    const rootMatches = (deptId: string | null, codes: Set<string>, names: Set<string>) => {
      const root = departmentRoot(deptId);
      const code = text(root?.code, 40).toUpperCase();
      const name = text(root?.name, 100).replace(/\s+/g, '');
      return Boolean((code && codes.has(code)) || (name && names.has(name)));
    };
    const isSecretaryUnit = (deptId: string | null) => rootMatches(deptId, SECRETARY_UNIT_CODES, SECRETARY_UNIT_NAMES);
    const isDeputyGmUnit = (deptId: string | null) => rootMatches(deptId, DEPUTY_GM_UNIT_CODES, DEPUTY_GM_UNIT_NAMES);
    const departmentScope = (rootId: string | null) => {
      const result = new Set<string>();
      const root = rootId || '';
      if (!root) return result;
      result.add(root);
      let changed = true;
      while (changed) {
        changed = false;
        departments.forEach(department => {
          if (department.parent_id && result.has(department.parent_id) && !result.has(department.dept_id)) {
            result.add(department.dept_id);
            changed = true;
          }
        });
      }
      return result;
    };
    const supervisors = new Set(['sysadmin', 'admin', 'unit_supervisor', 'mgmt_supervisor', 'supervisor']);
    const normalizedRole = (user: UserRow) => String(user.rbac_role || ({ admin: 'sysadmin', supervisor: 'unit_supervisor' } as Record<string, string>)[String(user.role || '')] || user.role || '');
    const results: Array<Record<string, unknown>> = [];
    for (const document of (documentsResult.data || []) as Array<Record<string, unknown>>) {
      if (!['awaiting_co_sign', 'awaiting_approval'].includes(String(document.status))) continue;
      const stepResult = await db.from('official_document_steps').select('step_id,unit_id,unit_name,status,sent_at,step_type').eq('step_id', document.current_step_id).maybeSingle();
      if (stepResult.error) throw stepResult.error;
      const step = stepResult.data as Record<string, unknown> | null;
      if (!step || step.status !== 'sent' || !step.sent_at) continue;
      const sentAt = Date.parse(String(step.sent_at));
      if (!Number.isFinite(sentAt)) continue;
      const dueMinutes = step.step_type === 'approval' ? approvalMinutes : receiveMinutes;
      const dueAt = new Date(sentAt + dueMinutes * 60000);
      if (Date.now() < dueAt.getTime()) continue;
      const recipients = new Set<string>();
      if (document.originator_id) recipients.add(String(document.originator_id));
      // 流程節點記錄第一階部／室；逾時通知要涵蓋其下的課／組／隊主管。
      const scope = departmentScope(text(step.unit_id, 80));
      users.forEach(user => {
        const role = normalizedRole(user);
        if (supervisors.has(role) && user.dept_id && scope.has(String(user.dept_id))) recipients.add(String(user.user_id));
      });
      if (step.step_type === 'approval' && isDeputyGmUnit(text(step.unit_id, 80))) {
        const targetSupervisorIds = new Set(users
          .filter(user => user.dept_id && scope.has(String(user.dept_id)) && ['unit_supervisor', 'sysadmin'].includes(normalizedRole(user)))
          .map(user => String(user.user_id)));
        users.forEach(user => {
          if (user.dept_id && isSecretaryUnit(user.dept_id) && user.supervisor_id && targetSupervisorIds.has(String(user.supervisor_id))) {
            recipients.add(String(user.user_id));
          }
        });
      }
      const title = step.step_type === 'approval' ? '公文陳核逾期未核決' : '公文逾期未收文';
      const bodyText = `${text(document.document_no, 100)}｜${text(document.subject, 300)}｜目前部／室：${text(step.unit_name, 100)}｜應於 ${dueAt.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })} 前處理`;
      let recorded = 0;
      for (const recipientId of recipients) {
        const existing = await db.from('official_document_notifications').select('notification_id').eq('document_id', document.document_id).eq('step_id', step.step_id).eq('recipient_id', recipientId).eq('notification_type', 'overdue').maybeSingle();
        if (existing.error) throw existing.error;
        if (existing.data) continue;
        if (body.dryRun) { recorded += 1; continue; }
        const inserted = await db.from('official_document_notifications').insert({
          document_id: document.document_id, step_id: step.step_id, recipient_id: recipientId,
          notification_type: 'overdue', status: 'recorded', title, body: bodyText, due_at: dueAt.toISOString(),
        });
        if (inserted.error) throw inserted.error;
        await db.from('notifications').insert({ recipient_id: recipientId, event: 'official_document_overdue', title, body: bodyText, document_id: document.document_id });
        recorded += 1;
      }
      results.push({ document_id: document.document_id, step_id: step.step_id, recipients: recipients.size, recorded, due_at: dueAt.toISOString(), dry_run: Boolean(body.dryRun) });
    }
    return reply({ ok: true, checked: (documentsResult.data || []).length, receive_minutes: receiveMinutes, approval_minutes: approvalMinutes, results });
  } catch {
    const requestId = crypto.randomUUID();
    console.error('official-document-timeout-check failed', { requestId });
    return reply({ ok: false, message: '公文逾時檢查暫時無法完成，請稍後再試。', request_id: requestId }, 500);
  }
});
