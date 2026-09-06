'use client';

import { getSupabase } from './supabase';
import { emitSecurityDataRead } from './security-audit-sink';

const READ_ACTION_LABELS: Record<string, string> = {
  admin_get_settings: '讀取系統設定',
  admin_list_account_applications: '讀取帳號申請清單',
  admin_list_board_notices: '讀取公開看板公告',
};

export async function invokeAdminApi<T = Record<string, unknown>>(action: string, payload: Record<string, unknown> = {}) {
  // 與登入及一般業務共用同一個 client：沿用同源路由及自動更新的 Bearer session。
  // 管理寫入不自動重送，避免逾時但已完成的操作被執行兩次。
  const { data, error } = await getSupabase().functions.invoke('admin-api', {
    body: { ...payload, action },
    timeout: 15_000,
  });
  if (error) {
    const response = (error as { context?: Response }).context;
    let message = '';
    if (response instanceof Response) {
      const result = await response.clone().json().catch(() => null);
      if (typeof result?.message === 'string') message = result.message;
      if (!message) message = response.status === 401 ? '登入已逾時，請重新登入'
        : response.status === 403 ? '沒有執行此管理功能的權限'
          : `後台管理服務回應異常（${response.status}），請稍後再試`;
    }
    throw new Error(message || '後台管理服務連線失敗或逾時，請確認操作結果後再試');
  }
  if (!data?.ok) throw new Error(data?.message || '後台管理服務回傳失敗');
  const label = READ_ACTION_LABELS[action];
  if (label) emitSecurityDataRead(label);
  return data as T;
}
