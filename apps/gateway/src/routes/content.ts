import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHmac, timingSafeEqual, randomInt } from 'node:crypto';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';

// Announcements carousel + Book Store (Blueprint §21, §26.1, §32.6).

const challengeSchema = z.object({ answer: z.string() });
const handoffSchema = z.object({ challenge_token: z.string(), answer: z.string(), retailer_link_id: z.string().uuid().optional() });

// Stateless adult-gate: an arithmetic challenge whose answer is bound into an HMAC token
// (Blueprint §21: adult challenge only, no OTP, no reusable guardian session). Passing it
// authorizes ONLY the retailer hand-off.
function signChallenge(bookId: string, answer: number, secret: string): string {
  const payload = `${bookId}.${answer}.${Math.floor(Date.now() / 1000) + 300}`;
  const sig = createHmac('sha256', secret + ':adult').update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}
function verifyChallenge(token: string, bookId: string, answer: string, secret: string): boolean {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret + ':adult').update(Buffer.from(payloadB64, 'base64url')).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const [tokBook, tokAnswer, tokExp] = Buffer.from(payloadB64, 'base64url').toString().split('.');
  if (tokBook !== bookId) return false;
  if (Number(tokExp) * 1000 < Date.now()) return false;
  return tokAnswer === String(Number(answer));
}

export function registerContentRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  // GET /v1/announcements — published carousel for the student's grade (§26.1)
  app.get('/v1/announcements', { preHandler: [app.authenticateStudent] }, async (req) => {
    const { rows } = await db.query(
      `select a.id, a.title, a.body_blocks, a.image_asset_id, a.carousel_order
         from ccat.announcements a
         join ccat.students st on st.id = $1
        where a.state = 'published'
          and (a.ends_at is null or a.ends_at > now())
          and (a.target_grades is null or array_length(a.target_grades,1) is null or st.grade_id = any(a.target_grades))
        order by a.carousel_order nulls last, a.published_at desc`,
      [req.student!.studentId],
    );
    return rows;
  });

  // GET /v1/books — the full active book catalog (§21). Returns books for ALL grades (each row
  // carries its grade_ids + subject) so the client can render the mockup's grade tiles / grade +
  // subject filters and let the student browse the whole store. Auth still required.
  app.get('/v1/books', { preHandler: [app.authenticateStudent] }, async (_req) => {
    const { rows } = await db.query(
      `select b.id, b.title, b.author, b.description, b.cover_asset_id, b.price_cents, b.original_price_cents, b.subject, b.grade_ids,
              coalesce(json_agg(json_build_object('id', l.id, 'retailer', l.retailer, 'kind', l.kind)
                       order by l.display_order) filter (where l.id is not null), '[]') as retailers
         from ccat.books b
         left join ccat.book_retailer_links l on l.book_id = b.id and l.active = true
        where b.active = true
        group by b.id
        order by b.subject nulls last, b.title`,
    );
    return rows;
  });

  // POST /v1/books/:id/adult-challenge — issue an adult arithmetic challenge (§21)
  app.post('/v1/books/:id/adult-challenge', { preHandler: [app.authenticateStudent] }, async (req) => {
    const id = (req.params as { id: string }).id;
    const book = await db.query('select 1 from ccat.books where id=$1 and active=true', [id]);
    if (book.rows.length === 0) throw Errors.notFound('Book not found');
    const a = randomInt(11, 49); const b = randomInt(11, 49);
    const token = signChallenge(id, a + b, cfg.hmacSecret);
    return { challenge_token: token, prompt: `What is ${a} + ${b}?` };
  });

  // POST /v1/books/:id/retailer-handoff — validate adult gate, return allowlisted HTTPS URL (§21, §32.6)
  app.post('/v1/books/:id/retailer-handoff', { preHandler: [app.authenticateStudent] }, async (req) => {
    const id = (req.params as { id: string }).id;
    const body = handoffSchema.parse(req.body);
    if (!verifyChallenge(body.challenge_token, id, body.answer, cfg.hmacSecret)) {
      throw Errors.forbidden('ADULT_CHALLENGE_FAILED', 'Adult verification failed');
    }
    const link = body.retailer_link_id
      ? await db.query('select destination_url from ccat.book_retailer_links where id=$1 and book_id=$2 and active=true', [body.retailer_link_id, id])
      : await db.query('select destination_url from ccat.book_retailer_links where book_id=$1 and active=true order by display_order limit 1', [id]);
    if (link.rows.length === 0) throw Errors.notFound('Retailer link not found');
    // destination_url is HTTPS by DB constraint and backend-controlled (client cannot submit URLs).
    return { destination_url: link.rows[0]!.destination_url };
  });
}

// (challengeSchema kept for future explicit-answer variants)
void challengeSchema;
