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
