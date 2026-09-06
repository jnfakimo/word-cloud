'use client';

// V2 登入。帳密與驗證碼走既有的 username-login Edge Function。
//
// 忘記密碼流程原本只回一句「請洽系統管理員重設密碼」，V1 login.html 其實有完整兩段：
// 輸入 Email 寄重設連結（auth.resetPasswordForEmail）→ 從信中連結回來時網址帶
// #type=recovery，改顯示設定新密碼；更新動作改由受信任的 app-api 執行。
//
// 注意：redirectTo 是本頁網址（/Inspection/v2/login/），與 V1 的
// /Inspection/system/login.html 不同，必須在 Supabase Auth 的 Redirect URLs
// 白名單另外加上，否則信中的連結會被拒絕。

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase, invokeAppApi } from '@/lib/supabase';
import { passwordInputProps, passwordPolicyMessage } from '@/lib/password-policy';
import { usePasswordPolicy } from '@/lib/use-password-policy';
import { clearProfile, saveProfile } from '@/lib/profile-cache';
import type { Profile } from '@/types/app';

// 只涵蓋這頁會遇到的幾種回應，不把後台那份大表拉進登入頁的 bundle。
function friendlyError(raw: unknown, fallback: string) {
  const text = raw instanceof Error ? raw.message : String(raw || '');
  if (/rate limit|too many requests|for security purposes/i.test(text)) return '操作過於頻繁，請稍後再試';
  if (/failed to fetch|network|load failed/i.test(text)) return '網路連線失敗，請確認連線後再試';
  if (/invalid.*email|email.*invalid/i.test(text)) return '電子郵件格式不正確';
  if (/user not found|no user/i.test(text)) return '查無此電子郵件對應的帳號';
  if (/expired|invalid.*token|session/i.test(text)) return '重設連結已失效，請重新申請';
  if (/password.*(short|least|weak)/i.test(text)) return '密碼不符合規則，請依畫面提示重新設定';
  return text || fallback;
}

export default function LoginPage() {
  const passwordPolicy = usePasswordPolicy();
  const [captcha, setCaptcha] = useState<{ id: string; image: string } | null>(null);
  const [view, setView] = useState<'login' | 'forgot' | 'reset'>('login');
  const [resetReady, setResetReady] = useState(false);
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(''), [password2, setPassword2] = useState('');

  function nextPath() {
    const requested = new URLSearchParams(window.location.search).get('next');
    if (requested && (requested.startsWith('/Inspection/v2/') || requested.startsWith('/word-cloud/v2/'))
      && !requested.startsWith('/Inspection/v2/login') && !requested.startsWith('/word-cloud/v2/login')) {
      return requested;
    }
    return '/Inspection/v2/systems/';
  }
  async function loadCaptcha() {
    setCaptcha(null);
    try {
      const { data, error } = await getSupabase().functions.invoke('username-login', { body: { action: 'captcha' } });
      if (error || !data?.challenge_id) return setMessage('驗證碼載入失敗，請確認網路後重新整理');
      setCaptcha({ id: data.challenge_id, image: data.image });
    } catch { setMessage('驗證碼服務暫時無法連線，請稍後重試'); }
  }

  useEffect(() => {
    const hash = window.location.hash;
    // 從重設密碼信回來：Supabase 會把 recovery session 放在網址 hash。
    // 但 lib/supabase.ts 設了 detectSessionInUrl:false，supabase-js 不會自己去讀
    // 這段 hash，必須像下方登入流程那樣手動 setSession。少了這一步，
    // 密碼更新會因為沒有 session 而失敗，而 friendlyError 的 /session/i 規則
    // 又會把它翻成「重設連結已失效」，把使用者指向完全錯誤的原因。
    if (hash.includes('type=recovery')) {
      setView('reset');
      const params = new URLSearchParams(hash.replace(/^#/, ''));
      const accessToken = params.get('access_token') || '', refreshToken = params.get('refresh_token') || '';
      if (!accessToken || !refreshToken) { setMessage('重設連結不完整，請重新申請'); return; }
      void getSupabase().auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
        .then(({ error }) => {
          // token 進了 session 就不該繼續留在網址列與瀏覽紀錄裡。
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
          if (error) setMessage(friendlyError(error, '重設連結已失效，請重新申請'));
          else setResetReady(true);
        });
      return;
    }
    if (hash.includes('error=')) {
      const params = new URLSearchParams(hash.replace(/^#/, ''));
      const description = params.get('error_description') || params.get('error_code') || params.get('error') || '';
      setMessage(friendlyError(description.replace(/\+/g, ' '), '重設連結已失效，請重新申請'));
      window.location.hash = '';
      void loadCaptcha();
      return;
    }
    getSupabase().auth.getSession().then(({ data }) => { if (data.session) location.replace(nextPath()); else void loadCaptcha(); });
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage('');
    const form = new FormData(event.currentTarget);
    try {
      const { data, error } = await getSupabase().functions.invoke('username-login', { body: {
        identifier: String(form.get('identifier') || '').trim(), password: String(form.get('password') || ''),
        captcha_id: captcha?.id, captcha_answer: String(form.get('captcha') || '').trim(),
      }});
      if (error || !data?.access_token) { setMessage(data?.message || '帳號、密碼或驗證碼錯誤'); setBusy(false); await loadCaptcha(); return; }
      const result = await getSupabase().auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
      if (result.error) { setMessage('登入狀態建立失敗，請重新登入'); setBusy(false); return; }
      try {
        const profile = await invokeAppApi<Profile>('profile');
        saveProfile(profile);
      } catch (profileError) {
        clearProfile();
        await getSupabase().auth.signOut({ scope: 'local' }).catch(() => {});
        setMessage(friendlyError(profileError, '找不到啟用中的系統帳號，請聯絡管理員'));
        setBusy(false);
        return;
      }
      location.replace(nextPath());
    } catch { setMessage('登入服務暫時無法連線，請稍後重試'); setBusy(false); }
  }

  async function sendResetLink() {
    setMessage(''); setNotice('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setMessage('請輸入有效的電子郵件地址'); return; }
    setBusy(true);
    const redirectTo = `${window.location.origin}${window.location.pathname}`;
    const { error } = await getSupabase().auth.resetPasswordForEmail(email.trim(), { redirectTo });
    setBusy(false);
    if (error) { setMessage(`寄送失敗：${friendlyError(error, '請稍後再試')}`); return; }
    setNotice('重設連結已寄出，請檢查您的信箱（含垃圾郵件）');
  }

  async function saveNewPassword() {
    setMessage(''); setNotice('');
    const passwordError = passwordPolicyMessage(password, passwordPolicy);
    if (passwordError) { setMessage(passwordError); return; }
    if (password !== password2) { setMessage('兩次密碼不一致'); return; }
    setBusy(true);
    try {
      await invokeAppApi('change_password', { password });
    } catch (error) {
      setBusy(false);
      setMessage(`設定失敗：${friendlyError(error, '請重新申請重設連結')}`);
      return;
    }
    setBusy(false);
    setNotice('密碼已更新，即將返回登入頁…');
    setTimeout(() => { window.location.hash = ''; window.location.reload(); }, 2000);
  }

  const brand = <>
    <img className="v1-login-logo" src="/Inspection/system/assets/logo-title.png" alt="臺北農產第一果菜市場" />
    <h1>臺北農產公司</h1>
    <p className="v1-login-sub">第一果菜市場 設備巡檢維修系統</p>
  </>;

  if (view === 'reset') return <main className="v1-login-page">
    <div className="login-card v1-login-card">
      {brand}
      <p className="v1-login-hint">設定新密碼（{passwordPolicy.hint}）</p>
      <label>新密碼<input type="password" value={password} {...passwordInputProps(passwordPolicy)} autoComplete="new-password" onChange={e => setPassword(e.target.value)} placeholder="••••••••••••" /></label>
      <label>再次輸入新密碼<input type="password" value={password2} {...passwordInputProps(passwordPolicy)} autoComplete="new-password" onChange={e => setPassword2(e.target.value)} placeholder="••••••••••••" /></label>
      {message && <p className="form-error">{message}</p>}
      {notice && <p className="inline-message">{notice}</p>}
      <button className="primary-btn" disabled={busy || !resetReady} onClick={() => void saveNewPassword()}>{busy ? '儲存中…' : resetReady ? '設定新密碼' : '驗證連結中…'}</button>
    </div>
    <footer>臺北農產運銷股份有限公司 第一果菜市場 ｜ 整合管理系統 ｜ 第二版</footer>
  </main>;

  if (view === 'forgot') return <main className="v1-login-page">
    <div className="login-card v1-login-card">
      {brand}
      <p className="v1-login-hint">請輸入您帳號對應的電子郵件，系統將寄送重設連結</p>
      <label>電子郵件<input type="email" value={email} autoComplete="email" onChange={e => setEmail(e.target.value)} placeholder="請輸入電子郵件地址" /></label>
      {message && <p className="form-error">{message}</p>}
      {notice && <p className="inline-message">{notice}</p>}
      <button className="primary-btn" disabled={busy || Boolean(notice)} onClick={() => void sendResetLink()}>{busy ? '寄送中…' : '寄送重設連結'}</button>
      <button type="button" className="forgot-link" onClick={() => { setView('login'); setMessage(''); setNotice(''); }}>返回登入</button>
    </div>
    <footer>臺北農產運銷股份有限公司 第一果菜市場 ｜ 整合管理系統 ｜ 第二版</footer>
  </main>;

  return <main className="v1-login-page">
    <form className="login-card v1-login-card" onSubmit={submit}>
      {brand}
      <p className="v1-login-hint">請使用帳號登入</p>
      <label>帳號（英數字）<input name="identifier" required autoComplete="username" placeholder="請輸入帳號" /></label>
      <label>密碼<input name="password" type="password" required autoComplete="current-password" placeholder="••••••••" /></label>
      <label>安全驗證碼（六位數字）
        <div className="captcha-row">
          {captcha ? <img src={captcha.image} alt="六位數驗證碼" onClick={loadCaptcha} /> : <button type="button" onClick={loadCaptcha}>重新載入</button>}
          <button type="button" onClick={loadCaptcha} aria-label="重新產生驗證碼">↻ 重新產生</button>
        </div>
        <input name="captcha" inputMode="numeric" pattern="[0-9]*" maxLength={6} required placeholder="輸入圖中六位數字" />
      </label>
      {message && <p className="form-error">{message}</p>}
      <button className="primary-btn" disabled={busy}>{busy ? '登入中…' : '登入'}</button>
      <button type="button" className="forgot-link" onClick={() => { setView('forgot'); setMessage(''); setNotice(''); }}>忘記密碼？</button>
      <Link className="forgot-link" href="/account-apply/">申請帳號</Link>
    </form>
    <footer>臺北農產運銷股份有限公司 第一果菜市場 ｜ 整合管理系統 ｜ 第二版</footer>
  </main>;
}
