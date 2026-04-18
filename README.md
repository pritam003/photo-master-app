# APhoto — Self-Hosted Personal Photo Library

A Google Photos-inspired, self-hosted photo library. Upload, organize, search, and share your photos — with AI tagging, face recognition, and Google Takeout import. Runs on your own infrastructure using Azure storage and PostgreSQL.

---

## Screenshots

| Login | Library | Albums |
|---|---|---|
| ![Login](docs/screenshots/login-page.png) | ![Library](docs/screenshots/library.png) | ![Albums](docs/screenshots/albums.png) |

| Upload | Multi-select | Trash |
|---|---|---|
| ![Upload](docs/screenshots/06-upload.png) | ![Multi-select](docs/screenshots/multiselect.png) | ![Trash](docs/screenshots/trash.png) |

---

## Table of Contents

1. [Features](#features)
2. [Architecture Overview](#architecture-overview)
3. [Repository Structure](#repository-structure)
4. [Local Development Setup](#local-development-setup)
5. [Authentication Setup](#authentication-setup)
   - [Microsoft Entra ID (Device Code Flow)](#microsoft-entra-id-device-code-flow)
   - [Google SSO (Sign in with Google)](#google-sso-sign-in-with-google)
6. [Google Photos Import](#google-photos-import)
7. [Environment Variables Reference](#environment-variables-reference)
8. [Database Schema](#database-schema)
9. [Background Worker](#background-worker)
10. [Archive Lock (TOTP)](#archive-lock-totp)
11. [Album Sharing](#album-sharing)
12. [Deployment](#deployment)
13. [Tech Stack](#tech-stack)

---

## Features

- Upload photos & videos (JPG, PNG, HEIC, MP4) — drag-and-drop or file picker; up to 100 MB per file
- Library view — date-grouped grid, search by filename, month, or year
- Favorites, Albums, Trash (soft-delete + restore)
- **On This Day** — auto-generated memories reel showing photos from the same calendar date across all years
- **Archive** — hide photos behind a TOTP lock (Microsoft Authenticator); recover via Gmail OTP if authenticator is lost
- **Face recognition** — local TensorFlow inference clusters detected faces into named "people"
- **AI tagging** — Azure Computer Vision generates searchable tags per photo
- **GPS geocoding** — EXIF GPS coordinates reverse-geocoded via Nominatim (OpenStreetMap)
- **Import from Google Photos** — OAuth 2.0 Picker API flow; bulk imports into albums
- **Album sharing** — share albums via access-code or email-gated links (view or contribute permissions)
- **Public share links** — expiring per-photo links
- Dark mode — full support
- **PWA** — installable, offline-capable; Web Share Target (share photos directly from device gallery)
- **Two auth providers** — Microsoft Entra ID (primary) + Google SSO (optional)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser / PWA                        │
│            React 18 + Vite + Tailwind + TanStack Query      │
│                  artifacts/my-photos/                       │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTPS REST (JSON)
                         │ auth_token cookie (JWT, 7d)
┌────────────────────────▼────────────────────────────────────┐
│                    Express API Server                        │
│            artifacts/api-server/  (Node.js + TS)            │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Auth routes │  │ Photo routes │  │  People/Faces    │  │
│  │  /api/auth/* │  │ /api/photos  │  │  /api/people     │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Albums/Share │  │ Google Import│  │  Archive Lock    │  │
│  │ /api/albums  │  │ /api/google  │  │  /api/archive    │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└────────┬────────────────────┬─────────────────┬────────────┘
         │                    │                 │
 ┌───────▼──────┐   ┌─────────▼──────┐  ┌──────▼──────┐
 │  PostgreSQL  │   │  Azure Blob    │  │  Redis      │
 │  (Drizzle)   │   │  Storage       │  │  (optional  │
 │              │   │  photos +      │  │  cache)     │
 │              │   │  thumbnails    │  └─────────────┘
 └──────────────┘   └────────────────┘

┌─────────────────────────────────────────────────────────────┐
│               Background Worker (same Docker image)         │
│                   WORKER_MODE=true                          │
│                                                             │
│  Every 30s: Vision tags, GPS geocoding                      │
│  Every 1hr: Face recognition (child process, isolated)      │
└─────────────────────────────────────────────────────────────┘
```

**Two processes, one image** — the same Docker image runs as either the API server or the background worker, controlled by the `WORKER_MODE` environment variable.

---

## Repository Structure

```
Photo-Master-main/
├── artifacts/
│   ├── api-server/          # Express API (Node.js + TypeScript)
│   │   ├── src/
│   │   │   ├── app.ts       # Express app, JWT middleware, session
│   │   │   ├── index.ts     # HTTP server entry point
│   │   │   ├── worker.ts    # Background worker entry point
│   │   │   ├── lib/
│   │   │   │   ├── auth.ts          # Microsoft Device Code flow
│   │   │   │   ├── azure-storage.ts # Blob upload/download/SAS URLs
│   │   │   │   ├── azure-vision.ts  # Computer Vision tags
│   │   │   │   ├── face-recognition.ts # TF face clustering
│   │   │   │   ├── cache.ts         # Redis cache helpers
│   │   │   │   └── thumbnails.ts    # sharp + ffmpeg thumbnails
│   │   │   └── routes/
│   │   │       ├── auth.ts          # Microsoft + Google SSO
│   │   │       ├── photos.ts        # Upload, CRUD, search
│   │   │       ├── albums.ts        # Album management
│   │   │       ├── album-shares.ts  # Code/email album sharing
│   │   │       ├── shares.ts        # Per-photo share links
│   │   │       ├── people.ts        # Face clusters
│   │   │       ├── google-import.ts # Google Photos Picker import
│   │   │       ├── archive-lock.ts  # TOTP archive gate
│   │   │       ├── blobs.ts         # SAS URL proxy
│   │   │       └── health.ts        # Liveness probe
│   │   └── Dockerfile
│   │
│   └── my-photos/           # React PWA frontend
│       └── src/
│           ├── App.tsx      # Routes + auth guard + layout
│           ├── pages/       # Library, Albums, People, Archive, etc.
│           ├── components/  # Lightbox, Upload modal, Sidebar, etc.
│           ├── hooks/       # useAuth, usePhotos, etc.
│           └── lib/         # API client, import context
│
├── lib/
│   ├── db/                  # Drizzle ORM schema (PostgreSQL)
│   ├── api-spec/            # OpenAPI 3.0 spec (orval codegen source)
│   ├── api-client-react/    # Auto-generated TanStack Query hooks
│   └── api-zod/             # Auto-generated Zod validators
│
├── tests/e2e/               # Playwright end-to-end tests
├── scripts/                 # One-off backfill scripts
└── docs/screenshots/        # App screenshots
```

---

## Local Development Setup

### Prerequisites

- **Node.js 22+**
- **pnpm** (`npm install -g pnpm`)
- **PostgreSQL** (local or remote)
- **Azure Storage account** (blob container)
- Optional: Docker, Redis

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure the API

Create `artifacts/api-server/.env`:

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/aphotos

# Azure Storage (required)
AZURE_STORAGE_ACCOUNT_NAME=yourstorageaccount
AZURE_STORAGE_CONTAINER_NAME=photos

# Auth (required — see Authentication Setup below)
JWT_SECRET=a-long-random-string-at-least-32-chars
SESSION_SECRET=another-long-random-string

# Microsoft Entra ID (for Microsoft sign-in)
AZURE_TENANT_ID=your-tenant-id
MSAL_CLIENT_ID=your-app-client-id

# Google SSO + Google Photos Import (optional)
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret

# App URL (the frontend's public URL — used for OAuth redirects)
APP_URL=http://localhost:5173

# Email (for archive Gmail OTP fallback)
SMTP_FROM=noreply@yourdomain.com
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password

# Optional
REDIS_URL=redis://localhost:6379
NODE_ENV=development
```

### 3. Configure the frontend

Create `artifacts/my-photos/.env`:

```env
PORT=5173
BASE_PATH=/
VITE_API_BASE=http://localhost:3000
```

### 4. Run database migrations

```bash
pnpm --filter @workspace/db drizzle-kit migrate
```

### 5. Start development servers

```bash
# Terminal 1 — API server (port 3000)
pnpm --filter api-server dev

# Terminal 2 — Frontend (port 5173)
pnpm --filter my-photos dev
```

Open [http://localhost:5173](http://localhost:5173).

---

## Authentication Setup

APhoto supports two authentication providers. You must set up at least one.

### Microsoft Entra ID (Device Code Flow)

The app uses the **OAuth 2.0 Device Authorization Grant** — no client secret is required. Users authenticate in their browser; the app polls for the token.

#### Step 1 — Register an app in Azure Entra ID

1. Go to [portal.azure.com](https://portal.azure.com) → **Microsoft Entra ID** → **App registrations** → **New registration**
2. Set a name (e.g., `APhoto`)
3. **Supported account types**: choose based on your needs
   - *Single tenant* — only users in your organization
   - *Personal Microsoft accounts only* — personal accounts (Outlook, Hotmail)
   - *Multitenant + personal* — broadest access
4. **Redirect URI**: leave blank for now (device code flow doesn't use one)
5. Click **Register**

#### Step 2 — Enable public client flows

1. In your app registration → **Authentication**
2. Scroll to **Advanced settings**
3. Toggle **Allow public client flows** → **Yes**
4. Click **Save**

#### Step 3 — Add API permissions

1. Go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**
2. Add: `User.Read`, `openid`, `profile`, `email`, `offline_access`
3. Click **Grant admin consent** (if you're an admin)

#### Step 4 — Copy credentials

From your app registration **Overview** page:

```
Application (client) ID  →  MSAL_CLIENT_ID
Directory (tenant) ID    →  AZURE_TENANT_ID
```

#### How the flow works at runtime

```
User clicks "Sign in with Microsoft"
        │
        ▼
GET /api/auth/device-code
        │   returns { user_code: "ABCD-EFGH", verification_uri: "https://microsoft.com/devicelogin" }
        │
        ▼
Frontend shows the code + opens microsoft.com/devicelogin in a new tab
        │
        ▼  (user enters code and approves in browser)
Frontend polls  GET /api/auth/device-code/poll
        │   polls Microsoft token endpoint every ~5s
        │   returns JWT auth_token cookie on success
        ▼
User is authenticated, redirected to library
```

---

### Google SSO (Sign in with Google)

This is an **optional, additive** auth provider. Users who prefer Google accounts can sign in with it. It is also **required** if you want Google Photos import.

#### Step 1 — Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project or select an existing one
3. Go to **APIs & Services** → **Enable APIs and Services**

#### Step 2 — Enable required APIs

Enable both of these APIs:

| API | Purpose |
|---|---|
| **Google People API** | Read basic profile info (`name`, `email`) after OAuth |
| **Photos Picker API** | Google Photos import (Picker API v1) |

Search each by name in the API Library and click **Enable**.

#### Step 3 — Configure the OAuth consent screen

1. Go to **APIs & Services** → **OAuth consent screen**
2. Choose **External** (for users outside your org) or **Internal**
3. Fill in:
   - **App name**: `APhoto`
   - **User support email**: your email
   - **Developer contact email**: your email
4. Click **Save and Continue**
5. **Scopes** — add:
   - `openid`
   - `email`
   - `profile`
   - `https://www.googleapis.com/auth/photospicker.mediaitems.readonly` *(for Google Photos import)*
6. Add yourself as a **Test user** if the app is in testing mode
7. Click **Save and Continue**

#### Step 4 — Create OAuth 2.0 credentials

1. Go to **APIs & Services** → **Credentials** → **Create credentials** → **OAuth client ID**
2. **Application type**: Web application
3. **Authorized JavaScript origins**:
   ```
   http://localhost:5173          (development)
   https://yourdomain.com         (production)
   ```
4. **Authorized redirect URIs** — add all of these:
   ```
   http://localhost:3000/api/auth/google/callback     (dev API)
   https://your-api-domain.com/api/auth/google/callback  (prod API)
   ```
   > The redirect URI **must point at the API server**, not the frontend.
5. Click **Create** and copy:
   ```
   Client ID     → GOOGLE_CLIENT_ID
   Client secret → GOOGLE_CLIENT_SECRET
   ```

#### Step 5 — Set environment variables

```env
GOOGLE_CLIENT_ID=123456789-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxxxx
```

#### How the Google SSO flow works

```
User clicks "Sign in with Google"
        │
        ▼
GET /api/auth/google
        │   generates random `state`, stores it in memory (10 min TTL)
        │   redirects to accounts.google.com/o/oauth2/v2/auth
        │
        ▼  (user approves on Google's page)
GET /api/auth/google/callback?code=...&state=...
        │
        ├── verifies state (CSRF protection)
        ├── exchanges code → id_token via https://oauth2.googleapis.com/token
        ├── decodes id_token payload (sub, name, email)
        ├── issues JWT auth_token cookie (7d)
        │
        ▼
User redirected to /  (library page)
```

---

## Google Photos Import

Once Google SSO is configured, users can import photos directly from their Google Photos library.

### How it works (end to end)

```
User opens Import modal → selects "From Google Photos"
        │
        ▼
POST /api/google-import/start
        │   requires ?albumName= or ?noAlbum=true
        │   initiates Google Photos Picker API session
        │   returns { importId, pickerUri }
        │
        ▼
Frontend opens pickerUri in a new tab
   User selects photos in Google's native picker UI
        │
        ▼
Worker loop polls the Picker session every 5s
   waiting for mediaItemsSet=true (user confirms selection)
        │
        ▼  (up to 1 hour wait for user to pick)
Phase 2: fetch selected media items (paginated, up to ~230/session)
        │
        ▼
For each photo:
   1. Download via baseUrl?=d (Google CDN, full res)
   2. Re-upload to Azure Blob Storage
   3. Generate thumbnails (sharp / ffmpeg)
   4. Insert into `photos` table
   5. Link to album (if albumName was specified)
        │
        ▼
GET /api/google-import/status/:importId
   Frontend polls this endpoint and shows a live progress banner
        │  { status: "importing", imported: 42, total: 100 }
        ▼
Status becomes "done" — import complete
```

### Error recovery & resumability

If the import fails mid-way (network error, quota issue), the server:
1. Marks the import as `resumable: true`
2. Stores unprocessed items + auth tokens in memory

The frontend shows a **Resume** button. The user can restart from the last checkpoint:

```
POST /api/google-import/resume/:importId
```

### Cancellation

```
DELETE /api/google-import/cancel/:importId
```

The worker loop checks the cancel set on each iteration and stops gracefully.

### Limitations

- The Google Photos Picker API returns a **maximum of ~230 items per session**. For larger libraries, run multiple imports.
- Picker sessions expire after **1 hour** if the user doesn't confirm selection.
- Downloaded photo URLs (`baseUrl`) are temporary CDN links — they are consumed immediately during import.

---

## Environment Variables Reference

### API Server

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `AZURE_STORAGE_ACCOUNT_NAME` | ✅ | Azure Blob Storage account name |
| `AZURE_STORAGE_CONTAINER_NAME` | ✅ | Blob container name for photos |
| `JWT_SECRET` | ✅ | Secret for signing JWT auth tokens (min 32 chars) |
| `SESSION_SECRET` | ✅ | Secret for express-session |
| `AZURE_TENANT_ID` | ⚠️ | Required for Microsoft sign-in |
| `MSAL_CLIENT_ID` | ⚠️ | Azure app registration client ID |
| `GOOGLE_CLIENT_ID` | ⚠️ | Required for Google SSO + Photos import |
| `GOOGLE_CLIENT_SECRET` | ⚠️ | Google OAuth client secret |
| `APP_URL` | ✅ | Public URL of the frontend (used for OAuth redirects) |
| `SMTP_FROM` | ⚠️ | From address for archive OTP emails |
| `SMTP_USER` | ⚠️ | SMTP username |
| `SMTP_PASS` | ⚠️ | SMTP password |
| `REDIS_URL` | ❌ | Redis connection URL (optional, for caching) |
| `VISION_BATCH` | ❌ | Azure Vision batch size (default: `5`) |
| `GPS_BATCH` | ❌ | GPS geocoding batch size (default: `20`) |
| `WORKER_MODE` | ❌ | Set to `true` to start the background worker instead of API |
| `NODE_ENV` | ❌ | `development` or `production` |

> ✅ = Always required · ⚠️ = Required only if using that feature · ❌ = Optional

### Frontend (build-time)

| Variable | Required | Description |
|---|---|---|
| `PORT` | ✅ | Dev server port (e.g. `5173`) |
| `BASE_PATH` | ✅ | Vite base path (usually `/`) |
| `VITE_API_BASE` | ✅ | Full URL of the API server |

---

## Database Schema

All tables use PostgreSQL via **Drizzle ORM**. Migrations live in `lib/db/`.

### `photos`

The central table. One row per uploaded photo or video.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Primary key |
| `userId` | text | Owner's identity subject (from JWT `sub`) |
| `filename` | text | Original filename |
| `blobName` | text | Azure Blob name (path in container) |
| `contentType` | text | MIME type (`image/jpeg`, `video/mp4`, etc.) |
| `size` | bigint | File size in bytes |
| `width`, `height` | integer | Image dimensions (null for videos) |
| `thumbBlobName` | text | 600×600 JPEG thumbnail blob name |
| `previewBlobName` | text | 1920px wide JPEG preview blob name |
| `favorite` | boolean | Starred by user |
| `trashed` | boolean | Soft-deleted |
| `trashedAt` | timestamp | When it was trashed |
| `hidden` | boolean | In the TOTP-protected archive |
| `takenAt` | timestamp | EXIF capture date (extracted at upload) |
| `uploadedAt` | timestamp | Server upload time |
| `tags` | text | JSON array of Azure Vision tags |
| `locationName` | text | Reverse-geocoded location (e.g., "Brooklyn, New York") |

### `albums`

```
id, userId, name, description, createdAt, trashed, trashedAt
```

### `albumPhotos`

Junction table: `albumId → photoId` (cascade deletes on both sides).

### `albumShares`

Sharing records for albums.

| Column | Description |
|---|---|
| `token` | Random unique share token (URL key) |
| `shareType` | `"code"` — access code gate, or `"email"` — email allowlist |
| `permission` | `"view"` or `"contribute"` |
| `accessCodeHash` | SHA-256 of the generated `ABCD-EF23` style code |
| `allowedEmails` | JSON array of allowed email addresses (email shares only) |
| `revokedAt` | Set when owner revokes access |

### `shareLinks`

Per-photo expiring public links. Stores `photoId + expiresAt`.

### `people`

Face recognition clusters. One row per recognized person per user.

| Column | Description |
|---|---|
| `name` | User-assigned name (nullable until user labels) |
| `coverFaceBlob` | Blob name of the representative face crop |

### `photoFaces`

Individual face detections. Links a detected face to a photo and optionally to a person cluster.

| Column | Description |
|---|---|
| `photoId` | The photo this face was found in |
| `personId` | The person cluster (nullable until clustered) |
| `boundingBox` | JSON `{top, left, width, height}` normalized 0–1 |
| `azurePersistedFaceId` | Azure Face API persisted face ID (if using cloud face service) |

### `userSettings`

One row per user. Stores `archiveTotpSecret` for the TOTP archive lock.

---

## Background Worker

The worker runs alongside the API as a **separate process** (same Docker image, different entrypoint). It handles all post-upload processing so that upload latency is not affected.

### Starting the worker

```bash
# Locally
WORKER_MODE=true pnpm --filter api-server dev

# Docker
docker run -e WORKER_MODE=true your-api-image
```

### What it does

```
Every 30 seconds:
  ┌─────────────────────────────────────────────────────┐
  │ 1. Vision tags pass                                 │
  │    SELECT 5 photos WHERE tags IS NULL               │
  │    → call Azure Computer Vision                     │
  │    → UPDATE photos SET tags = [...]                 │
  │                                                     │
  │ 2. GPS geocoding pass                               │
  │    SELECT 20 photos WHERE location_name IS NULL     │
  │      AND has EXIF GPS data                          │
  │    → call Nominatim (1.1s rate limit between calls) │
  │    → UPDATE photos SET location_name = "City, ..."  │
  │                                                     │
  │ 3. Video thumbnail pass                             │
  │    SELECT 3 videos WHERE thumb_blob_name IS NULL    │
  │    → download blob → ffmpeg extract frame           │
  │    → sharp resize → re-upload thumbnail             │
  └─────────────────────────────────────────────────────┘

Every hour:
  ┌─────────────────────────────────────────────────────┐
  │ Face recognition batch                              │
  │   Spawned as isolated child process                 │
  │   (prevents TF native crash from killing worker)   │
  │                                                     │
  │   → Download unprocessed photos                     │
  │   → Detect faces with @vladmandic/face-api (TF)    │
  │   → Cluster descriptors into person groups         │
  │   → Insert/update people + photoFaces tables        │
  └─────────────────────────────────────────────────────┘
```

### Why face recognition is a child process

`@tensorflow/tfjs-node` uses native binaries. A native crash (segfault) in TensorFlow would kill the entire Node.js worker process. By spawning face recognition as an **isolated child process**, a crash is contained — the main worker loop survives and continues processing vision tags and GPS.

### Batch size tuning

```env
VISION_BATCH=5   # photos per Azure Vision pass (default 5)
GPS_BATCH=20     # photos per geocoding pass (default 20)
```

Reduce `GPS_BATCH` if you hit Nominatim rate limits in production.

---

## Archive Lock (TOTP)

The archive is a special hidden album protected by a Time-based One-Time Password (TOTP), implementing RFC 6238 from scratch using Node.js `crypto` — no third-party TOTP library.

### Setup flow

```
User goes to Settings → Enable Archive Lock
        │
        ▼
POST /api/archive-lock/setup
        │   generates a 20-byte random TOTP secret
        │   encodes as Base32
        │   returns { qrCodeDataUrl, secret }
        │
        ▼
Frontend shows QR code
   User scans with Microsoft Authenticator (or any TOTP app)
        │
        ▼
POST /api/archive-lock/verify  { token: "123456" }
        │   verifies against current ±1 TOTP window
        │   on success: saves secret to userSettings table
        │
        ▼
Archive lock is active
```

### Unlocking the archive

```
User navigates to /archive
        │
        ▼
POST /api/archive-lock/unlock  { token: "123456" }
        │   verifies TOTP (±1 step window)
        │   on success: issues a short-lived session flag
        ▼
Archive photos are visible for the session
```

### Recovery (Gmail OTP)

If the user loses their authenticator, they can request a one-time code via email:

```
POST /api/archive-lock/request-otp
        │   generates a random 6-digit code
        │   emails it via SMTP (requires SMTP_* env vars)
        ▼
POST /api/archive-lock/verify-otp  { otp: "839201" }
        │   verifies + disables the TOTP lock
        ▼
User can re-enroll with a new QR code
```

---

## Album Sharing

Albums can be shared in two modes:

### Code-based sharing

The owner generates a `ABCD-EF23` style access code. Anyone with the link + code can view (or contribute to) the album. The code hash (SHA-256) is stored — the plain code is never persisted.

```
POST /api/album-shares/:albumId         → creates share, returns { token, accessCode }
GET  /shared/album/:token               → public page; prompts for access code
POST /api/album-shares/:token/verify    → verifies code, issues short-lived share JWT
```

### Email-based sharing

The owner specifies a list of allowed email addresses. Recipients must sign in with Google to prove their email, then receive a short-lived JWT granting access.

```
POST /api/album-shares/:albumId  { shareType: "email", allowedEmails: ["a@b.com"] }
GET  /shared/album/:token        → redirects to Google SSO if not authenticated
```

### Permissions

| Permission | Can view | Can add photos |
|---|---|---|
| `view` | ✅ | ❌ |
| `contribute` | ✅ | ✅ |

---

## Deployment

### Build the API Docker image

```bash
# From repo root
docker build -f artifacts/api-server/Dockerfile -t aphotos-api .
```

### Required infrastructure

You need:

1. **PostgreSQL** — any managed PostgreSQL service (Supabase, Railway, Neon, Azure Database for PostgreSQL, etc.)
2. **Azure Blob Storage** — a storage account and a container (default name `photos`)
3. A container runtime running two instances of the same image:
   - API server: `WORKER_MODE=false` (default), expose port `3001`
   - Worker: `WORKER_MODE=true`, no exposed port needed

### Azure Blob Storage — managed identity (production)

In production, the API uses `ManagedIdentityCredential` to authenticate to Azure Blob Storage — no storage connection strings or keys needed. Assign the **Storage Blob Data Contributor** role to the container app's managed identity on the storage account.

In development, `DefaultAzureCredential` is used — run `az login` and it will pick up your local credentials automatically.

### Build & deploy the frontend

```bash
pnpm --filter my-photos build
# Output is in artifacts/my-photos/dist/
```

Serve `dist/` from any static host (Azure Static Web Apps, Netlify, Vercel, Nginx, Caddy, etc.). The app is a SPA — configure your host to serve `index.html` for all routes.

Set `VITE_API_BASE` at build time to your API's public URL:

```bash
VITE_API_BASE=https://api.yourdomain.com pnpm --filter my-photos build
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend framework** | React 18 |
| **Build tool** | Vite |
| **Styling** | Tailwind CSS v4 |
| **UI components** | shadcn/ui (Radix UI primitives) |
| **Data fetching** | TanStack Query v5 |
| **Routing** | Wouter |
| **PWA** | vite-plugin-pwa + Workbox |
| **Backend framework** | Express v5 |
| **Language** | TypeScript (ESM) |
| **ORM** | Drizzle ORM |
| **Database** | PostgreSQL |
| **Auth** | JWT (jsonwebtoken) + httpOnly cookies |
| **Storage** | Azure Blob Storage (`@azure/storage-blob`) |
| **Image processing** | sharp (thumbnails), ffmpeg (video frames) |
| **Face recognition** | @vladmandic/face-api + TensorFlow.js Node |
| **AI tagging** | Azure Computer Vision |
| **Geocoding** | Nominatim (OpenStreetMap) |
| **TOTP** | RFC 6238 — Node.js `crypto` (no library) |
| **Logging** | Pino + pino-http |
| **Caching** | Redis (ioredis, optional) |
| **Testing** | Playwright (e2e) |
| **Monorepo** | pnpm workspaces |
| **API spec** | OpenAPI 3.0 (Orval codegen) |
