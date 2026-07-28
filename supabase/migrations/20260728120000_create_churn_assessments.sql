-- Tabelle: ein Datensatz pro Churn-Bewertungslauf.
-- Spalten sind bewusst nach "wer befüllt sie" gruppiert:
--   1) Eingang, 2) deterministisch vom Code, 3) vom Sprachmodell, 4) Ausbaustufe, 5) Meta.

create table if not exists public.churn_assessments (
  id          uuid        primary key default gen_random_uuid(),
  created_at  timestamptz not null    default now(),

  -- 1) Eingang -----------------------------------------------------------
  customer_name text not null,
  raw_input     text not null,          -- Original-Payload, für Audit & Debugging

  -- 2) Deterministisch vom Code -----------------------------------------
  arr          numeric,                 -- aus Text geparst; NULL = "unbekannt"
  arr_at_risk  numeric,                 -- = arr wenn bekannt, sonst NULL (nicht raten!)
  escalation_tier text                  -- reine Geschäftsregel, NICHT vom Modell
    check (escalation_tier in ('cs_eigenstaendig','retention_gespraech','eskalation_founder')),

  -- 3) Vom Sprachmodell bewertet ----------------------------------------
  churn_risk_score int  check (churn_risk_score between 0 and 100),
  risk_level       text check (risk_level in ('low','medium','high','critical')),
  signals_detected jsonb not null default '[]'::jsonb,
  recommended_action text,
  confidence       text check (confidence in ('low','medium','high')),
  reasoning        text,

  -- 4) Ausbaustufe A (Retrieval); sonst leeres Array --------------------
  similar_cases jsonb not null default '[]'::jsonb,

  -- 5) Meta -------------------------------------------------------------
  model text                            -- welches Claude-Modell den Lauf gemacht hat
);

-- Neueste Bewertungen zuerst abfragbar
create index if not exists churn_assessments_created_at_idx
  on public.churn_assessments (created_at desc);
