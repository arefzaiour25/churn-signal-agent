# Churn-Signal-Agent

Ein Webhook-getriebenes System, das aus rohen, unstrukturierten Kundensignalen ein
Churn-Risiko bewertet, eine konkrete Handlungsempfehlung ableitet und das Ergebnis
strukturiert in Supabase speichert.

**Stack:** Supabase Edge Function (Webhook, Deno/TypeScript) · Claude API (Bewertung) · Supabase Postgres (Datenziel)

---

## Datenfluss

```
POST (curl / Make / n8n)
  -> Supabase Edge Function "churn-agent"
       1. ARR aus Text parsen            (Code)
       2. Claude-Call (Tool Use)         -> Score / Signale / Empfehlung / Confidence
       3. escalation_tier + arr_at_risk  (Code, deterministische Geschäftsregel)
       4. Schema validieren, 1x Retry
       5. INSERT in Tabelle "churn_assessments"
  <- strukturiertes JSON (die gespeicherte Zeile)
```

## Wichtigste Designentscheidungen (in Kürze)

1. **Klare Trennung Modell vs. Code:** Das Sprachmodell macht nur die *fuzzy* Interpretation
   (Risiko-Score, erkannte Signale, Empfehlung, Confidence). Alles Deterministische — ARR
   parsen, `arr_at_risk`, die Eskalationsstufe — macht Code. Eine `ARR >= 3000`-Regel gehört
   nicht in ein LLM.
2. **Zuverlässiger Output durch Tool Use:** Claude wird per erzwungenem `tool_choice` gezwungen,
   ein festes Schema auszufüllen — dadurch ist der Output strukturell garantiert parsebar. Zusätzlich
   Validierung + ein Retry.
3. **Kein Halluzinieren bei Lücken:** Fehlt die ARR (Input 3), bleiben `arr` und `arr_at_risk`
   `null` und es wird keine Eskalationsstufe geraten — statt eine Zahl zu erfinden.
4. **Confidence als Ehrlichkeits-Signal:** Bei dünnen oder widersprüchlichen Signalen senkt das
   Modell die Confidence, statt falsch selbstbewusst zu wirken.
5. **Modellwahl Sonnet:** Die harten Fälle sind reine Urteilsfragen (dünne/widersprüchliche
   Signale) — dort ist Sonnet robuster als Haiku. Kosten sind bei diesem Volumen vernachlässigbar.

## Ausbaustufe A (Retrieval) — gebaut

In `past_cases` liegen abgeschlossene Alt-Fälle (Kunde, Situation, Ausgang). Bei jedem Lauf
findet der Code per **Stichwort-Überlappung** die 1–2 ähnlichsten Fälle, gibt sie Claude als
Kontext mit (erdet die Empfehlung) und legt sie strukturiert in `similar_cases` ab.

Bewusst simpel gehalten (kein pgvector, wie im Case erlaubt). Für Produktion wäre der nächste
Schritt semantische Ähnlichkeit über Embeddings (pgvector) statt reiner Wort-Überschneidung —
das fängt Synonyme/Umschreibungen, die die Stichwort-Suche verpasst.

**Ausbaustufe B (CRM-Rückschreiben)** wurde nicht gebaut, wird im Gespräch als Design-Frage
besprochen: Ergebnis (Risiko + Empfehlung + Eskalationsstufe) per Upsert an den Kundendatensatz
in Salesforce / einem Mock-CRM zurückschreiben, idempotent über eine externe Kunden-ID.

---

## Setup (Ziel: unter 10 Minuten)

**Voraussetzungen:** Node (für die Supabase CLI via `npx`), ein Supabase-Projekt, ein Anthropic API Key.

### 1. Tabelle anlegen
Den Inhalt von [`supabase/migrations/20260728120000_create_churn_assessments.sql`](supabase/migrations/20260728120000_create_churn_assessments.sql)
im **Supabase SQL-Editor** ausführen (oder `supabase db push`).

### 2. Secret setzen (Anthropic Key)
```bash
export SUPABASE_ACCESS_TOKEN=<dein-sbp-token>
npx supabase secrets set ANTHROPIC_API_KEY=<dein-anthropic-key> --project-ref <project-ref>
```
> `SUPABASE_URL` und `SUPABASE_SERVICE_ROLE_KEY` werden von Supabase automatisch in die
> Edge Function injiziert und müssen nicht gesetzt werden.

### 3. Function deployen
```bash
npx supabase functions deploy churn-agent --project-ref <project-ref> --no-verify-jwt
```

### 4. Testen
```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/churn-agent" \
  -H "content-type: application/json" \
  -d '{"input":"Kunde: Bäckerei Landmann GmbH\nARR: 3.400 EUR\nSignale:\n- Support-Ticket: \"Wir bekommen kaum noch Bewerbungen.\"\n- Nutzung: keine neue Anzeige seit 9 Wochen.\n- E-Mail des GF: \"Was zahlen wir eigentlich monatlich?\""}'
```
Die drei Beispiel-Inputs aus dem Case liegen zum Durchtesten in [`local-test.mjs`](local-test.mjs).

---

## Lokaler Test (nur Kern-Logik, ohne Deploy)
```bash
cp .env.example .env   # und Werte eintragen
node local-test.mjs    # läuft gegen alle 3 Beispiel-Inputs
```

## Output-Schema (ein Datensatz pro Lauf)

| Feld | Quelle | Beispiel |
|---|---|---|
| `customer_name` | Code | "Bäckerei Landmann GmbH" |
| `arr`, `arr_at_risk` | Code | 3400 / `null` bei unbekannt |
| `escalation_tier` | Code (Regel) | `eskalation_founder` |
| `churn_risk_score` (0–100) | Modell | 65 |
| `risk_level` | Modell | `high` |
| `signals_detected` | Modell | ["…", "…"] |
| `recommended_action` | Modell | "CS sollte …" |
| `confidence` | Modell | `low` / `medium` / `high` |
| `reasoning` | Modell | "Kombination aus …" |
| `similar_cases` | Ausbaustufe A | [{ customer, outcome, relevance }] |

### Eskalationslogik (deterministisch)
- ARR unter 1.000 € → `cs_eigenstaendig`
- ARR ab 1.000 € → `retention_gespraech`
- ARR ab 3.000 € → `eskalation_founder`
- ARR unbekannt → keine Stufe (`null`), bewusst kein Raten

---

## Projektstruktur
```
supabase/
  functions/churn-agent/index.ts   # der Webhook (Deno) — Kernlogik
  migrations/*.sql                 # Tabellen-Schema
local-test.mjs                     # lokaler Test der Kern-Logik (Node)
.env.example                       # Vorlage für Keys
```
