import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.112.2';

export const BOARD_NOTICE_ACTIONS = new Set(['admin_list_board_notices', 'admin_save_board_notice', 'admin_toggle_board_notice']);
const events = ['board_notice', 'board_notice_inactive'];
const columns = 'notif_id,event,title,body,created_at';
type Audit = (table: string, id: unknown, action: 'insert' | 'update' | 'status_change', changes: unknown) => Promise<void>;

// Called only after the parent handler has authenticated an active system administrator.
// Inactive announcements retain their content/history; personal notifications are never writable here.
export async function handleBoardNotices(db: Pick<SupabaseClient, 'from'>, action: string, body: Record<string, unknown>, audit: Audit) {
  const fail = (status: number, message: string) => ({ status, body: { ok: false, message } });
  if (action === 'admin_list_board_notices') {
    const { data, error } = await db.from('notifications').select(columns).in('event', events).is('recipient_id', null).order('created_at', { ascending: false }).limit(200);
    return error ? fail(503, '看板公告載入失敗，請稍後重試') : { status: 200, body: { ok: true, data } };
  }
  const rawId = body.notif_id;
  const noticeId = typeof rawId === 'string' ? rawId : '';
  if ((rawId !== undefined || action === 'admin_toggle_board_notice') && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(noticeId)) return fail(400, '公告識別碼無效');
  let before: Record<string, unknown> | null = null;
  if (noticeId) {
    const result = await db.from('notifications').select(columns).eq('notif_id', noticeId).in('event', events).is('recipient_id', null).maybeSingle();
    if (result.error) return fail(503, '無法讀取原公告，請稍後重試');
    before = result.data;
    if (!before) return fail(404, '找不到指定看板公告');
  }
  let values: Record<string, unknown>;
  if (action === 'admin_save_board_notice') {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const content = typeof body.body === 'string' ? body.body.trim() : '';
    if (!title || title.length > 120 || !content || content.length > 200 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(title + content)) return fail(400, '請填寫標題（最多 120 字）與內容（最多 200 字）');
    if ((!before || before.event === 'board_notice') && body.publish_confirmed !== true) return fail(400, '請先確認公告將公開顯示');
    values = { title, body: content, ...(!before ? { event: 'board_notice', recipient_id: null } : {}) };
  } else if (action === 'admin_toggle_board_notice') {
    if (!['active', 'inactive'].includes(String(body.status))) return fail(400, '公告狀態無效');
    if (body.status === 'active' && body.publish_confirmed !== true) return fail(400, '請先確認公告將公開顯示');
    values = { event: body.status === 'active' ? 'board_notice' : 'board_notice_inactive' };
  } else return fail(400, '不支援的公告操作');
  const query = before
    ? db.from('notifications').update(values).eq('notif_id', noticeId).eq('event', before.event).is('recipient_id', null)
    : db.from('notifications').insert(values);
  const { data, error } = await query.select(columns).maybeSingle();
  if (error) return fail(503, '公告儲存結果無法確認，請重新載入清單確認後再操作');
  if (!data) return fail(409, '公告已由其他管理員變更，請重新載入');
  await audit('notifications', data.notif_id, !before ? 'insert' : action === 'admin_toggle_board_notice' ? 'status_change' : 'update', { event_type: action, before, after: data });
  return { status: 200, body: { ok: true, data } };
}
