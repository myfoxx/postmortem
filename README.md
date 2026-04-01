# PostMortem — Your Voice, Beyond Time

> *"If you're hearing this, it means I wanted to leave you something more than a memory."*

**[→ Live demo](https://postmortem.cybersartoria.it)**

---

## What is this?

PostMortem lets you clone your voice and leave a message for someone you love — sealed until the right moment.

Set it to open on a specific date. Or protect it with a secret code only they know.

When they open it, they don't read a text. They hear you. Your voice, exactly as it sounds today.

---

## Why it exists

We take thousands of photos. We write messages. But we almost never preserve our voice — the thing that makes us most recognisably *us*.

PostMortem is for the message you've been meaning to leave. For the words you'd want your daughter to hear on her wedding day. For what you'd say to your best friend if you knew it was the last time. For everything that matters too much to type.

---

## How it works

```
1. Clone your voice      →  60 seconds of audio. ElevenLabs captures everything.
2. Write your message    →  Your words. Your cloned voice will speak them.
3. Seal the vault        →  Opens on a date, or with a secret code.
4. Share the link        →  They open it when the time comes. They hear you.
```

---

## Stack

| Layer | Technology |
|-------|-----------|
| Voice cloning + TTS | ElevenLabs Instant Voice Clone + Multilingual TTS |
| Compute | Cloudflare Workers |
| State + scheduling | Cloudflare Durable Objects (SQLite + Alarms API) |
| Audio storage | Cloudflare R2 |
| Frontend | Cloudflare Pages |
| AI writing assistant | Claude (Haiku) via Workers proxy |

---

## Architecture

```
Browser
  │
  ├── POST /clone      → Worker → ElevenLabs IVC API
  ├── POST /message    → Worker → ElevenLabs TTS → R2 → Durable Object
  ├── POST /generate   → Worker → Claude API (AI writing assistant)
  ├── GET  /vault/:id/status  → Worker → Durable Object
  ├── POST /vault/:id/unlock  → Worker → Durable Object (verify + unlock)
  └── GET  /vault/:id/audio   → Worker → R2 stream
```

### Why Durable Objects?

Each vault is a single Durable Object instance. This gives us:

- **Persistent SQLite state** — no external database, zero config
- **Alarms API** — the vault wakes itself up at the exact unlock date, no polling, no cron jobs
- **Edge-native** — runs close to users globally, sub-100ms response times

---

## Local development

```bash
# Clone the repo
git clone https://github.com/myfoxx/postmortem.git
cd postmortem/worker

# Install dependencies
npm install

# Set secrets
wrangler secret put ELEVENLABS_API_KEY
wrangler secret put ANTHROPIC_API_KEY

# Create R2 bucket
wrangler r2 bucket create postmortem-audio

# Run locally
wrangler dev
```

Frontend: open `frontend/index.html` directly in browser, set `WORKER_URL = 'http://localhost:8787'` in `js/app.js`.

---

## Deploy

```bash
# Deploy Worker
cd worker
wrangler deploy

# Deploy frontend
cd ..
wrangler pages deploy frontend --project-name postmortem
```

---

## Built for

**#ElevenHacks × Cloudflare** — April 2026

---

*Some things are too important to type.*
