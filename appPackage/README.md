# Microsoft Teams app package

This folder is the source for the Teams app package that an admin uploads (sideloads) into a
tenant. Phase 1 requests **only the `personal` (1:1 DM) scope** — group-chat and channel
(`team`) scopes are deferred until the provider implements the owner/thread isolation those
shared contexts need (Phase 2), at which point the manifest gains the scopes and the package is
re-uploaded.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Teams app manifest (schema v1.19). Contains placeholders (see below). |
| `color.png` | 192×192 full-color icon. Placeholder solid-purple "M" — replace with brand art. |
| `outline.png` | 32×32 transparent outline icon. Placeholder white "M" — replace with brand art. |
| `maestro-relay-teams.zip` | Generated upload artifact (emitted by `deploy.ts`; not checked in). |

## Placeholders substituted by `deploy.ts`

`src/providers/teams/deploy.ts` (run via `npm run deploy-teams`) reads `manifest.json`,
substitutes the placeholders from the environment, and writes the substituted manifest plus both
icons into `maestro-relay-teams.zip`. **Do not hand-edit the placeholders** — set the env vars
and run the deploy script.

| Placeholder in `manifest.json` | Source env var | Notes |
| --- | --- | --- |
| `<TEAMS_APP_ID>` (`id` and `bots[0].botId`) | `TEAMS_APP_ID` | Entra app (client) ID. |
| `<public-host>` (`validDomains[0]`) | `TEAMS_PUBLIC_URL` | Host portion of the public HTTPS base URL Teams POSTs to (e.g. `example.com` from `https://example.com`). |

## Building the package

```bash
TEAMS_APP_ID=<entra-app-id> TEAMS_PUBLIC_URL=https://<public-host> npm run deploy-teams
```

This emits `appPackage/maestro-relay-teams.zip`. A Teams admin uploads that zip — see
[`docs/teams.md`](../docs/teams.md) for the full sideload / "Built for your org" runbook.
