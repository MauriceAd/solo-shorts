# solo shorts

Link-only short-video site, styled like YouTube: top header with logo and
search, left sidebar (Home / Shorts / Library), a Shorts grid, a vertical
Shorts feed, and a watch view. Black-and-gold theme with the back-hips
emblem logo.

Only the owner uploads videos; anyone with the link can watch (no account,
no login, no age gate, no verification), like, comment and download.
Downloads carry the "solo shorts" logo burned into the bottom-right corner;
streamed playback stays clean.

## Free stack

| Piece    | Service               | Free tier                                              |
|----------|-----------------------|--------------------------------------------------------|
| Hosting  | Render web service    | $0 — Docker, spins down after 15 min idle, ~1 min wake |
| Videos   | Cloudflare R2         | 10 GB storage, zero egress fees                        |
| Metadata | Cloudflare D1         | 5 GB storage, 5M rows read/day, 100K rows written/day |

**Caveats**

- **Render free spins down after 15 minutes without traffic** and takes
  about a minute to wake up. The first visitor after a quiet spell waits
  for the service to start. There is no persistent disk on the free plan,
  so nothing is stored on the web service itself — videos live in R2 and
  metadata in D1, which is why they survive restarts.
- **R2 needs a credit card or PayPal on file with Cloudflare to activate**
  (dashboard: R2 → "Add payment method"). There is no charge while you
  stay inside the free allowance (10 GB stored, zero egress), but the card
  must be on file. D1 needs only an email — no card.
- The app never stores video bytes or the database on the web service.

## Run locally

Requirements: Node.js 20+, ffmpeg on your PATH.

```sh
npm install
node server.js
```

Open http://localhost:3000

Without any credentials the app runs with an **in-memory test store**:
uploads, likes, comments and the passcode live only in memory and reset
when the server restarts. That is enough to test every feature end to end.
To test against the real R2 + D1, copy `.env.example` to `.env` and fill
in the values (see "Cloudflare setup" below), then restart.

- First visit: click **Owner login** and set a passcode. There is **no
  reset** — write it down. Only the owner can upload, edit titles,
  delete videos and delete comments.
- Upload a video (+ title) and it goes live instantly.
- Viewers need no login: they can watch, like (one like per browser),
  comment (name + text) and download. Downloaded files have the
  "solo shorts" logo burned into the bottom-right corner.

Environment variables (see `.env.example`):

| Variable             | Purpose                                                     |
|----------------------|-------------------------------------------------------------|
| `PORT`               | Port the server listens on (Render sets this; default 3000) |
| `R2_ENDPOINT`        | `https://<account-id>.r2.cloudflarestorage.com`            |
| `R2_ACCESS_KEY_ID`   | R2 API token access key                                     |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret key                                   |
| `R2_BUCKET`          | R2 bucket name (e.g. `solo-shorts`)                         |
| `R2_PUBLIC_BASE_URL` | Public URL videos play from (e.g. `https://pub-<id>.r2.dev`) |
| `CF_ACCOUNT_ID`      | Cloudflare account ID                                       |
| `CF_API_TOKEN`       | API token with D1:Edit permission                           |
| `D1_DATABASE_ID`     | D1 database ID                                              |

## Cloudflare setup (one time)

1. **R2 bucket** — Cloudflare dashboard → R2 → Create bucket (name it
   e.g. `solo-shorts`). Then enable public access: bucket → Settings →
   Public access → allow access via the `r2.dev` subdomain (or connect a
   custom domain). Copy the public URL into `R2_PUBLIC_BASE_URL`.
2. **R2 API token** — R2 → Manage R2 API Tokens → Create API token with
   Object Read & Write permission for your bucket. Copy the access key,
   secret key, and the endpoint URL shown on that page
   (`https://<account-id>.r2.cloudflarestorage.com`).
3. **D1 database** — Workers & Pages → D1 → Create database (name it
   e.g. `solo-shorts`). The app creates its tables automatically on
   first start. Copy the database ID from its Overview page.
4. **API token for D1** — My Profile → API Tokens → Create Token →
   use the "Edit Cloudflare Workers" template or a custom token with
   D1:Edit permission. Copy the token into `CF_API_TOKEN`.
   Your account ID is shown in the dashboard URL and on the account home.

## Deploy on Render (free)

1. Push this folder to a Git repo (GitHub/GitLab/Bitbucket).
2. Render dashboard → **New → Blueprint** → connect the repo (uses
   `render.yaml`), or **New → Web Service → Docker** → point it at the
   repo.
3. The blueprint creates a **free** Docker web service (no disk — the
   free plan has none, and this app doesn't need one). Fill in the
   secret env vars in the Render dashboard (R2_* / CF_* / D1_*).
   Nothing secret lives in this repo.
4. When the deploy finishes, Render gives you a public URL like
   `https://solo-shorts.onrender.com` — that is the link to send people.
5. Open the link, click **Owner login**, set your passcode (no reset —
   write it down), then upload your first video.

No other setup is needed. No accounts are created by the app itself.

## Notes

- **Sleep/wake:** on the free plan the service sleeps after 15 minutes
  idle; the next visitor waits ~1 minute for it to wake. This is a
  Render free-tier limit, not a bug.
- **Existing videos:** this hosted version starts empty. Videos on the
  original (artifact) version of the site are not copied over
  automatically — they would need a manual migration later.
