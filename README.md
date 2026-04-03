# Streamer

[![Build and Push Docker Image](https://github.com/C0D3D3V/Streamer/actions/workflows/docker.yml/badge.svg)](https://github.com/C0D3D3V/Streamer/actions/workflows/docker.yml)

A self-hosted live streaming and video archive platform. Ingest video over WebSocket, transcode to adaptive HLS with hardware acceleration, and share recordings with optional password protection.

## Features

- Live streaming via WebSocket ingest
- Adaptive bitrate HLS output (1080p / 720p / 480p / 320p)
- Hardware-accelerated encoding (Intel QSV, VA-API, or software fallback)
- VOD archive with MP4 download
- Password-protected share links for guests
- OpenID Connect authentication via Authelia (or any OIDC provider)
- Progressive Web App (PWA) support for the streamer client

---

## Requirements

- Docker + Docker Compose
- An OIDC provider (Authelia recommended)
- A reverse proxy with HTTPS (Traefik example included)
- _(Optional)_ Intel GPU for hardware-accelerated encoding

---

## Quick Start

### 1. Clone and configure

```bash
git clone https://github.com/youruser/streamer.git
cd streamer
cp .env.example .env
```

Edit `.env` and fill in all values (see [Configuration](#configuration) below).

### 2. Set up the Authelia OIDC client

See [Authelia OIDC Setup](#authelia-oidc-setup) below.

### 3. Deploy

```bash
cp docker-compose.example.yml docker-compose.yml
# Edit docker-compose.yml — update the data volume path and Traefik hostname
docker compose pull
docker compose up -d
```

The image is published automatically to `ghcr.io/c0d3d3v/streamer:latest` on every push to `main`. Tagged releases (e.g. `v1.2.0`) are also published as versioned image tags.

The app will be available at the hostname configured in your reverse proxy.

---

## Configuration

All settings are provided via environment variables (`.env`):

| Variable             | Default               | Description                                                           |
| -------------------- | --------------------- | --------------------------------------------------------------------- |
| `PORT`               | `3000`                | Port the server listens on                                            |
| `DATA_DIR`           | `/data`               | Directory for the database and stream files                           |
| `SESSION_SECRET`     | —                     | **Required.** Long random string for signing sessions                 |
| `OIDC_ISSUER`        | —                     | Base URL of your OIDC provider (e.g. `https://auth.example.com`)      |
| `OIDC_CLIENT_ID`     | —                     | Client ID registered in your OIDC provider                            |
| `OIDC_CLIENT_SECRET` | —                     | Client secret from your OIDC provider                                 |
| `OIDC_REDIRECT_URI`  | —                     | Full callback URL (e.g. `https://streamer.example.com/auth/callback`) |
| `FFMPEG_ENCODER`     | `auto`                | Encoder: `auto`, `qsv`, `vaapi`, or `libx264`                         |
| `VAAPI_DEVICE`       | `/dev/dri/renderD128` | VA-API device node (only needed when `FFMPEG_ENCODER=vaapi`)          |
| `PUID`               | `1000`                | User ID to run the process as inside the container                    |
| `PGID`               | `1000`                | Group ID to run the process as inside the container                   |
| `UMASK`              | `022`                 | File creation mask                                                    |

Generate a secure session secret with:

```bash
openssl rand -hex 32
```

---

## Authelia OIDC Setup

Streamer uses the Authorization Code flow with scopes `openid profile email`. Follow these steps to register it as an OIDC client in Authelia.

### 1. Generate a client secret

```bash
# Generate a plain secret, then hash it for Authelia's config
SECRET=$(openssl rand -hex 32)
echo "Plain secret (use in Streamer's .env): $SECRET"

# Hash it for Authelia (requires authelia binary or Docker)
docker run --rm authelia/authelia:latest authelia crypto hash generate pbkdf2 --variant sha512 --password "$SECRET"
```

Save the **plain secret** in `.env` as `OIDC_CLIENT_SECRET`.
Use the **hashed value** in Authelia's configuration.

### 2. Add the client to Authelia's configuration

In your `configuration.yml`:

```yaml
identity_providers:
  oidc:
    # ... your existing OIDC config (hmac_secret, jwks, etc.) ...

    clients:
      - client_id: streamer
        client_name: Streamer
        client_secret: "$pbkdf2-sha512$..." # hashed secret from step 1
        public: false
        authorization_policy: one_factor # or two_factor
        require_pkce: false
        redirect_uris:
          - https://streamer.example.com/auth/callback
        scopes:
          - openid
          - profile
          - email
        response_types:
          - code
        grant_types:
          - authorization_code
        token_endpoint_auth_method: client_secret_basic
        userinfo_signed_response_alg: none
```

Reload Authelia after saving:

```bash
docker exec authelia authelia validate-config   # optional sanity check
docker compose restart authelia
```

### 3. Configure Streamer's environment

```env
OIDC_ISSUER=https://auth.example.com
OIDC_CLIENT_ID=streamer
OIDC_CLIENT_SECRET=<plain secret from step 1>
OIDC_REDIRECT_URI=https://streamer.example.com/auth/callback
```

The issuer URL must be the root of your Authelia instance. Streamer discovers the OIDC endpoints automatically via `/.well-known/openid-configuration`.

---

## Hardware Acceleration

Set `FFMPEG_ENCODER` in `.env`:

| Value     | Description                                            |
| --------- | ------------------------------------------------------ |
| `auto`    | Detect the best available encoder at startup           |
| `qsv`     | Intel Quick Sync (lowest latency, requires Intel iGPU) |
| `vaapi`   | VA-API (good compatibility on Linux with Intel/AMD)    |
| `libx264` | Software encoding (no GPU required, higher CPU usage)  |

For GPU access, pass the DRI device to the container:

```yaml
# docker-compose.yml
devices:
  - /dev/dri:/dev/dri
```

---

## Reverse Proxy (Traefik)

The example `docker-compose.yml` includes Traefik labels. Update the hostname:

```yaml
labels:
  traefik.enable: "true"
  traefik.http.routers.streamer.rule: "Host(`streamer.example.com`)"
  traefik.http.routers.streamer.entrypoints: "websecure"
  traefik.http.routers.streamer.tls: "true"
  traefik.http.services.streamer.loadbalancer.server.port: "3000"
```

HTTPS is required — session cookies are marked `Secure` in production.

---

## Usage

### Admin

Navigate to `https://streamer.example.com/admin/`. You will be redirected to Authelia to log in. Any user that successfully authenticates is granted admin access.

From the admin panel you can:

- Create and manage streams
- Start/stop live ingest
- View the archive and download MP4 recordings
- Generate share links (optionally password-protected)

### Streaming

Open `https://streamer.example.com/streamer/` on your device (works as a PWA). Select a stream and start broadcasting. Video is sent over WebSocket and transcoded in real time.

### Share Links

Share links (`/s/<slug>`) give unauthenticated guests access to a specific stream or recording. You can set an optional password and expiry when creating them from the admin panel.

---

## Data

All persistent data is stored under `DATA_DIR` (default: `/data` inside the container):

```
/data/
├── db.sqlite         # Stream metadata and share links
├── sessions.sqlite   # Session store
└── streams/          # HLS segments and MP4 files
    └── <stream-id>/
        ├── hls/
        │   ├── 1080p/
        │   ├── 720p/
        │   ├── 480p/
        │   └── 320p/
        └── recording.mp4
```

Back up the entire `DATA_DIR` to preserve your archive.

---

## Development

```bash
npm install
cp .env.example .env   # fill in values
npm run dev            # starts with auto-reload
```

Requires Node.js 20+ and FFmpeg installed locally.
