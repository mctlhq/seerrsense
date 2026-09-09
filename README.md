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

Minimum settings for any of the three ways to run it: `SEERR_URL` (defaults to
`http://127.0.0.1:5055`), `SEERR_API_KEY` for the household Overseerr/Jellyseerr, and
`SEERRSENSE_AUTH_TOKEN`, which `assertHttpConfig` requires only when the HTTP server
is started — stdio mode has no network surface and does not need it.

**Container.** The published image is built from the `Dockerfile` (`node:22-slim`),
listens on port `8787` and answers `/healthz` for the container healthcheck:

```sh
docker run -p 8787:8787 \
  -e SEERR_URL=https://media.example.com \
  -e SEERR_API_KEY=... \
  -e SEERRSENSE_AUTH_TOKEN=... \
  ghcr.io/mctlhq/seerrsense:<tag>
```

(`<tag>` is a released version; see [Deployment](#deployment) for how images are
built and tagged.)

**Standalone binary.** Every tagged release attaches four bun-compiled executables
(`.github/workflows/release-binaries.yml`): `seerrsense-linux-x64`,
`seerrsense-windows-x64.exe`, `seerrsense-darwin-x64` and `seerrsense-darwin-arm64`.
They are built primarily for `seerrsense stdio` below; whether a given release also
serves the HTTP landing page depends on `public/` being present next to the binary,
which is not verified here — for HTTP mode, the container image is the documented
path.

**stdio.** For clients that own the process directly (Claude Desktop and similar),
run the server on stdio instead of opening a port:

```sh
seerrsense stdio
```

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `SEERR_API_KEY` | no | API key for the household Overseerr/Jellyseerr. Optional: a signed-in person can attach their own instead |
| `SEERR_URL` | no | Seerr base URL, default `http://127.0.0.1:5055` |
| `SEERRSENSE_LOCALE` | no | `Accept-Language` for Seerr, default `en-US` |
| `SEERRSENSE_AUTH_TOKEN` | HTTP only | Shared bearer token. Not needed in stdio mode |
| `PORT` | no | default `8787` |
| `NEBIUS_API_KEY`, `NEBIUS_MODEL` | no | enable the semantic resolver |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | no | reach a Seerr behind Cloudflare Zero Trust |

### Cloudflare Access and the semantic layer

`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` add the Cloudflare Access
service-token headers to every call the *household* Seerr client makes. A
signed-in person does not set these: the same two values are two fields on
`/account`, sealed per user and applied only to their own attached instance.

`NEBIUS_API_KEY` (with the optional `NEBIUS_MODEL`) turns on the semantic
resolver: when Seerr's native search and a normalised retry both come up
empty, unresolved phrasings go through a language model that proposes
candidate titles for verification against Seerr. Without it, search still
works, just without the fallback.

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
| `DATABASE_URL` | PostgreSQL for OAuth state and attached Seerr instances. Without it both live in memory and a restart detaches everyone |
| `SEERRSENSE_ENCRYPTION_KEY` | 32 bytes, hex or base64, sealing the Seerr API keys people attach. Without it nobody can attach one |

## MCP

The MCP endpoint is `/mcp`, a Streamable HTTP transport speaking the 2026-07-28
protocol revision. It exposes four tools — `search_media`, `resolve_media`,
`get_media` and `request_media`, the last being the only one that writes — under
three scopes: `seerr:read`, `seerr:request` and `offline_access`. See
[Security Model](#security-model) for how a token earns those scopes and what
each one gates.

A client discovers the authorization server the standard way: an
unauthenticated request to `/mcp` is refused with a `WWW-Authenticate` header
pointing at the RFC 9728 protected-resource document. Four `.well-known`
documents are served: `/.well-known/oauth-authorization-server`,
`/.well-known/oauth-authorization-server/mcp`,
`/.well-known/oauth-protected-resource` and
`/.well-known/oauth-protected-resource/mcp`.

Clients register through **Client ID Metadata Documents**: `client_id` is an
https URL with a path, naming a JSON document that lists the client's
`client_name` and allowed `redirect_uris`. Dynamic Client Registration is
deprecated in MCP 2026-07-28 and is not implemented. A client that cannot
publish a CIMD can instead be given a **pre-registered** entry via
`SEERRSENSE_OAUTH_CLIENTS`, formatted as
`client_id=redirect_uri[,redirect_uri...];...` (semicolon-separated entries,
comma-separated redirect URIs within one entry).

## Whose Seerr

A person signs in at `/account` with the same Google account, enters the
address and API key of their Overseerr or Jellyseerr, and the page checks the
credentials against that instance before storing them. The key is never typed
into a chat and never returned by the API, not even masked.

The page authenticates with a short-lived session cookie, deliberately not with
an MCP access token: an assistant holding a token must not be able to read or
rewrite which Seerr it talks to. The two credentials carry different audiences,
so neither works in place of the other.


Each signed-in person can attach their own Overseerr or Jellyseerr; their API
key is sealed with AES-256-GCM before it is stored and never leaves this server.
Resolution order for a request:

1. the instance that person attached, if any;
2. otherwise the household instance from `SEERR_URL` and `SEERR_API_KEY`;
3. otherwise the tools say so and point at the account page.

The legacy shared token and stdio mode have no person behind them, so they
always get the household instance.

On the household instance the API key belongs to its owner, which would file
every request under that one name. Overseerr accepts a `userId` on a request
made with an admin key, so the signed-in address is matched against the Seerr
user list and the request is filed as the person who actually asked — their
quota and approval rules then apply. On somebody's own instance this is moot:
the key is already theirs.

## Web

`GET /` serves a static landing page from `public/`, with `/favicon.svg`,
`/og.png` and `/assets/*`. Those paths, the health probes and the OAuth
endpoints are the only ones served without a token.

`/privacy` and `/terms` state what is stored, where it goes, and what the
operator can technically see. Google requires both before an OAuth app can leave
testing, and a service holding other people's API keys owes them the statement
regardless.

There is no catch-all route: this is not a single-page app, and an undeclared
path is never answered with the page.

The MCTL design tokens are vendored into `public/assets/tokens.css` by
`npm run sync:tokens` and committed, so the page fetches no third-party
stylesheet and cannot be restyled without a commit. `npm run check:tokens` runs
in CI and fails when the committed copy no longer matches the design system, so
an upstream change arrives as a diff to review rather than as a surprise on the
site.

The source is a pinned version — `https://ui.mctl.ai/0.5.0/mctl.css` — not the
floating `mctl.css`. That path is served `immutable` and mctl-design's CI
refuses to edit, move or delete a published version directory, so upgrading is
an edit made here on purpose. Change the `SOURCE` constant in
`scripts/sync-tokens.mjs`, run `npm run sync:tokens`, and commit the diff.

The MCP endpoint shown on the page is derived from `window.location.origin`, so
promoting a domain needs no change here.

## REST API

The same four operations are available over REST at `/api/v1`, gated by the
same bearer token as `/mcp`:

* `GET /api/v1/search` — query the tenant's Seerr.
* `GET /api/v1/media/:mediaType/:tmdbId` — canonical record for one TMDB id.
* `POST /api/v1/request` — file a request, guarded the same way `request_media` is.
* `GET /api/v1/resolve` — natural-language resolution, going through the semantic
  layer when it is configured.

`/api/v1/account/connection` has its own `GET`, `PUT` and `DELETE` methods for
reading, saving and removing a person's attached Seerr, but — as already noted
above — it authenticates with the browser session cookie set at `/account`, not
with an MCP access token: an assistant holding a token must not be able to read
or rewrite which Seerr it talks to.

## Architecture

* `src/api` — the Fastify HTTP server: `/mcp`, `/api/v1/*`, `/account/*`, the
  static landing/account pages, and the health probes.
* `src/auth` — the optional OAuth 2.1 authorization server (config, routes,
  client resolution, token verification) and the legacy shared-token check.
* `src/core` — environment config and shared schemas.
* `src/mcp` — the MCP server factory and its four tools.
* `src/providers/seerr` — the Seerr HTTP client and `TenantResolver`.

`TenantResolver` decides which Seerr a request reaches, in order: the instance
that signed-in person attached themselves; otherwise the household instance
from `SEERR_URL`/`SEERR_API_KEY`; otherwise none, in which case the tools and
REST endpoints say so and point at `/account`. A resolution is cached for one
minute per subject so the MCP hot path costs no extra database read; saving or
deleting a connection calls `forget()` on that person's cache entry so the
change is not stuck behind the cache window.

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
  Registration is deprecated in MCP 2026-07-28 and is not implemented; a client
  that cannot use either path can be given a pre-registered entry instead.
- **Redirect URIs match exactly, except for loopback**, where the port is
  ignored as RFC 8252 requires — a native client binds an ephemeral port and
  cannot declare it in advance. `localhost` and `127.0.0.1` stay distinct, and a
  URI carrying userinfo is refused outright.
- **One consent screen** names the client, the address you will be returned to
  and what is being granted. It is what makes a loopback client distinguishable
  from a local impostor, and it doubles as visible confirmation that the
  connection worked.
- **PKCE S256 is mandatory**, on both legs: one exchange with the client, a
  separate one with Google.
- **Access tokens are short-lived HS256 JWTs** audienced at `<public url>/mcp`,
  so a token minted for another resource is refused here.
- **Refresh tokens rotate.** They are stored hashed, and presenting one that was
  already rotated revokes the entire family, on the assumption that two parties
  now hold it.
- **Scopes are `seerr:read`, `seerr:request` and `offline_access`.** Only those
  are advertised, because a scope advertised but not granted makes clients warn
  the user about permissions on a token that works. `request_media` checks for
  `seerr:request` itself.
- The shared `SEERRSENSE_AUTH_TOKEN` keeps working during the migration and is
  compared in constant time. Turn it off with
  `SEERRSENSE_LEGACY_TOKEN_ENABLED=false`.

## Development

`package.json` scripts:

| Script | What it does |
|---|---|
| `npm run dev` | run the server with `tsx`, no build step |
| `npm run build` | compile to `dist/` with `tsc` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | run the vitest suite |
| `npm run sync:tokens` | regenerate `public/assets/tokens.css` from the pinned `https://ui.mctl.ai/0.5.0/mctl.css` |
| `npm run check:tokens` | verify the committed tokens file still matches that source (CI gate) |

CI (`.github/workflows/ci.yml`) runs, in order: `check:tokens`, `typecheck`,
`test`, then a `docker build` of the image with no push. The test step runs
against a `postgres:16-alpine` service container via `TEST_DATABASE_URL`, so
`PostgresAuthStore` — which carries every authorization code and refresh token
in production — is exercised for real, not only through the in-memory store.

## Deployment

The version is managed by [release-please](.github/workflows/release-please.yml),
which opens and merges the release PR and tags the resulting commit. Once a
release is created, that workflow hands the new tag to the platform's
`mctl-gitops` repository, which builds `ghcr.io/mctlhq/seerrsense` from this
repo's `Dockerfile` and updates the deployed image tag for ArgoCD to sync.
Tag pushes also trigger `release-binaries.yml`, which builds and attaches the
four standalone executables described in [Quick Start](#quick-start) to that
tag's GitHub release. `ci.yml`'s own `docker build` step never pushes; it only
proves the image still builds on every PR.
