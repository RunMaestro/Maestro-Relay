import test from 'node:test';
import assert from 'node:assert/strict';

test('config loads core + discord values from env and throws on missing keys', async () => {
  const previousEnv = { ...process.env };

  try {
    process.env.DISCORD_BOT_TOKEN = 'token-123';
    process.env.DISCORD_CLIENT_ID = 'client-456';
    process.env.DISCORD_GUILD_ID = 'guild-789';
    process.env.DISCORD_ALLOWED_USER_IDS = ' 111,222 ,, 333 ';

    const core = await import('../core/config');
    const discord = await import('../providers/discord/config');

    assert.equal(core.required('DISCORD_BOT_TOKEN'), 'token-123');
    assert.equal(discord.discordConfig.token, 'token-123');
    assert.equal(discord.discordConfig.clientId, 'client-456');
    assert.equal(discord.discordConfig.guildId, 'guild-789');
    assert.deepEqual(discord.discordConfig.allowedUserIds, ['111', '222', '333']);

    assert.throws(() => core.required('MISSING_ENV'), /Missing required env var/);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(previousEnv)) {
      process.env[key] = value;
    }
  }
});

test('config.susFactor validates mode, threshold bounds, and maxChars floor', async () => {
  const previousEnv = { ...process.env };
  const { config } = await import('../core/config');

  const reset = () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SUSFACTOR_')) delete process.env[key];
    }
  };

  try {
    // Unset means off, so an existing install picks up no new behavior.
    reset();
    assert.equal(config.susFactor.mode, 'off');
    assert.equal(config.susFactor.maxChars, 8000);
    assert.equal(config.susFactor.failOpen, true);

    reset();
    process.env.SUSFACTOR_MODE = ' BLOCK ';
    assert.equal(config.susFactor.mode, 'block', 'mode is trimmed and lowercased');

    reset();
    process.env.SUSFACTOR_MODE = 'warn';
    assert.throws(() => config.susFactor, /SUSFACTOR_MODE must be one of/);

    reset();
    process.env.SUSFACTOR_FAIL_OPEN = 'false';
    assert.equal(config.susFactor.failOpen, false);

    // A sample smaller than the floor would leave screening on but blind.
    reset();
    process.env.SUSFACTOR_MAX_CHARS = '10';
    assert.throws(() => config.susFactor, /SUSFACTOR_MAX_CHARS must be an integer >= 256/);

    reset();
    process.env.SUSFACTOR_MAX_CHARS = '256';
    assert.equal(config.susFactor.maxChars, 256);

    reset();
    process.env.SUSFACTOR_TIMEOUT_MS = '0';
    assert.throws(() => config.susFactor, /SUSFACTOR_TIMEOUT_MS must be an integer >= 1/);

    reset();
    process.env.SUSFACTOR_THRESHOLD = 'abc';
    assert.throws(() => config.susFactor, /SUSFACTOR_THRESHOLD must be a number/);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
});
