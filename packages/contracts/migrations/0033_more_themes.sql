-- 0033_more_themes.sql — 15 new student themes (7 free + 8 XP-unlockable), a mix of solid + gradient.
-- Same model as the existing themes (ccat.themes.palette jsonb of CSS token -> value; theme_unlock_rules
-- rule_expr {"type":"default"} = free, {"type":"xp_total","threshold":N} = unlock at XP). Gradient support
-- is enabled by the new --app-bg token (apps/web: body background = var(--app-bg, <default>), applied with
-- `background`). Existing themes (sky/aurora/meadow/sunset) are left untouched. Idempotent.
set search_path = ccat, public;

insert into ccat.themes (id, key, name, palette, active) values
 ('c3000000-0000-0000-0000-000000000010','ocean_blue','Ocean Blue',
   '{"--primary":"#2563EB","--primary-dark":"#1E40AF","--ink":"#0F172A","--card":"#FFFFFF","--tint-blue":"#DBEAFE","--app-bg":"#F0F6FF"}'::jsonb, true),
 ('c3000000-0000-0000-0000-000000000011','forest_green','Forest Green',
   '{"--primary":"#16A34A","--primary-dark":"#15803D","--ink":"#0F172A","--card":"#FFFFFF","--tint-blue":"#DCFCE7","--app-bg":"#F0FDF4"}'::jsonb, true),
 ('c3000000-0000-0000-0000-000000000012','sunset_coral','Sunset Coral',
   '{"--primary":"#F97316","--primary-dark":"#EA580C","--ink":"#1F2937","--card":"#FFFFFF","--tint-blue":"#FFE4D5","--app-bg":"#FFF7ED"}'::jsonb, true),
 ('c3000000-0000-0000-0000-000000000013','grape_purple','Grape Purple',
   '{"--primary":"#7C3AED","--primary-dark":"#6D28D9","--ink":"#1F2937","--card":"#FFFFFF","--tint-blue":"#EDE9FE","--app-bg":"#F5F3FF"}'::jsonb, true),
 ('c3000000-0000-0000-0000-000000000014','rose_pink','Rose Pink',
   '{"--primary":"#EC4899","--primary-dark":"#DB2777","--ink":"#1F2937","--card":"#FFFFFF","--tint-blue":"#FCE7F3","--app-bg":"#FDF2F8"}'::jsonb, true),
 ('c3000000-0000-0000-0000-000000000015','midnight_slate','Midnight Slate',
   '{"--primary":"#38BDF8","--primary-dark":"#6366F1","--ink":"#E2E8F0","--card":"#1E293B","--tint-blue":"#BAE6FD","--app-bg":"#0F172A"}'::jsonb, true),
 ('c3000000-0000-0000-0000-000000000016','sky_mint','Sky Mint',
   '{"--primary":"#0EA5E9","--primary-dark":"#0284C7","--ink":"#0F172A","--card":"#FFFFFF","--tint-blue":"#DBEAFE","--app-bg":"linear-gradient(135deg,#A7F3D0,#BFDBFE)"}'::jsonb, true),
 ('c3000000-0000-0000-0000-000000000017','aurora_grad','Aurora',
   '{"--primary":"#6366F1","--primary-dark":"#8B5CF6","--ink":"#FFFFFF","--card":"rgba(17,24,39,0.55)","--tint-blue":"#E9D5FF","--app-bg":"linear-gradient(135deg,#6366F1,#8B5CF6,#EC4899)"}'::jsonb, true),
 ('c3000000-0000-0000-0000-000000000018','peach_sorbet','Peach Sorbet',
   '{"--primary":"#F97316","--primary-dark":"#EA580C","--ink":"#3B2F2F","--card":"#FFFFFF","--tint-blue":"#FEE2C7","--app-bg":"linear-gradient(135deg,#FDE68A,#FCA5A5)"}'::jsonb, true),
 ('c3000000-0000-0000-0000-000000000019','deep_space','Deep Space',
   '{"--primary":"#6366F1","--primary-dark":"#4338CA","--ink":"#E5E7EB","--card":"#1E1B4B","--tint-blue":"#C7D2FE","--app-bg":"linear-gradient(160deg,#0F172A,#312E81)"}'::jsonb, true),
 ('c3000000-0000-0000-0000-00000000001a','emerald_lagoon','Emerald Lagoon',
   '{"--primary":"#10B981","--primary-dark":"#0EA5E9","--ink":"#06281F","--card":"#FFFFFF","--tint-blue":"#D1FAE5","--app-bg":"linear-gradient(135deg,#10B981,#0EA5E9)"}'::jsonb, true),
 ('c3000000-0000-0000-0000-00000000001b','cotton_candy','Cotton Candy',
   '{"--primary":"#DB2777","--primary-dark":"#C026D3","--ink":"#3B2F3A","--card":"#FFFFFF","--tint-blue":"#FBE3F3","--app-bg":"linear-gradient(135deg,#C4B5FD,#F9A8D4,#FBCFE8)"}'::jsonb, true),
 ('c3000000-0000-0000-0000-00000000001c','golden_hour','Golden Hour',
   '{"--primary":"#F59E0B","--primary-dark":"#EF4444","--ink":"#FFFFFF","--card":"rgba(17,24,39,0.50)","--tint-blue":"#FDE7B0","--app-bg":"linear-gradient(135deg,#F59E0B,#EF4444)"}'::jsonb, true),
 ('c3000000-0000-0000-0000-00000000001d','cyber_neon','Cyber Neon',
   '{"--primary":"#22D3EE","--primary-dark":"#A855F7","--ink":"#E5E7EB","--card":"#131A2E","--tint-blue":"#A5F3FC","--app-bg":"#0B1020"}'::jsonb, true),
 ('c3000000-0000-0000-0000-00000000001e','bubblegum','Bubblegum',
   '{"--primary":"#DB2777","--primary-dark":"#BE185D","--ink":"#1F2937","--card":"#FFFFFF","--tint-blue":"#FBE3F3","--app-bg":"#FFF1F7"}'::jsonb, true)
on conflict (id) do update set name = excluded.name, palette = excluded.palette, active = true;

-- Unlock rules: 7 FREE (default) + 8 XP-unlockable (xp_total ladder), matching the existing gating style.
insert into ccat.theme_unlock_rules (theme_id, version_number, rule_expr, active) values
 ('c3000000-0000-0000-0000-000000000010',1,'{"type":"default"}'::jsonb,true),
 ('c3000000-0000-0000-0000-000000000011',1,'{"type":"default"}'::jsonb,true),
 ('c3000000-0000-0000-0000-000000000012',1,'{"type":"default"}'::jsonb,true),
 ('c3000000-0000-0000-0000-000000000013',1,'{"type":"default"}'::jsonb,true),
 ('c3000000-0000-0000-0000-000000000014',1,'{"type":"default"}'::jsonb,true),
 ('c3000000-0000-0000-0000-000000000015',1,'{"type":"default"}'::jsonb,true),
 ('c3000000-0000-0000-0000-000000000016',1,'{"type":"default"}'::jsonb,true),
 ('c3000000-0000-0000-0000-000000000017',1,'{"type":"xp_total","threshold":25}'::jsonb,true),
 ('c3000000-0000-0000-0000-000000000018',1,'{"type":"xp_total","threshold":50}'::jsonb,true),
 ('c3000000-0000-0000-0000-000000000019',1,'{"type":"xp_total","threshold":75}'::jsonb,true),
 ('c3000000-0000-0000-0000-00000000001a',1,'{"type":"xp_total","threshold":100}'::jsonb,true),
 ('c3000000-0000-0000-0000-00000000001b',1,'{"type":"xp_total","threshold":150}'::jsonb,true),
 ('c3000000-0000-0000-0000-00000000001c',1,'{"type":"xp_total","threshold":200}'::jsonb,true),
 ('c3000000-0000-0000-0000-00000000001d',1,'{"type":"xp_total","threshold":300}'::jsonb,true),
 ('c3000000-0000-0000-0000-00000000001e',1,'{"type":"xp_total","threshold":500}'::jsonb,true)
on conflict (theme_id, version_number) do update set rule_expr = excluded.rule_expr, active = true;
