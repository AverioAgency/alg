-- Welche Firmen ein Suchlauf geliefert hat, neue wie wiedergefundene.
--
-- first_seen_run_id kennt nur Erstfunde: ein Autohaus, das schon in der
-- Datenbank stand, gehoert trotzdem zum Ergebnis der neuen Suche. Ohne diese
-- Liste musste die Bewertung mit all:true ueber den ganzen Workspace laufen -
-- eine Suche nach Autohaeusern bewertete und zeigte die Restaurants der
-- Vortage.
--
-- Additiv: eine nullable jsonb-Spalte. Alte Zeilen bleiben NULL, alter Code
-- sieht die Spalte nicht.

alter table search_runs
  add column if not exists company_ids jsonb;
