# sniperlol — atak.gg backend API

Backend service powering [atak.gg](https://atakgg.revolution505.com/), a *League of Legends* statistics and tournament platform. Handles Riot Games API integration, match data ingestion, user authentication and tournament data.

**Live:** https://atakgg.revolution505.com/
**API reference:** [`PUBLIC_API.md`](./PUBLIC_API.md)

## Stack

| Concern | Technology |
|---|---|
| Runtime | Node.js, Express, TypeScript |
| Database | MySQL (`mysql2`) |
| Caching | Redis (`ioredis`), `node-cache` |
| Authentication | JWT, Passport with Google OAuth 2.0, express-session |
| Security | Helmet, CORS, `express-rate-limit` |
| Upstream throttling | Bottleneck — keeps outbound Riot API calls inside quota |
| Validation | Zod |
| Mail | Nodemailer |
| Logging | Morgan |
| Deployment | Docker |

## Design notes

- **Two-tier caching.** Redis for shared state across instances, `node-cache` in-process for hot reads, to keep Riot API usage low and responses fast.
- **Quota protection.** Outbound Riot requests pass through a Bottleneck limiter rather than firing directly, so the service stays within rate limits under load.
- **Schema validation at the boundary.** Zod validates incoming payloads before they reach application logic.
- **Companion client.** The `companion/` directory holds the desktop companion integration — see [atak-companion](https://github.com/ChristianJair27/atak-companion).

## Running locally

```bash
npm install
cp .env.example .env    # database, Redis, Riot API key, OAuth credentials
npm run dev
```

| Script | Purpose |
|---|---|
| `npm run dev` | Development server with hot reload (tsx) |
| `npm run build` | Compile TypeScript |
| `npm start` | Run the compiled server |

---

Built by [Christian Jair Loeza Zermeño](https://github.com/ChristianJair27) · [Revolution505](https://revolution505.com)
