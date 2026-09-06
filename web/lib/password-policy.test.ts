import assert from 'node:assert/strict';
import test from 'node:test';
import { passwordPolicyMessage as cloudBackendMessage } from '../../supabase/functions/_shared/password-policy.ts';
import { usesLocalBackendOrigin } from './backend-origin.ts';
import { LOCAL_PASSWORD_POLICY, PASSWORD_POLICY, passwordInputProps, passwordPolicyForEndpoint, passwordPolicyMessage, temporaryPassword } from './password-policy.ts';

test('policy follows existing local origin routing, including forwarded ports', () => {
  for (const endpoint of ['https://192.168.50.192', 'https://192.168.50.192:5057', 'https://203.0.113.10:5443', 'http://localhost:3000', 'http://127.0.0.1']) {
    assert.equal(usesLocalBackendOrigin(new URL(endpoint).hostname), true);
    assert.equal(passwordPolicyForEndpoint(endpoint), LOCAL_PASSWORD_POLICY);
  }
  for (const endpoint of ['https://qztffronusdhgxhjjubt.supabase.co', 'https://example.com', 'https://192.168.50.192.example.com', 'invalid']) {
    assert.equal(passwordPolicyForEndpoint(endpoint), PASSWORD_POLICY);
  }
});

test('local validation matches reviewed production policy and HTML constraints', () => {
  const inputs = passwordInputProps(LOCAL_PASSWORD_POLICY);
  assert.equal(inputs.inputMode, 'numeric');
  for (const value of ['12345678', '00000000', '', '1234567', '123456789', 'Abcd1234', '1234 678', '１２３４５６７８', '1234567\n']) {
    const accepted = value.length === 8 && /^\d{8}$/.test(value);
    assert.equal(passwordPolicyMessage(value, LOCAL_PASSWORD_POLICY) === '', accepted);
    const htmlAccepted = value.length >= inputs.minLength && value.length <= inputs.maxLength && new RegExp(`^(?:${inputs.pattern})$`, 'v').test(value);
    assert.equal(htmlAccepted, accepted);
  }
});

test('cloud keeps the actual backend rules and permits mixed characters in HTML', () => {
  const inputs = passwordInputProps(PASSWORD_POLICY);
  assert.equal(inputs.pattern, undefined);
  assert.equal(inputs.inputMode, 'text');
  const values = ['', '12345678', 'Abcd1234', 'abcd1234', 'Abcd!234', 'Abc 1234', 'Abcd\t1234', 'A'.repeat(198) + 'a1', 'A'.repeat(199) + 'a1'];
  for (const value of values) assert.equal(passwordPolicyMessage(value), cloudBackendMessage(value));
  assert.equal(passwordPolicyMessage('Abcd1234'), '');
  assert.notEqual(passwordPolicyMessage('12345678'), '');
});

test('blank XLSX passwords generate values accepted by the corresponding policy', () => {
  for (const policy of [LOCAL_PASSWORD_POLICY, PASSWORD_POLICY]) {
    for (let i = 0; i < 100; i++) {
      const value = temporaryPassword(policy);
      assert.equal(value.length, policy.numericOnly ? 8 : 16);
      assert.equal(passwordPolicyMessage(value, policy), '');
      if (!policy.numericOnly) assert.equal(cloudBackendMessage(value), '');
    }
  }
});

test('credential generation fails clearly when secure randomness is unavailable', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    assert.throws(() => temporaryPassword(LOCAL_PASSWORD_POLICY), /無法安全產生/);
    assert.throws(() => temporaryPassword(PASSWORD_POLICY), /無法安全產生/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
  }
});
