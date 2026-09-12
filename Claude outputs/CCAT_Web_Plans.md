# CCAT Practice App (Web) — What Each Plan Gives the User

*Internal reference. Prices in CAD, one-year access on all paid plans. Source of truth for access: the gateway capability map (`apps/gateway/src/lib/entitlements.ts`) and the display catalog (`apps/web/src/lib/entitlements.ts`). Where those two disagree, it is flagged below.*

---

## What the web app is

A secure online practice platform for CCAT / NGAT-style reasoning. A child signs in with a username + 4-digit PIN (one active device at a time) and works through material in two modes:

- **Practice mode** — individual sets, one skill at a time, for building up a battery.
- **Exam mode** — full-length, timed mock papers that run the three reasoning batteries back-to-back, the way the real test does.

Around those two modes the app tracks **progress** (per-battery completion, scores, accuracy, time), awards **achievements**, and lets a child **bookmark** questions. A parent buys a plan once; access lasts a year.

The three reasoning batteries the content is organised around are Verbal, Quantitative, and Non-Verbal reasoning. *(Battery naming reflects the content structure in the catalog; treat the exact category labels as configurable rather than fixed.)*

---

## The four tiers at a glance

| Capability | Free ($0) | Standard ($49) | Plus ($99) | Premium ($199) |
|---|:---:|:---:|:---:|:---:|
| Individual practice sets | Set 1 only, each battery | All sets, all batteries | All sets, all batteries | All sets, all batteries |
| Battery Combine (mixed full-battery sets) | — | — | ✓ | ✓ |
| Full-length timed exam papers | — | — | ✓ | ✓ |
| Exam analytics / progress on exams | — | — | ✓ | ✓ |
| Weekly test | — | — | — | ✓ *(see note)* |
| Live 1-on-1 mentoring | — | — | — | ✓ (5 sessions) |
| Progress page | Locked | Practice only *(exam parts locked)* | Full | Full |
| Access term | Ongoing | 1 year | 1 year | 1 year |

`✓` = unlocked. `—` = not included at that tier. Locks are enforced server-side, not just hidden in the UI.

---

## Free — $0

The look-around tier, so a parent can see the real thing before paying.

The child gets **Set 1 of every practice topic** (the first published set in each non-combine battery). That's enough to see the question style, the interface, and how a set plays, in every reasoning area. Battery Combine and exam papers are not included, and the Progress page is locked. Everything else in the app (login, bookmarks, the general interface) works normally.

Use it as the on-ramp: the child practises a genuine set in each battery, the parent decides.

---

## Standard — $49 · 1-year access

*Positioned as: full access to practice material.*

Unlocks **every individual practice set, across all batteries** — not just Set 1. A child can work through the full library of single-skill sets, repeat them, and build each battery up at their own pace over the year.

What Standard does **not** include: Battery Combine (the mixed full-battery sets), full-length timed exam papers, and the exam side of the Progress page. Those open at Plus.

This is the plan for the family whose priority is *volume of practice* — lots of reps on each skill — rather than test-day simulation.

---

## Plus — $99 · 1-year access

*Positioned as: expanded access, including full battery tests and timed exams.*

Everything in Standard, plus the two things that turn practice into preparation:

- **Battery Combine** — mixed sets that run a whole battery end-to-end, instead of one skill at a time. This is how a child stops treating each skill in isolation and starts handling a full battery the way the test presents it.
- **Full-length timed exam papers** — complete mock papers, timed per battery, that mirror the real sitting. The exam auto-ends when the batteries run out of time, and the paper's result appears once the child finishes it.
- **Exam analytics** — the Exam box and Exam Progress panel on the Progress page unlock, so a parent can see per-paper and per-battery scores, accuracy, and the time the child actually took on each battery.

This is the plan where a parent can answer "is my child ready?" with data, not a guess.

---

## Premium — $199 · 1-year access · *Best value*

*Positioned as: complete preparation — practice, exams, and personal mentoring.*

Everything in Plus, plus a human in the loop:

- **5 live 1-on-1 mentoring sessions** — direct time with a Concept Mastery instructor, the part self-serve practice can't replace: someone who looks at how *this* child is doing and coaches accordingly.
- **Weekly test** — a recurring test checkpoint. **⚠️ Flag:** this is still present in the code (`t500` capability map and the display catalog list "Weekly test"), but you asked to remove "Weekly test checkpoint" from the landing page. The landing copy was updated; the in-app entitlement was **not**. Decide one of two things: (a) keep Weekly test as a real Premium feature and restore it to the landing, or (b) remove it from the in-app catalog and capability map too, so the code matches the site. Right now they're inconsistent.

This is the plan for the family that wants the full runway plus personal guidance, not just more content.

---

## How the tiers stack

Each paid tier is a strict superset of the one below it — nobody loses anything by moving up:

- **Free → Standard:** Set 1 only → the entire practice library.
- **Standard → Plus:** practice-only → full battery tests + timed mock exams + exam analytics.
- **Plus → Premium:** self-serve → adds live 1-on-1 mentoring (and, pending the decision above, the weekly test).

Upgrades only go up — the app never offers a downgrade or a same-tier repurchase.

---

## Open item to resolve

The **Weekly test** inconsistency above is the one thing in this doc that isn't clean. Everything else — practice, combine, exams, analytics, mentoring, the lock behaviour — matches between the site, the app, and the server. Settle Weekly test and this table is fully accurate end-to-end.
