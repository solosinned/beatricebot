import WebSocket from "ws";
import https from "https";
import http from "http";

const API_BASE = "https://hummus.sys42.net/api/v6";
const GATEWAY_URL = "wss://hummus-gateway.sys42.net/?encoding=json&v=6";

const EMAIL    = process.env.BOT_EMAIL    ?? "";
const PASSWORD = process.env.BOT_PASSWORD ?? "";
const PREFIX   = "b!";

function apiRequest(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const url  = new URL(`${API_BASE}${urlPath}`);
    const lib  = url.protocol === "https:" ? https : http;
    const req  = lib.request(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: token } : {}),
        ...(data  ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login() {
  if (!EMAIL || !PASSWORD) { console.error("BOT_EMAIL and BOT_PASSWORD must be set."); process.exit(1); }
  const res = await apiRequest("POST", "/auth/login", { email: EMAIL, password: PASSWORD });
  if (!res.token) { console.error("Login failed:", res.message ?? JSON.stringify(res)); process.exit(1); }
  return res.token;
}

async function send(channelId, content, token) {
  await apiRequest("POST", `/channels/${channelId}/messages`, { content }, token);
}

async function startBot(token, selfId) {
  let heartbeatInterval = null;
  let sequence = null;
  let reconnectDelay = 1000;

  function connect() {
    console.log("[Gateway] Connecting...");
    const ws = new WebSocket(GATEWAY_URL, { headers: { Origin: "https://hmus.sys42.net" } });

    ws.on("open", () => { console.log("[Gateway] Connected"); reconnectDelay = 1000; });

    ws.on("message", async (raw) => {
      const payload = JSON.parse(raw.toString());
      if (payload.s != null) sequence = payload.s;

      switch (payload.op) {
        case 10: {
          const { heartbeat_interval } = payload.d;
          if (heartbeatInterval) clearInterval(heartbeatInterval);
          heartbeatInterval = setInterval(
            () => ws.send(JSON.stringify({ op: 1, d: sequence })),
            heartbeat_interval
          );
          ws.send(JSON.stringify({
            op: 2,
            d: {
              token,
              properties: { $os: "linux", $browser: "friendbot", $device: "friendbot" },
              presence: { status: "online", afk: false },
            },
          }));
          break;
        }

        case 0: {
          const { t, d } = payload;

          if (t === "READY") {
            console.log(`[Bot] Logged in as ${d.user.username}`);
            for (const guild of d.guilds) {
              ws.send(JSON.stringify({
                op: 14,
                d: { guild_id: guild.id, typing: true, activities: true, threads: true, members: [] },
              }));
            }
          }

          if (t === "MESSAGE_CREATE") {
            const msg = d;
            const content = (msg.content ?? "").trim();

            if (content.startsWith(PREFIX)) {
              const withoutPrefix = content.slice(PREFIX.length).trim();
              const [cmd, ...args] = withoutPrefix.split(/\s+/);

              if (cmd?.toLowerCase() === "say") {
                const text = args.join(" ");
                if (text) {
                  console.log(`[say] ${msg.author.username}: ${text}`);
                  await send(msg.channel_id, text, token);
                }
              }

              if (cmd?.toLowerCase() === "spam") {
                const amount = parseInt(args[0]);
                const text = args.slice(1).join(" ");
                if (isNaN(amount) || amount < 1 || amount > 1000) {
                  await send(msg.channel_id, "Invalid amount. Please provide a number between 1 and 1000.", token);
                } else if (!text) {
                  await send(msg.channel_id, "Please provide text to spam.", token);
                } else {
                  console.log(`[spam] ${msg.author.username}: ${amount} times "${text}"`);
                  for (let i = 0; i < amount; i++) {
                    await send(msg.channel_id, text, token);
                  }
                }
              }
            }
          }
          break;
        }

        case 7: ws.close(); break;
        case 9: setTimeout(connect, 5000); break;
      }
    });

    ws.on("close", (code) => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      console.log(`[Gateway] Disconnected (${code}). Reconnecting in ${reconnectDelay / 1000}s...`);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    });

    ws.on("error", (err) => console.error("[Gateway] Error:", err.message));
  }

  connect();
}

async function main() {
  console.log("=== FriendBot ===");
  const token = await login();
  const me = await apiRequest("GET", "/users/@me", undefined, token);
  console.log(`Authenticated as: ${me.username}`);
  await startBot(token, me.id);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });