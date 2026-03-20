import { getPool } from '../db/client.js';

export interface OAuthUserProfile {
  email?: string | null;
  issuer: string;
  picture?: string | null;
  subject: string;
  username?: string | null;
}

export interface LocalUser {
  avatar_url: string | null;
  display_name: string | null;
  id: string;
  oidc_issuer: string | null;
  oidc_subject: string | null;
  primary_email: string | null;
}

function normalizeEmail(email?: string | null): string | null {
  return email ? email.trim().toLowerCase() : null;
}

export async function ensureSystemUser(params?: {
  displayName?: string;
  issuer?: string;
  subject?: string;
}): Promise<LocalUser> {
  const issuer = params?.issuer ?? 'system://legacy';
  const subject = params?.subject ?? 'workspace-owner';
  const displayName = params?.displayName ?? 'Legacy System Owner';
  const pool = getPool();

  const { rows: existingRows } = await pool.query<LocalUser>(
    `SELECT id, avatar_url, display_name, oidc_issuer, oidc_subject, primary_email
     FROM users
     WHERE oidc_issuer = $1 AND oidc_subject = $2
     LIMIT 1`,
    [issuer, subject]
  );
  if (existingRows[0]) {
    return existingRows[0];
  }

  const { rows } = await pool.query<LocalUser>(
    `INSERT INTO users (
       email,
       primary_email,
       display_name,
       avatar_url,
       picture_url,
       status,
       last_login_at,
       oidc_issuer,
       oidc_subject
     )
     VALUES (NULL, NULL, $1, NULL, NULL, 'active', NOW(), $2, $3)
     RETURNING id, avatar_url, display_name, oidc_issuer, oidc_subject, primary_email`,
    [displayName, issuer, subject]
  );
  return rows[0];
}

export async function upsertOAuthUser(profile: OAuthUserProfile): Promise<LocalUser> {
  const pool = getPool();
  const client = await pool.connect();
  const email = normalizeEmail(profile.email);
  const displayName = profile.username?.trim() || email || profile.subject;
  const picture = profile.picture ?? null;

  try {
    await client.query('BEGIN');

    const { rows: subjectRows } = await client.query<LocalUser>(
      `SELECT id, avatar_url, display_name, oidc_issuer, oidc_subject, primary_email
       FROM users
       WHERE oidc_issuer = $1 AND oidc_subject = $2
       LIMIT 1`,
      [profile.issuer, profile.subject]
    );

    let userId = subjectRows[0]?.id ?? null;
    if (!userId && email) {
      const { rows: emailRows } = await client.query<Pick<LocalUser, 'id'>>(
        `SELECT id
         FROM users
         WHERE LOWER(COALESCE(primary_email, email, '')) = $1
         LIMIT 1`,
        [email]
      );
      if (emailRows[0]) {
        throw new Error(`Email ${email} is already associated with another account`);
      }
    }

    if (userId) {
      const { rows } = await client.query<LocalUser>(
        `UPDATE users
         SET email = COALESCE($2, email),
             primary_email = COALESCE($2, primary_email),
             display_name = $3,
             avatar_url = $4,
             picture_url = $4,
             status = 'active',
             last_login_at = NOW(),
             oidc_issuer = $5,
             oidc_subject = $6,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, avatar_url, display_name, oidc_issuer, oidc_subject, primary_email`,
        [userId, email, displayName, picture, profile.issuer, profile.subject]
      );
      await client.query('COMMIT');
      return rows[0];
    }

    const { rows } = await client.query<LocalUser>(
      `INSERT INTO users (
         email,
         primary_email,
         display_name,
         avatar_url,
         picture_url,
         status,
         last_login_at,
         oidc_issuer,
         oidc_subject
       )
       VALUES ($1, $2, $3, $4, $4, 'active', NOW(), $5, $6)
       RETURNING id, avatar_url, display_name, oidc_issuer, oidc_subject, primary_email`,
      [email, email, displayName, picture, profile.issuer, profile.subject]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
