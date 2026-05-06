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
