// Lokales Testskript für die Kern-Logik (ohne Webhook, ohne DB).
// Ziel: sehen, dass Claude die 3 Beispiel-Inputs zuverlässig bewertet.
// Start:  node local-test.mjs
//
// Dieselbe Logik wandert danach 1:1 in die Supabase Edge Function.

import { readFileSync } from "node:fs";

// --- .env laden (ohne Zusatzpaket) ----------------------------------------
const env = Object.fromEntries(
  readFileSync(new URL("./.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-5"; // Sonnet: bessere Urteilskraft bei dünnen/widersprüchlichen Signalen

// ==========================================================================
// TEIL A — Deterministischer Code (KEIN Modell)
// ==========================================================================

// ARR aus dem Text ziehen. "3.400 EUR" -> 3400 | "unbekannt" -> null
function parseArr(text) {
  const line = text.split("\n").find((l) => /arr\s*:/i.test(l)) ?? "";
  if (/unbekannt|unknown|n\/?a/i.test(line)) return null;
  const m = line.match(/[\d.,]+/);
  if (!m) return null;
  const num = parseFloat(m[0].replace(/\./g, "").replace(",", "."));
  return Number.isFinite(num) ? num : null;
}

// Kundenname aus "Kunde: X"
function parseCustomerName(text) {
  const line = text.split("\n").find((l) => /kunde\s*:/i.test(l)) ?? "";
  return line.split(":").slice(1).join(":").trim() || "Unbekannt";
}

// Eskalationsstufe = reine Geschäftsregel. Ohne ARR keine wertbasierte Stufe.
function escalationTier(arr) {
  if (arr == null) return null;          // ARR unbekannt -> bewusst keine Stufe raten
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

// Validierung: fängt ab, falls das Modell doch mal Unsinn liefert.
function validate(a) {
  const levels = ["low", "medium", "high", "critical"];
  const conf = ["low", "medium", "high"];
  if (typeof a?.churn_risk_score !== "number" || a.churn_risk_score < 0 || a.churn_risk_score > 100)
    return "churn_risk_score ungültig";
  if (!levels.includes(a?.risk_level)) return "risk_level ungültig";
  if (!conf.includes(a?.confidence)) return "confidence ungültig";
  if (!Array.isArray(a?.signals_detected)) return "signals_detected ungültig";
  return null; // ok
}

// Ein Claude-Aufruf mit erzwungenem Tool Use. Ein Retry bei ungültigem Output.
async function assessWithClaude(rawInput, attempt = 1) {
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
  const toolUse = data.content?.find((c) => c.type === "tool_use");
  const assessment = toolUse?.input;

  const err = validate(assessment);
  if (err) {
    if (attempt < 2) return assessWithClaude(rawInput, attempt + 1); // 1x Retry
    throw new Error(`Ungültiger Output nach Retry: ${err}`);
  }
  return assessment;
}

// ==========================================================================
// TEIL C — Zusammenbau (Code + Modell) -> finales Objekt
// ==========================================================================

async function run(rawInput) {
  const arr = parseArr(rawInput);                 // Code
  const customer_name = parseCustomerName(rawInput); // Code
  const model = await assessWithClaude(rawInput);    // Modell

  return {
    customer_name,
    churn_risk_score: model.churn_risk_score,
    risk_level: model.risk_level,
    signals_detected: model.signals_detected,
    arr,
    arr_at_risk: arr, // = ARR wenn bekannt, sonst null (nicht raten)
    recommended_action: model.recommended_action,
    escalation_tier: escalationTier(arr), // Code
    similar_cases: [], // Ausbaustufe A folgt
    confidence: model.confidence,
    reasoning: model.reasoning,
    model: MODEL,
  };
}

// --- Die 3 Beispiel-Inputs aus dem Case ------------------------------------
const INPUTS = [
  `Kunde: Bäckerei Landmann GmbH
ARR: 3.400 EUR
Signale:
- Support-Ticket vom 12.06.: "Wir bekommen kaum noch Bewerbungen über eure Plattform, das war mal anders."
- Nutzung: keine neue Stellenanzeige seit 9 Wochen, vorher im Schnitt 2 pro Monat.
- E-Mail des Geschäftsführers: "Bitte schickt mir mal eine Übersicht, was wir bei euch eigentlich monatlich zahlen."`,

  `Kunde: Kfz-Werkstatt Berger
ARR: 780 EUR
Signale:
- Support-Ticket vom 03.06.: "Login hat kurz nicht funktioniert, geht jetzt wieder."
- Nutzung: eine neue Anzeige letzte Woche geschaltet.`,

  `Kunde: Metallbau Sudholt
ARR: unbekannt
Signale:
- Telefonnotiz: "Kunde sehr zufrieden mit letzter Kampagne, lobt Bewerberqualität."
- Support-Ticket vom 10.06.: "Ihr habt versprochen zurückzurufen, ist nie passiert. Langsam überlege ich, ob sich das noch lohnt."`,
];

// --- Alle 3 nacheinander laufen lassen -------------------------------------
for (let i = 0; i < INPUTS.length; i++) {
  console.log(`\n===== INPUT ${i + 1} =====`);
  try {
    const result = await run(INPUTS[i]);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error("FEHLER:", e.message);
  }
}
