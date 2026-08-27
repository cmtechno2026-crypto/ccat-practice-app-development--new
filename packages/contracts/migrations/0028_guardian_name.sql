-- Onboarding: capture the guardian's name at registration (mockup + CONFIG). The guardian_contacts
-- row already holds email/phone + verified timestamps; add an optional display name so the Web Admin
-- student directory can show who consented. Additive + nullable — no existing row is affected.
alter table ccat.guardian_contacts add column if not exists name text;
