# SeerrSense

> **Give Seerr some sense.**

**AI companion for Seerr — natural-language media discovery, resolution, and MCP automation.**

SeerrSense is an intelligence and agent layer for Seerr.

Describe a movie or TV show in natural language, resolve it to verified canonical media, check its status, and request it through your existing Seerr stack.

```text
"фильм Нолана про сон во сне"
        ↓
     SeerrSense
        ↓
   Inception (2010)
   TMDB: verified
        ↓
       Seerr
        ↓
   Radarr / Sonarr
```

## Why SeerrSense?

Seerr already orchestrates your media stack.

SeerrSense adds the intelligence layer:

* Natural-language movie and TV resolution
* Verified canonical media IDs
* MCP support for Claude, ChatGPT, and other agents
* REST API
* Works with your existing Seerr / Radarr / Sonarr stack
* LLMs interpret intent, but never become the source of truth for provider IDs

## Core principle

```text
Natural-language query
        ↓
Native Seerr search
        ↓
Semantic fallback when needed
        ↓
LLM extracts MediaIntent
        ↓
Seerr / metadata provider verification
        ↓
Canonical media candidate
        ↓
User confirmation
        ↓
Seerr request
```

LLMs may infer titles, people, directors, genres, years, or plot hints.

They do **not** generate trusted TMDB or IMDb IDs.

## Interfaces

SeerrSense exposes the same core capabilities through:

* MCP
* REST API

Current MCP tools:

* `search_media`
* `resolve_media`
* `get_media`
* `request_media`

## Status

SeerrSense is under active development.

Current focus:

* standalone deployment
* semantic media resolver
* Seerr-native orchestration
* MCP integration

## Quick Start
*TBD*

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `SEERR_API_KEY` | yes | Overseerr/Jellyseerr API key |
| `SEERR_URL` | no | Seerr base URL, default `http://127.0.0.1:5055` |
| `SEERRSENSE_LOCALE` | no | `Accept-Language` for Seerr, default `en-US` |
| `SEERRSENSE_AUTH_TOKEN` | HTTP only | Shared bearer token. Not needed in stdio mode |
| `PORT` | no | default `8787` |
| `NEBIUS_API_KEY`, `NEBIUS_MODEL` | no | enable the semantic resolver |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | no | reach a Seerr behind Cloudflare Zero Trust |

### OAuth (optional)

Set all four and the server becomes its own OAuth 2.1 authorization server, with
Google as the identity provider. Set none and it keeps using the shared token.
Setting some but not all is refused at startup.

| Variable | Purpose |
|---|---|
| `SEERRSENSE_PUBLIC_URL` | Public base URL. Becomes the token issuer, so changing it invalidates every issued token |
| `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth client. Its redirect URI must be `<public url>/oauth/google/callback` |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth client secret |
| `SEERRSENSE_OAUTH_JWT_SIGNING_KEY` | HS256 key for access tokens, at least 32 bytes |
| `SEERRSENSE_ALLOWED_EMAILS` | Comma-separated Google addresses allowed to sign in. **Empty means nobody** |
| `SEERRSENSE_OAUTH_CLIENTS` | Optional pre-registered clients, `client_id=redirect_uri[,uri];...` |
| `SEERRSENSE_LEGACY_TOKEN_ENABLED` | Set to `false` to stop accepting `SEERRSENSE_AUTH_TOKEN` |
| `SEERRSENSE_ACCESS_TOKEN_TTL` | Access token lifetime in seconds, default 3600 |
| `SEERRSENSE_REFRESH_TOKEN_TTL` | Refresh token lifetime in seconds, default 30 days |
| `DATABASE_URL` | PostgreSQL for OAuth state. Without it state is in memory and a restart costs a re-login |

## MCP
*TBD*

## Web

`GET /` serves a static landing page from `public/`, with `/favicon.svg`,
`/og.png` and `/assets/*`. Those paths, the health probes and the OAuth
endpoints are the only ones served without a token.

There is no catch-all route: this is not a single-page app, and an undeclared
path is never answered with the page. The tokens the page uses are served from
this origin as `/assets/tokens.css`, so it stays readable when
`https://ui.mctl.ai/mctl.css` cannot be reached; the CDN copy is loaded after it
as the canonical source. The MCP endpoint shown on the page is derived from
`window.location.origin`, so promoting a domain needs no change here.

## REST API
*TBD*

## Architecture
*TBD*

## Security Model

`/mcp` and `/api/v1/*` require a bearer token. `/healthz`, `/readyz`, `/`,
`/.well-known/*` and `/oauth/*` do not.

With OAuth configured, clients discover the flow the standard way: an
unauthenticated request is refused with `WWW-Authenticate: Bearer …,
resource_metadata="…"`, which points at the RFC 9728 document naming this
authorization server.

- **Identity comes from Google.** Passkeys, 2FA and account recovery are
  Google's job; this server only checks the `id_token` and the allowlist.
- **Access is an allowlist**, `SEERRSENSE_ALLOWED_EMAILS`, and it fails closed:
  an unset variable admits nobody rather than everybody.
- **Clients register through Client ID Metadata Documents**, where the
  `client_id` is an https URL naming a JSON document with the client's allowed
  redirect URIs. Pre-registered clients are supported too. Dynamic Client
  Registration is deprecated in MCP 2026-07-28 and is not implemented.
- **PKCE S256 is mandatory**, on both legs: one exchange with the client, a
  separate one with Google.
- **Access tokens are short-lived HS256 JWTs** audienced at `<public url>/mcp`,
  so a token minted for another resource is refused here.
- **Refresh tokens rotate.** They are stored hashed, and presenting one that was
  already rotated revokes the entire family, on the assumption that two parties
  now hold it.
- **Scopes are `seerr:read` and `seerr:request`.** Only those two are
  advertised, and `request_media` checks for `seerr:request` itself.
- The shared `SEERRSENSE_AUTH_TOKEN` keeps working during the migration and is
  compared in constant time. Turn it off with
  `SEERRSENSE_LEGACY_TOKEN_ENABLED=false`.

## Development
*TBD*

## Deployment
*TBD*

## Roadmap
*TBD*
