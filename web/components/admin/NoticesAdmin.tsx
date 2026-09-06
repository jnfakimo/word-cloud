'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { getSupabase } from '@/lib/supabase';
import { invokeAdminApi } from '@/lib/admin-api';
import { BoardNoticesAdmin } from './BoardNoticesAdmin';
import { AdminHeader, type AdminProps, errorMessage, fmtTime, PAGE_SIZE, Pager, type Row } from './shared';

const NOTICE_EVENT_LABELS: Record<string, string> = {
  new_repair: '新報修', dispatch: '已派工', return: '退件', overdue: '逾期提醒',
  complete: '完工', close: '結案', sign: '簽核', assignment: '任務指派',
  reminder: '系統提醒', security_alert: '資安告警', vehicle_dispatch_followup: '派車回報提醒',
  board_notice: '看板公告', board_notice_inactive: '已停用看板公告',
};

export function NoticesAdmin({ profile, module }: AdminProps) {
  const [notices, setNotices] = useState<Row[]>([]), [busy, setBusy] = useState(true), [note, setNote] = useState(''), [tab, setTab] = useState<'all' | 'unread' | 'read'>('all'), [query, setQuery] = useState(''), [page, setPage] = useState(1);
  const load = useCallback(async (options: { preserveNote?: boolean } = {}) => {
    setBusy(true); if (!options.preserveNote) setNote('');
    try {
      const { data, error } = await getSupabase().from('notifications').select('*').eq('recipient_id', profile.user_id).order('created_at', { ascending: false }).limit(1000);
      if (error) setNote(`失敗：${errorMessage(error, '通知載入失敗')}`);
      setNotices(data || []);
    } catch (error) { setNote(`失敗：${errorMessage(error, '通知載入失敗')}`); }
    finally { setBusy(false); }
  }, [profile.user_id]);
  useEffect(() => {
    void load();
    const client = getSupabase();
    const channel = client.channel(`v2-notices-${profile.user_id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${profile.user_id}` }, () => { void load({ preserveNote: true }); })
      .subscribe();
    return () => { void client.removeChannel(channel); };
  }, [load, profile.user_id]);
  const rows = useMemo(() => notices.filter(row => {
    const q = query.trim().toLowerCase(); const read = Boolean(row.is_read);
    return (tab === 'all' || (tab === 'read' ? read : !read)) && (!q || [row.title, row.body, row.event].some(value => String(value || '').toLowerCase().includes(q)));
  }), [notices, query, tab]);
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [query, tab]);
  const noticePages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  useEffect(() => { if (page > noticePages) setPage(noticePages); }, [page, noticePages]);
  const mark = async (notifId?: string) => {
    setBusy(true); setNote('');
    try {
      await invokeAdminApi('admin_mark_notice', notifId ? { notif_id: notifId } : {});
      await load({ preserveNote: true });
      setNote(notifId ? '通知已標記為已讀' : '全部通知已標記為已讀');
    } catch (error) { setNote(`失敗：${errorMessage(error)}`); setBusy(false); }
  };
  const unread = notices.filter(row => !row.is_read).length;
  return <AppShell profile={profile} title={module.title}>
    <AdminHeader module={module} busy={busy} note={note} onReload={() => { void load(); }} action={<button className="primary-btn compact" disabled={busy || unread === 0} onClick={() => window.confirm(`確定將 ${unread} 筆未讀通知全部標記為已讀？`) && void mark()}>全部標記已讀</button>}/>
    <section className="panel admin-panel"><div className="admin-tabs"><button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>全部 {notices.length}</button><button className={tab === 'unread' ? 'active' : ''} onClick={() => setTab('unread')}>未讀 {unread}</button><button className={tab === 'read' ? 'active' : ''} onClick={() => setTab('read')}>已讀 {notices.length - unread}</button></div><div className="admin-toolbar"><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜尋通知標題、內容或事件"/></div>
      <div className="admin-notice-list">{pageRows.map(row => <article className={row.is_read ? 'read' : 'unread'} key={row.notif_id}><div><span className="notice-event">{NOTICE_EVENT_LABELS[String(row.event || '')] || '系統通知'}</span><h3>{row.title || '系統通知'}</h3><p>{row.body || '—'}</p><time>{fmtTime(row.created_at)}</time></div>{!row.is_read && <button className="secondary-btn" disabled={busy} onClick={() => void mark(row.notif_id)}>標記已讀</button>}</article>)}{!busy && rows.length === 0 && <p className="empty">目前沒有符合條件的通知</p>}</div>
      {rows.length > 0 && <Pager page={page} total={rows.length} onPage={setPage} />}
    </section>
    {(profile.role === 'admin' || profile.rbac_role === 'sysadmin') && <BoardNoticesAdmin />}
  </AppShell>;
}
