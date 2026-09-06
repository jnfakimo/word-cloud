import { usesLocalBackendOrigin } from './backend-origin.ts';

export type PasswordPolicy = {
  minLength: number;
  maxLength: number;
  requiredCharacterClasses: number;
  numericOnly: boolean;
  hint: string;
};

export const PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  maxLength: 200,
  requiredCharacterClasses: 3,
  numericOnly: false,
  hint: '8～200 個字元，不含空白，需含大寫、小寫、數字、特殊字元中的至少 3 類',
} as const;

export const LOCAL_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8, maxLength: 8, requiredCharacterClasses: 1, numericOnly: true, hint: '8 位數字',
};

export function passwordPolicyForEndpoint(endpoint: string): PasswordPolicy {
  try {
    if (usesLocalBackendOrigin(new URL(endpoint).hostname)) return LOCAL_PASSWORD_POLICY;
  } catch { /* Unknown endpoints retain the cloud policy. */ }
  return PASSWORD_POLICY;
}

export function passwordInputProps(policy: PasswordPolicy) {
  return {
    minLength: policy.minLength, maxLength: policy.maxLength,
    pattern: policy.numericOnly ? '[0-9]{8}' : undefined,
    inputMode: policy.numericOnly ? 'numeric' as const : 'text' as const,
  };
}

export function passwordPolicyMessage(password: string, policy: PasswordPolicy = PASSWORD_POLICY) {
  if (policy.numericOnly) {
    if (password.length !== policy.minLength) return `密碼必須是 ${policy.minLength} 位數字`;
    return /^\d{8}$/.test(password) ? '' : '密碼只能包含數字';
  }
  if (password.length < policy.minLength) return `密碼至少需要 ${policy.minLength} 個字元`;
  if (password.length > policy.maxLength) return `密碼不可超過 ${policy.maxLength} 個字元`;
  if (/\s/.test(password)) return '密碼不可包含空白字元';
  const classes = [/[a-z]/.test(password), /[A-Z]/.test(password), /\d/.test(password), /[^A-Za-z0-9]/.test(password)].filter(Boolean).length;
  return classes < policy.requiredCharacterClasses
    ? '密碼需包含大寫、小寫、數字、特殊字元中的至少 3 類'
    : '';
}

// Rejection sampling avoids modulo bias; never fall back to Math.random for credentials.
function randomIndex(limit: number) {
  if (!globalThis.crypto?.getRandomValues) throw new Error('無法安全產生臨時密碼，請改為手動輸入');
  const bytes = new Uint8Array(1);
  const ceiling = 256 - (256 % limit);
  do { globalThis.crypto.getRandomValues(bytes); } while (bytes[0] >= ceiling);
  return bytes[0] % limit;
}

export function temporaryPassword(policy: PasswordPolicy) {
  if (policy.numericOnly) return Array.from({ length: policy.minLength }, () => String(randomIndex(10))).join('');
  const groups = ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789', '!@#$%&*?'];
  const alphabet = groups.join('');
  const chars = groups.map(group => group[randomIndex(group.length)]);
  while (chars.length < 16) chars.push(alphabet[randomIndex(alphabet.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
