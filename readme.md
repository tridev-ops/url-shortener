```markdown
# URL Shortener

A URL shortener built with Fastify, PostgreSQL, Drizzle ORM, and Redis.

## Features

- Create generated or custom short codes
- Redirect short links
- Track and expose click counts
- Redis caching with PostgreSQL fallback
- Redis-backed rate limiting

## Requirements

- Node.js
- pnpm
- PostgreSQL
- Redis

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Create a `.env` file:

```env
PORT=3000
APP_URL=http://localhost:3000
DATABASE_URL=postgresql://user:password@localhost:5432/url_shortener
REDIS_URL=redis://localhost:6379
```

- `DATABASE_URL` is required.
- `REDIS_URL` is required.
- `APP_URL` controls generated short URLs and defaults to `http://localhost:<PORT>`.

3. Generate and apply the database schema:

```bash
pnpm exec drizzle-kit generate
pnpm exec drizzle-kit push
```

4. Start the server:

```bash
pnpm start
```

The server listens on `http://localhost:3000` by default.

## API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Health-style greeting |
| `POST` | `/shorten` | Create or reuse a short URL |
| `GET` | `/:code` | Redirect to the original URL |
| `GET` | `/:code/stats` | Get link details and click count |

### Create a short URL

```bash
curl -X POST http://localhost:3000/shorten \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

Response:

```json
{
  "code": "Ab12Cd",
  "shortUrl": "http://localhost:3000/Ab12Cd"
}
```

Custom codes are optional:

```json
{
  "url": "https://example.com",
  "customCode": "example"
}
```

Custom codes must contain 3–20 alphanumeric, underscore, or hyphen characters.

The `/shorten` endpoint is limited to 20 requests per minute per IP. Existing original URLs reuse their existing short code.

### Redirect

```bash
curl -i http://localhost:3000/Ab12Cd
```

Redirect URLs are cached in Redis for one hour. Redis cache failures fall back to PostgreSQL. Successful redirects increment the click count.

### Statistics

```bash
curl http://localhost:3000/Ab12Cd/stats
```

Response:

```json
{
  "code": "Ab12Cd",
  "originalUrl": "https://example.com",
  "clicks": 42
}
```

## Response Codes

- `201` — Short URL created
- `400` — Invalid URL or unsupported protocol
- `404` — Short code not found
- `409` — Custom code already in use
- `429` — Rate limit exceeded
