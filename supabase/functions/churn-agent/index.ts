// Supabase Edge Function "churn-agent" — der Webhook.
// Nimmt einen rohen Kundendatensatz entgegen, bewertet ihn (Code + Claude)
// und schreibt EINE Zeile nach public.churn_assessments.
//
// Auslösen z.B. per:
//   curl -X POST "<FUNCTION_URL>" -H "Authorization: Bearer <ANON_KEY>" \
//        -H "content-type: application/json" -d '{"input":"Kunde: ..."}'

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODEL = "claude-sonnet-5";

// ==========================================================================
// TEIL A — Deterministischer Code (KEIN Modell)
// ==========================================================================

function parseArr(text: string): number | null {
  const line = text.split("\n").find((l) => /arr\s*:/i.test(l)) ?? "";
  if (/unbekannt|unknown|n\/?a/i.test(line)) return null;
  const m = line.match(/[\d.,]+/);
  if (!m) return null;
  const num = parseFloat(m[0].replace(/\./g, "").replace(",", "."));
  return Number.isFinite(num) ? num : null;
}

function parseCustomerName(text: string): string {
  const line = text.split("\n").find((l) => /kunde\s*:/i.test(l)) ?? "";
  return line.split(":").slice(1).join(":").trim() || "Unbekannt";
}

function escalationTier(arr: number | null): string | null {
  if (arr == null) return null;
  if (arr >= 3000) return "eskalation_founder";
  if (arr >= 1000) return "retention_gespraech";
  return "cs_eigenstaendig";
}

// ==========================================================================
// TEIL B — Das Sprachmodell (nur die Urteilsfragen)
// ==========================================================================

const SYSTEM_PROMPT = `Du bist Analyst für Kundenabwanderung (Churn) bei einer B2B-SaaS-Firma, die regionale Jobplattformen betreibt.

Deine Aufgabe: Bewerte anhand roher, unstrukturierter Kundensignale das Abwanderungsrisiko und leite eine konkrete Handlungsempfehlung für das Customer-Success-Team ab.

Regeln:
- churn_risk_score: 0-100. Grobe Bänder: 0-24 low, 25-49 medium, 50-74 high, 75-100 critical. risk_level muss zum Score passen.
- signals_detected: die konkreten Warnsignale, die du IM TEXT erkennst (kurze Stichpunkte). Nur was wirklich dasteht.
- recommended_action: eine konkrete nächste Handlung (ein Satz), umsetzbar für Customer Success.
- confidence: Wie sicher bist du dir? Bei WENIGEN oder WIDERSPRÜCHLICHEN Signalen -> "low". Bei klaren, eindeutigen Signalen -> "high". Lieber ehrlich unsicher als falsch selbstbewusst.
- reasoning: 1-2 Sätze, warum du zu dieser Einschätzung kommst.

Wichtig:
- Erfinde KEINE Fakten. Wenn Informationen fehlen, spiegle das in einer niedrigeren confidence, statt zu raten.
- Du bekommst bewusst KEINE ARR-Zahl und entscheidest NICHT über Eskalationsstufen — das übernimmt separater, deterministischer Code. Konzentrier dich auf die inhaltliche Bewertung der Signale.`;

const TOOL = {
  name: "record_churn_assessment",
  description: "Erfasst die Churn-Bewertung eines Kunden in strukturierter Form.",
  input_schema: {
    type: "object",
    properties: {
      churn_risk_score: { type: "integer", minimum: 0, maximum: 100 },
      risk_level: { type: "string", enum: ["low", "medium", "high", "critical"] },
      signals_detected: { type: "array", items: { type: "string" } },
      recommended_action: { type: "string" },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      reasoning: { type: "string" },
    },
    required: [
      "churn_risk_score",
      "risk_level",
      "signals_detected",
      "recommended_action",
      "confidence",
      "reasoning",
    ],
  },
};

// deno-lint-ignore no-explicit-any
function validate(a: any): string | null {
  const levels = ["low", "medium", "high", "critical"];
  const conf = ["low", "medium", "high"];
  if (typeof a?.churn_risk_score !== "number" || a.churn_risk_score < 0 || a.churn_risk_score > 100)
    return "churn_risk_score ungültig";
  if (!levels.includes(a?.risk_level)) return "risk_level ungültig";
  if (!conf.includes(a?.confidence)) return "confidence ungültig";
  if (!Array.isArray(a?.signals_detected)) return "signals_detected ungültig";
  return null;
}

async function assessWithClaude(rawInput: string, attempt = 1): Promise<any> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: rawInput }],
      tools: [TOOL],
      tool_choice: { type: "tool", name: "record_churn_assessment" },
    }),
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const toolUse = data.content?.find((c: any) => c.type === "tool_use");
  const assessment = toolUse?.input;

  const err = validate(assessment);
  if (err) {
    if (attempt < 2) return assessWithClaude(rawInput, attempt + 1); // 1x Retry
    throw new Error(`Ungültiger Output nach Retry: ${err}`);
  }
  return assessment;
}

// ==========================================================================
// TEIL C — Webhook-Handler
// ==========================================================================

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ error: "Nur POST erlaubt" }, 405);
  }

  try {
    // Input akzeptieren: JSON {"input":"..."} ODER roher Text im Body
    let rawInput: string;
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const body = await req.json();
      rawInput = typeof body?.input === "string" ? body.input : JSON.stringify(body);
    } else {
      rawInput = await req.text();
    }
    if (!rawInput?.trim()) return json({ error: "Leerer Input" }, 400);

    // Code
    const arr = parseArr(rawInput);
    const customer_name = parseCustomerName(rawInput);

    // Modell
    const model = await assessWithClaude(rawInput);

    // Zusammenbau
    const record = {
      customer_name,
      raw_input: rawInput,
      arr,
      arr_at_risk: arr,
      escalation_tier: escalationTier(arr),
      churn_risk_score: model.churn_risk_score,
      risk_level: model.risk_level,
      signals_detected: model.signals_detected,
      recommended_action: model.recommended_action,
      confidence: model.confidence,
      reasoning: model.reasoning,
      similar_cases: [],
      model: MODEL,
    };

    // In Supabase schreiben
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase
      .from("churn_assessments")
      .insert(record)
      .select()
      .single();

    if (error) throw new Error(`Supabase: ${error.message}`);
    return json({ ok: true, assessment: data }, 200);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message ?? e) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
