import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS, status: 204 });
  }

  try {
    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Load system_settings
    const { data: rows } = await db.from("system_settings").select("key,value");
    const s: Record<string, string> = {};
    (rows ?? []).forEach((r: { key: string; value: string }) => (s[r.key] = r.value));

    const token   = s.line_channel_token;
    const groupId = s.line_group_id;

    if (!token || !groupId) {
      return json({ ok: false, msg: "LINE not configured" });
    }

    const payload = await req.json();
    let text = "";

    // ── Test message ───────────────────────────────────────────────────────────
    if (payload.test === true) {
      text = "✅ 系統測試訊息\n臺北農產巡檢維修系統 LINE 推播連線正常。";
    }

    // ── Inspection abnormal ────────────────────────────────────────────────────
    else if (
      payload.table === "inspection_records" &&
      payload.record?.run_status === "abnormal"
    ) {
      if (s.line_notify_inspect !== "true") return json({ ok: true, msg: "disabled" });
      const rec = payload.record;
      let eqName: string = rec.equipment_id ?? "—";
      if (rec.equipment_id) {
        const { data: eq } = await db
          .from("equipment")
          .select("name")
          .eq("equipment_id", rec.equipment_id)
          .single();
        if (eq?.name) eqName = eq.name;
      }
      const dtStr = new Date(rec.inspect_time ?? rec.created_at).toLocaleString("zh-TW", {
        timeZone: "Asia/Taipei",
      });
      text = `⚠️ 巡檢異常警報\n設備：${eqName}\n時間：${dtStr}\n說明：${rec.note ?? "（未填）"}`;
    }

    // ── New repair request ─────────────────────────────────────────────────────
    else if (payload.table === "repair_requests") {
      if (s.line_notify_repair !== "true") return json({ ok: true, msg: "disabled" });
      const rec = payload.record;
      let eqName: string = rec.equipment_id ?? "—";
      if (rec.equipment_id) {
        const { data: eq } = await db
          .from("equipment")
          .select("name")
          .eq("equipment_id", rec.equipment_id)
          .single();
        if (eq?.name) eqName = eq.name;
      }
      text = `🔧 新報修單\n設備：${eqName}\n報修人：${rec.reporter ?? "—"}\n說明：${rec.fault_desc ?? "—"}`;
    }

    // ── New handover case ──────────────────────────────────────────────────────
    else if (payload.table === "handover_cases") {
      if (s.line_notify_case !== "true") return json({ ok: true, msg: "disabled" });
      const rec = payload.record;
      text = `📋 新異常案件\n案件編號：${rec.case_no ?? "—"}\n標題：${rec.title ?? "—"}\n狀態：待處理`;
    }

    if (!text) return json({ ok: true, msg: "skip" });

    // ── Send LINE push ─────────────────────────────────────────────────────────
    const lineRes = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ to: groupId, messages: [{ type: "text", text }] }),
    });

    if (!lineRes.ok) {
      const errBody = await lineRes.text();
      console.error("LINE push error:", lineRes.status, errBody);
      return json({ ok: false, msg: errBody }, 500);
    }

    return json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Edge function error:", msg);
    return json({ ok: false, msg }, 500);
  }
});
