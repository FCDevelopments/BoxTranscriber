# BoxTranscriber

Automatically transcribes videos uploaded to a watched **Box** folder via **AssemblyAI** speech-to-text, posting the transcript back as comments on the file — with a `[HH:MM:SS]` timestamp label every 10 seconds so viewers can jump straight to the moment they need.

Replaces a manual watch-video-and-type-notes workflow with a pipeline that finishes in minutes.

## Two run modes

| Mode | Entry point | How it triggers |
|---|---|---|
| **Batch scan** (recommended) | `run.bat` → `transcribe_timestamps.js` | Scans the folder, transcribes anything without a transcript comment |
| **Webhook server** | `start_server.bat` → `index.js` | Box `FILE.UPLOADED` webhook fires per upload (pair with `start_ngrok.bat` + `create_webhook.js`) |

## How it works

- **Small/medium files** stream to AssemblyAI directly via a pre-signed Box download URL — nothing is downloaded locally
- **Files over 2 GB** are routed through **ffmpeg** first, extracting a mono 64 kbps MP3 (a 1-hour video becomes ~28 MB) before upload
- **Dedup** — files that already carry a transcript comment are skipped, so re-runs are always safe
- **Comment chunking** — long transcripts split at timestamp boundaries to fit Box's comment length limit, labeled `(part N of M)`
- **Zero-setup portability** — bundles a portable Node.js runtime; a coworker just double-clicks `run.bat`

## Setup

1. `install.bat` (installs npm dependencies using the bundled Node)
2. Create a Box **Custom App (Server Authentication / JWT)** at <https://app.box.com/developers/console>, download its config JSON, save as `box_jwt_config.json` (see the `.example.json`)
3. `copy .env.example .env` and fill in your AssemblyAI API key + Box folder ID
4. Double-click `run.bat`

## Stack

Node.js · AssemblyAI (universal-2) · box-node-sdk (JWT) · ffmpeg · Express (webhook mode)
