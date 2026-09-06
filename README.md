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
*TBD*

## MCP
*TBD*

## REST API
*TBD*

## Architecture
*TBD*

## Security Model
*TBD*

## Development
*TBD*

## Deployment
*TBD*

## Roadmap
*TBD*
