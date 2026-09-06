// Keep self-hosted origin routing and its existing password policy in agreement.
export function usesLocalBackendOrigin(hostname: string) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(hostname) || hostname === 'localhost';
}
