# FIXED_ISSUES — student web (apps/web)

Tracking doc for regressions that have been fixed and must not come back. Each item lists the fix and the
file(s) that own it, so a future change can be checked against this list.

## ⚠️ Recurring root cause — theme.css / types.ts keep getting rolled back
The single most common breakage in recent sessions is NOT a bad edit — it is `apps/web/src/theme.css`
(and `packages/api-client/src/types.ts`) being **reverted to an older version** by a merge/checkout, which
drops the appended CSS/type blocks while the TSX that depends on them stays. Symptoms: sidebar renders as a
stuck-open drawer with an ✕ on desktop, Home cards become plain text, Progress content clips under the
sidebar; or the web build fails with "no exported member CurrentAvatar/ProgressSummary".

Before pushing, verify the working tree kept the additions:
```
git diff origin/master -- apps/web/src/theme.css | grep -E "#7b5cff|home-hero|p3-grid|q-figure"
git diff origin/master -- packages/api-client/src/types.ts | grep -E "CurrentAvatar|ProgressSummary|image_url"
```
The likely mechanism: the image-authoring branch forks from before the api-client/CSS work, so each merge
that touches these two files must carry those blocks forward, not overwrite them.

## Fixed items (must stay true)

- [x] **Single, in-flow S2 sidebar (no overlap).** Exactly one purple-gradient sidebar; content column
  reserves the rail width via `--rail-w`/`--rail-open` and is never painted over. Owner: `apps/web/src/App.tsx`
  (`.layout`/`.main`/`nav-expanded` push model) + `theme.css` (`.sidebar`, `.sidebar.expanded`,
  `.layout.nav-expanded`, `.sidebar-close{display:none}` on desktop, mobile drawer `@media(max-width:768px)`).
- [x] **S2 purple sidebar scheme.** Gradient `#7b5cff→#5b3ff0`, white brand text, active nav = white pill
  with `#5b3ff0` text, footer fox in a white circle. Owner: `theme.css` "SIDEBAR S2" block + `Sidebar.tsx`.
- [x] **CM brand header.** CM tile (white bg, `#5b3ff0` "CM") on the LEFT + "Concept Mastery / CCAT Practice"
  text on the RIGHT, as markup (crisp at any DPI). Owner: `Sidebar.tsx` (`.brand` → `.brand-tile` +
  `.brandtext`) + `theme.css` `.sidebar .brand-tile`.
- [x] **Fixed universal fox avatar.** Top-right header chip and sidebar footer both show the same fixed 🦊;
  the per-user equipped avatar is NOT read for display. Owner: `apps/web/src/components/Avatar.tsx`.
- [x] **Customize/Avatar picker removed from the UI.** Top-right chip is non-interactive (opens nothing);
  `/customize` route redirects to `/home`; nav item + `CustomizeScreen` import removed. Code kept in repo,
  unreachable. Owner: `AvatarControl.tsx`, `App.tsx`, `Sidebar.tsx`.
- [x] **Home dashboard styled.** Greeting hero + Coins/XP/Level/Badges cards + Progress & Analytics A4 card
  + Practice/Exam action cards + right rail render as styled cards, not plain text. Owner: `theme.css`
  (`.home-a/.home-hero/.home-grid/.home-rail/.stat-tiles/.stile/.entry-tile/.hp-tiles`).
- [x] **Progress page fills width, not clipped.** `.content.content-wide` (max-width 1240px) fills WITHIN
  the shell; P3 bento; no horizontal body scroll. Owner: `theme.css` + `ProgressScreen.tsx`.
- [x] **Question/option figures.** Images render in Practice, Exam, and bookmark review from the gateway's
  flat `image_url` (block fallback for review); lazy, alt text, hide-on-error, no layout jump. Owner:
  `apps/web/src/components/ui.tsx` (`Figure`), `SessionScreen.tsx`, `BookmarksScreen.tsx`, `theme.css`.

## Change log
- Restored `theme.css` after a 4th rollback of the appended shell/Home/S2/Progress/figure blocks (rebuilt
  from the complete baseline + re-applied all blocks). No markup changed; only CSS was missing.
