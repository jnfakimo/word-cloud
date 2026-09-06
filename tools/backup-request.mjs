/** Consume the whole response under one deadline. Never log URLs, credentials or response bodies. */
export async function backupRequest(url, init, read, label, { timeoutMs = 60000, attempts = 3, fetcher = fetch, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let retry = false;
    let failure;
    try {
      const response = await fetcher(url, { ...init, signal: controller.signal });
      if (response.ok) return await read(response);
      failure = new Error(`${label}回應 HTTP ${response.status}`);
      retry = [408, 429].includes(response.status) || response.status >= 500;
      await response.body?.cancel();
    } catch {
      failure = new Error(`${label}${controller.signal.aborted ? '逾時' : '連線或回應讀取失敗'}`);
      retry = true;
    } finally { clearTimeout(timer); }
    if (!retry || attempt === attempts) throw failure;
    console.warn(`${label}暫時失敗，將重試（${attempt}/${attempts - 1}）`);
    await delay(Math.min(5000, 1000 * 2 ** (attempt - 1)));
  }
}
