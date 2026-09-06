'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { AdminSidebar } from '@/components/AdminSidebar';
import { ResponsiveTableLabels } from '@/components/ResponsiveTableLabels';
import { getSupabase, invokeAppApi } from '@/lib/supabase';
import { invokeGoogleCalendar, type GoogleCalendarStatus } from '@/lib/google-calendar';
import type { Profile } from '@/types/app';
import { passwordInputProps, passwordPolicyMessage } from '@/lib/password-policy';
import { usePasswordPolicy } from '@/lib/use-password-policy';
import { clearProfile } from '@/lib/profile-cache';
import { findModule, findSystem, type ModuleDefinition, type SystemDefinition } from '@/lib/modules';
import { SystemPageHeader } from '@/components/SystemPageHeader';
import { resolveAppBackHref } from '@/lib/app-navigation';


function taipeiClock() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date()).replace(',', '');
}

export function AppShell({ profile, title, children, heading }: {
  profile: Profile;
  title: string;
  children: React.ReactNode;
  heading?: { system: SystemDefinition; module: ModuleDefinition; title?: string; metaTitle?: string; description?: string };
}) {
  const passwordPolicy = usePasswordPolicy();
  const pathname = usePathname();
  const [clock, setClock] = useState(taipeiClock);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileDetails, setProfileDetails] = useState<Profile>(profile);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileMessage, setProfileMessage] = useState('');
  const [passwordMessage, setPasswordMessage] = useState('');
  const [calendarStatus, setCalendarStatus] = useState<GoogleCalendarStatus | null>(null);
  const [calendarMessage, setCalendarMessage] = useState('');
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  const isAdminArea = pathname === '/systems/admin/' || pathname.startsWith('/systems/admin/') ||
    pathname === '/systems/structuremap/relations/' || pathname.startsWith('/systems/structuremap/relations/');
  const pathParts = pathname.split('/').filter(Boolean);
  const systemsIndex = pathParts.indexOf('systems');
  const routeSystem = systemsIndex >= 0 ? findSystem(pathParts[systemsIndex + 1] || '') : undefined;
  const routeModule = routeSystem ? findModule(routeSystem.key, pathParts[systemsIndex + 2] || '') : undefined;
  const headingSystem = heading?.system || routeSystem;
  const headingModule = heading?.module || routeModule;
  const backHref = resolveAppBackHref(pathname);
  const pageHeading = headingSystem && headingModule
    ? <SystemPageHeader system={headingSystem} module={headingModule} title={heading?.title} metaTitle={heading?.metaTitle} description={heading?.description} />
    : null;

  useEffect(() => {
    // 主題屬性由 layout.tsx 的行內腳本在算繪前就設好，切換由全站的 ThemeToggle
    // 負責；這裡只留時鐘。
    const timer = window.setInterval(() => setClock(taipeiClock()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const loadPersonalProfile = useCallback(async () => {
    setProfileBusy(true);
    setProfileMessage('');
    try {
      const [details, google] = await Promise.all([
        invokeAppApi<Profile>('profile'),
        invokeGoogleCalendar<GoogleCalendarStatus>('status').catch(() => null),
      ]);
      setProfileDetails(details);
      setCalendarStatus(google);
    } catch {
      setProfileMessage('個人資料載入失敗，請稍後再試');
    } finally {
      setProfileBusy(false);
    }
  }, []);

  const openProfile = useCallback(() => {
    setPasswordMessage('');
    setCalendarMessage('');
    setProfileOpen(true);
    void loadPersonalProfile();
  }, [loadPersonalProfile]);

  useEffect(() => {
    const handleOpen = () => openProfile();
    window.addEventListener('open-personal-profile', handleOpen);
    const url = new URL(window.location.href);
    if (url.searchParams.get('profile') === '1') {
      openProfile();
      url.searchParams.delete('profile');
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    }
    const result = url.searchParams.get('google_calendar');
    if (result) {
      openProfile();
      setCalendarMessage(result === 'connected' ? 'Google 個人行事曆已連結，預約將開始同步。' : 'Google 授權未完成，請重新連結。');
      url.searchParams.delete('google_calendar');
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    }
    return () => window.removeEventListener('open-personal-profile', handleOpen);
  }, [openProfile]);

  useEffect(() => {
    if (!profileOpen) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setProfileOpen(false); };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', closeOnEscape); };
  }, [profileOpen]);

  useEffect(() => {
    if (!adminMenuOpen) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAdminMenuOpen(false);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [adminMenuOpen]);

  async function logout() {
    try { await getSupabase().auth.signOut({ scope: 'local' }); }
    catch (error) { console.warn('logout failed:', error); }
    clearProfile();
    location.replace('/Inspection/v2/login/');
  }
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const password = String(form.get('password') || '');
    const confirm = String(form.get('confirm') || '');
    const passwordError = passwordPolicyMessage(password, passwordPolicy);
    if (passwordError) return setPasswordMessage(passwordError);
    if (password !== confirm) return setPasswordMessage('兩次輸入的密碼不一致');
    try {
      await invokeAppApi('change_password', { password });
      setPasswordMessage('密碼已更改');
      formElement.reset();
    } catch (error) { setPasswordMessage(error instanceof Error ? error.message : '密碼更新失敗，請檢查網路後重試'); }
  }
  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setProfileBusy(true); setProfileMessage('');
    try {
      const updated = await invokeAppApi<Profile>('update_personal_profile', { name: form.get('name'), phone: form.get('phone') });
      setProfileDetails(updated); setProfileMessage('個人資料已更新');
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : '個人資料更新失敗');
    } finally { setProfileBusy(false); }
  }
  async function connectGoogle() {
    setProfileBusy(true); setCalendarMessage('');
    try {
      const result = await invokeGoogleCalendar<{ url: string }>('oauth_start', { return_to: window.location.href });
      window.location.assign(result.url);
    } catch (error) {
      setCalendarMessage(error instanceof Error ? error.message : 'Google 授權啟動失敗'); setProfileBusy(false);
    }
  }
  async function disconnectGoogle() {
    if (!window.confirm('確定解除 Google 個人行事曆連結？已建立的既有行程不會自動刪除。')) return;
    setProfileBusy(true); setCalendarMessage('');
    try {
      await invokeGoogleCalendar('disconnect');
      setCalendarStatus({ connected: false }); setCalendarMessage('已解除 Google 個人行事曆連結');
    } catch (error) {
      setCalendarMessage(error instanceof Error ? error.message : '解除連結失敗');
    } finally { setProfileBusy(false); }
  }

  return <div className="app-shell v1-shell">
    <ResponsiveTableLabels />
    <header className="v1-navbar">
      <div className="v1-brand"><b>■ TAIPEC-MKT-1</b><strong>{title}</strong><span>臺北農產公司／第一果菜市場</span></div>
      <div className="user-meta v1-meta">
        <span>{profileDetails.department || '未設定單位'}｜{profileDetails.name}</span>
        <i><em />系統連線中</i>
        <time>{clock}</time>
      </div>
      <nav className="v1-actions" aria-label="主要導覽">
        <Link href={backHref} className="v1-back-action">
          <span className="generated-nav-icon nav-back" aria-hidden="true" />
          <span>上頁</span>
        </Link>
        <Link href="/systems/" className={pathname === '/systems/' ? 'is-current' : ''}>
          <span className="generated-nav-icon nav-home" aria-hidden="true" />
          <span>首頁</span>
        </Link>
        <button type="button" className="v1-profile-action" onClick={openProfile}>
          <span className="generated-nav-icon nav-profile" aria-hidden="true" />
          <span>個人資料</span>
        </button>
        <button type="button" className="v1-logout-action" onClick={logout}>
          <span className="generated-nav-icon nav-logout" aria-hidden="true" />
          <span>登出</span>
        </button>
      </nav>
    </header>
    {isAdminArea ? <div className="admin-v2-frame">
      <AdminSidebar
        profile={profile}
        pathname={pathname}
        open={adminMenuOpen}
        onClose={() => setAdminMenuOpen(false)}
        onChangePassword={openProfile}
      />
      <div className="admin-v2-workspace">
        <button
          type="button"
          className="admin-sidebar-toggle"
          aria-expanded={adminMenuOpen}
          aria-controls="admin-v2-sidebar"
          onClick={() => setAdminMenuOpen(true)}
        >
          <img src="/Inspection/assets/system-icons-v20260901/admin-icon.png" alt="" />
          後台選單
        </button>
        <main className="content v1-content admin-v2-content">{pageHeading}{children}</main>
      </div>
    </div> : <main className="content v1-content">{pageHeading}{children}</main>}
    {profileOpen && <div className="profile-modal-bg" role="dialog" aria-modal="true" aria-labelledby="personal-profile-title">
      <section className="profile-modal">
        <header><div><small>個人設定</small><h2 id="personal-profile-title">個人資料設定</h2><p>查詢與維護本人的聯絡資料、登入安全及個人行事曆。</p></div><button type="button" aria-label="關閉" onClick={() => setProfileOpen(false)}>×</button></header>
        <div className="profile-modal-body">
          <form className="profile-section profile-section-basic" onSubmit={saveProfile}>
            <div className="profile-section-title"><span>01</span><div><b>基本資料</b><small>帳號、單位及權限由管理員維護</small></div></div>
            <div className="profile-form-grid">
              <div className="profile-basic-account-fields">
                <label>登入帳號<input value={profileDetails.username || ''} readOnly /></label>
                <label>電子郵件<input value={profileDetails.email || ''} readOnly /></label>
              </div>
              <div className="profile-basic-contact-fields">
                <label>姓名<input name="name" defaultValue={profileDetails.name} key={`name-${profileDetails.name}`} maxLength={100} required /></label>
                <label>聯絡電話<input name="phone" defaultValue={profileDetails.phone || ''} key={`phone-${profileDetails.phone || ''}`} maxLength={40} inputMode="tel" /></label>
                <label>所屬單位<input value={profileDetails.department || '未設定'} readOnly /></label>
                <label>帳號角色<input value={profileDetails.rbac_role || profileDetails.role || '未設定'} readOnly /></label>
              </div>
            </div>
            {profileMessage && <p className="profile-message">{profileMessage}</p>}
            <div className="profile-actions"><button type="submit" className="primary-btn compact" disabled={profileBusy}>儲存個人資料</button></div>
          </form>

          <section className="profile-section profile-section-calendar google-calendar-section">
            <div className="profile-section-title"><span>02</span><div><b>Google 個人行事曆</b><small>只連結目前登入者自己的 Google 帳號</small></div></div>
            <div className={`google-connection-card${calendarStatus?.connected ? ' is-connected' : ''}`}>
              <div className="google-calendar-mark">G</div><div><b>{calendarStatus?.connected ? '已連結' : calendarStatus?.status === 'error' ? '需要重新連結' : '尚未連結'}</b><span>{calendarStatus?.connected ? calendarStatus.google_email : calendarStatus?.status === 'error' ? 'Google 授權已失效，請重新完成帳號授權' : '連結後可將本人會議室預約同步到個人行事曆'}</span>{calendarStatus?.last_sync_at && <small>最後同步：{Number.isNaN(new Date(calendarStatus.last_sync_at).getTime()) ? '—' : new Date(calendarStatus.last_sync_at).toLocaleString('zh-TW')}</small>}</div>
              {calendarStatus?.connected ? <button type="button" className="is-connected" onClick={disconnectGoogle} disabled={profileBusy}>解除連結</button> : <button type="button" className="primary-btn compact" onClick={connectGoogle} disabled={profileBusy}>連結 Google 帳號</button>}
            </div>
            <p className="google-policy-links">連結即表示您已閱讀並同意 <a href="/Inspection/v2/privacy/" target="_blank" rel="noreferrer">隱私權政策</a> 與 <a href="/Inspection/v2/terms/" target="_blank" rel="noreferrer">服務條款</a>。</p>
            {calendarMessage && <p className="profile-message">{calendarMessage}</p>}
          </section>

          <form className="profile-section profile-section-security" onSubmit={changePassword}>
            <div className="profile-section-title"><span>03</span><div><b>登入安全</b><small>{passwordPolicy.hint}</small></div></div>
            <div className="profile-form-grid"><label>新密碼<input type="password" name="password" {...passwordInputProps(passwordPolicy)} required autoComplete="new-password" /></label><label>確認新密碼<input type="password" name="confirm" {...passwordInputProps(passwordPolicy)} required autoComplete="new-password" /></label></div>
            {passwordMessage && <p className="profile-message">{passwordMessage}</p>}
            <div className="profile-actions"><button className="primary-btn compact">更新密碼</button></div>
          </form>
        </div>
        <footer><button type="button" onClick={() => setProfileOpen(false)}>關閉</button></footer>
      </section>
    </div>}
  </div>;
}
