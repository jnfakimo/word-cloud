const CLOUD_SUPABASE_URL = 'https://qztffronusdhgxhjjubt.supabase.co';
const CLOUD_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF6dGZmcm9udXNkaGd4aGpqdWJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTI1MzgsImV4cCI6MjA5NzI2ODUzOH0.FnUxot5YXI3yKCUCmJA5P4ysEJhmtaQQA6rM7MRy3oA';
// Existing public weather service; never use an authenticated session for fallback.
export const PUBLIC_WEATHER_SERVICE = {
  url: `${CLOUD_SUPABASE_URL}/functions/v1/cwa-weather`, anonKey: CLOUD_SUPABASE_ANON_KEY,
};
// The self-hosted stack signs requests with the anon key from its local .env.
// It is intentionally public in a browser build, but must match the local JWT
// issuer; the cloud anon key is not accepted by the local Auth gateway.
const LOCAL_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg4MjM1ODExLCJleHAiOjE5NDU5MTU4MTF9.quXojlju5ZREdYLgvaC9qMXccarzw15hY6kQw_PIwqA';

// Local/self-hosted builds inject these two public values at build time. Keeping
// the cloud defaults preserves the existing GitHub Pages build and rollback path.
const configuredSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || CLOUD_SUPABASE_URL;
// 本機站台可能透過路由器以不同外部埠（例如 5057/5443）提供服務；
// 只要瀏覽器是以 IP 或 localhost 開啟，就必須沿用目前頁面的 origin，
// 否則手機 4G/5G 會把登入請求送到雲端或內網 IP。這個判斷刻意不依賴
// NEXT_PUBLIC_* 是否被打包器正確內嵌，避免舊版快取造成登入逾時。
const isIpAddress = (hostname: string) => /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(hostname);
const useBrowserOrigin = typeof window !== 'undefined' && (
  isIpAddress(window.location.hostname) ||
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1'
);
export const SUPABASE_URL = useBrowserOrigin ? window.location.origin : configuredSupabaseUrl;
export const SUPABASE_ANON_KEY = useBrowserOrigin
  ? (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() || LOCAL_SUPABASE_ANON_KEY)
  : (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() || CLOUD_SUPABASE_ANON_KEY);
export const LEGACY_BASE = '/Inspection/system';
// 第一果菜市場。markets 只有 market1／market2 兩列（system/sql/locations_schema.sql:66），
// floor_spaces 與 locations 的 market_id 都是 references markets(market_id)。
export const MARKET_ID = 'market1';
