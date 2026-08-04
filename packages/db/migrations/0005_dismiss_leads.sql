-- Leads ausblenden, ohne sie zu verlieren.
--
-- Getrennt von `feedback`, weil "passt nicht zu mir" und "die Rubrik hat ihn
-- falsch bewertet" verschiedene Aussagen sind. Die Kalibrierung liest nur
-- feedback; ein ausgeblendeter Lead darf sie nicht verzerren.
--
-- Additiv: eine nullable Spalte und ein partieller Index. Bestehende Zeilen
-- bekommen NULL und bleiben damit sichtbar, alter Code sieht die Spalte nicht.

alter table lead_scores
  add column if not exists dismissed_at timestamptz;

-- Die Liste zeigt fast immer nur nicht-ausgeblendete Leads, sortiert nach
-- Score. Ein partieller Index deckt genau diese Abfrage ab, ohne den
-- bestehenden Rang-Index zu verbreitern.
create index if not exists lead_scores_visible_idx
  on lead_scores (workspace_id, rubric_id, total desc)
  where dismissed_at is null;
