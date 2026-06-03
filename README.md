# Whisper Backend

Voice-first AI companion backend. Whisper gives users a persistent, emotionally intelligent companion that remembers across sessions, adapts its personality, and responds in real time via streaming.

Built with **Fastify · MongoDB Atlas · Redis · BullMQ · OpenAI · LiveKit · Deepgram · Hume AI**.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22 + TypeScript (ESM) |
| HTTP Framework | Fastify 5 |
| Database | MongoDB Atlas (Mongoose 8) |
| Cache / Queue broker | Redis 7 (ioredis) |
| Background jobs | BullMQ 5 |
| LLM | OpenAI SDK — GPT-5.4-mini (chat), GPT-4o-mini (summaries), text-embedding-3-small |
| Real-time transport | LiveKit Cloud (WebRTC) |
| STT | Deepgram Nova-3 (streaming WebSocket) |
| TTS | Hume Octave 2 (streaming WebSocket, instant mode) |
| Streaming text | Server-Sent Events (SSE) |
| Dev tooling | tsx, nodemon |

---

## Architecture Overview

### Text chat path
```
Client ──► POST /conversations/send ──► SSE stream
              │
              ├── Safety (OpenAI Moderation) — input + output
              ├── Memory retrieval (Atlas Vector Search top-10, recency re-rank)
              ├── Usage-based summary (latest MemorySummary doc)
              ├── Session context (Redis, compressed rolling window ≤4k tokens)
              └── GPT-5.4-mini streaming → SSE events
```

### Voice call path (Sprint 4)
```
Client ──► POST /voice/sessions/start ──► returns LiveKit token
              │
              └─► Client joins LiveKit room
                       │
                       └─► Voice worker process auto-dispatches into the room
                              │
                              ├── User mic ──► Deepgram (STT, nova-3)
                              │                  ├── interim_results — ignored
                              │                  ├── is_final segments — accumulated
                              │                  └── UtteranceEnd — triggers turn
                              │
                              ├── Same prompt pipeline as text chat
                              │   (safety + memory + summary + context + GPT-5.4-mini)
                              │
                              ├── Hume Octave 2 TTS (persistent socket, sentence-buffered)
                              │
                              └── PCM 48kHz mono ──► LiveKit ──► Client speaker
```

### Background jobs
```
POST /sessions/:id/end  ──► BullMQ ──► Job 1: Memory Extraction (GPT-4o-mini + embeddings)
POST /voice/sessions … (on hangup)         │
                                       Job 2: Usage Summary (after 50 turns or 5 sessions)
```

---

## Project Structure

```
src/
├── config/                            # DB, Redis, OpenAI, BullMQ connections + env
├── data/
│   ├── archetypes.ts                  # 4 archetypes: mentor, bestfriend, challenger, partner
│   └── voices.ts                      # Whisper voice catalog (Hume custom voices)
├── middleware/                        # Error handler
├── models/                            # Mongoose schemas (6)
├── queues/                            # BullMQ queue + job helpers
├── routes/
│   ├── user.routes.ts
│   ├── character.routes.ts
│   ├── session.routes.ts
│   ├── conversation.routes.ts         # Text chat (SSE)
│   ├── memory.routes.ts
│   └── voice.routes.ts                # Sprint 4: voice session + webhook + voice catalog
├── services/
│   ├── conversation.service.ts        # Text LLM streaming pipeline
│   ├── prompt.service.ts              # Prompt assembly
│   ├── safety.service.ts              # OpenAI Moderation + crisis detection
│   ├── session-context.service.ts     # Redis session context
│   ├── memory-extraction.service.ts
│   ├── memory-retrieval.service.ts
│   ├── memory-summary.service.ts
│   ├── context-compression.service.ts
│   ├── livekit-token.service.ts       # Sprint 4: AccessToken + agent dispatch
│   ├── voice-stt.service.ts           # Sprint 4: Deepgram WebSocket wrapper
│   ├── voice-tts.service.ts           # Sprint 4: Hume WebSocket wrapper (persistent)
│   └── voice.service.ts               # Sprint 4: voice pipeline orchestration
├── types/                             # TypeScript interfaces
├── utils/
└── workers/
    ├── memory.worker.ts                # BullMQ memory job worker (in-process w/ API)
    └── voice.worker.ts                 # Sprint 4: LiveKit Agent dispatch entrypoint
```

---

## Setup

### Prerequisites
- Node.js 22+
- Docker Desktop (for local Redis) OR a Redis URL
- MongoDB Atlas cluster
- OpenAI API key
- For voice (Sprint 4): LiveKit Cloud account, Deepgram account, Hume AI account (**Creator plan or higher** — free tier rate-limits streaming TTS)

### ⚠️ WSL2 users — important

Do NOT run the project from `/mnt/c/...` (Windows-mounted drive). The `@livekit/rtc-node` native FFI binding takes 30+ seconds to load there due to slow I/O, which causes voice worker timeouts. Clone into native WSL ext4 (`~/whisper-backend` or similar). VS Code can still open the WSL path with the WSL extension.

### 1. Clone + install

```bash
git clone https://github.com/vvr1701/whisper-backend.git
cd whisper-backend
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`. Minimum for text chat:

```env
PORT=3000
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/whisper
REDIS_URL=redis://localhost:6379
OPENAI_API_KEY=sk-...
```

For voice (Sprint 4), also set:
```env
LIVEKIT_URL=wss://<project>.livekit.cloud
LIVEKIT_API_KEY=APIxxx...
LIVEKIT_API_SECRET=...
DEEPGRAM_API_KEY=...
HUME_API_KEY=...
```

### 3. Start Redis

```bash
docker compose up -d redis
```

or `sudo apt install redis-server && sudo service redis-server start` for native WSL.

### 4. Set up Atlas Vector Search index

In **Atlas UI → your cluster → Search → Create Search Index → JSON Editor**:

- Database: `whisper`
- Collection: `memories`
- Index name: `memory_vector_index` (exact — the code looks it up by this name)
- Definition:

```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 1536, "similarity": "cosine" },
    { "type": "filter", "path": "character_id" },
    { "type": "filter", "path": "is_deleted" }
  ]
}
```

Wait ~1-2 minutes for the index to go **Active**. Without this, long-term memory retrieval silently returns empty (text chat still works).

### 5. Whitelist your IP in Atlas

Atlas → Network Access → add your current IP. For dev convenience: `0.0.0.0/0`.

### 6. Design Hume custom voices (Sprint 4 only)

The voice catalog in `src/data/voices.ts` references 4 Hume custom voice UUIDs (Kai, Theo, Maya, Iris). If you fork this repo, you'll need to:

1. Design 4 voices in the [Hume voice playground](https://platform.hume.ai/) using natural-language voice descriptions
2. Save them with a unique name
3. Note their voice UUIDs
4. Replace the UUIDs in `src/data/voices.ts`
5. Update fallback voice IDs in `src/data/archetypes.ts` too

(The descriptions used for the existing voices are in the commit history if you want to regenerate them.)

### 7. Run

**Text chat only (Sprints 1-3):**
```bash
npm run dev
```

**Voice (Sprint 4) — needs two processes:**
```bash
# Terminal 1: API server (handles HTTP + text chat + memory jobs)
npm run dev

# Terminal 2: Voice worker (registers with LiveKit, auto-joins voice rooms)
npm run voice-worker
```

---

## End-to-End Test Procedure

### Smoke-test text chat (no voice keys needed)

```bash
# Health
curl http://localhost:3000/health

# Onboard a user + companion
USER=$(curl -s -X POST http://localhost:3000/api/v1/users/onboard \
  -H "Content-Type: application/json" \
  -d '{
    "display_name":"Test User",
    "gender":"male",
    "date_of_birth":"1995-01-01",
    "communication_style":"warm",
    "intent":"end to end test",
    "companion":{
      "name":"Maya",
      "archetype":"bestfriend",
      "gender":"female",
      "voice_id":"c050bc97-0e14-44ba-8c23-ae353fee972d"
    }
  }')
echo $USER
# extract user_id + character_id from the JSON response

# Start a session
curl -X POST http://localhost:3000/api/v1/sessions/start \
  -H "Content-Type: application/json" \
  -d '{"user_id":"<user_id>","character_id":"<character_id>","session_type":"text"}'

# Send a streaming message (SSE response)
curl -N -X POST http://localhost:3000/api/v1/conversations/send \
  -H "Content-Type: application/json" \
  -d '{
    "session_id":"<session_id>",
    "character_id":"<character_id>",
    "user_id":"<user_id>",
    "message":"Hey Maya, I had a rough day."
  }'

# End the session (triggers memory extraction job)
curl -X POST http://localhost:3000/api/v1/sessions/<session_id>/end \
  -H "Content-Type: application/json" -d '{}'
```

### Smoke-test voice (Sprint 4)

1. Make sure `npm run voice-worker` is running. Look for `registered worker` in its log.
2. Start a voice session:
   ```bash
   curl -X POST http://localhost:3000/api/v1/voice/sessions/start \
     -H "Content-Type: application/json" \
     -d '{"user_id":"<user_id>","character_id":"<character_id>"}'
   ```
   Returns `{ session_id, livekit_token, livekit_url, room_name }`.

3. Open https://meet.livekit.io → click **Custom** → paste `livekit_url` + `livekit_token` → Connect → allow mic.
4. Speak a sentence. Maya should reply with audio. Watch the voice worker log for:
   - `Voice agent starting pipeline`
   - `Participant joined`
   - `Coalesced transcript — starting turn`
   - `Hume TTS socket open` (first turn only — socket is persistent after that)
   - Latency metric (target <1500ms P50)

---

## API Reference

### Health
| Method | Path | Description |
|---|---|---|
| GET | `/health` | Server health check |

### Users
| Method | Path | Description |
|---|---|---|
| POST | `/api/v1/users/onboard` | Create user + companion in one step |
| GET | `/api/v1/users/:id` | Fetch user profile |

### Characters
| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/characters/:id` | Fetch character profile |

### Sessions
| Method | Path | Description |
|---|---|---|
| POST | `/api/v1/sessions/start` | Start a session, initialize Redis context |
| POST | `/api/v1/sessions/:id/end` | End session, enqueue memory extraction |
| GET | `/api/v1/sessions/character/:character_id` | Paginated session history |

### Conversations (text chat)
| Method | Path | Description |
|---|---|---|
| POST | `/api/v1/conversations/send` | Send message — **SSE streaming response** |
| GET | `/api/v1/conversations/:session_id` | Paginated turn history |

SSE event types: `chunk` (each token), `done` (turn complete), `crisis` (988 hotline injected), `error`.

### Memories
| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/memories/:character_id` | Non-deleted memories. Filter: `?type=fact\|emotion\|event\|preference` |
| DELETE | `/api/v1/memories/:memory_id` | Soft-delete one memory |
| DELETE | `/api/v1/memories/character/:character_id` | Bulk soft-delete |

### Voice (Sprint 4)
| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/voice/voices` | List available voices (catalog from `src/data/voices.ts`) |
| POST | `/api/v1/voice/sessions/start` | Create voice session + return LiveKit token with agent dispatch |
| POST | `/api/v1/voice/webhook` | LiveKit Cloud webhook (room_finished → finalize session) |

---

## Voice Pipeline (Sprint 4) — Key Design Decisions

### Persistent Hume socket per session
One Hume `streamInput` WebSocket lives for the whole voice call. Each turn calls `beginTurn()` + `sendText()` + `flush()`. Saves 500-1000ms/turn vs opening a fresh socket each time, and avoids burst rate-limiting.

On barge-in, the socket is closed (server stops generating). The next turn lazily reopens it via `ensureConnected()`.

### Deepgram conversational mode
Deepgram is configured with `interim_results=true` + `utterance_end_ms=1000`. The pipeline:
- Ignores interim transcripts
- Accumulates `is_final` segments into a buffer
- Fires `runTurn` on `UtteranceEnd` (Deepgram's "user is done talking" signal) — NOT on every fragment

Result: pausing mid-sentence no longer fragments your speech into multiple turns.

### Coalesce safety timer
If `UtteranceEnd` is delayed >1500ms after the last segment, a safety timer fires the turn anyway. Robust against Deepgram edge cases.

### Serial audio writer
LiveKit's `AudioSource.captureFrame()` can't be called concurrently — concurrent calls trigger `InvalidState` errors. All Hume audio chunks funnel through a single `SerialAudioWriter` drainer. Prevents audio distortion.

### Barge-in
When Deepgram detects user speech mid-bot-speech (past 1.5s grace period):
- OpenAI stream is `AbortController`-cancelled (no token waste)
- Hume socket is closed (Hume stops generating)
- `SerialAudioWriter.clear()` drops queued audio
- Half-spoken assistant turns are NOT persisted

### Latency tracking
`latency_ms` (Deepgram final transcript → first Hume audio byte) is logged per turn and stored on the assistant `ConversationTurn`. P50 logged at session end.

---

## Memory System

### How memories are created
1. User ends a session → `POST /sessions/:id/end` (or voice user hangs up)
2. BullMQ enqueues **Job 1 (memory-extraction)**
3. Job reads all conversation turns → GPT-4o-mini extracts facts
4. Each fact is embedded with `text-embedding-3-small` (1536 dims)
5. Memories inserted into MongoDB `memories` collection

### How memories are used
On every conversation turn (text or voice):
1. User message is embedded
2. Atlas `$vectorSearch` returns top-10 nearest memories for that character
3. Re-ranked: `0.6 × cosine_similarity + 0.4 × recency_decay`
4. Deduplicated (cosine > 0.85 = drop near-duplicate)
5. Formatted as `[Known about this person]` block, injected as system message

### Usage-based summary
Triggers automatically when **50 turns** or **5 sessions** accumulate since the last summary. GPT-4o-mini generates mood, recurring topics, emotional patterns, relationship trajectory — injected into every subsequent prompt.

### Session context compression
When Redis session context exceeds **3,500 tokens**, the oldest 10 turns are compressed into ~80-token summary via GPT-4o-mini. Last 20 turns always kept verbatim.

---

## Companion Archetypes

| Archetype | Personality | Use case |
|---|---|---|
| `mentor` | Wise, Socratic, growth-focused | Personal development |
| `bestfriend` | Warm, casual, validating | Emotional support |
| `challenger` | Blunt, direct, no excuses | Accountability |
| `partner` | Deeply attentive, intimate | Connection |

Each archetype has its own system prompt, behavioral rules, safety overrides, and default personality sliders (warmth, humor, directness, energy, formality).

---

## Voice Catalog

4 Hume custom voices live in `src/data/voices.ts`:

| Name | Gender | Personality |
|---|---|---|
| Kai | male | Warm and gentle — a close friend speaking softly at night |
| Theo | male | Thoughtful and present — someone who genuinely listens |
| Maya | female | Warm and expressive — the friend who makes you feel safe being honest |
| Iris | female | Soft and intimate — gentle, attentive, deeply human |

Voices are user-selectable; not bound to archetypes.

---

## Safety

- **OpenAI Moderation API** runs on every user message and every LLM output (text + voice)
- **Crisis detection**: self-harm score > 0.5 → bypasses LLM, injects 988 Suicide & Crisis Lifeline response
- **Minor protection**: `is_minor` flag set at onboarding via DOB calculation
- Output moderation: flagged responses are logged but never blocked (Phase 1)

---

## Background Jobs (BullMQ)

| Job | Trigger | What it does |
|---|---|---|
| `memory-extraction` | Session end | Extract facts → embed → insert memories |
| `usage-summary` | After extraction, if 50 turns or 5 sessions accumulated | Generate compressed summary of all turns since last summary |

Queue: `whisper-memory` · Retries: 3 × exponential backoff · Concurrency: 2

---

## Sprint Progress

- [x] **Sprint 1** — Project setup, Mongoose models, onboarding API
- [x] **Sprint 2** — LLM streaming chat, session management, safety classifier, Redis context
- [x] **Sprint 3** — Memory extraction, vector retrieval, context compression, usage-based summaries
- [x] **Sprint 4** — Voice pipeline (LiveKit + Deepgram + Hume Octave 2 + barge-in + latency tracking)
- [ ] **Sprint 5** — Companion editing endpoints (`PATCH /characters/:id`), stats, polish

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No (default 3000) | HTTP port |
| `MONGODB_URI` | Yes | MongoDB Atlas connection string (include database in path) |
| `REDIS_URL` | Yes | Redis connection URL |
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `LIVEKIT_API_KEY` | Sprint 4 | LiveKit API key |
| `LIVEKIT_API_SECRET` | Sprint 4 | LiveKit API secret |
| `LIVEKIT_URL` | Sprint 4 | LiveKit WebSocket URL (wss://...) |
| `DEEPGRAM_API_KEY` | Sprint 4 | Deepgram API key |
| `HUME_API_KEY` | Sprint 4 | Hume AI API key (**Creator plan or higher** for streaming TTS rate limits) |

---

## Known Issues / Phase 1 Caveats

- **Barge-in is VAD-based** — short noises or breaths can sometimes false-trigger barge-in. Confirm-then-barge-in pattern is a planned future fix.
- **Webhook signature verification** — `POST /voice/webhook` may fail signature verification because Fastify 5 strips raw bodies. The in-worker `ParticipantDisconnected` handler is the primary session-end path; webhook is fallback only.
- **Voice IDs hardcoded** — `src/data/voices.ts` references specific Hume voice UUIDs. Forks need to design their own voices and update both `voices.ts` and `archetypes.ts`.
