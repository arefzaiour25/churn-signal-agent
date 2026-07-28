-- Ausbaustufe A (Retrieval): abgeschlossene Alt-Fälle als "Gedächtnis".
-- Bei jedem Lauf zieht der Code die 1-2 ähnlichsten Fälle heran, um die
-- Empfehlung zu erden. Bewusst simpel gehalten (Stichwort-Überlappung, kein pgvector).

create table if not exists public.past_cases (
  id        uuid primary key default gen_random_uuid(),
  customer  text not null,
  situation text not null,   -- was passiert ist (Signale/Kontext)
  outcome   text not null    -- wie es ausgegangen ist
);

insert into public.past_cases (customer, situation, outcome) values
  ('Tischlerei Vogt',
   'Beschwerte sich über stark sinkende Bewerbungszahlen und fragte nach den monatlichen Kosten. Seit Wochen keine neue Stellenanzeige geschaltet.',
   'Gekündigt — Reaktion kam zu spät, Vertrag lief aus.'),

  ('Gärtnerei Sommer',
   'Nutzung deutlich eingebrochen, Kunde wirkte unzufrieden mit der Performance. Customer Success nahm proaktiv Kontakt auf und optimierte die Stellenanzeigen gemeinsam.',
   'Gehalten — Kunde verlängerte nach spürbarer Performance-Verbesserung.'),

  ('Autohaus Klein',
   'Support-Ticket wegen eines kurzen technischen Login-Problems, das schnell behoben war. Ansonsten aktive Nutzung mit regelmäßigen neuen Anzeigen.',
   'Kein Risiko — reines Support-Thema, Kunde blieb durchgehend aktiv.'),

  ('Schlosserei Neumann',
   'Kunde war mit dem Produkt inhaltlich zufrieden, aber verärgert über eine nicht eingehaltene Rückrufzusage. Äußerte Zweifel, ob sich das Ganze noch lohnt.',
   'Zurückgewonnen — persönlicher Entschuldigungs-Call stellte das Vertrauen wieder her.');
