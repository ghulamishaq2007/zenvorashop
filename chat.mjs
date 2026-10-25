import { getStore } from "@netlify/blobs";

const WA = "03232974451";
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";

const SYSTEM = `Tum ZENVORA SHOOP ke official AI sales assistant ho. ZENVORA SHOOP Karachi ka online Pakistani fashion store hai (website: zenvorashoop.netlify.app).

ZABAN: Customer jis zaban mein likhe (Roman Urdu, Urdu ya English) usi mein jawab do. Jawab chhote, dostana aur saaf rakho (2-5 lines). Emojis kam use karo.

STORE INFO:
- Delivery sirf Karachi mein (DHA, Clifton, Gulshan, PECHS, Nazimabad, Korangi, Malir wagera). Doorstep delivery 2 se 3 din. Same day / next day dispatch.
- Cash on Delivery available hai aur customer payment se pehle order inspect kar sakta hai.
- Order WhatsApp par: ${WA} (https://wa.me/92${WA.slice(1)}) ya website ke Cart se.
- Order track karne ke liye: zenvorashoop.netlify.app/my-order
- Return/Refund policy ke liye: zenvorashoop.netlify.app/return-policy
- VIP Membership sirf loyal customers ko WhatsApp ke zariye milti hai.

PRODUCTS (current sale price, Rs.):
Ladies Suits: Turquoise Block Printed 3Pcs Maxi 2529 | Blue Embroidered Cotton Lawn 3Pcs 3330 | Royal Blue Chiffon Maxi Gold Embroidery 3300 | Printed Lawn 3-Piece Multicolor 3930 | Brown Embroidered 3-Piece Cotton Lawn 3330 | Pakistani Printed Lawn White Green 2190 | Red Arabic Lawn 2190
Gents Suits: Grey Wash & Wear Kurta Suit SW-2 2929 | Wash & Wear Plain Brown All Season 2939 | Cotton Unstitched Light Brown Summer 3120 | Formal Black Wash & Wear Italian Cut 2939 | Khaddar Plain Blue Summer 2559
Handbags: Girl's Leather Textured Hand Bag 2639 | Girl's Leather Textured Shoulder Bag 2639
Sandals: Orange Cross Strap Rexine Slides 1790 | Women's White Rexine Fancy Slippers 1740
Men Wallet: Double Fold Stylish Wallet 1500
Watch: Black Skeleton Chronograph Watch for Men 3500

RULES:
- Sirf upar di gayi information use karo. Stock, size availability, exact delivery charges ya koi aur cheez jo yahan nahi likhi, usay andaza se mat batao; kaho ke WhatsApp par confirm kar lein.
- Koi discount ya price change khud se offer mat karo.
- Order lena ho to customer se ye cheezein pucho: naam, phone number, mukammal address (Karachi), product aur size/colour. Phir kaho ke order confirm karne ke liye WhatsApp ${WA} par yahi details bhej dein.
- Karachi ke bahar delivery ke bare mein kaho ke WhatsApp par pooch lein.
- Complaint, damaged/wrong product ya gussa hone par pehle maafi mango aur WhatsApp par rabta karne ko kaho.
- Website ke bare mein ya fashion se related sawalon ke ilawa baaki topics par politely kaho ke tum sirf ZENVORA SHOOP ke bare mein madad kar sakte ho.
- Kabhi mat kaho ke tum insaan ho. Agar puchha jaye to batao ke tum AI assistant ho.`;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });

export default async (req, context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }

  const sessionId = String(body.sessionId || "");
  const message = String(body.message || "").trim().slice(0, 1000);
  if (!/^[a-zA-Z0-9-]{10,64}$/.test(sessionId) || !message) {
    return json({ error: "Invalid request" }, 400);
  }

  const store = getStore("chats");
  const key = `chat-${sessionId}`;
  const chat =
    (await store.get(key, { type: "json" })) || {
      id: sessionId,
      createdAt: Date.now(),
      visitor: {
        ip: context.ip || "",
        country: context.geo?.country?.name || "",
        city: context.geo?.city || "",
        device: (req.headers.get("user-agent") || "").slice(0, 200),
        page: String(body.page || "").slice(0, 200),
      },
      messages: [],
    };

  if (chat.messages.length >= 120) {
    return json({ reply: `Is chat ki limit poori ho gayi hai. Baqi baat ke liye WhatsApp par rabta karein: ${WA}` });
  }

  chat.messages.push({ role: "user", content: message, ts: Date.now() });

  let reply;
  let failed = false;
  try {
    const history = chat.messages.slice(-20).map((m) => ({ role: m.role, content: m.content }));
    while (history.length && history[0].role !== "user") history.shift();

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, system: SYSTEM, messages: history }),
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    reply = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (!reply) throw new Error("empty reply");
  } catch (err) {
    console.error(err);
    failed = true;
    reply = `Maazrat, abhi thori technical problem hai. Please WhatsApp par rabta karein: ${WA}`;
  }

  chat.messages.push({ role: "assistant", content: reply, ts: Date.now(), ...(failed && { error: true }) });
  chat.updatedAt = Date.now();
  await store.setJSON(key, chat);

  return json({ reply });
};

export const config = { path: "/api/chat" };
