'use client';

import { useSyncExternalStore } from 'react';
import { SUPABASE_URL } from './config';
import { PASSWORD_POLICY, passwordPolicyForEndpoint } from './password-policy';

const subscribe = () => () => {};
const clientPolicy = () => passwordPolicyForEndpoint(SUPABASE_URL);
const serverPolicy = () => PASSWORD_POLICY;

export function usePasswordPolicy() {
  // Static HTML and the first hydration render agree; then use the actual API origin.
  return useSyncExternalStore(subscribe, clientPolicy, serverPolicy);
}
