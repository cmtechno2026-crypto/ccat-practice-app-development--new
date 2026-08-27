import type { DB } from '../db.js';

// Push PII guard (Blueprint §26.1: "push bodies never carry a child's name or score"). Push bodies
// are static admin templates, so the real risk is a merge field that would interpolate a child's
// name/score/xp at send time. We reject interpolation tokens for those fields. Generic copy like
// "improve your score!" is fine — only field-injecting tokens are blocked.
const PII_TOKENS = [
  /\{\{?\s*(name|first_?name|last_?name|student|child|score|xp|coins|points|grade)\b/i,
  /%\s*(name|first_?name|student|child|score|xp|coins)\s*%/i,
  /\$\{\s*(name|first_?name|student|child|score|xp|coins)/i,
  /\[\[?\s*(name|student|child|score|xp)\b/i,
];
export function checkPushPii(text: string): { safe: boolean; reason?: string } {
  for (const re of PII_TOKENS) {
    if (re.test(text)) return { safe: false, reason: "Push body must not interpolate a child's name, score or balance (§26.1). Remove merge fields such as {{name}} or {{score}}." };
  }
  return { safe: true };
}

// Scheduled-announcement publisher. Flips due 'scheduled' announcements to 'published' with the
// next carousel_order. Idempotent; safe to run on an interval alongside pg_cron.
export async function publishScheduledAnnouncements(db: DB): Promise<number> {
  const r = await db.query(
    `update ccat.announcements a set state='published', published_at=now(), version=version+1,
        carousel_order=(select coalesce(max(carousel_order),-1)+1 from ccat.announcements where state='published')
      where a.state='scheduled' and a.scheduled_at is not null and a.scheduled_at <= now()`,
  );
  return r.rowCount ?? 0;
}
