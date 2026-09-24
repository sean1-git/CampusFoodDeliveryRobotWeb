/**
 * SERVER-ONLY SSO integration seam. Call issueStudentSession only AFTER a
 * school SSO adapter verifies the token/assertion, issuer, audience, expiry,
 * login state/nonce, and student eligibility. This function does not verify
 * tokens and is intentionally NOT exposed as a public HTTP endpoint.
 * Never pass request body/header student IDs directly to it.
 */
export const SESSION_AGE = 7 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = "campus_demo_session";

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

export async function authenticatedSession(request, db, now) {
  const id = request.headers.get("cookie")?.split(";").map((value) => value.trim())
    .find((value) => value.startsWith(SESSION_COOKIE + "="))?.slice(SESSION_COOKIE.length + 1);
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return db.prepare(`SELECT s.* FROM sessions s JOIN accounts a ON a.id = s.account_id
    WHERE s.id = ? AND s.created_at > ? AND a.kind = 'student'`)
    .bind(id, now - SESSION_AGE).first();
}
