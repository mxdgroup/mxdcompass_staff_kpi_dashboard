# KPI Dashboard

MxD Digital team KPI dashboard. Tracks Wrike pipeline metrics, flow efficiency, and team velocity.

## Repository

**GitHub:** https://github.com/mxdgroup/mxdcompass_staff_kpi_dashboard

This is a standalone git repo nested inside `mxd-compass/clientservice_tools/kpi_dashboard/`.
It pushes to its own GitHub repo, NOT to `mxd-compass`. The parent repo gitignores this directory.

## Local path

```
/Users/matthewsliedrecht/Scripts/mxd-compass/clientservice_tools/kpi_dashboard/
```

## Development

```bash
npm install
npm run dev
# App runs at http://localhost:3000/kpi
```

## Deployment

Deployed to Vercel. Pushes to `main` trigger automatic deploys.

## Secrets & Rotators

Sensitive values used by this service live only in Vercel encrypted environment variables (Production, Preview, Development). Never in files, chat transcripts, or notes.

| Secret | Purpose | Rotate on |
|---|---|---|
| `WRIKE_PERMANENT_ACCESS_TOKEN` | Wrike API auth (sync, webhook registrar, admin endpoints) | Exposure; otherwise annually |
| `CRON_SECRET` | Bearer auth for `/api/cron/*`, `/api/admin/*`, `/api/debug/*`, and the internal `/api/sync` endpoint | Exposure; otherwise annually |
| `WRIKE_WEBHOOK_SECRET` | Validates `x-hook-signature` on incoming Wrike webhooks; stored from handshake | Only if Wrike re-issues |

**Authorized rotators:** developers@mxd.digital.

### Operational hygiene — stop burning tokens

Permanent access tokens get burned when their raw value ends up in a chat transcript. Avoid:

- Pasting `.env` output, curl commands with `Authorization: Bearer <token>`, or error messages that echo the header.
- Asking an agent "what's the token value?" — it shouldn't need it.

Instead:

- Reference secrets by env-var name (`WRIKE_PERMANENT_ACCESS_TOKEN`). Let the shell expand `$WRIKE_PERMANENT_ACCESS_TOKEN` so the transcript never sees the value.
- Run token-using curl from the deployed service or a local shell, not by pasting the value into an agent.
- If a token was exposed, rotate immediately in Wrike → Apps & Integrations → API → Permanent Access Tokens, then update Vercel env (all three environments) and confirm the old value returns 401.

### Rotation procedure (`WRIKE_PERMANENT_ACCESS_TOKEN`)

1. Regenerate in Wrike → Apps & Integrations → API → Permanent Access Tokens.
2. Update the new value in Vercel env: Production, Preview, Development.
3. Redeploy (trigger any deploy; env changes don't propagate until a new build).
4. Verify the old token is rejected: `curl -H "Authorization: Bearer $OLD_TOKEN" https://www.wrike.com/api/v4/accounts` should return 401.
5. If the exposure window is known, review Wrike account activity for unauthorized API calls during that window.

If `SECURITY.md` is later added to this repo, migrate this section there.
