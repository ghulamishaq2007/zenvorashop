import { getStore } from "@netlify/blobs";
import { jwtVerify, createRemoteJWKSet } from "jose";

const JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")
);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

// returns 200 (ok), 401 (not logged in / bad token) or 403 (logged in but not an allowed admin)
async function check(req) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const allowed = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
  if (!projectId || !allowed.length || !token) return 401;
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    });
    const email = String(payload.email || "").toLowerCase();
    return allowed.includes(email) ? 200 : 403;
  } catch {
    return 401;
  }
}

export default async (req) => {
  const status = await check(req);
  if (status !== 200) return json({ error: status === 403 ? "Forbidden" : "Unauthorized" }, status);

  const store = getStore("chats");
  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (id) {
    if (!/^[a-zA-Z0-9-]{10,64}$/.test(id)) return json({ error: "Bad id" }, 400);
    if (req.method === "DELETE") {
      await store.delete(`chat-${id}`);
      return json({ ok: true });
    }
    const chat = await store.get(`chat-${id}`, { type: "json" });
    return chat ? json(chat) : json({ error: "Not found" }, 404);
  }

  const { blobs } = await store.list({ prefix: "chat-" });
  const chats = await Promise.all(
    blobs.slice(0, 300).map((b) => store.get(b.key, { type: "json" }).catch(() => null))
  );

  const list = chats
    .filter(Boolean)
    .map((c) => {
      const msgs = c.messages || [];
      const last = msgs[msgs.length - 1];
      return {
        id: c.id,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt || c.createdAt,
        visitor: c.visitor,
        count: msgs.length,
        firstQuestion: (msgs.find((m) => m.role === "user") || {}).content || "",
        last: last ? last.content.slice(0, 100) : "",
        hasError: msgs.some((m) => m.error),
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return json({ chats: list });
};

export const config = { path: "/api/admin" };
