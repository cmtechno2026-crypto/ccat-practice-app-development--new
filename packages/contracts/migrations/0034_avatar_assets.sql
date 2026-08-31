-- 0034_avatar_assets.sql
-- Avatar image persistence (§20).
--   1. content_assets gains a stable public_url, written at upload time — an absolute Supabase Storage
--      URL in production, or the Gateway's own /v1/assets/:id route under the local-disk driver. Lists
--      (student /v1/avatars, admin avatars) then simply SELECT it; no per-request URL signing.
--   2. Guarantee the canonical 5 avatar families × 7 XP-gated stages exist so the Admin "Avatars"
--      manager and the student picker render a real 5×7 grid. Idempotent: existing families/stages are
--      left exactly as they are (admin owns their live/active state); only what is missing is created.

alter table ccat.content_assets
  add column if not exists public_url text;   -- resolved public URL for the stored object

do $$
declare
  ladder int[] := array[0, 50, 120, 220, 350, 520, 750];      -- XP thresholds, stage 1..7
  fam_keys  text[] := array['animals', 'bird', 'aquatic', 'space', 'mythic'];
  fam_names text[] := array['Animals', 'Birds', 'Aquatic', 'Space', 'Mythic'];
  fid uuid;
  i int;
  n int;
begin
  for i in 1 .. array_length(fam_keys, 1) loop
    select id into fid from ccat.avatar_families where key = fam_keys[i];
    if fid is null then
      insert into ccat.avatar_families(key, name, display_order, active)
        values (fam_keys[i], fam_names[i],
                (select coalesce(max(display_order), 0) + 1 from ccat.avatar_families), true)
        returning id into fid;
    end if;
    for n in 1 .. 7 loop
      insert into ccat.avatar_stages(family_id, stage_number, name, required_xp, active)
        values (fid, n, fam_names[i] || ' · Stage ' || n, ladder[n], true)
        on conflict (family_id, stage_number) do nothing;
    end loop;
  end loop;
end $$;
