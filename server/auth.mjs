/**
 * SERVER-ONLY SSO integration seam. Call issueStudentSession only AFTER a
 * school SSO adapter verifies the token/assertion, issuer, audience, expiry,
 * login state/nonce, and student eligibility. This function does not verify
 * tokens and is intentionally NOT exposed as a public HTTP endpoint.
 * Never pass request body/header student IDs directly to it.
 */
export const SESSION_AGE = 7 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = "campus_demo_session";
// The existing 'legacy' database kind represents anonymous accounts. Use a
// dedicated issuer for NEW demo visitors; old legacy cookies stay invalid.
export const DEMO_ISSUER = "campus-demo-v1";
export const eligibleAccountSql = `(a.kind = 'student' OR (a.kind = 'legacy' AND a.issuer = '${DEMO_ISSUER}'))`;

export async function issueDemoSession(db, now = Date.now(), secure = true) {
  const accountId = crypto.randomUUID();
  const session = { id: crypto.randomUUID(), csrf: crypto.randomUUID(), account_id: accountId };
  // Account and session creation must succeed together. No identity is taken
  // from request headers, body fields, or a client-selected cookie value.
  await db.batch([
    db.prepare("INSERT INTO accounts (id, issuer, subject, kind, created_at) VALUES (?, ?, ?, 'legacy', ?)")
      .bind(accountId, DEMO_ISSUER, accountId, now),
    db.prepare("INSERT INTO sessions (id, csrf, account_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(session.id, session.csrf, accountId, now),
  ]);
  return { ...session,
    cookie: `${SESSION_COOKIE}=${session.id}; Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Max-Age=${SESSION_AGE / 1000}` };
}

export async function issueStudentSession(db, verifiedIdentity, now = Date.now()) {
  const { issuer, subject } = verifiedIdentity ?? {};
  if (typeof issuer !== "string" || !issuer.startsWith("https://") || issuer.length > 2048
    || typeof subject !== "string" || !subject.trim() || subject.length > 255) {
    throw new Error("Verified SSO issuer and subject are required.");
  }
  await db.prepare(`INSERT INTO accounts (id, issuer, subject, kind, created_at)
    VALUES (?, ?, ?, 'student', ?) ON CONFLICT(issuer, subject) DO NOTHING`)
    .bind(crypto.randomUUID(), issuer, subject, now).run();
  const account = await db.prepare("SELECT id FROM accounts WHERE issuer = ? AND subject = ? AND kind = 'student'")
    .bind(issuer, subject).first();
  if (!account) throw new Error("Student account is unavailable.");
  const session = { id: crypto.randomUUID(), csrf: crypto.randomUUID(), account_id: account.id };
  await db.prepare("INSERT INTO sessions (id, csrf, account_id, created_at) VALUES (?, ?, ?, ?)")
    .bind(session.id, session.csrf, account.id, now).run();
  return { ...session,
    cookie: `${SESSION_COOKIE}=${session.id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_AGE / 1000}` };
}

export async function authenticatedSession(request, db, now, allowDemo = false) {
  const id = request.headers.get("cookie")?.split(";").map((value) => value.trim())
    .find((value) => value.startsWith(SESSION_COOKIE + "="))?.slice(SESSION_COOKIE.length + 1);
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return db.prepare(`SELECT s.* FROM sessions s JOIN accounts a ON a.id = s.account_id
    WHERE s.id = ? AND s.created_at > ? AND ${allowDemo ? eligibleAccountSql : "a.kind = 'student'"}`)
    .bind(id, now - SESSION_AGE).first();
}
