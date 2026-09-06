'use client';

import { useCallback, useEffect, useState } from 'react';
import { invokeAdminApi } from '@/lib/admin-api';
import { AdminModal, errorMessage, fmtTime, type Row } from './shared';

export function BoardNoticesAdmin() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [note, setNote] = useState(''), [loaded, setLoaded] = useState(false);
  const [editor, setEditor] = useState<Row | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invokeAdminApi<{ data: Row[] }>('admin_list_board_notices');
      setRows(result.data || []); setLoaded(true); return true;
    } catch (error) { setNote(`失敗：${errorMessage(error, '公告載入失敗')}`); return false; }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const save = async () => {
    if (!editor || saving) return;
    const title = String(editor.title || '').trim(), body = String(editor.body || '').trim();
    if (!title || !body) { setNote('請填寫公告標題與內容'); return; }
    const active = editor.event !== 'board_notice_inactive';
    if (active && !window.confirm(`以下公告將顯示於免登入公開看板，任何人都能閱讀。\n\n${title}\n${body}\n\n確定發布？`)) return;
    setSaving(true); setNote('');
    try {
      await invokeAdminApi('admin_save_board_notice', { ...(editor.notif_id ? { notif_id: editor.notif_id } : {}), title, body, publish_confirmed: active });
      setEditor(null);
      if (await load()) setNote(active ? '公告已發布，看板下次更新時顯示' : '已儲存停用公告');
    } catch (error) { setNote(`失敗：${errorMessage(error)}`); }
    finally { setSaving(false); }
  };
  const toggle = async (row: Row) => {
    const active = row.event !== 'board_notice';
    if (!window.confirm(active ? `「${row.title}」將重新顯示於免登入公開看板，確定啟用？` : `確定停用「${row.title}」？看板下次更新後會停止顯示。`)) return;
    setSaving(true); setNote('');
    try {
      await invokeAdminApi('admin_toggle_board_notice', { notif_id: row.notif_id, status: active ? 'active' : 'inactive', publish_confirmed: active });
      if (await load()) setNote(active ? '公告已啟用' : '公告已停用，歷史內容已保留');
    } catch (error) { setNote(`失敗：${errorMessage(error)}`); }
    finally { setSaving(false); }
  };
  const busy = loading || saving;
  return <section className="panel admin-panel board-notices-panel" aria-label="公開看板公告管理">
    <div className="admin-toolbar"><h2>公開看板公告</h2><button className="primary-btn compact" disabled={busy || !loaded} onClick={() => { setNote(''); setEditor({ title: '', body: '', event: 'board_notice' }); }}>新增公告</button><button className="secondary-btn compact" disabled={busy} onClick={() => { setNote(''); void load(); }}>重新載入公告</button></div>
    <p className="hint">啟用的公告會顯示於免登入的市場公開看板，請勿填寫個人或內部機密資訊。此處顯示最近 200 筆公告；看板播放最新 15 筆不同內容。</p>
    {note && <p role="status" className={note.startsWith('失敗') ? 'error' : 'hint'}>{note}</p>}
    <div className="admin-notice-list">{rows.map(row => <article key={row.notif_id}><div><span className="notice-event">{row.event === 'board_notice' ? '啟用' : '停用'}</span><h3>{row.title}</h3><p>{row.body}</p><time>{fmtTime(row.created_at)}</time></div><div className="board-notice-actions"><button className="secondary-btn compact" disabled={busy} onClick={() => { setNote(''); setEditor({ ...row }); }}>編輯</button><button className={row.event === 'board_notice' ? 'danger-btn compact' : 'primary-btn compact'} disabled={busy} onClick={() => void toggle(row)}>{row.event === 'board_notice' ? '停用' : '啟用'}</button></div></article>)}</div>
    {loading && <p className="hint">載入公告中…</p>}
    {!loading && loaded && rows.length === 0 && <p className="empty">尚未建立公開看板公告</p>}
    {editor && <AdminModal title={editor.notif_id ? '編輯看板公告' : '新增看板公告'} onClose={() => { if (!saving) setEditor(null); }}>
      <form className="board-notice-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <label>公告標題<input required maxLength={120} disabled={saving} value={editor.title} onChange={event => setEditor({ ...editor, title: event.target.value })}/></label>
        <label>公告內容<textarea required maxLength={200} rows={4} disabled={saving} value={editor.body} onChange={event => setEditor({ ...editor, body: event.target.value })}/></label>
        <p className="hint">標題最多 120 字，內容最多 200 字。{editor.event === 'board_notice_inactive' ? '儲存後仍維持停用。' : '儲存後將公開播放。'}</p>
        {note && <p role="status">{note}</p>}
        <div className="board-notice-actions"><button type="button" className="secondary-btn" disabled={saving} onClick={() => setEditor(null)}>取消</button><button className="primary-btn" disabled={saving}>{saving ? '儲存中…' : editor.event === 'board_notice_inactive' ? '儲存' : '確認發布'}</button></div>
      </form>
    </AdminModal>}
  </section>;
}
