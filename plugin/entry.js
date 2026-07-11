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
  COMMAND_IDS: () => COMMAND_IDS,
  activate: () => activate,
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
function csv(value) {
  return value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}
async function readSetting(sdk, key, fallback) {
  const bare = await sdk.settings.get(key);
  if (typeof bare === "string" && bare.length > 0)
    return bare;
  const namespaced = await sdk.settings.get(`plugins.${sdk.pluginId}.${key}`);
  if (typeof namespaced === "string" && namespaced.length > 0)
    return namespaced;
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

// src/plugin/entry.ts
var COMMAND_IDS = [
  "relay-start",
  "relay-stop",
  "relay-status",
  "relay-reload-config"
];
function createRuntime(sdk, config, scheduler) {
  const activeReplies = /* @__PURE__ */ new Map();
  let running = false;
  const runtime = {
    config,
    start() {
      running = true;
    },
    stop() {
      running = false;
      for (const handle of activeReplies.values())
        handle.cancel();
      activeReplies.clear();
    },
    status() {
      return {
        running,
        enabledProviders: runtime.config.enabledProviders.slice(),
        connectedProviders: [],
        activeReplies: activeReplies.size
      };
    },
    async reloadConfig() {
      runtime.config = await loadConfig(sdk);
      return runtime.config;
    },
    async handleCommand(commandId, _args) {
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
          return `Relay ${s.running ? "running" : "stopped"} | enabled: ${s.enabledProviders.join(", ") || "(none)"} | connected: ${s.connectedProviders.join(", ") || "(none)"} | active replies: ${s.activeReplies}`;
        }
        case "relay-reload-config": {
          const next = await runtime.reloadConfig();
          const message = `Configuration reloaded; providers enabled: ${next.enabledProviders.join(", ") || "(none)"}.`;
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
      if (sessionId.length === 0)
        return;
      const handle = activeReplies.get(sessionId);
      if (handle)
        handle.markComplete();
    }
  };
  return runtime;
}
var current;
async function activate(sdk) {
  const config = await loadConfig(sdk);
  const runtime = createRuntime(sdk, config);
  current = runtime;
  for (const id of COMMAND_IDS) {
    sdk.commands.register(id, (args) => runtime.handleCommand(id, args));
  }
  sdk.events.on("agent.completed", (payload) => runtime.onAgentCompleted(payload));
  await sdk.events.subscribe(["agent.completed"]);
  runtime.start();
  await sdk.notifications.toast(
    `Maestro Relay loaded; providers enabled: ${config.enabledProviders.join(", ") || "(none)"}.`
  );
}
function deactivate() {
  current?.stop();
  current = void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  COMMAND_IDS,
  activate,
  createRuntime,
  deactivate
});
