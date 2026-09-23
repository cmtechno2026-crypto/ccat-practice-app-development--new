import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

// Guard test for the Parent Booking Links (A) + Booking Requests inbox (B) endpoints. The booking
// logic itself runs against the SEPARATE TeachTime DB (public.ta_booking_*), which is not the CCAT
// test DB — it was verified end-to-end against the live cm-whiteboard schema. Here we only assert the
// new routes are REGISTERED and AUTH-GATED: an unauthenticated call must be rejected before it ever
// touches the teacher pool (so it never leaks 404 "route not found" or reaches the DB).
let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(loadConfig()); await app.ready(); });
afterAll(async () => { await app.close(); });

async function call(method: string, url: string, body?: unknown) {
  const res = await app.inject({ method: method as any, url, payload: body as any,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {} });
  return res.statusCode;
}

describe('Teacher Hub booking endpoints — registered + auth-gated', () => {
  const routes: [string, string, unknown?][] = [
    ['GET', '/v1/admin/teacher/booking-links'],
    ['GET', '/v1/admin/teacher/booking-links/preview?teacher_ids=x&grade=5&subject=Math'],
    ['POST', '/v1/admin/teacher/booking-links', { teacher_ids: [], grade: 5, subject: 'Math' }],
    ['PATCH', '/v1/admin/teacher/booking-links/00000000-0000-0000-0000-000000000000', { action: 'revoke' }],
    ['GET', '/v1/admin/teacher/booking-requests'],
    ['GET', '/v1/admin/teacher/booking-requests/pending-count'],
    ['POST', '/v1/admin/teacher/booking-requests/00000000-0000-0000-0000-000000000000/approve', {}],
    ['POST', '/v1/admin/teacher/booking-requests/00000000-0000-0000-0000-000000000000/reject', {}],
  ];
  for (const [method, url, body] of routes) {
    it(`${method} ${url.split('?')[0]} is registered and rejects unauthenticated`, async () => {
      const status = await call(method, url, body);
      // Registered but unauthenticated → 401 (never 404 route-not-found).
      expect(status).not.toBe(404);
      expect(status).toBe(401);
    });
  }
});
