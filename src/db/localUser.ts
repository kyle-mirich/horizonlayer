import { getPool } from './client.js';

export interface LocalUser {
  avatar_url: string | null;
  display_name: string | null;
  id: string;
  oidc_issuer: string | null;
  oidc_subject: string | null;
  primary_email: string | null;
}

export async function ensureLocalUser(): Promise<LocalUser> {
  const issuer = 'local://horizon-layer';
  const subject = 'local-user';
  const displayName = 'Local Horizon Layer User';
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
