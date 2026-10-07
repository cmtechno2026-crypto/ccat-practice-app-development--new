-- 0067_math_study_material_render.sql
-- Study Material rasterize + watermark pipeline (Phase 1 backend).
--
-- Adds render bookkeeping to ccat.study_materials and provisions a PRIVATE Supabase Storage
-- bucket for the ORIGINAL files and the un-watermarked base page images. Hard-block design
-- (owner decision: strongest real protection): the original file and raw page images live
-- ONLY in this private bucket and are never served by URL. Students receive per-page images
-- that the gateway watermarks (student identity) at request time and streams no-store. This
-- stops the raw bytes from ever reaching the browser; it cannot stop screenshots (no browser
-- mechanism can). Additive + idempotent. CCAT/NGAT untouched.
begin;

alter table ccat.study_materials add column if not exists source_kind  text;      -- 'pdf' | 'pptx'
alter table ccat.study_materials add column if not exists page_count   int;
alter table ccat.study_materials add column if not exists render_state text not null default 'processing'; -- processing | ready | failed
alter table ccat.study_materials add column if not exists render_error text;
alter table ccat.study_materials add column if not exists pages_prefix text;       -- secure-bucket prefix holding base page images

commit;

-- PRIVATE bucket for secure study material (source files + base page images). public=false so
-- nothing is reachable by URL; the gateway reads with the service-role key. Guarded so the
-- gateway's own migrate runner (which may lack storage-schema privileges) skips it without failing;
-- the authoritative provisioning path is the Supabase admin connection (MCP apply_migration).
do $$
begin
  insert into storage.buckets (id, name, public)
  values ('study-secure', 'study-secure', false)
  on conflict (id) do nothing;
exception
  when insufficient_privilege or undefined_table or undefined_object then
    raise notice 'skip study-secure bucket provisioning (no storage privilege here): %', sqlerrm;
end $$;
