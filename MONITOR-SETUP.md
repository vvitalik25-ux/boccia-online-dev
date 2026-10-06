# Developer HUD

The development Worker hosts read-only monitoring for both game sites. The production game server is unchanged.

Configure these **secrets** in the development Worker's Settings → Variables and Secrets:

- `DEV_PANEL_PASSWORD`: the administrator's chosen password.
- `DEV_CF_ANALYTICS_TOKEN`: Account Analytics / Read token restricted to the development account.
- `STABLE_CF_ANALYTICS_TOKEN`: Account Analytics / Read token restricted to the production account.

Configure plain-text variables after checking the Workers plan in each account:

- `DEV_CF_ACCOUNT_ID`: development account ID.
- `STABLE_CF_ACCOUNT_ID`: production account ID.
- `DEV_CF_DAILY_REQUEST_LIMIT`, `STABLE_CF_DAILY_REQUEST_LIMIT`: actual daily Workers request allowance. For Workers Free, 100000 requests per account, resetting at 00:00 UTC. Do not use this value for a paid plan with no daily request cap.

No tokens or passwords belong in Git, client JavaScript or query strings. Login sessions expire after 30 minutes and password rotation revokes them. Authentication/presence are transient and reset if the monitoring Durable Object restarts.

Quota is account-wide Workers request usage, **not CPU load**, based on Cloudflare's adaptive analytics (possibly sampled/delayed), cached for 60 seconds. Empty successful results mean zero; missing credentials or API errors are reported as unavailable. Other service quotas (Durable Objects, storage) are not represented by this percentage.

Presence is an approximate count of visible browsers sending a heartbeat every 30 seconds, removed after 90 seconds without a heartbeat. It includes phones, but the HUD button is for devices with a fine pointer and hover. Browser IDs are random and no player names, room codes, locations or email addresses are collected. Public self-reported heartbeats are not an authoritative count of people.

Run `npm run test:monitor`, `npm run test:network`, and `npm run test:clock` before deployment.
