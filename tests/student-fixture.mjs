import { issueStudentSession } from "../server/auth.mjs";

// Test-only identity provider substitute. Never exposed to the HTTP application.
export async function studentSession(db, subject = crypto.randomUUID(), now = Date.now()) {
  const session = await issueStudentSession(db, { issuer: "https://school.test", subject }, now);
  return { ...session, cookie: session.cookie.split(";")[0] };
}
