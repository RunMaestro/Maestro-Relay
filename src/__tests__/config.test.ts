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

test('ambientConfig rejects unparseable values and clamps to safe floors', async () => {
  const previousEnv = { ...process.env };
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };

  try {
    const { ambientConfig } = await import('../core/config');

    delete process.env.AMBIENT_WINDOW_MS;
    delete process.env.AMBIENT_MAX_BATCH;
    delete process.env.AMBIENT_MAX_WAIT_MS;
    assert.equal(ambientConfig.windowMs, 20_000);
    assert.equal(ambientConfig.maxBatch, 25);
    assert.equal(ambientConfig.maxWaitMs, 120_000);

    // parseInt('2m') would be 2 — a two-millisecond window, which defeats
    // batching entirely and turns every message into its own agent turn.
    process.env.AMBIENT_WINDOW_MS = '2m';
    assert.equal(ambientConfig.windowMs, 20_000);

    process.env.AMBIENT_WINDOW_MS = '';
    assert.equal(ambientConfig.windowMs, 20_000);

    process.env.AMBIENT_WINDOW_MS = '0';
    assert.equal(ambientConfig.windowMs, 20_000);

    process.env.AMBIENT_WINDOW_MS = '-5000';
    assert.equal(ambientConfig.windowMs, 20_000);

    process.env.AMBIENT_WINDOW_MS = '50';
    assert.equal(ambientConfig.windowMs, 1_000, 'clamped to the 1s floor');

    process.env.AMBIENT_MAX_BATCH = '0.5';
    assert.equal(ambientConfig.maxBatch, 1, 'clamped to at least one message');

    process.env.AMBIENT_MAX_WAIT_MS = '90000';
    assert.equal(ambientConfig.maxWaitMs, 90_000, 'a valid value is honoured');

    assert.ok(
      warnings.some((w) => w.includes('AMBIENT_WINDOW_MS')),
      'an invalid value should warn rather than fail silently',
    );
  } finally {
    console.warn = realWarn;
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(previousEnv)) {
      process.env[key] = value;
    }
  }
});
