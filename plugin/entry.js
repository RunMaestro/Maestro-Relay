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
    }
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
var BACKGROUND_SERVICE_ID = "relay-bridge";
var BACKGROUND_SERVICE_NAME = "Maestro Relay bridge";
var STATUS_TOPICS = ["agent.completed", "agent.statusChanged", "agent.error"];
function createRuntime(sdk, config, scheduler) {
  const activeReplies = /* @__PURE__ */ new Map();
  const providers = [];
  let running = false;
  const agentStatus = /* @__PURE__ */ new Map();
  let backgroundServiceId;
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
        default:
          throw new Error(`unknown relay command "${commandId}"`);
      }
    },
    async routeInbound(message, sink) {
      if (message.text.trim().length === 0)
        return { status: "empty" };
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
  STATUS_TOPICS,
  activate,
  buildConfiguredProviders,
  createRuntime,
  deactivate
});
