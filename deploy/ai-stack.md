# The AI lineup — Ubuntu server setup

> ## ⚠ Parts 1–5 of this guide are SUPERSEDED (2026-08-06)
>
> HomeHub no longer routes between models. It chooses an **agent** — Barnaby or Geist — and Hermes
> owns the model, provider, tier, routing, escalation, fallback, vision and locality. These settings
> **no longer exist in the code**:
>
> ```
> Ai__LocalEndpoint   Ai__LocalModel   Ai__OpenAiModel   Ai__Routing__*
> Ai__Agent__Endpoint Ai__Agent__ApiKey                  Ai__Agents__*
> ```
>
> Replaced by one entry per agent — see **[HERMES_INTEGRATION.md](../HERMES_INTEGRATION.md)** and the
> Assist block in [`server-systemd.md`](server-systemd.md):
>
> ```ini
> Hermes__Agents__barnaby__ApiKey=…      # http://127.0.0.1:8642
> Hermes__Agents__geist__ApiKey=…        # http://127.0.0.1:8643
> ```
>
> **Still accurate and still needed:** Ollama and the models themselves (Hermes uses them, HomeHub
> just no longer names them), the MCP seam in Part 5.4, the speech stack, and the hardware notes.
> `Ai__OpenAiApiKey` survives for **cloud speech-to-text only** — it is not an assistant model choice.
>
> The two gateways are already installed and running as systemd user services; Part 5.3's install
> steps are history rather than instructions. Rewrite this guide against the deployed topology before
> following it end to end.

Everything the assistant and the voice loop need, installed on the **home server**. This is the
companion to [`server-systemd.md`](server-systemd.md), which gets the app itself running; nothing
here is required to have a working panel, and every piece can be added later without a redeploy.

**The Pi stays thin glass.** Every model in this guide runs on the server. The Pi records audio and
plays audio back; it holds no model and makes no decision about which one answers.

> **Do [`server-systemd.md`](server-systemd.md) Parts A–C first.** This guide edits
> `/etc/homehub/homehub.env` and restarts the `homehub` service, both of which that guide creates.
> Commands are marked **[server]** — you are over ssh on the Ubuntu box for all of them.

---

## The lineup

| # | Piece | Gives you | Runs on | Cost | Do it |
|---|---|---|---|---|---|
| 1 | **Ollama + `gemma3:4b`** | The reflex path — the local brain. Every voice turn. | server CPU | free | [Part 1](#part-1--tier-1-the-local-model) |
| 2 | **OpenAI `gpt-4o-mini`** | World knowledge, long-form, images | cloud | per-token | [Part 2](#part-2--tier-3-the-cloud-model) |
| 3 | **Speaches (faster-whisper)** | Local speech-to-text | server CPU | free | [Part 3](#part-3--local-speech-to-text) |
| 4 | **Piper + `en_US-norman-medium`** | The house voice — all spoken output | server CPU | free | [Part 4](#part-4--the-house-voice-piper) |
| 5 | **Hermes Agent** | The deliberate path — tools, memory, standing jobs | server | free (MIT) | [Part 5](#part-5--the-mcp-seam-let-an-agent-run-the-house) + stage **A5** |
| 6 | *Chatterbox TTS* | Expressive voice | server **GPU** | — | code is in — [Part 6](#part-6--what-is-waiting-on-a-gpu) |

**Install none of it and the panel still works.** With no model configured the assistant falls back
to `SimulatedAssistantProvider`, the always-available floor, and the actions-first layer — timers,
lists, adding a task, changing a target — runs *before* any model regardless. The things people
actually ask a wall panel for keep working with an empty `Ai__` section.

**The order that makes sense:** 1 → 4 → 3 → 2. The local model is the biggest single upgrade; the
voice is what makes it feel like a fixture rather than a chat box; STT completes the hands-free
loop; the cloud tier is the only one that costs money or leaves the house, so it goes last.

The design behind all of this is [`ai-assistant.md`](../ai-assistant.md) (assistant, stages A1–A7)
and [`voice-tts.md`](../voice-tts.md) (speech output). This guide is only the server side.

---

# Part 1 — Tier 1: the local model

Barnaby answering from a model on your own hardware, with nothing leaving the house. **All voice
turns route here, always** — the cloud tier is never on the spoken path.

### 1.1 · Install Ollama — [server]

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

The vendor installer drops the binary in `/usr/local/bin`, creates an `ollama` system user, and
installs and starts a systemd unit. Check it:

```bash
systemctl is-active ollama
curl -s http://localhost:11434/api/tags
```

> **Leave it bound to localhost.** Ollama listens on `127.0.0.1:11434` by default, which is exactly
> right here — HomeHub runs on this same machine. Setting `OLLAMA_HOST=0.0.0.0` publishes an
> unauthenticated model API to your LAN. There is no reason to.

### 1.2 · Pull the model — [server]

```bash
ollama pull gemma3:4b
```

A few GB down, and roughly the same again in RAM while it answers. `gemma3:4b` is the Tier-1 choice
in `ai-assistant.md`: small enough to answer on CPU, which is what this server has. Confirm it
speaks:

```bash
ollama run gemma3:4b "Reply with the single word: ready"
```

> **Sizing.** Budget ~4 GB of RAM for the model while a turn is in flight, on top of whatever else
> the server runs. On CPU expect a few seconds to first word — which is why replies are kept terse
> and why the panel plays a pre-rendered acknowledgement while it waits, rather than sitting silent.

### 1.3 · Point HomeHub at it — [server]

```bash
sudo nano /etc/homehub/homehub.env
```

```ini
Ai__LocalEndpoint=http://localhost:11434
Ai__LocalModel=gemma3:4b
```

`Ai__LocalEndpoint` is the switch — the local tier stays off until it is set, and the provider
appends `/api/chat` itself, so give it the base URL only. `Ai__LocalModel` matches the compiled
default since stage A1, so it is strictly optional now; set it anyway, because it is the line you
will edit when you swap models and a lineup you can read beats one you have to remember.

```bash
sudo systemctl restart homehub
```

### 1.4 · Verify — [server]

```bash
curl -s -X POST http://localhost:5000/api/assistant/chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"what is a substitute for buttermilk?","history":[]}'
```

Look at `"origin"` in the reply: **`Local`** means the model answered. `Local` with obviously canned
text means you are still on the simulated floor — the endpoint is wrong, or the service was not
restarted. Ask something conversational rather than "set a timer": actions-first handles the latter
before any model sees it, so it proves nothing about this part.

---

# Part 2 — Tier 3: the cloud model

World knowledge, long-form answers, and image analysis. **This is the only piece that costs money
or sends anything off the LAN.**

### 2.1 · Add the key — [server]

```ini
Ai__OpenAiApiKey=sk-...
Ai__OpenAiModel=gpt-4o-mini
```

```bash
sudo systemctl restart homehub
```

The key lives in `/etc/homehub/homehub.env`, which is `root:homehub` and `0640` — server-side only.
**It is never sent to the Pi or the browser**; cloud turns are proxied through the API.

### 2.2 · What actually goes there

Since stage A5 the router does **not** try to guess from the wording whether a question is a "cloud
question" — that is a judgement an agent makes better, and the old `Ai__Routing__*` hint lists are
gone. What decides it now (PROJECT.md §6):

- **Spoken turns never go to cloud or to the agent.** They stay on the local model, always, because
  a spoken reply has a couple of seconds before the silence *is* the answer.
- **Images go to cloud** — it is the only one that can see.
- **Typed turns take the best thing configured**: the agent (Part 5) if there is one, else cloud,
  else local.
- A weak local answer still escalates to cloud.

Every turn shows a **LOCAL / CLOUD / AGENT** tag, and an escalated one shows `CLOUD ↑`. If you want
to know whether something left the house, the answer is on screen — only `CLOUD` did.

### 2.3 · Verify — [server]

```bash
curl -s -X POST http://localhost:5000/api/assistant/chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"explain why bread dough needs to rest","history":[]}' | grep -o '"origin":"[^"]*"'
```

Expect `"origin":"Cloud"`.

---

# Part 3 — Local speech-to-text

Turns the household's speech into text on your own hardware. Without it, push-to-talk falls back to
OpenAI Whisper (if `Ai__OpenAiApiKey` is set) or is unavailable.

HomeHub talks to **any** OpenAI-compatible transcription server: it POSTs multipart `file` + `model`
to `<endpoint>/v1/audio/transcriptions` and reads `text` back. [Speaches](https://speaches.ai)
(formerly `faster-whisper-server`) is the one this is written against.

### 3.1 · Install Docker, if it isn't there — [server]

```bash
command -v docker || sudo apt-get install -y docker.io
sudo systemctl enable --now docker
```

### 3.2 · Run the sidecar — [server]

```bash
sudo docker run -d --restart unless-stopped \
  --name speaches \
  --publish 127.0.0.1:8000:8000 \
  --volume hf-hub-cache:/home/ubuntu/.cache/huggingface/hub \
  ghcr.io/speaches-ai/speaches:latest-cpu
```

`--restart unless-stopped` is what brings it back after a reboot; there is no systemd unit for this
one. To drop the `sudo` on every later `docker` command, add yourself to the group once —
`sudo usermod -aG docker $USER` — and log out and back in.

> **`127.0.0.1:8000` and not `8000`.** Binding the container to loopback keeps the transcription API
> on this machine, the same reasoning as Ollama above. HomeHub is local to it; nothing else needs to
> reach it.

The named volume is what stops it re-downloading the model on every container restart.

### 3.3 · Wire it up — [server]

```ini
Voice__Stt__LocalEndpoint=http://localhost:8000
Voice__Stt__LocalModel=Systran/faster-whisper-base.en
Voice__Stt__AllowCloudFallback=false
```

> **`Voice__Stt__LocalModel` is not optional here, and the compiled default will not work.** That
> default is `base.en`, which is the plain Whisper name; Speaches wants a Hugging Face repo id —
> `Systran/faster-whisper-base.en`. Leave it unset and every transcription fails with a
> model-not-found from the sidecar while the panel simply reports that it couldn't hear you.
>
> `base.en` is the sweet spot for a wall panel on CPU. `tiny.en` is faster and noticeably worse with
> names; `small.en` is better and slow enough to feel like a delay.

Set `AllowCloudFallback=false` if you want speech to stay on the LAN even when the sidecar is down —
the honest trade is that push-to-talk then simply stops working instead of quietly going to OpenAI.
Leave it `true` (the default) to keep the loop alive through a restart.

```bash
sudo systemctl restart homehub
```

### 3.4 · Verify — [server]

First that HomeHub knows the engine exists:

```bash
curl -s http://localhost:5000/api/voice/capabilities
# {"serverStt":true,"localStt":true,"cloudStt":false,"serverTts":true,"ttsEngine":"piper"}
```

`localStt: true` is this part wired. `serverStt: false` means neither engine is configured and
`/api/voice/transcribe` answers **501**.

That only proves the config, though — it does not prove the sidecar can transcribe. Do that with a
real clip once Part 4 gives you one:

```bash
curl -s -o /tmp/speak.wav -X POST http://localhost:5000/api/voice/speak \
  -H 'Content-Type: application/json' -d '{"text":"testing one two three"}'

curl -s -F 'audio=@/tmp/speak.wav;type=audio/wav' \
  http://localhost:5000/api/voice/transcribe
```

The panel speaking to itself is a genuinely good end-to-end test: TTS, the sidecar, and the routing
between them all have to work for words to come back.

> **The model downloads on first use, not on `docker run`.** So the *first* transcription after a
> fresh container stalls for a minute or two and may time out — that is the download, not a fault.
> Run the check above once to get it out of the way before anyone speaks to the panel. The named
> volume from 3.2 means it only ever happens once.

---

# Part 4 — The house voice (Piper)

**Since stage 8R this is the whole household's voice.** Both speech paths — the panel's on-screen
replies *and* the Pi bridge's wake-word replies — post to `POST /api/voice/speak` and play the WAV
that comes back. The Pi keeps its own Piper only as an offline fallback for when it cannot reach the
API. So Piper needs to exist **on this server**, not just on the Pi.

### 4.1 · Install Piper — [server]

```bash
sudo apt-get install -y python3-venv
sudo mkdir -p /opt/piper && sudo chown $USER /opt/piper
python3 -m venv /opt/piper/.venv
/opt/piper/.venv/bin/pip install piper-tts
```

That gives you the CLI at `/opt/piper/.venv/bin/piper` — the same `piper-tts` package the Pi bridge
uses, so both ends speak with one voice.

### 4.2 · Fetch the voice — [server]

```bash
mkdir -p /opt/piper/voices && cd /opt/piper/voices
BASE=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/norman/medium
curl -L -O $BASE/en_US-norman-medium.onnx
curl -L -O $BASE/en_US-norman-medium.onnx.json   # must sit beside the .onnx
```

**Both files, in the same directory.** Piper reads the `.json` for the sample rate and phoneme map;
the `.onnx` alone fails in a way that reads like a broken binary.

Let the service read them:

```bash
sudo chmod -R a+rX /opt/piper
```

### 4.3 · Wire it up — [server]

```ini
Voice__Tts__PiperPath=/opt/piper/.venv/bin/piper
Voice__Tts__VoiceModel=/opt/piper/voices/en_US-norman-medium.onnx
Voice__Tts__Primary=piper
```

Both paths must be set — TTS reports itself unconfigured unless it has the binary *and* the model.
`Voice__Tts__CacheDirectory` is already in your env file from `server-systemd.md` A4; that is the
pre-rendered phrase cache, and it is why "Good morning" comes back instantly.

```bash
sudo systemctl restart homehub
```

### 4.4 · Verify — [server]

```bash
curl -s -D- -o /tmp/speak.wav -X POST http://localhost:5000/api/voice/speak \
  -H 'Content-Type: application/json' \
  -d '{"text":"Barnaby here. The panel can speak."}' | grep -i '^x-voice'
```

Expect `X-Voice-Engine: piper` and `X-Voice-Degraded: 0`, and a real WAV in `/tmp/speak.wav`
(`file /tmp/speak.wav`). A **501** means the two paths above are not both set; a **502** means Piper
started and failed — `journalctl -u homehub -n 50` has the exit code and stderr.

Play it on a machine with speakers, or feed it to the Pi. On the server itself:

```bash
aplay /tmp/speak.wav     # only if this box has an output device; most home servers do not
```

---

# Part 5 — The MCP seam (let an agent run the house)

**This is the piece that makes an agent useful rather than merely conversational.** HomeHub exposes
the house — climate, room sensors, the calendar, the to-do lists — as MCP tools. Hermes Agent (or
any MCP client) connects and can actually read and act, instead of only talking.

**It is off until you set a key**, and the key is not optional: the tools *write*, and on a
household LAN "reachable" and "authorised" are not the same thing.

### 5.1 · Generate a key and turn it on — [server]

```bash
openssl rand -hex 32          # copy the output
sudo nano /etc/homehub/homehub.env
```

```ini
Mcp__ApiKey=<the hex string you just generated>
```

```bash
sudo systemctl restart homehub
```

### 5.2 · Verify — [server]

```bash
curl -s -X POST http://localhost:5000/mcp \
  -H "Authorization: Bearer $MCP_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Expect six tools: `get_climate_zones`, `set_climate_setpoint`, `set_climate_mode`,
`get_sensor_readings`, `get_calendar`, `add_todo`. Drop the `Authorization` header and you should
get **401** — that is the check working. A **405** means no key is configured, so the endpoint was
never mounted.

> **`add_todo` runs as whoever is signed in at the panel.** With nobody signed in it declines rather
> than filing the item under a guess — a to-do belongs to a person, and the agent has no session of
> its own.

### 5.3 · Install Hermes Agent — [server]

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

Point it at the Ollama you already have (Part 1) — no account, no key, nothing leaving the house —
then enable its API server in `~/.hermes/.env`:

```ini
API_SERVER_ENABLED=true
API_SERVER_KEY=<generate another with: openssl rand -hex 32>
```

```bash
hermes gateway        # or install it as a systemd unit for restart-on-boot
```

> **Tool-calling is the thing to watch.** Hermes's own guidance is that the full experience wants a
> 27B-class model, which on CPU runs at 2–5 tok/s. On `gemma3:4b` the agent will answer but will
> call tools unreliably. That is the honest state until a GPU lands (Part 6) — it is a *quality*
> ceiling, not a broken install.

### 5.4 · Point Hermes at the house

In Hermes's MCP config, add HomeHub as an HTTP server at `http://localhost:5000/mcp` with the MCP
bearer token from 5.1, and **filter its toolset to this server plus the jobs API**. Hermes's API
server otherwise grants full access to its own toolset *including terminal commands*, and this panel
answers to whoever is in earshot.

### 5.5 · Point HomeHub back at Hermes — [server]

```ini
Ai__Agent__Endpoint=http://localhost:8642
Ai__Agent__ApiKey=<the API_SERVER_KEY from 5.3>
```

```bash
sudo systemctl restart homehub
```

Both keys are required; either one missing leaves the deliberate path off and the panel routes as it
did before. Verify from the panel: **a typed question should come back tagged `AGENT`** (full brass),
**a spoken one should still say `LOCAL`** — that is the reflex rule working, not a fault — and
stopping Hermes should leave the panel answering normally, just plainly.

---

# Part 6 — What is waiting on a GPU

**Nothing to install. Do not start either of these until the card is in the machine.**

| | What it is | Blocked on |
|---|---|---|
| **A tool-calling-capable model** | Hermes Agent's toolset needs a model that can call tools reliably — their guidance is 27B+, which on CPU is 2–5 tok/s. The agent itself installs fine today; it is the *model behind it* that wants the card. | Stage **A7** in `ai-assistant.md` |
| **Chatterbox TTS** | The expressive voice, with prosody. Replaces Piper as primary; Piper stays the permanent fallback. | Stage **8.5** — `ChatterboxTextToSpeech` **is implemented and registered**; it needs a GPU and a deployed Chatterbox-TTS-Server |

These are one purchase, not two. `voice-tts.md` is blunt about it: *TTS is not the VRAM driver — the
local LLM is.* Budget for the whole resident set — Tier 1 + a quantized reasoning distill +
Chatterbox — because the realistic worst case is the assistant composing a reply while speaking the
previous sentence, which is all three at once. The 14B-vs-32B distill choice is a VRAM trade made at
purchase time.

When the card lands, Chatterbox is a config flip and nothing else:

```ini
Voice__Tts__Chatterbox__Endpoint=http://localhost:8004
Voice__Tts__Primary=chatterbox
```

`VoiceRouter` gives the primary engine `Voice__Tts__FirstAudioDeadlineSeconds` (2.5s) to produce
audio and falls back to Piper if it doesn't — so a cold GPU delays a spoken alert by 2.5 seconds
rather than swallowing it.

---

# Verify the lineup

One call answers "what is actually on":

```bash
curl -s http://localhost:5000/api/voice/capabilities
curl -s http://localhost:5000/api/health
```

| Symptom | Cause | Fix |
|---|---|---|
| Assistant replies are canned and terse | No tier configured — the simulated floor | Part 1; confirm `Ai__LocalEndpoint` is set and restart |
| `"origin":"Local"` but answers are nonsense | Ollama has a different model than `Ai__LocalModel` | `ollama list`, then match the two exactly |
| Assistant hangs, then falls back | Model is loading on CPU for the first time | Normal on the first turn after a restart; `ollama run gemma3:4b` once to warm it |
| `/api/voice/speak` → **501** | Piper binary *or* model path missing | Part 4.3 — both keys, absolute paths |
| `/api/voice/speak` → **502** | Piper is configured but failing | `journalctl -u homehub -n 50`; usually the `.onnx.json` is not beside the `.onnx` |
| `/api/voice/transcribe` → **501** | No STT engine at all | Part 3, or set `Ai__OpenAiApiKey` for the cloud fallback |
| Transcription always fails, panel says it couldn't hear | `Voice__Stt__LocalModel` is the plain `base.en` | Use the HF id: `Systran/faster-whisper-base.en` |
| Push-to-talk missing in the browser | Not a server problem — mic needs a secure context | HTTPS: `server-systemd.md` Part D |
| Everything works over ssh, nothing works from the panel | You are testing `localhost`; the panel uses the LAN address and port | `sudo ss -lntp \| grep homehub` |

**Ports this guide opens, all loopback-only:** Ollama `11434`, Speaches `8000`. Neither should be
reachable from the LAN, and neither needs a firewall rule. The only port the household touches is
the panel's own.

---

## Reference — every key this guide sets

Drop-in block for `/etc/homehub/homehub.env`. Uncomment what you have installed.

```ini
# --- AI assistant -------------------------------------------------------------
# Tier 1, local (Part 1). LocalEndpoint is the on/off switch; the provider appends /api/chat.
#Ai__LocalEndpoint=http://localhost:11434
#Ai__LocalModel=gemma3:4b

# --- MCP seam (Part 5). Required to expose the house to an agent; the tools write. ---
#Mcp__ApiKey=

# The deliberate path — Hermes Agent (Part 5.3–5.5). Both required or the agent path stays off.
#Ai__Agent__Endpoint=http://localhost:8642
#Ai__Agent__ApiKey=

# Tier 3, cloud (Part 2). The key stays server-side, never on the Pi.
#Ai__OpenAiApiKey=sk-...
#Ai__OpenAiModel=gpt-4o-mini

# --- Voice --------------------------------------------------------------------
# Local STT (Part 3). LocalModel MUST be the Hugging Face id, not the plain Whisper name.
#Voice__Stt__LocalEndpoint=http://localhost:8000
#Voice__Stt__LocalModel=Systran/faster-whisper-base.en
#Voice__Stt__AllowCloudFallback=true

# The house voice (Part 4). Both paths required, or TTS reports itself unconfigured.
#Voice__Tts__PiperPath=/opt/piper/.venv/bin/piper
#Voice__Tts__VoiceModel=/opt/piper/voices/en_US-norman-medium.onnx
#Voice__Tts__Primary=piper

# Chatterbox (Part 6) — GPU only. Flipping Primary is the whole migration.
#Voice__Tts__Chatterbox__Endpoint=http://localhost:8004
#Voice__Tts__Primary=chatterbox
```

Every key is also in the README's [configuration reference](../README.md#configuration-reference-all-keys),
in its `Ai:LocalModel` colon form — systemd env files use the `__` form instead. Same keys, same
meanings, different separator.

## Everyday commands — [server]

```bash
systemctl status ollama homehub --no-pager     # the two real systemd units
sudo docker ps --filter name=speaches          # the sidecar is a container, not a unit
sudo docker logs --tail 50 speaches
journalctl -u homehub -n 100 --no-pager
ollama list                                    # what is pulled
ollama ps                                      # what is resident right now
sudo systemctl restart homehub                 # after every homehub.env edit
```

Updating a piece is the same shape as installing it:

```bash
ollama pull gemma3:4b                                       # re-pull the local model
/opt/piper/.venv/bin/pip install -U piper-tts               # update Piper

sudo docker pull ghcr.io/speaches-ai/speaches:latest-cpu    # update the STT sidecar
sudo docker rm -f speaches                                  # then re-run the 3.2 command
```

None of them needs a HomeHub redeploy — these are config seams, not code. Recreating the Speaches
container is safe: the model cache lives in the named volume, not the container.
