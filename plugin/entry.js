"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/plugin/entry.ts
var entry_exports = {};
__export(entry_exports, {
  BACKGROUND_SERVICE_ID: () => BACKGROUND_SERVICE_ID,
  BACKGROUND_SERVICE_NAME: () => BACKGROUND_SERVICE_NAME,
  COMMAND_IDS: () => COMMAND_IDS,
  PANEL_COMMAND_IDS: () => PANEL_COMMAND_IDS,
  ROOM_COMMAND_IDS: () => ROOM_COMMAND_IDS,
  STATUS_TOPICS: () => STATUS_TOPICS,
  activate: () => activate,
  buildConfiguredProviders: () => buildConfiguredProviders,
  createRuntime: () => createRuntime,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(entry_exports);

// src/plugin/reply.ts
var REPLY_FIELDS = [
  "id",
  "type",
  "timestamp",
  "fullResponse",
  "summary"
];
var DEFAULT_SCHEDULER = {
  now: () => Date.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (id) => clearTimeout(id)
};
function collectAgentReply(sdk, options, hooks = {}, scheduler = DEFAULT_SCHEDULER) {
  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const idleGraceMs = options.idleGraceMs ?? 5e3;
  const timeoutMs = options.timeoutMs ?? 18e4;
  const fields = (options.fields ?? REPLY_FIELDS).slice();
  const seen = /* @__PURE__ */ new Set();
  const chunks = [];
  let since = 0;
  const startedAt = scheduler.now();
  let lastActivityAt = startedAt;
  let completeRequested = false;
  let cancelled = false;
  let finished = false;
  let timer;
  let sessionId = "";
  const { promise, resolve, reject } = Promise.withResolvers();
  function clearPending() {
    if (timer !== void 0) {
      scheduler.clearTimer(timer);
      timer = void 0;
    }
  }
  function finish(reason) {
    if (finished)
      return;
    finished = true;
    clearPending();
    resolve({ sessionId, text: chunks.join(""), chunks: chunks.slice(), reason });
  }
  function ingest(entry) {
    const key = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : `${entry.type ?? ""}@${entry.timestamp ?? ""}`;
    if (seen.has(key))
      return false;
    seen.add(key);
    if (typeof entry.timestamp === "number" && entry.timestamp > since) {
      since = entry.timestamp;
    }
    const text = typeof entry.fullResponse === "string" && entry.fullResponse.length > 0 ? entry.fullResponse : typeof entry.summary === "string" && entry.summary.length > 0 ? entry.summary : "";
    if (text.length === 0)
      return false;
    chunks.push(text);
    if (hooks.onChunk)
      hooks.onChunk(text, entry);
    return true;
  }
  async function drain() {
    const rows = await sdk.transcripts.read({ sessionId, fields: fields.slice(), since });
    let gotNew = false;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (ingest(row))
          gotNew = true;
      }
    }
    return gotNew;
  }
  async function tick() {
    if (finished)
      return;
    try {
      if (await drain())
        lastActivityAt = scheduler.now();
    } catch (error) {
      console.warn("transcripts.read failed: " + String(error));
    }
    if (finished)
      return;
    const now = scheduler.now();
    if (completeRequested) {
      finish("event");
      return;
    }
    if (now - startedAt >= timeoutMs) {
      finish("timeout");
      return;
    }
    if (chunks.length > 0 && now - lastActivityAt >= idleGraceMs) {
      finish("idle");
      return;
    }
    timer = scheduler.setTimer(() => {
      void tick();
    }, pollIntervalMs);
  }
  void (async () => {
    try {
      const dispatch = await sdk.agents.dispatch(options.agentId, options.prompt);
      sessionId = dispatch.sessionId;
      if (hooks.onSession)
        hooks.onSession(sessionId);
      if (cancelled) {
        finish("cancel");
        return;
      }
      void tick();
    } catch (error) {
      if (!finished) {
        finished = true;
        clearPending();
        reject(error);
      }
    }
  })();
  return {
    promise,
    markComplete() {
      completeRequested = true;
      if (!finished && sessionId.length > 0) {
        clearPending();
        void tick();
      }
    },
    cancel() {
      cancelled = true;
      finish("cancel");
    }
  };
}

// src/plugin/registry.ts
var BINDINGS_KEY = "relay:bindings";
var SECRET_PREFIX = "relay:secret:";
function conversationKey(provider, channelId) {
  return `${provider}:${channelId}`;
}
function parseBindings(raw) {
  if (typeof raw !== "string" || raw.length === 0)
    return {};
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
  } catch {
  }
  return {};
}
async function loadBindings(sdk) {
  return parseBindings(await sdk.storage.get(BINDINGS_KEY));
}
async function getBinding(sdk, key) {
  const bindings = await loadBindings(sdk);
  const agentId = bindings[key];
  return typeof agentId === "string" && agentId.length > 0 ? agentId : void 0;
}
async function setBinding(sdk, key, agentId) {
  const bindings = await loadBindings(sdk);
  bindings[key] = agentId;
  await sdk.storage.set(BINDINGS_KEY, JSON.stringify(bindings));
}
async function removeBinding(sdk, key) {
  const bindings = await loadBindings(sdk);
  if (!Object.prototype.hasOwnProperty.call(bindings, key))
    return false;
  delete bindings[key];
  await sdk.storage.set(BINDINGS_KEY, JSON.stringify(bindings));
  return true;
}
async function getSecret(sdk, name) {
  const value = await sdk.storage.get(SECRET_PREFIX + name);
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
async function setSecret(sdk, name, value) {
  await sdk.storage.set(SECRET_PREFIX + name, value);
}
function csv(value) {
  return value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}
async function readSetting(sdk, key, fallback) {
  const namespaced = await sdk.settings.get(`plugins.${sdk.pluginId}.${key}`);
  if (typeof namespaced === "string")
    return namespaced;
  const bare = await sdk.settings.get(key);
  if (typeof bare === "string")
    return bare;
  return fallback;
}
async function loadConfig(sdk) {
  return {
    enabledProviders: csv(await readSetting(sdk, "enabledProviders", "discord,slack")),
    logLevel: await readSetting(sdk, "logLevel", "info"),
    discord: {
      clientId: await readSetting(sdk, "discordClientId", ""),
      guildId: await readSetting(sdk, "discordGuildId", ""),
      allowedUserIds: csv(await readSetting(sdk, "discordAllowedUserIds", ""))
    },
    slack: {
      teamId: await readSetting(sdk, "slackTeamId", ""),
      appId: await readSetting(sdk, "slackAppId", ""),
      allowedUserIds: csv(await readSetting(sdk, "slackAllowedUserIds", ""))
    }
  };
}

// src/core/fences.ts
function parseFenceLine(line) {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})\s*(.*)$/);
  if (!m)
    return null;
  const char = m[1][0];
  const info = m[2].trim();
  if (char === "`" && info.includes("`"))
    return null;
  return { char, len: m[1].length, info };
}
function closesFence(open, fence) {
  return fence.char === open.char && fence.len >= open.len && fence.info === "";
}
function openLine(f) {
  return f.char.repeat(f.len) + (f.info ? f.info : "");
}
function closeLine(f) {
  return f.char.repeat(f.len);
}
function danglingFence(text) {
  let open = null;
  for (const line of text.split("\n")) {
    const fence = parseFenceLine(line);
    if (!fence)
      continue;
    if (open) {
      if (closesFence(open, fence))
        open = null;
    } else {
      open = fence;
    }
  }
  return open;
}

// src/core/splitMessage.ts
var DEFAULT_MAX_LENGTH = 1990;
function fenceReserve(text) {
  let maxPrepend = 0;
  let maxAppend = 0;
  for (const line of text.split("\n")) {
    const f = parseFenceLine(line);
    if (!f)
      continue;
    maxPrepend = Math.max(maxPrepend, openLine(f).length + 1);
    maxAppend = Math.max(maxAppend, closeLine(f).length + 1);
  }
  return maxPrepend + maxAppend;
}
var MENTION_TOKEN = /<(?:@[!&]?|#)\d+>/g;
function avoidMentionCut(text, splitAt) {
  MENTION_TOKEN.lastIndex = 0;
  let m;
  while ((m = MENTION_TOKEN.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (start >= splitAt)
      break;
    if (splitAt > start && splitAt < end) {
      return start > 0 ? start : splitAt;
    }
  }
  return splitAt;
}
function rawSplit(text, maxLength) {
  if (text.length <= maxLength)
    return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt <= 0)
      splitAt = maxLength;
    splitAt = avoidMentionCut(remaining, splitAt);
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0)
    parts.push(remaining);
  return parts;
}
function repairFences(parts) {
  const out = [];
  let carry = null;
  for (let part of parts) {
    if (carry)
      part = openLine(carry) + "\n" + part;
    const open = danglingFence(part);
    if (open) {
      part = part + "\n" + closeLine(open);
      carry = open;
    } else {
      carry = null;
    }
    out.push(part);
  }
  return out;
}
function splitMessage(text, maxLength = DEFAULT_MAX_LENGTH) {
  if (text.length <= maxLength)
    return [text];
  const reserve = fenceReserve(text);
  const budget = reserve > 0 ? Math.max(1, maxLength - reserve) : maxLength;
  const parts = rawSplit(text, budget);
  if (parts.length <= 1)
    return parts;
  return reserve > 0 ? repairFences(parts) : parts;
}

// src/plugin/providers/discord.ts
var GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
var API_BASE = "https://discord.com/api/v10";
var MESSAGE_LIMIT = 1990;
var DEFAULT_INTENTS = 1 << 0 | 1 << 9 | 1 << 12 | 1 << 15;
var OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11
};
var MAX_BACKOFF_MS = 3e4;
function createDiscordClient(options) {
  const sdk = options.sdk;
  const scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  const gatewayUrl = options.gatewayUrl ?? GATEWAY_URL;
  const apiBase = options.apiBase ?? API_BASE;
  const intents = options.intents ?? DEFAULT_INTENTS;
  const reconnectBaseMs = options.reconnectBaseMs ?? 1e3;
  const allowedUsers = options.config.allowedUserIds ?? [];
  const guildId = options.config.guildId;
  let socketId;
  let heartbeatIntervalMs = 0;
  let heartbeatTimer;
  let reconnectTimer;
  let awaitingAck = false;
  let lastSeq = null;
  let sessionId;
  let resumeUrl;
  let botUserId;
  let isConnected = false;
  let closed = false;
  let wantResume = false;
  let backoffAttempt = 0;
  function log(message) {
    console.warn("[relay:discord] " + message);
  }
  async function send(frame) {
    if (socketId === void 0)
      return;
    try {
      await sdk.net.send(socketId, JSON.stringify(frame));
    } catch (error) {
      log("gateway send failed: " + String(error));
    }
  }
  function sendIdentify() {
    void send({
      op: OP.IDENTIFY,
      d: {
        token: options.token,
        intents,
        properties: { os: "linux", browser: "maestro-relay", device: "maestro-relay" }
      }
    });
  }
  function sendResume() {
    void send({
      op: OP.RESUME,
      d: { token: options.token, session_id: sessionId, seq: lastSeq }
    });
  }
  function clearHeartbeat() {
    if (heartbeatTimer !== void 0) {
      scheduler.clearTimer(heartbeatTimer);
      heartbeatTimer = void 0;
    }
  }
  function beat() {
    if (awaitingAck) {
      reconnect(true);
      return;
    }
    awaitingAck = true;
    void send({ op: OP.HEARTBEAT, d: lastSeq });
  }
  function scheduleHeartbeat() {
    clearHeartbeat();
    heartbeatTimer = scheduler.setTimer(() => {
      beat();
      if (socketId !== void 0)
        scheduleHeartbeat();
    }, heartbeatIntervalMs);
  }
  function makeSink() {
    return async (message, reply) => {
      const text = reply.text.trim();
      if (text.length === 0)
        return;
      for (const chunk of splitMessage(text, MESSAGE_LIMIT)) {
        await postMessage(message.channelId, chunk);
      }
    };
  }
  async function postMessage(channelId, content) {
    try {
      await sdk.net.fetch(apiBase + "/channels/" + channelId + "/messages", {
        method: "POST",
        headers: {
          Authorization: "Bot " + options.token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ content })
      });
    } catch (error) {
      log("reply post failed: " + String(error));
    }
  }
  async function postAs(channelId, handle, text) {
    const body = text.trim();
    if (body.length === 0)
      return;
    const prefix = `**${handle}:** `;
    for (const chunk of splitMessage(body, MESSAGE_LIMIT - prefix.length)) {
      await postMessage(channelId, prefix + chunk);
    }
  }
  function handleMessageCreate(payload) {
    const author = payload.author;
    if (!author || typeof author.id !== "string")
      return;
    if (author.bot === true)
      return;
    if (botUserId !== void 0 && author.id === botUserId)
      return;
    const content = typeof payload.content === "string" ? payload.content : "";
    if (content.trim().length === 0)
      return;
    if (guildId && payload.guild_id !== guildId)
      return;
    if (allowedUsers.length > 0 && !allowedUsers.includes(author.id))
      return;
    const channelId = payload.channel_id;
    if (typeof channelId !== "string")
      return;
    const message = {
      provider: "discord",
      channelId,
      userId: author.id,
      text: content
    };
    void options.route(message, makeSink()).catch((error) => {
      log("route failed: " + String(error));
    });
  }
  function handleDispatch(eventName, data) {
    const payload = data ?? {};
    if (eventName === "READY") {
      if (typeof payload.session_id === "string")
        sessionId = payload.session_id;
      if (typeof payload.resume_gateway_url === "string")
        resumeUrl = payload.resume_gateway_url;
      const user = payload.user;
      if (user && typeof user.id === "string")
        botUserId = user.id;
      isConnected = true;
      backoffAttempt = 0;
    } else if (eventName === "RESUMED") {
      isConnected = true;
      backoffAttempt = 0;
    } else if (eventName === "MESSAGE_CREATE") {
      handleMessageCreate(payload);
    }
  }
  function handleFrame(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof frame.s === "number")
      lastSeq = frame.s;
    switch (frame.op) {
      case OP.HELLO: {
        const d = frame.d ?? {};
        heartbeatIntervalMs = typeof d.heartbeat_interval === "number" ? d.heartbeat_interval : 45e3;
        awaitingAck = false;
        scheduleHeartbeat();
        if (wantResume && sessionId !== void 0)
          sendResume();
        else
          sendIdentify();
        break;
      }
      case OP.DISPATCH:
        handleDispatch(frame.t, frame.d);
        break;
      case OP.HEARTBEAT:
        awaitingAck = false;
        beat();
        break;
      case OP.RECONNECT:
        reconnect(true);
        break;
      case OP.INVALID_SESSION:
        reconnect(frame.d === true);
        break;
      case OP.HEARTBEAT_ACK:
        awaitingAck = false;
        break;
      default:
        break;
    }
  }
  function onSocketEvent(event) {
    if (event.type === "message") {
      if (typeof event.data === "string")
        handleFrame(event.data);
      return;
    }
    isConnected = false;
    reconnect(true);
  }
  function teardownSocket() {
    clearHeartbeat();
    awaitingAck = false;
    isConnected = false;
    const id = socketId;
    socketId = void 0;
    if (id !== void 0) {
      void sdk.net.close(id).catch(() => {
      });
    }
  }
  function reconnect(resume) {
    teardownSocket();
    if (closed)
      return;
    if (!resume) {
      sessionId = void 0;
      resumeUrl = void 0;
      lastSeq = null;
    }
    wantResume = resume && sessionId !== void 0;
    if (reconnectTimer !== void 0)
      scheduler.clearTimer(reconnectTimer);
    const delay = Math.min(reconnectBaseMs * Math.pow(2, backoffAttempt), MAX_BACKOFF_MS);
    backoffAttempt += 1;
    reconnectTimer = scheduler.setTimer(() => {
      reconnectTimer = void 0;
      void connect();
    }, delay);
  }
  async function connect() {
    if (closed)
      return;
    if (socketId !== void 0)
      return;
    const url = wantResume && resumeUrl !== void 0 ? resumeUrl + "/?v=10&encoding=json" : gatewayUrl;
    try {
      const result = await sdk.net.connect(url);
      socketId = result.socketId;
      sdk.events.on("net.connect:" + result.socketId, (payload) => {
        onSocketEvent(payload);
      });
    } catch (error) {
      log("gateway connect failed: " + String(error));
      isConnected = false;
      if (!closed)
        reconnect(false);
    }
  }
  return {
    name: "discord",
    async connect() {
      closed = false;
      await connect();
    },
    disconnect() {
      closed = true;
      if (reconnectTimer !== void 0) {
        scheduler.clearTimer(reconnectTimer);
        reconnectTimer = void 0;
      }
      teardownSocket();
    },
    connected() {
      return isConnected;
    },
    postAs
  };
}

// src/plugin/providers/slack.ts
var WEB_API_BASE = "https://slack.com/api";
var MESSAGE_LIMIT2 = 3900;
var MAX_BACKOFF_MS2 = 3e4;
var IGNORED_SUBTYPES = {
  message_changed: true,
  message_deleted: true,
  message_replied: true,
  bot_message: true,
  tombstone: true,
  channel_join: true,
  channel_leave: true,
  channel_topic: true,
  channel_purpose: true,
  channel_name: true,
  channel_archive: true,
  channel_unarchive: true
};
function parseJsonBody(result) {
  const r = result;
  const raw = r && typeof r.body === "string" ? r.body : void 0;
  if (raw === void 0 || raw.length === 0)
    return void 0;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function createSlackClient(options) {
  const sdk = options.sdk;
  const scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  const apiBase = options.apiBase ?? WEB_API_BASE;
  const reconnectBaseMs = options.reconnectBaseMs ?? 1e3;
  const allowedUsers = options.config.allowedUserIds ?? [];
  const teamId = options.config.teamId;
  let socketId;
  let reconnectTimer;
  let isConnected = false;
  let closed = false;
  let backoffAttempt = 0;
  const seenEventKeys = /* @__PURE__ */ new Set();
  const seenLimit = 200;
  function log(message) {
    console.warn("[relay:slack] " + message);
  }
  async function send(frame) {
    if (socketId === void 0)
      return;
    try {
      await sdk.net.send(socketId, JSON.stringify(frame));
    } catch (error) {
      log("socket send failed: " + String(error));
    }
  }
  function makeSink() {
    return async (message, reply) => {
      const text = reply.text.trim();
      if (text.length === 0)
        return;
      for (const chunk of splitMessage(text, MESSAGE_LIMIT2)) {
        await postMessage(message.channelId, chunk, message.threadId);
      }
    };
  }
  async function postMessage(channel, text, threadTs) {
    const body = { channel, text };
    if (threadTs !== void 0)
      body.thread_ts = threadTs;
    try {
      await sdk.net.fetch(apiBase + "/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + options.botToken,
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      log("reply post failed: " + String(error));
    }
  }
  async function postAs(channel, handle, text) {
    const body = text.trim();
    if (body.length === 0)
      return;
    const prefix = `*${handle}:* `;
    for (const chunk of splitMessage(body, MESSAGE_LIMIT2 - prefix.length)) {
      await postMessage(channel, prefix + chunk);
    }
  }
  function handleMessageEvent(payload, event) {
    if (event.bot_id !== void 0)
      return;
    if (typeof event.subtype === "string" && IGNORED_SUBTYPES[event.subtype] === true)
      return;
    const user = typeof event.user === "string" ? event.user : "";
    if (user.length === 0)
      return;
    const channel = typeof event.channel === "string" ? event.channel : "";
    if (channel.length === 0)
      return;
    if (teamId && payload.team_id !== teamId)
      return;
    if (allowedUsers.length > 0 && !allowedUsers.includes(user))
      return;
    const rawText = typeof event.text === "string" ? event.text : "";
    const text = rawText.replace(/<@[^>]+>/g, "").trim();
    if (text.length === 0)
      return;
    const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : typeof event.ts === "string" ? event.ts : void 0;
    const ts = typeof event.ts === "string" ? event.ts : "";
    if (ts.length > 0) {
      const key = channel + ":" + ts;
      if (seenEventKeys.has(key))
        return;
      seenEventKeys.add(key);
      if (seenEventKeys.size > seenLimit) {
        const oldest = seenEventKeys.values().next().value;
        if (oldest !== void 0)
          seenEventKeys.delete(oldest);
      }
    }
    const message = {
      provider: "slack",
      channelId: channel,
      userId: user,
      text,
      threadId: threadTs
    };
    void options.route(message, makeSink()).catch((error) => {
      log("route failed: " + String(error));
    });
  }
  function handleEnvelope(frame) {
    if (typeof frame.envelope_id === "string")
      void send({ envelope_id: frame.envelope_id });
    const payload = frame.payload;
    if (!payload)
      return;
    const event = payload.event;
    if (!event)
      return;
    if (event.type !== "message" && event.type !== "app_mention")
      return;
    handleMessageEvent(payload, event);
  }
  function handleFrame(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    switch (frame.type) {
      case "hello":
        isConnected = true;
        backoffAttempt = 0;
        break;
      case "disconnect":
        isConnected = false;
        reconnect();
        break;
      case "events_api":
        handleEnvelope(frame);
        break;
      default:
        if (typeof frame.envelope_id === "string")
          void send({ envelope_id: frame.envelope_id });
        break;
    }
  }
  function onSocketEvent(event) {
    if (event.type === "message") {
      if (typeof event.data === "string")
        handleFrame(event.data);
      return;
    }
    isConnected = false;
    reconnect();
  }
  function teardownSocket() {
    isConnected = false;
    const id = socketId;
    socketId = void 0;
    if (id !== void 0) {
      void sdk.net.close(id).catch(() => {
      });
    }
  }
  function reconnect() {
    teardownSocket();
    if (closed)
      return;
    if (reconnectTimer !== void 0)
      scheduler.clearTimer(reconnectTimer);
    const delay = Math.min(reconnectBaseMs * Math.pow(2, backoffAttempt), MAX_BACKOFF_MS2);
    backoffAttempt += 1;
    reconnectTimer = scheduler.setTimer(() => {
      reconnectTimer = void 0;
      void openConnection();
    }, delay);
  }
  async function openConnection() {
    if (closed)
      return;
    if (socketId !== void 0)
      return;
    let wssUrl;
    try {
      const result = await sdk.net.fetch(apiBase + "/apps.connections.open", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + options.appToken,
          "Content-Type": "application/x-www-form-urlencoded"
        }
      });
      const body = parseJsonBody(result);
      if (!body || body.ok !== true || typeof body.url !== "string") {
        log("apps.connections.open rejected: " + JSON.stringify(body?.error ?? body ?? null));
        if (!closed)
          reconnect();
        return;
      }
      wssUrl = body.url;
    } catch (error) {
      log("apps.connections.open failed: " + String(error));
      if (!closed)
        reconnect();
      return;
    }
    try {
      const connectResult = await sdk.net.connect(wssUrl);
      socketId = connectResult.socketId;
      sdk.events.on("net.connect:" + connectResult.socketId, (payload) => {
        onSocketEvent(payload);
      });
    } catch (error) {
      log("socket connect failed: " + String(error));
      isConnected = false;
      if (!closed)
        reconnect();
    }
  }
  return {
    name: "slack",
    async connect() {
      closed = false;
      await openConnection();
    },
    disconnect() {
      closed = true;
      if (reconnectTimer !== void 0) {
        scheduler.clearTimer(reconnectTimer);
        reconnectTimer = void 0;
      }
      teardownSocket();
    },
    connected() {
      return isConnected;
    },
    postAs
  };
}

// src/core/room/protocol.ts
var RESERVED = { all: "all", human: "human" };
var HANDLE_TOKEN = /@([A-Za-z0-9_-]+)/g;
var DEFAULT_MAX_MENTIONS = 2;
function sanitizeHandle(name) {
  let h = (name ?? "").trim().replace(/[^A-Za-z0-9_-]/g, "");
  h = h.replace(/discord/gi, "").replace(/clyde/gi, "");
  if (h.length > 80)
    h = h.slice(0, 80);
  if (h.length === 0)
    h = "agent";
  return h;
}
function buildPreamble(room, self, participants) {
  const selfHandle = self.handle.toLowerCase();
  const peers = participants.filter((p) => p.handle.toLowerCase() !== selfHandle).map((p) => `@${p.handle}`);
  const roster = peers.length > 0 ? peers.join(", ") : "(none yet)";
  const roomName = room.name ?? room.roomKey ?? "this room";
  return [
    `You are @${self.handle} in room "${roomName}".`,
    `Other participants: ${roster}.`,
    "Address a peer by writing @Handle; a message with no @mention is spoken to the room.",
    "You are only invoked when you are addressed. Reply briefly.",
    "Write @human to hand the conversation back to a person."
  ].join("\n");
}
function parseMentions(text, participants, opts = {}) {
  const maxMentions = opts.maxMentions ?? DEFAULT_MAX_MENTIONS;
  const selfHandle = opts.self?.handle.toLowerCase();
  const byHandle = new Map(participants.map((p) => [p.handle.toLowerCase(), p]));
  let all = false;
  let human = false;
  const targets = [];
  const seen = /* @__PURE__ */ new Set();
  for (const match of text.matchAll(HANDLE_TOKEN)) {
    const lower = match[1].toLowerCase();
    if (lower === RESERVED.all) {
      all = true;
      continue;
    }
    if (lower === RESERVED.human) {
      human = true;
      continue;
    }
    if (selfHandle !== void 0 && lower === selfHandle)
      continue;
    if (seen.has(lower))
      continue;
    const participant = byHandle.get(lower);
    if (participant === void 0)
      continue;
    seen.add(lower);
    targets.push(participant);
  }
  return { targets: targets.slice(0, maxMentions), all, human };
}

// src/plugin/rooms.ts
var ROOMS_KEY = "relay:rooms";
var DEFAULT_MAX_MENTIONS2 = 2;
var DEFAULT_MAX_BURST_TURNS = 6;
function isRoomRecord(value) {
  if (value === null || typeof value !== "object")
    return false;
  const r = value;
  return typeof r.roomKey === "string" && typeof r.provider === "string" && typeof r.channelId === "string" && Array.isArray(r.participants);
}
function parseRooms(raw) {
  if (!raw)
    return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object")
      return {};
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isRoomRecord(value))
        out[key] = normalizeRoom(value);
    }
    return out;
  } catch {
    return {};
  }
}
function normalizeRoom(r) {
  const participants = Array.isArray(r.participants) ? r.participants.filter(
    (p) => p !== null && typeof p === "object" && typeof p.agentId === "string" && typeof p.handle === "string"
  ).map((p) => ({ agentId: p.agentId, handle: p.handle })) : [];
  return {
    roomKey: r.roomKey,
    provider: r.provider,
    channelId: r.channelId,
    name: typeof r.name === "string" && r.name.length > 0 ? r.name : void 0,
    status: r.status === "paused" ? "paused" : "active",
    maxMentions: typeof r.maxMentions === "number" && r.maxMentions > 0 ? Math.floor(r.maxMentions) : DEFAULT_MAX_MENTIONS2,
    participants
  };
}
async function loadRooms(sdk) {
  return parseRooms(await sdk.storage.get(ROOMS_KEY));
}
async function saveRooms(sdk, rooms) {
  await sdk.storage.set(ROOMS_KEY, JSON.stringify(rooms));
}
async function listRooms(sdk) {
  const rooms = await loadRooms(sdk);
  return Object.keys(rooms).sort().map((key) => rooms[key]);
}
async function getRoom(sdk, provider, channelId) {
  const rooms = await loadRooms(sdk);
  return rooms[conversationKey(provider, channelId)];
}
async function isRoomChannel(sdk, provider, channelId) {
  return await getRoom(sdk, provider, channelId) !== void 0;
}
async function createRoom(sdk, provider, channelId, opts = {}) {
  const rooms = await loadRooms(sdk);
  const key = conversationKey(provider, channelId);
  const existing = rooms[key];
  if (existing)
    return existing;
  const record = {
    roomKey: key,
    provider,
    channelId,
    name: opts.name && opts.name.length > 0 ? opts.name : void 0,
    status: "active",
    maxMentions: typeof opts.maxMentions === "number" && opts.maxMentions > 0 ? Math.floor(opts.maxMentions) : DEFAULT_MAX_MENTIONS2,
    participants: []
  };
  rooms[key] = record;
  await saveRooms(sdk, rooms);
  return record;
}
async function deleteRoom(sdk, provider, channelId) {
  const rooms = await loadRooms(sdk);
  const key = conversationKey(provider, channelId);
  if (!rooms[key])
    return false;
  delete rooms[key];
  await saveRooms(sdk, rooms);
  return true;
}
function uniqueHandle(name, agentId, taken) {
  const base = sanitizeHandle(name);
  if (!taken.has(base.toLowerCase()))
    return base;
  const idSuffix = sanitizeHandle(agentId).slice(0, 4) || "x";
  let candidate = `${base}-${idSuffix}`;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${base}-${idSuffix}-${n}`;
    n += 1;
  }
  return candidate;
}
async function addParticipant(sdk, provider, channelId, agentId, displayName) {
  const rooms = await loadRooms(sdk);
  const key = conversationKey(provider, channelId);
  let room = rooms[key];
  if (!room) {
    room = {
      roomKey: key,
      provider,
      channelId,
      status: "active",
      maxMentions: DEFAULT_MAX_MENTIONS2,
      participants: []
    };
    rooms[key] = room;
  }
  const existing = room.participants.find((p) => p.agentId === agentId);
  if (existing)
    return existing;
  const taken = new Set(room.participants.map((p) => p.handle.toLowerCase()));
  const participant = {
    agentId,
    handle: uniqueHandle(displayName || agentId, agentId, taken)
  };
  room.participants.push(participant);
  await saveRooms(sdk, rooms);
  return participant;
}
async function removeParticipant(sdk, provider, channelId, agentIdOrHandle) {
  const rooms = await loadRooms(sdk);
  const key = conversationKey(provider, channelId);
  const room = rooms[key];
  if (!room)
    return false;
  const lower = agentIdOrHandle.toLowerCase();
  const before = room.participants.length;
  room.participants = room.participants.filter(
    (p) => p.agentId !== agentIdOrHandle && p.handle.toLowerCase() !== lower
  );
  if (room.participants.length === before)
    return false;
  await saveRooms(sdk, rooms);
  return true;
}
async function setRoomStatus(sdk, provider, channelId, status) {
  const rooms = await loadRooms(sdk);
  const key = conversationKey(provider, channelId);
  const room = rooms[key];
  if (!room)
    return false;
  room.status = status;
  await saveRooms(sdk, rooms);
  return true;
}
function createRoomBus(deps) {
  const { sdk, dispatch, sendAs } = deps;
  const logger = deps.logger ?? {
    warn: (m) => console.warn("[relay:room] " + m),
    error: (m) => console.error("[relay:room] " + m)
  };
  const maxBurstTurns = typeof deps.maxBurstTurns === "number" && deps.maxBurstTurns > 0 ? Math.floor(deps.maxBurstTurns) : DEFAULT_MAX_BURST_TURNS;
  const queues = /* @__PURE__ */ new Map();
  const processing = /* @__PURE__ */ new Set();
  const burst = /* @__PURE__ */ new Map();
  const sessions = /* @__PURE__ */ new Map();
  const lastPost = /* @__PURE__ */ new Map();
  async function drain(key) {
    if (processing.has(key))
      return 0;
    processing.add(key);
    let turns = 0;
    try {
      while (true) {
        const rooms = await loadRooms(sdk);
        const room = rooms[key];
        if (!room)
          break;
        if (room.status === "paused")
          break;
        const backlog = queues.get(key);
        if (!backlog || backlog.length === 0)
          break;
        if ((burst.get(key) ?? 0) >= maxBurstTurns) {
          logger.warn(
            `room ${key}: burst cap ${maxBurstTurns} reached; dropping ${backlog.length} queued turn(s)`
          );
          queues.set(key, []);
          break;
        }
        const item = backlog.shift();
        const participant = room.participants.find((p) => p.agentId === item.toAgentId);
        if (!participant)
          continue;
        const preamble = buildPreamble(
          { name: room.name, roomKey: room.roomKey },
          participant,
          room.participants
        );
        const prompt = `${preamble}

[${item.fromHandle}]: ${item.text}`;
        const sessKey = `${key}\0${participant.agentId}`;
        let reply;
        try {
          reply = await dispatch(participant.agentId, prompt, sessions.get(sessKey));
        } catch (error) {
          logger.error(
            `room ${key}: dispatch to ${participant.handle} (${participant.agentId}) failed: ${String(error)}`
          );
          continue;
        }
        burst.set(key, (burst.get(key) ?? 0) + 1);
        turns += 1;
        if (reply.sessionId)
          sessions.set(sessKey, reply.sessionId);
        const text = (reply.text ?? "").trim();
        if (text.length === 0)
          continue;
        if (lastPost.get(sessKey) === text) {
          logger.warn(`room ${key}: echo from ${participant.handle} suppressed`);
          continue;
        }
        lastPost.set(sessKey, text);
        try {
          await sendAs(room, { handle: participant.handle, text });
        } catch (error) {
          logger.error(`room ${key}: sendAs for ${participant.handle} failed: ${String(error)}`);
        }
        const parsed = parseMentions(text, room.participants, {
          self: participant,
          maxMentions: room.maxMentions
        });
        const followups = parsed.all ? room.participants.filter((p) => p.agentId !== participant.agentId) : parsed.targets;
        for (const target of followups) {
          const agentId = target.agentId;
          if (!agentId)
            continue;
          backlog.push({ fromHandle: participant.handle, text, toAgentId: agentId });
        }
      }
    } finally {
      processing.delete(key);
    }
    return turns;
  }
  return {
    async isRoom(provider, channelId) {
      return isRoomChannel(sdk, provider, channelId);
    },
    async submitMessage(provider, channelId, fromHandle, text) {
      const key = conversationKey(provider, channelId);
      const rooms = await loadRooms(sdk);
      const room = rooms[key];
      if (!room)
        return { status: "no-room", targets: 0, turns: 0, human: false };
      const parsed = parseMentions(text, room.participants, {
        maxMentions: room.maxMentions
      });
      const targets = parsed.all ? room.participants.slice() : parsed.targets;
      if (targets.length === 0) {
        return { status: "no-target", targets: 0, turns: 0, human: parsed.human };
      }
      const backlog = queues.get(key) ?? [];
      for (const target of targets) {
        const agentId = target.agentId;
        if (!agentId)
          continue;
        backlog.push({ fromHandle, text, toAgentId: agentId });
      }
      queues.set(key, backlog);
      burst.set(key, 0);
      if (processing.has(key)) {
        return { status: "queued", targets: targets.length, turns: 0, human: parsed.human };
      }
      const turns = await drain(key);
      return { status: "drained", targets: targets.length, turns, human: parsed.human };
    }
  };
}

// src/plugin/entry.ts
var COMMAND_IDS = [
  "relay-start",
  "relay-stop",
  "relay-status",
  "relay-reload-config"
];
var PANEL_COMMAND_IDS = ["relay-save-config", "relay-bind", "relay-unbind"];
var ROOM_COMMAND_IDS = [
  "relay-room-create",
  "relay-room-delete",
  "relay-room-add",
  "relay-room-remove",
  "relay-room-list",
  "relay-room-pause",
  "relay-room-resume"
];
function argString(args, key) {
  const record = args ?? {};
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}
async function roomArgError(sdk, op, required) {
  const message = `Relay room ${op} failed: ${required} are required.`;
  await sdk.notifications.toast(message);
  return message;
}
var BACKGROUND_SERVICE_ID = "relay-bridge";
var BACKGROUND_SERVICE_NAME = "Maestro Relay bridge";
var STATUS_TOPICS = ["agent.completed", "agent.statusChanged", "agent.error"];
function createRuntime(sdk, config, scheduler) {
  const activeReplies = /* @__PURE__ */ new Map();
  const providers = [];
  let running = false;
  const agentStatus = /* @__PURE__ */ new Map();
  let backgroundServiceId;
  const roomDispatch = async (agentId, prompt) => {
    const handle = collectAgentReply(
      sdk,
      { agentId, prompt },
      {
        onSession(sessionId) {
          activeReplies.set(sessionId, handle);
        }
      },
      scheduler
    );
    const reply = await handle.promise;
    activeReplies.delete(reply.sessionId);
    return { text: reply.text, sessionId: reply.sessionId };
  };
  const roomSendAs = async (room, post) => {
    const client = providers.find((provider) => provider.name === room.provider);
    if (client?.postAs)
      await client.postAs(room.channelId, post.handle, post.text);
  };
  const bus = createRoomBus({ sdk, dispatch: roomDispatch, sendAs: roomSendAs });
  const runtime = {
    config,
    start() {
      running = true;
      for (const provider of providers) {
        provider.connect().catch((error) => {
          console.error(`[relay] provider "${provider.name}" failed to connect: ${String(error)}`);
        });
      }
    },
    stop() {
      running = false;
      for (const provider of providers)
        provider.disconnect();
      for (const handle of activeReplies.values())
        handle.cancel();
      activeReplies.clear();
    },
    status() {
      return {
        running,
        enabledProviders: runtime.config.enabledProviders.slice(),
        connectedProviders: providers.filter((provider) => provider.connected()).map((provider) => provider.name),
        activeReplies: activeReplies.size,
        supervised: backgroundServiceId !== void 0,
        agentStatuses: [...agentStatus.entries()].map(([agentId, status]) => ({ agentId, status }))
      };
    },
    async reloadConfig() {
      runtime.config = await loadConfig(sdk);
      return runtime.config;
    },
    async handleCommand(commandId, args) {
      switch (commandId) {
        case "relay-start": {
          runtime.start();
          const message = `Relay started; providers enabled: ${runtime.config.enabledProviders.join(", ") || "(none)"}. Gateway clients not yet connected.`;
          await sdk.notifications.toast(message);
          return message;
        }
        case "relay-stop": {
          runtime.stop();
          await sdk.notifications.toast("Relay stopped.");
          return "Relay stopped.";
        }
        case "relay-status": {
          const s = runtime.status();
          const agents = s.agentStatuses.map((a) => `${a.agentId}=${a.status}`).join(", ") || "(none)";
          return `Relay ${s.running ? "running" : "stopped"} | supervised: ${s.supervised ? "yes" : "no"} | enabled: ${s.enabledProviders.join(", ") || "(none)"} | connected: ${s.connectedProviders.join(", ") || "(none)"} | active replies: ${s.activeReplies} | agents: ${agents}`;
        }
        case "relay-reload-config": {
          const next = await runtime.reloadConfig();
          const message = `Configuration reloaded; providers enabled: ${next.enabledProviders.join(", ") || "(none)"}.`;
          await sdk.notifications.toast(message);
          return message;
        }
        case "relay-save-config": {
          const record = args ?? {};
          const settings = record.settings && typeof record.settings === "object" ? record.settings : {};
          const secrets = record.secrets && typeof record.secrets === "object" ? record.secrets : {};
          let settingsCount = 0;
          for (const key of Object.keys(settings)) {
            await sdk.settings.set(`plugins.${sdk.pluginId}.${key}`, String(settings[key] ?? ""));
            settingsCount += 1;
          }
          let secretCount = 0;
          for (const name of Object.keys(secrets)) {
            const value = secrets[name];
            if (typeof value === "string" && value.trim().length > 0) {
              await setSecret(sdk, name, value.trim());
              secretCount += 1;
            }
          }
          await runtime.reconnect();
          const message = `Relay configuration saved (${settingsCount} setting(s), ${secretCount} secret(s)); providers enabled: ${runtime.config.enabledProviders.join(", ") || "(none)"}. Bridges (re)connecting.`;
          await sdk.notifications.toast(message);
          return message;
        }
        case "relay-bind": {
          const record = args ?? {};
          const provider = typeof record.provider === "string" ? record.provider.trim() : "";
          const channelId = typeof record.channelId === "string" ? record.channelId.trim() : "";
          const agentId = typeof record.agentId === "string" ? record.agentId.trim() : "";
          if (!provider || !channelId || !agentId) {
            const message2 = "Relay bind failed: provider, channelId, and agentId are all required.";
            await sdk.notifications.toast(message2);
            return message2;
          }
          await setBinding(sdk, conversationKey(provider, channelId), agentId);
          const message = `Bound ${provider}:${channelId} -> agent ${agentId}.`;
          await sdk.notifications.toast(message);
          return message;
        }
        case "relay-unbind": {
          const record = args ?? {};
          const provider = typeof record.provider === "string" ? record.provider.trim() : "";
          const channelId = typeof record.channelId === "string" ? record.channelId.trim() : "";
          if (!provider || !channelId) {
            const message2 = "Relay unbind failed: provider and channelId are required.";
            await sdk.notifications.toast(message2);
            return message2;
          }
          const removed = await removeBinding(sdk, conversationKey(provider, channelId));
          const message = removed ? `Unbound ${provider}:${channelId}.` : `No binding found for ${provider}:${channelId}.`;
          await sdk.notifications.toast(message);
          return message;
        }
        case "relay-room-create": {
          const provider = argString(args, "provider");
          const channelId = argString(args, "channelId");
          const name = argString(args, "name");
          if (!provider || !channelId)
            return roomArgError(sdk, "create", "provider and channelId");
          const room = await createRoom(sdk, provider, channelId, name ? { name } : {});
          const message = `Room ready: ${provider}:${channelId}${room.name ? ` ("${room.name}")` : ""}; ${room.participants.length} persona(s).`;
          await sdk.notifications.toast(message);
          return message;
        }
        case "relay-room-delete": {
          const provider = argString(args, "provider");
          const channelId = argString(args, "channelId");
          if (!provider || !channelId)
            return roomArgError(sdk, "delete", "provider and channelId");
          const removed = await deleteRoom(sdk, provider, channelId);
          const message = removed ? `Room deleted: ${provider}:${channelId}.` : `No room found for ${provider}:${channelId}.`;
          await sdk.notifications.toast(message);
          return message;
        }
        case "relay-room-add": {
          const provider = argString(args, "provider");
          const channelId = argString(args, "channelId");
          const agentId = argString(args, "agentId");
          const displayName = argString(args, "displayName") || agentId;
          if (!provider || !channelId || !agentId) {
            return roomArgError(sdk, "add", "provider, channelId, and agentId");
          }
          const participant = await addParticipant(sdk, provider, channelId, agentId, displayName);
          const message = `Added @${participant.handle} (agent ${agentId}) to ${provider}:${channelId}.`;
          await sdk.notifications.toast(message);
          return message;
        }
        case "relay-room-remove": {
          const provider = argString(args, "provider");
          const channelId = argString(args, "channelId");
          const target = argString(args, "target") || argString(args, "agentId") || argString(args, "handle");
          if (!provider || !channelId || !target) {
            return roomArgError(sdk, "remove", "provider, channelId, and target (agent id or handle)");
          }
          const removed = await removeParticipant(sdk, provider, channelId, target);
          const message = removed ? `Removed "${target}" from ${provider}:${channelId}.` : `No persona "${target}" in ${provider}:${channelId}.`;
          await sdk.notifications.toast(message);
          return message;
        }
        case "relay-room-list": {
          const rooms = await listRooms(sdk);
          if (rooms.length === 0)
            return "No rooms configured.";
          return rooms.map((room) => {
            const personas = room.participants.map((p) => `@${p.handle}`).join(", ") || "(none)";
            return `${room.roomKey} [${room.status}]${room.name ? ` "${room.name}"` : ""}: ${personas}`;
          }).join("\n");
        }
        case "relay-room-pause":
        case "relay-room-resume": {
          const provider = argString(args, "provider");
          const channelId = argString(args, "channelId");
          const op = commandId === "relay-room-pause" ? "pause" : "resume";
          if (!provider || !channelId)
            return roomArgError(sdk, op, "provider and channelId");
          const status = op === "pause" ? "paused" : "active";
          const ok = await setRoomStatus(sdk, provider, channelId, status);
          const message = ok ? `Room ${provider}:${channelId} ${status === "paused" ? "paused" : "resumed"}.` : `No room found for ${provider}:${channelId}.`;
          await sdk.notifications.toast(message);
          return message;
        }
        default:
          throw new Error(`unknown relay command "${commandId}"`);
      }
    },
    async routeInbound(message, sink) {
      if (message.text.trim().length === 0)
        return { status: "empty" };
      if (await bus.isRoom(message.provider, message.channelId)) {
        const room = await bus.submitMessage(message.provider, message.channelId, "human", message.text);
        return { status: "room", room };
      }
      const agentId = await getBinding(sdk, conversationKey(message.provider, message.channelId));
      if (!agentId)
        return { status: "unbound" };
      const handle = collectAgentReply(
        sdk,
        { agentId, prompt: message.text },
        {
          onSession(sessionId) {
            activeReplies.set(sessionId, handle);
          }
        },
        scheduler
      );
      const reply = await handle.promise;
      activeReplies.delete(reply.sessionId);
      await sink(message, reply);
      return { status: "dispatched", agentId, reply };
    },
    onAgentCompleted(payload) {
      const record = payload;
      const sessionId = record && typeof record.sessionId === "string" ? record.sessionId : "";
      const agentId = record && typeof record.agentId === "string" ? record.agentId : "";
      const status = record && typeof record.status === "string" ? record.status : "";
      if (agentId.length > 0 && status.length > 0)
        agentStatus.set(agentId, status);
      if (sessionId.length === 0)
        return;
      const handle = activeReplies.get(sessionId);
      if (handle)
        handle.markComplete();
    },
    onAgentStatusChanged(payload) {
      const record = payload;
      const agentId = record && typeof record.agentId === "string" ? record.agentId : "";
      const status = record && typeof record.status === "string" ? record.status : "";
      if (agentId.length === 0 || status.length === 0)
        return;
      agentStatus.set(agentId, status);
    },
    onAgentError(payload) {
      const record = payload;
      const agentId = record && typeof record.agentId === "string" ? record.agentId : "";
      const errorType = record && typeof record.errorType === "string" ? record.errorType : "unknown";
      const recoverable = record ? record.recoverable === true : false;
      if (agentId.length > 0)
        agentStatus.set(agentId, `error:${errorType}`);
      const target = agentId.length > 0 ? `agent ${agentId}` : "an agent";
      void sdk.notifications.toast(
        `Relay: ${target} reported an error (${errorType}); recoverable=${recoverable ? "yes" : "no"}.`
      );
    },
    registerProvider(client) {
      providers.push(client);
    },
    replaceProviders(clients) {
      for (const provider of providers)
        provider.disconnect();
      providers.length = 0;
      for (const client of clients)
        providers.push(client);
      if (running) {
        for (const provider of providers) {
          provider.connect().catch((error) => {
            console.error(`[relay] provider "${provider.name}" failed to connect: ${String(error)}`);
          });
        }
      }
    },
    async reconnect() {
      runtime.stop();
      await runtime.reloadConfig();
      const clients = await buildConfiguredProviders(
        sdk,
        runtime.config,
        (message, sink) => runtime.routeInbound(message, sink)
      );
      runtime.replaceProviders(clients);
      runtime.start();
    },
    async registerBackgroundService() {
      if (backgroundServiceId !== void 0)
        return;
      const result = await sdk.background.register({
        id: BACKGROUND_SERVICE_ID,
        name: BACKGROUND_SERVICE_NAME
      });
      backgroundServiceId = result && typeof result.serviceId === "string" && result.serviceId.length > 0 ? result.serviceId : BACKGROUND_SERVICE_ID;
    },
    async unregisterBackgroundService() {
      if (backgroundServiceId === void 0)
        return;
      const id = backgroundServiceId;
      backgroundServiceId = void 0;
      try {
        await sdk.background.unregister(id);
      } catch (error) {
        console.warn("[relay] background.unregister failed: " + String(error));
      }
    }
  };
  return runtime;
}
async function buildConfiguredProviders(sdk, config, route) {
  const clients = [];
  const discordToken = await getSecret(sdk, "discordToken");
  if (config.enabledProviders.includes("discord") && discordToken) {
    clients.push(createDiscordClient({ sdk, token: discordToken, config: config.discord, route }));
  }
  const slackAppToken = await getSecret(sdk, "slackAppToken");
  const slackBotToken = await getSecret(sdk, "slackBotToken");
  if (config.enabledProviders.includes("slack") && slackAppToken && slackBotToken) {
    clients.push(
      createSlackClient({ sdk, appToken: slackAppToken, botToken: slackBotToken, config: config.slack, route })
    );
  }
  return clients;
}
var current;
async function activate(sdk) {
  const config = await loadConfig(sdk);
  const runtime = createRuntime(sdk, config);
  current = runtime;
  for (const id of COMMAND_IDS) {
    sdk.commands.register(id, (args) => runtime.handleCommand(id, args));
  }
  for (const id of PANEL_COMMAND_IDS) {
    sdk.commands.register(id, (args) => runtime.handleCommand(id, args));
  }
  for (const id of ROOM_COMMAND_IDS) {
    sdk.commands.register(id, (args) => runtime.handleCommand(id, args));
  }
  sdk.events.on("agent.completed", (payload) => runtime.onAgentCompleted(payload));
  sdk.events.on("agent.statusChanged", (payload) => runtime.onAgentStatusChanged(payload));
  sdk.events.on("agent.error", (payload) => runtime.onAgentError(payload));
  await sdk.events.subscribe([...STATUS_TOPICS]);
  await runtime.registerBackgroundService();
  const clients = await buildConfiguredProviders(
    sdk,
    config,
    (message, sink) => runtime.routeInbound(message, sink)
  );
  runtime.replaceProviders(clients);
  runtime.start();
  await sdk.notifications.toast(
    `Maestro Relay loaded; providers enabled: ${config.enabledProviders.join(", ") || "(none)"}.`
  );
}
function deactivate() {
  current?.stop();
  void current?.unregisterBackgroundService();
  current = void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BACKGROUND_SERVICE_ID,
  BACKGROUND_SERVICE_NAME,
  COMMAND_IDS,
  PANEL_COMMAND_IDS,
  ROOM_COMMAND_IDS,
  STATUS_TOPICS,
  activate,
  buildConfiguredProviders,
  createRuntime,
  deactivate
});
