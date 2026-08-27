-- CONTENT-3: inline set authoring — per-set question-order policy + per-membership active flag.
-- Mockup: a set row expands to its questions with an Active/Inactive toggle per question and a
-- set-level "Order: fixed / shuffled" control (app.js togglePreserve / toggleActive). Publish counts
-- only ACTIVE questions (app.js: qs = questionsFor(id).filter(q=>q.active); publishable = qs>=5).
--
-- Order policy: false = shuffled per session (server seed, the existing default), true = fixed
-- authoring order. Default false preserves current runtime behavior for every existing set.
alter table ccat.question_set_versions
  add column if not exists preserve_order boolean not null default false;

-- Active flag: a question can remain a set member but be excluded from new sessions (inactive),
-- which is how the mockup greys a question out without removing it. Default true = unchanged.
alter table ccat.set_version_questions
  add column if not exists active boolean not null default true;
