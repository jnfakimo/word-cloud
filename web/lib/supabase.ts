'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config';
import { usesLocalBackendOrigin } from './backend-origin';
import { reportIfInfrastructureError } from './error-tracker';
import { emitSecurityDataRead } from './security-audit-sink';
import { cachedRequest, requestCacheKey } from './request-cache';

let client: SupabaseClient | null = null;
// The formal self-hosted site must keep writes on the same backend as its login.
const nodeAppApiUrl = usesLocalBackendOrigin(new URL(SUPABASE_URL).hostname)
  ? undefined : process.env.NEXT_PUBLIC_APP_API_URL?.trim().replace(/\/$/, '');
// 地端相容 API 不能讓前端無限等待；逾時後改走同源地端 app-api。
const NODE_API_TIMEOUT_MS = 5000;
const READ_ACTION_LABELS: Record<string, string> = {
  profile: '讀取個人帳號資料',
  module_data: '讀取系統模組資料',
  workorder_list: '讀取報修與工單清單',
  workorder_options: '讀取報修表單選項',
  workorder_detail: '讀取報修與工單明細',
  dashboard: '讀取戰情儀表板資料',
  inspections: '讀取巡檢資料',
  equipment_map: '讀取設備地圖資料',
  official_documents: '讀取公文傳送資料',
};

// 公文流程動作固定走同源地端 app-api；名稱保留供既有路由相容。
const EDGE_ONLY_ACTIONS = new Set(['official_document_create', 'official_document_action']);

const recordAppRead = (action: string) => {
  const label = READ_ACTION_LABELS[action];
  if (label) emitSecurityDataRead(label);
};

const isTransientNodeResponse = (response: Response) => (
  response.status === 408 || response.status === 429 || response.status >= 500
);

export function getSupabase() {
  if (client) return client;
  if (typeof window === 'undefined') throw new Error('地端資料相容客戶端無法在預先轉譯期間使用');
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      storage: window.sessionStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  return client;
}

export async function invokeAppApi<T>(action: string, payload: Record<string, unknown> = {}) {
  // 查詢與寫入均維持同源地端路徑；Node-first 僅保留既有相容流程，避免重送動作。
  if (nodeAppApiUrl && !READ_ACTION_LABELS[action] && !EDGE_ONLY_ACTIONS.has(action)) {
    const supabase = getSupabase();
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (sessionError || !accessToken) throw new Error('登入狀態無效，請重新登入');

    let response: Response | undefined;
    let timeoutId: number | undefined;
    try {
      const controller = new AbortController();
      timeoutId = window.setTimeout(() => controller.abort(), NODE_API_TIMEOUT_MS);
      response = await fetch(`${nodeAppApiUrl}/api/app-api`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action, ...payload }),
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch {
      console.warn('Node.js API 連線逾時或失敗，改走同源地端 app-api');
      // Do nothing, let it fall through to the same-origin local app-api below.
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    }

    if (response && !isTransientNodeResponse(response)) {
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) {
        // Render 服務可能仍在滾動部署舊版 handler；新 V2 動作先由 Edge
        // Function 提供，遇到明確的「不支援」才安全回退，其他業務錯誤仍直接呈現，
        // 避免把驗證失敗重送到第二個後端。
        if (result?.message !== '不支援的 API 動作') {
          reportIfInfrastructureError(result?.message, { action, via: 'node-api' });
          throw new Error(result?.message || '系統服務回傳失敗');
        }
        console.warn(`Node.js API 尚未支援 ${action}，改由同源地端 app-api 處理`);
      } else {
        recordAppRead(action);
        return result.data as T;
      }
    }
    if (response) {
      console.warn(`Node.js API 回傳 ${response.status}，改走同源地端 app-api`);
    }
  }

  const { data, error } = await getSupabase().functions.invoke('app-api', {
    body: { action, ...payload },
  });
  if (error) {
    console.error('地端 app-api 錯誤:', error);
    let msg = error.message || '連線失敗';
    if ((error as any).context && typeof (error as any).context.json === 'function') {
      try {
        const errData = await (error as any).context.json();
        if (errData?.message) msg = errData.message;
      } catch { /* ignore */ }
    }
    throw new Error(`地端 app-api 失敗: ${msg}`);
  }
  if (!data?.ok) {
    reportIfInfrastructureError(data?.message, { action, via: 'local-app-api' });
    throw new Error(data?.message || '系統服務回傳失敗');
  }
  recordAppRead(action);
  return data.data as T;
}

export async function invokeCachedAppApi<T>(
  action: string,
  payload: Record<string, unknown> = {},
  options?: number | { ttlMs?: number; force?: boolean }
): Promise<T> {
  const key = requestCacheKey('app-api', action, payload);
  const ttlMs = typeof options === 'number' ? options : options?.ttlMs ?? 30000;
  const force = typeof options === 'object' ? Boolean(options.force) : false;
  return cachedRequest(key, () => invokeAppApi<T>(action, payload), { ttlMs, force });
}
