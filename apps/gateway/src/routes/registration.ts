import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import { withTransaction } from '../db.js';
import type { Config } from '../config.js';
import { Errors } from '../errors.js';
import { hashSecret } from '../security/crypto.js';
import { signGrant, verifyGrant, grantValidated, type RegistrationGrant } from '../security/token.js';
import { deriveAgeYears } from '../lib/age.js';
import { grantReferralMilestone } from '../lib/referrals.js';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

// Registration flow (Blueprint §4). Minors-only product → the account is ALWAYS guardian-owned. ONE
// guardian_contact holds the guardian name + email + phone. Contacts are VALIDATED server-side (email
// format + E.164 phone WITH a country code), NOT verified by OTP — no code is generated, sent, or
// checked. Consent is persisted atomically with the student (§4.5, "create only if valid" §4.3). A
// short-lived signed grant carries the validated contact + consent state between the stateless steps.
// (The verification_challenges table is intentionally left in place so OTP can return later.)

const contactSchema = z.object({
  guardian_name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email('A valid email is required'),
  phone: z.string().trim().min(4),          // full validation (E.164 + country code) done below
  registration_grant: z.string().optional(), // present when the guardian edits + resubmits
});
const consentSchema = z.object({
  registration_grant: z.string(),
  policy_version: z.string(),
  consent_hash: z.string(),
});
const studentSchema = z.object({
  registration_grant: z.string(),
  display_name: z.string().min(1),
  username: z.string().min(3).max(40),
  grade_id: z.string().uuid(),
  birth_month: z.number().int().min(1).max(12),
  birth_year: z.number().int().min(1990).max(2100),
  pin: z.string().regex(/^\d{4}$/),
  device_hash: z.string().min(3),
  referral_code: z.string().trim().min(4).max(16).optional(), // optional invite code (Gate 2B)
});

export function registerRegistrationRoutes(app: FastifyInstance, db: DB, cfg: Config) {
  // Validate + persist the SINGLE guardian contact (name + email + phone). No OTP is generated, sent,
  // or checked — contacts are VALIDATED, not verified. Email must be a valid format (normalized to
  // lowercase by the schema); phone must parse to a valid E.164 number WITH a country code (real lib,
  // not a regex) and is stored normalized. Invalid email/phone → 422. Repeat email/phone is allowed
  // (siblings). Resubmitting with the grant updates the same guardian row (guardian editing).
  app.post('/v1/registration/contact/start', async (req, reply) => {
    const body = contactSchema.parse(req.body);
    const email = body.email; // schema already trimmed + lowercased + format-checked
    const parsed = parsePhoneNumberFromString(body.phone);
    if (!parsed || !parsed.isValid()) {
      throw Errors.validation('Enter a valid phone number including its country code (e.g. +14165551234).', { field: 'phone' });
    }
    const phoneE164 = parsed.number; // normalized E.164, e.g. +14165551234

    let guardianId: string;
    if (body.registration_grant) {
      const prev = verifyGrant(body.registration_grant, cfg.hmacSecret);
      if (!prev) throw Errors.unauthorized('Invalid or expired registration grant');
      guardianId = prev.guardianId;
      await db.query(
        `update ccat.guardian_contacts set name = $2, email = $3, phone = $4, updated_at = now() where id = $1`,
        [guardianId, body.guardian_name, email, phoneE164],
      );
    } else {
      const gc = await db.query(
        `insert into ccat.guardian_contacts(name, email, phone) values ($1, $2, $3) returning id`,
        [body.guardian_name, email, phoneE164],
      );
      guardianId = gc.rows[0]!.id;
    }

    // NOTE: email_verified_at / phone_verified_at are intentionally left NULL — the contact is
    // validated, not OTP-verified, and the data stays truthful.
    const grant: RegistrationGrant = {
      guardianId, guardianName: body.guardian_name,
      guardianEmail: email, guardianPhone: phoneE164,
      validated: true,
      exp: Math.floor(Date.now() / 1000) + 1800,
    };
    reply.code(200);
    return {
      registration_grant: signGrant(grant, cfg.hmacSecret),
      guardian_email: email,
      guardian_phone: phoneE164,
    };
  });

  app.post('/v1/registration/consent', async (req, reply) => {
    const body = consentSchema.parse(req.body);
    const grant = verifyGrant(body.registration_grant, cfg.hmacSecret);
    if (!grant) throw Errors.unauthorized('Invalid registration grant');
    if (!grantValidated(grant)) throw Errors.validation('Guardian contact must be validated first');
    const updated = signGrant(
      { ...grant, policyVersion: body.policy_version, consentHash: body.consent_hash },
      cfg.hmacSecret,
    );
    reply.code(201);
    return { registration_grant: updated };
  });

  app.post('/v1/registration/student', async (req, reply) => {
    const body = studentSchema.parse(req.body);
    const grant = verifyGrant(body.registration_grant, cfg.hmacSecret);
    if (!grant) throw Errors.unauthorized('Invalid registration grant');
    if (!grantValidated(grant)) throw Errors.validation('Guardian contact must be validated first');
    if (!grant.policyVersion || !grant.consentHash) throw Errors.validation('Consent not recorded');

    // Grade eligibility (§4.3): grade active + registration_enabled + age within bounds.
    const g = await db.query(
      `select id, active, registration_enabled, age_min_years, age_max_years from ccat.grades where id = $1`,
      [body.grade_id],
    );
    if (g.rows.length === 0) throw Errors.validation('Unknown grade');
    const grade = g.rows[0]!;
    if (!grade.active || !grade.registration_enabled) throw Errors.forbidden('REGISTRATION_DISABLED', 'Registration is not enabled for this grade');
    const age = deriveAgeYears(body.birth_month, body.birth_year);
    if (grade.age_min_years != null && age < grade.age_min_years) throw Errors.validation('Age below grade minimum', { age });
    if (grade.age_max_years != null && age > grade.age_max_years) throw Errors.validation('Age above grade maximum', { age });

    const pinHash = await hashSecret(body.pin, cfg.pinPepper);

    try {
      const result = await withTransaction(db, async (client) => {
        // The guardian_contact already exists (validated + persisted during contact/start). Re-check
        // it is real inside the tx — defence in depth, no duplicate row.
        const gcheck = await client.query(
          `select id from ccat.guardian_contacts where id = $1 and email is not null and phone is not null`,
          [grant.guardianId],
        );
        if (gcheck.rows.length === 0) throw Errors.validation('Guardian contact not found — re-enter the guardian details');
        const guardianId = grant.guardianId;
        const student = await client.query(
          `insert into ccat.students(username_normalized, display_name, grade_id, birth_month, birth_year)
           values ($1,$2,$3,$4,$5) returning id`,
          [body.username, body.display_name, body.grade_id, body.birth_month, body.birth_year],
        );
        const studentId = student.rows[0]!.id;
        await client.query(
          `insert into ccat.student_credentials(student_id, pin_hash) values ($1,$2)`,
          [studentId, pinHash],
        );
        await client.query(
          `insert into ccat.student_guardians(student_id, guardian_id, relationship, is_primary)
           values ($1,$2,'guardian',true)`,
          [studentId, guardianId],
        );
        await client.query(
          `insert into ccat.consents(student_id, guardian_id, policy_version, consent_hash)
           values ($1,$2,$3,$4)`,
          [studentId, guardianId, grant.policyVersion, grant.consentHash],
        );
        // First device becomes the sole active enrolled device (§5.1).
        await client.query(
          `insert into ccat.student_devices(student_id, device_hash, status, enrolled_at)
           values ($1,$2,'active',now())`,
          [studentId, body.device_hash],
        );
        await client.query(
          `insert into ccat.analytics_identities(student_id) values ($1)`,
          [studentId],
        );
        // Referral redemption (Gate 2B): if a valid invite code was supplied, link this new learner
        // to the referrer and grant the referrer their milestone bonus. A bad/unknown code is ignored
        // (never blocks registration). Codes are compared case-insensitively.
        if (body.referral_code) {
          const ref = await client.query(
            'select student_id from ccat.referral_codes where upper(code)=upper($1)', [body.referral_code],
          );
          const referrerId = ref.rows[0]?.student_id as string | undefined;
          if (referrerId && referrerId !== studentId) {
            await client.query(
              `insert into ccat.referral_redemptions(referrer_student_id, invited_student_id, code)
               values ($1,$2,$3) on conflict (invited_student_id) do nothing`,
              [referrerId, studentId, body.referral_code],
            );
            await grantReferralMilestone(client, referrerId);
          }
        }
        return { studentId, age };
      });
      reply.code(201);
      return {
        id: result.studentId,
        display_name: body.display_name,
        username: body.username,
        grade_id: body.grade_id,
        age_years: result.age,
        status: 'active',
      };
    } catch (e: any) {
      if (e?.code === '23505') throw Errors.usernameTaken();
      throw e;
    }
  });
}
