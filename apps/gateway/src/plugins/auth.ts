import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db.js';
import { verifyToken } from '../security/token.js';
import { Errors } from '../errors.js';

// Request-time enforcement (Blueprint §5.4): every authenticated student request re-validates
// the application session, current student status, current enrolled device, and token family.
// Revocation takes effect on the next request. The token is NOT trusted on its own.

export interface StudentContext {
  studentId: string;
  deviceId: string;
  authSessionId: string;
  isPreview: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    student?: StudentContext;
  }
}

export function makeAuthenticateStudent(db: DB, hmacSecret: string) {
  return async function authenticateStudent(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) throw Errors.unauthorized();
    const payload = verifyToken(header.slice(7), hmacSecret);
    if (!payload) throw Errors.unauthorized('Invalid or expired token');

    // Validate session + student status + device in one query.
    const { rows } = await db.query(
      `select s.status as student_status,
              s.is_preview as is_preview,
              d.status as device_status,
              a.revoked_at as session_revoked
         from ccat.auth_sessions a
         join ccat.students s on s.id = a.student_id
         join ccat.student_devices d on d.id = a.device_id
        where a.id = $1 and a.student_id = $2 and a.device_id = $3`,
      [payload.sid, payload.sub, payload.did],
    );
    if (rows.length === 0) throw Errors.unauthorized('Session not found');
    const row = rows[0]!;
    if (row.session_revoked) throw Errors.unauthorized('Session revoked');
    if (row.student_status !== 'active') throw Errors.forbidden('ACCOUNT_NOT_ACTIVE', `Account is ${row.student_status}`);
    if (row.device_status !== 'active') throw Errors.deviceNotEnrolled();

    req.student = { studentId: payload.sub, deviceId: payload.did, authSessionId: payload.sid, isPreview: row.is_preview === true };
    await db.query('update ccat.auth_sessions set last_used_at = now() where id = $1', [payload.sid]);
  };
}
