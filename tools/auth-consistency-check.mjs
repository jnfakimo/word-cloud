import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8');
const files = {
  v1Config: read('system/supabase-config.js'),
  v1Login: read('system/login.html'),
  handoverLogin: read('system/handover-login.html'),
  v2Login: read('web/app/login/page.tsx'),
  authGate: read('web/components/AuthGate.tsx'),
  appShell: read('web/components/AppShell.tsx'),
  cache: read('web/lib/profile-cache.ts'),
};
const v1ProfilePages = [
  'system/admin.html', 'system/dispatch.html', 'system/dashboard.html', 'system/notices.html',
  'system/handover.html', 'system/meetingroom.html', 'system/vehicle-dispatch.html',
  'system/repair.html', 'system/guardpatrol3d.html', 'system/workorder.html',
].map((file) => [file, read(file)]);

function assert(condition, message) {
  if (!condition) throw new Error(`Auth consistency check failed: ${message}`);
}

assert(files.v1Config.includes("window.SystemAuth") && files.v1Config.includes("{ action: 'profile' }"),
  'V1 must expose the shared app-api/profile loader');
assert(files.v1Login.includes("var v2Target = '/Inspection/v2/login/';") && files.v1Login.includes('window.location.replace(v2Target'),
  'V1 login must forward to the authoritative V2 login');
assert(files.handoverLogin.includes('/Inspection/v2/login/?redirect=%2Fsystems%2Fhandover%2F') && files.handoverLogin.includes('window.location.replace(target)'),
  'handover login must forward to V2 login and preserve its destination');
assert(files.v2Login.includes("functions.invoke('username-login'") && files.v2Login.includes('captcha_id') && files.v2Login.includes('auth.setSession'),
  'V2 login must use the shared captcha login and establish its session');
assert(!/login_lookup_email|signInWithPassword|\.from\(['"]users['"]\)/.test(files.handoverLogin),
  'handover login must not bypass the shared login/profile path');
assert(
  (files.v2Login.includes("invokeAppApi<Profile>('profile')") || files.v2Login.includes('localAuth.me<Profile>()')) && files.v2Login.includes('saveProfile'),
  'V2 login must hydrate the shared profile cache from the active auth provider',
);
assert(
  (files.authGate.includes("invokeAppApi<Profile>('profile')") || files.authGate.includes('localAuth.me<Profile>()')) && files.authGate.includes('saveProfile'),
  'V2 AuthGate must refresh the same authoritative profile from the active auth provider',
);
assert(files.appShell.includes('clearProfile()'), 'V2 logout must clear the shared profile cache');
assert(files.cache.includes("inspectionSystemUserProfile") && files.cache.includes('system-user-profile-updated'),
  'V2 cache must use the V1 storage key and update event');
for (const [file, source] of v1ProfilePages) {
  assert(!source.includes("eq('auth_id'") && !source.includes('eq("auth_id"'),
    `${file} must use SystemAuth for the current user instead of a page-specific auth_id query`);
}

console.log('Auth consistency checks passed.');
