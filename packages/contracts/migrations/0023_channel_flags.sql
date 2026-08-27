-- 0023_channel_flags.sql
-- Per-client channel enable flags (admin-managed, no redeploy) — CONTROL guarantee (A).
-- Two booleans express all four states: both on = app + web; web off = app-only; app off = web-only;
-- both off = fully unavailable. Clients read these through the PUBLIC, unauthenticated endpoint
-- GET /v1/channel-status (gateway reads global_flags server-side; no client DB access) and honor them
-- with a clean "unavailable" state. Toggled from the admin console (audited, flags.emergency-gated).
insert into ccat.global_flags(key, value) values
  ('channel_web_enabled', true),
  ('channel_app_enabled', true)
on conflict (key) do nothing;
