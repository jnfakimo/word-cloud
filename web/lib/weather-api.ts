type WeatherService = { url: string; anonKey: string };
type WeatherPayload = { ok?: boolean; configured?: boolean; message?: string; [key: string]: unknown };

export function createWeatherReader(primary: WeatherService, fallback: WeatherService, fetcher: typeof fetch = fetch) {
  async function request(service: WeatherService, view: 'summary' | 'town', county?: string) {
    const url = new URL(service.url);
    url.searchParams.set('view', view);
    if (view === 'town' && county) url.searchParams.set('county', county);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetcher(url, {
        credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: { apikey: service.anonKey, Authorization: `Bearer ${service.anonKey}` },
      });
      const payload = await response.json().catch(() => null) as WeatherPayload | null;
      return { response, payload };
    } catch {
      throw new Error('氣象服務連線失敗或逾時，請稍後重新取得');
    } finally { clearTimeout(timer); }
  }

  return async function readWeather<T>(view: 'summary' | 'town', county?: string): Promise<T & { usingFallback: boolean }> {
    let result = await request(primary, view, county);
    let usingFallback = false;
    // Only the explicit missing-configuration response can switch services.
    // These public weather requests never carry the user's session or cookies.
    if (result.response.status === 503 && result.payload?.configured === false && primary.url !== fallback.url) {
      result = await request(fallback, view, county);
      usingFallback = true;
    }
    if (!result.response.ok || result.payload?.ok !== true) {
      if (result.payload?.configured === false) throw new Error('氣象資料服務尚未完成設定，請聯絡系統管理員');
      throw new Error(`氣象資料暫時無法取得（${result.response.status}），請稍後重新取得`);
    }
    return { ...result.payload, usingFallback } as T & { usingFallback: boolean };
  };
}
