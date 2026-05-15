import WebSocket from "ws";
import https from "https";
import http from "http";
import path from "path";
import { promises as fsp } from "fs";

const API_BASE = "https://hummus.sys42.net/api/v6";
const GATEWAY_URL = "wss://hummus-gateway.sys42.net/?encoding=json&v=6";

const EMAIL    = process.env.BOT_EMAIL    ?? "";
const PASSWORD = process.env.BOT_PASSWORD ?? "";
const PREFIX   = "b!";

const DATA_FILE = path.join(process.cwd(), "user_data.json");
let STORE = { users: {} };
let saveScheduled = false;

async function loadStore() {
  try {
    const raw = await fsp.readFile(DATA_FILE, "utf8");
    STORE = JSON.parse(raw);
    console.log(`[Store] Loaded ${Object.keys(STORE.users || {}).length} users`);
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[Store] Failed to load:", err);
    STORE = { users: {} };
  }
  ensureStoreLists();
}

function ensureStoreLists() {
  STORE.users = STORE.users || {};
  STORE.whitelist = Array.isArray(STORE.whitelist) ? STORE.whitelist : [];
  STORE.blacklist = Array.isArray(STORE.blacklist) ? STORE.blacklist : [];
}

function formatUserList(list) {
  if (!list.length) return "none";
  return list.map((id) => STORE.users[id]?.username ?? id).join(", ");
}

function parseUserId(arg) {
  if (!arg) return null;
  const mentionMatch = arg.match(/^<@!?(\d+)>$/);
  if (mentionMatch) return mentionMatch[1];
  const idMatch = arg.match(/^(\d+)$/);
  return idMatch ? idMatch[1] : null;
}

function isUserAllowed(id, selfId) {
  if (id === selfId) return true;
  if (STORE.blacklist.includes(id)) return false;
  if (STORE.whitelist.length === 0) return true;
  return STORE.whitelist.includes(id);
}

function isBotOwner(id, selfId) {
  return id === selfId;
}

async function saveStore() {
  const tmp = DATA_FILE + ".tmp";
  try {
    await fsp.writeFile(tmp, JSON.stringify(STORE, null, 2), "utf8");
    await fsp.rename(tmp, DATA_FILE);
    saveScheduled = false;
    // console.log("[Store] Saved");
  } catch (err) {
    console.error("[Store] Failed to save:", err);
  }
}

function scheduleSave() {
  if (saveScheduled) return;
  saveScheduled = true;
  setTimeout(() => saveStore().catch((e) => console.error(e)), 1000);
}

function getUserStats(id) {
  if (!STORE.users[id]) STORE.users[id] = { id, username: null, messages: 0, lastUpdated: Date.now() };
  return STORE.users[id];
}

function incrementMessageCount(id, username) {
  if (!id) return;
  const u = getUserStats(id);
  u.username = username || u.username;
  u.messages = (u.messages || 0) + 1;
  u.lastUpdated = Date.now();
  scheduleSave();
}

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

            // quick !joke command (supports messages starting with !joke)
            try {
              if (content.toLowerCase().startsWith("!joke")) {
                const jokes = [
                  "Why don't scientists trust atoms? Because they make up everything!",
                  "I told my computer I needed a break, and it said 'No problem — I'll go to sleep.'",
                  "Why did the scarecrow win an award? Because he was outstanding in his field.",
                  "Why don't programmers like nature? Too many bugs.",
                  "Why did the math book look sad? It had too many problems.",
                  "I would tell a UDP joke, but you might not get it.",
                  "Parallel lines have so much in common. It’s a shame they’ll never meet.",
                  "Did you hear about the claustrophobic astronaut? He just needed a little space."
                ];
                const pick = jokes[Math.floor(Math.random() * jokes.length)];
                await send(msg.channel_id, pick, token);
                return;
              }
            } catch (err) {
              console.error("[Joke] Failed to send joke:", err);
            }

            // Track message counts for persistence
            try {
              if (msg.author && msg.author.id) incrementMessageCount(msg.author.id, msg.author.username);
            } catch (err) {
              console.error("[Store] Failed to increment message count:", err);
            }

            if (content.startsWith(PREFIX)) {
              const withoutPrefix = content.slice(PREFIX.length).trim();
              const [cmd, ...args] = withoutPrefix.split(/\s+/);
              const command = cmd?.toLowerCase();

              if (!command) return;
              if (!isUserAllowed(msg.author.id, selfId)) {
                await send(msg.channel_id, "You are not permitted to use bot commands.", token);
                return;
              }

              if (command === "say") {
                const text = args.join(" ");
                const nested = text.trim().toLowerCase().startsWith(PREFIX);
                if (nested) {
                  await send(msg.channel_id, `Nested commands are not allowed. Please do not pass another ${PREFIX} command to ${PREFIX}say.`, token);
                } else if (text) {
                  console.log(`[say] ${msg.author.username}: ${text}`);
                  await send(msg.channel_id, text, token);
                }
                return;
              }

              if (command === "spam") {
                if (msg.author.id !== selfId) {
                  await send(msg.channel_id, "Only the account owner may use this command.", token);
                } else {
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
                return;
              }

              if (command === "stats") {
                const mention = (Array.isArray(d.mentions) && d.mentions[0]) ? d.mentions[0] : null;
                const targetId = mention ? mention.id : msg.author.id;
                const stats = STORE.users[targetId];
                if (!stats) {
                  await send(msg.channel_id, "No stats recorded for that user.", token);
                } else {
                  await send(msg.channel_id, `${stats.username ?? targetId} — messages: ${stats.messages}` , token);
                }
                return;
              }

              if (command === "whitelist" || command === "blacklist") {
                if (!isBotOwner(msg.author.id, selfId)) {
                  await send(msg.channel_id, "Only the logged-in bot account may manage whitelist and blacklist entries.", token);
                  return;
                }

                const listName = command === "whitelist" ? "whitelist" : "blacklist";
                const subcmd = args[0]?.toLowerCase();
                const targetArg = args[1];
                const targetId = parseUserId(targetArg) || ((Array.isArray(d.mentions) && d.mentions[0]) ? d.mentions[0].id : null);

                if (!subcmd || subcmd === "list") {
                  await send(msg.channel_id, `${listName} entries: ${formatUserList(STORE[listName])}` , token);
                  return;
                }

                if (subcmd !== "add" && subcmd !== "remove") {
                  await send(msg.channel_id, `Usage: ${PREFIX}${listName} list | ${PREFIX}${listName} add <user> | ${PREFIX}${listName} remove <user>` , token);
                  return;
                }

                if (!targetId) {
                  await send(msg.channel_id, `Please provide a valid user mention or ID for ${PREFIX}${listName} ${subcmd}.` , token);
                  return;
                }

                const list = STORE[listName];
                const present = list.includes(targetId);
                if (subcmd === "add") {
                  if (present) {
                    await send(msg.channel_id, `${targetId} is already on the ${listName}.`, token);
                    return;
                  }
                  list.push(targetId);
                  await send(msg.channel_id, `${targetId} was added to the ${listName}.`, token);
                } else {
                  if (!present) {
                    await send(msg.channel_id, `${targetId} is not on the ${listName}.`, token);
                    return;
                  }
                  STORE[listName] = list.filter((id) => id !== targetId);
                  await send(msg.channel_id, `${targetId} was removed from the ${listName}.`, token);
                }
                scheduleSave();
                return;
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
  await loadStore();
  // autosave every 30s
  setInterval(() => saveStore().catch((e) => console.error(e)), 30000);
  const token = await login();
  const me = await apiRequest("GET", "/users/@me", undefined, token);
  console.log(`Authenticated as: ${me.username}`);

  // ensure store is saved on shutdown/crash
  const saveAndExit = (code = 0) => {
    saveStore().then(() => process.exit(code)).catch(() => process.exit(1));
  };
  process.on("SIGINT", () => saveAndExit(0));
  process.on("SIGTERM", () => saveAndExit(0));
  process.on("uncaughtException", (err) => { console.error(err); saveAndExit(1); });

  await startBot(token, me.id);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });