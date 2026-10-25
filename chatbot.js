(() => {
  const API = "/api/chat";
  const GREETING =
    "Assalam o Alaikum! 👋 Main ZENVORA SHOOP ka AI assistant hoon. Suits, bags, sandals, price ya delivery ke bare mein kuch bhi puchein.";
  const QUICK = ["Ladies suits dikhao", "Delivery kitne din mein?", "Order kaise karun?"];

  const safe = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  let sid = safe.get("zv_sid");
  if (!sid) {
    sid = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + "-" + Math.random().toString(36).slice(2, 12);
    safe.set("zv_sid", sid);
  }
  let saved = [];
  try { saved = JSON.parse(safe.get("zv_msgs") || "[]"); } catch {}

  const style = document.createElement("style");
  style.textContent = `
  #zv-btn{position:fixed;right:18px;bottom:84px;width:58px;height:58px;border-radius:50%;border:0;background:#111;color:#f5c542;font-size:26px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.35);z-index:99998}
  #zv-box{position:fixed;right:18px;bottom:152px;width:340px;max-width:calc(100vw - 24px);height:480px;max-height:calc(100vh - 170px);background:#fff;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.3);display:none;flex-direction:column;overflow:hidden;z-index:99999;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  #zv-box.open{display:flex}
  #zv-head{background:#111;color:#fff;padding:12px 14px;display:flex;justify-content:space-between;align-items:center}
  #zv-head b{font-size:15px}#zv-head small{display:block;color:#f5c542;font-size:11px}
  #zv-x{background:none;border:0;color:#fff;font-size:20px;cursor:pointer}
  #zv-msgs{flex:1;overflow-y:auto;padding:12px;background:#f6f6f6;display:flex;flex-direction:column;gap:8px}
  .zv-m{max-width:82%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}
  .zv-u{align-self:flex-end;background:#111;color:#fff;border-bottom-right-radius:4px}
  .zv-b{align-self:flex-start;background:#fff;color:#111;border:1px solid #e5e5e5;border-bottom-left-radius:4px}
  .zv-q{display:flex;flex-wrap:wrap;gap:6px}
  .zv-q button{border:1px solid #111;background:#fff;border-radius:16px;padding:5px 10px;font-size:12px;cursor:pointer}
  #zv-row{display:flex;gap:6px;padding:10px;border-top:1px solid #eee;background:#fff}
  #zv-in{flex:1;border:1px solid #ddd;border-radius:20px;padding:9px 13px;font-size:14px;outline:none}
  #zv-send{border:0;background:#111;color:#f5c542;border-radius:20px;padding:0 16px;cursor:pointer;font-weight:600}
  #zv-note{font-size:10px;color:#888;text-align:center;padding:0 8px 6px;background:#fff}`;
  document.head.appendChild(style);

  const btn = document.createElement("button");
  btn.id = "zv-btn"; btn.setAttribute("aria-label", "Chat with us"); btn.textContent = "💬";
  const box = document.createElement("div");
  box.id = "zv-box";
  box.innerHTML = `<div id="zv-head"><div><b>ZENVORA SHOOP</b><small>AI Assistant • Online</small></div><button id="zv-x" aria-label="Close">×</button></div>
  <div id="zv-msgs"></div>
  <div id="zv-row"><input id="zv-in" placeholder="Apna sawal likhein..." maxlength="1000" autocomplete="off"><button id="zv-send">Send</button></div>
  <div id="zv-note">Support ke liye yeh chat save hoti hai.</div>`;
  document.body.append(btn, box);

  const msgs = box.querySelector("#zv-msgs");
  const input = box.querySelector("#zv-in");

  const add = (text, who) => {
    const d = document.createElement("div");
    d.className = "zv-m " + (who === "user" ? "zv-u" : "zv-b");
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  };
  const persist = () => safe.set("zv_msgs", JSON.stringify(saved.slice(-40)));

  function init() {
    if (msgs.childElementCount) return;
    add(GREETING, "bot");
    saved.forEach((m) => add(m.t, m.w));
    if (!saved.length) {
      const q = document.createElement("div");
      q.className = "zv-q";
      QUICK.forEach((t) => {
        const b = document.createElement("button");
        b.textContent = t;
        b.onclick = () => { q.remove(); send(t); };
        q.appendChild(b);
      });
      msgs.appendChild(q);
    }
  }

  let busy = false;
  async function send(text) {
    text = (text || input.value).trim();
    if (!text || busy) return;
    busy = true; input.value = "";
    add(text, "user"); saved.push({ w: "user", t: text }); persist();
    const typing = add("…", "bot");
    try {
      const r = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid, message: text, page: location.href }),
      });
      const data = await r.json();
      const reply = data.reply || "Maazrat, dobara koshish karein.";
      typing.textContent = reply;
      saved.push({ w: "bot", t: reply }); persist();
    } catch {
      typing.textContent = "Internet ka masla hai, dobara koshish karein ya WhatsApp par rabta karein: 03232974451";
    }
    msgs.scrollTop = msgs.scrollHeight;
    busy = false; input.focus();
  }

  btn.onclick = () => { box.classList.toggle("open"); init(); if (box.classList.contains("open")) input.focus(); };
  box.querySelector("#zv-x").onclick = () => box.classList.remove("open");
  box.querySelector("#zv-send").onclick = () => send();
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
})();
