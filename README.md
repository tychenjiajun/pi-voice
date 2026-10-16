# Pi Voice

Speech-to-text for Pi — on-device model or OpenAI-compatible remote ASR, with optional compaction-style post-processing.

Press a keyboard shortcut, talk, and the resulting transcript will be put directly into your chat.

> **Fork notice.** `@tychenjiajun/pi-voice` is a fork of [`@earendil-works/pi-voice`](https://github.com/earendil-works/pi-voice) that adds a remote ASR backend (any OpenAI-compatible `input_audio` chat-completions endpoint) in an exclusive local-only or remote-only setup, plus compaction-style post-processing that refines a transcript with Pi's own model. It is published independently under a personal npm scope. See the [changelog](#changelog) for what changed.

## Install

Install the npm package:

```bash
pi install npm:@tychenjiajun/pi-voice
```

If you prefer being on the development tip, you can install from GitHub:

```bash
pi install ssh://git@github.com/tychenjiajun/pi-voice
```

## Usage

The extension registers:

- a configurable terminal shortcut (`Ctrl+Alt+Z` by default) to start and stop recording;
- `/voice`, which does the same as the shortcut. While recording, `Space` also stops and transcribes, and `Escape` discards;
- a `transcribe_file` tool that the agent can use to transcribe local audio or video files;
- `/voice-settings` for preferred languages, model, transcription backend, transcription language, post-processing, microphone, and shortcut settings.

`/transcribe` remains available as a compatibility alias for `/voice-settings`.

## Remote ASR (OpenAI-compatible endpoint)

Pi Voice can send audio to a remote ASR service instead of transcribing with the local model. It speaks the OpenAI chat-completions `input_audio` dialect: the recording is uploaded as a base64 WAV data URL and the transcript is read from `choices[0].message.content`. Any endpoint that accepts that shape works.

Set it up either during first-run setup — `/voice-settings` starts by asking **Local model** or **Remote ASR (OpenAI-compatible)** — or later in `/voice-settings` → **Transcription backend** → **Remote ASR (OpenAI-compatible)**. You are asked for:

1. **Base URL** — endpoint root, without `/chat/completions`;
2. **Model** — the model name your endpoint expects;
3. **API key environment variable** — the *name* of an env var. The key itself is read from that variable at runtime and never written to settings.

Then export the key before starting Pi:

```bash
export OPENAI_API_KEY=sk-...
```

Behavior:

- **Remote-only mode.** Remote settings store no local model: setup skips the model download step, and a failed remote request (network, quota, HTTP error, or an unset API key) surfaces as an error instead of being retried offline. Failures are logged to `~/.pi/agent/pi-voice.log`.
- **Batch-only.** Remote transcription happens when recording stops (the ASR request carries the whole clip), so there is no streaming preview.
- **16 kHz mono WAV** is uploaded as a base64 WAV data URL.
- **Exclusive modes.** Switching **Transcription backend** to **Local model** asks you to pick a model first; switching to **Remote ASR** drops the local model from settings. The **Model** and **Transcription language** settings rows appear only in local mode.
- `transcribe_file` uses whichever mode is configured — in remote mode the file audio is sent to the endpoint instead of a local model.

Transcripts still go through the **Chinese output** script conversion preference; because a remote response carries no detected language, Han characters in the transcript are what trigger the conversion when the language is set to automatic. The **Chinese output** row stays reachable in remote mode, since the endpoint can always produce Chinese.

## Post-processing (compaction-style refinement)

After ASR produces a transcript, Pi Voice can refine it with the same model (and provider credentials) Pi agents already use for tasks like conversation compaction. The cleanup fixes obvious speech-recognition errors, punctuation, and capitalization, and strips filler words and false starts — without a separate endpoint to configure.

Set it up in `/voice-settings` → **Post-processing** → **On**. You then choose the model:

- **Pi's current model** (default) — whichever model the agent is using, exactly like compaction;
- **a different model** — any model from Pi's registry, using that provider's configured authentication. The picker is searchable: type a keyword (a model name or part of `provider/id`) to filter the list, `Enter` selects the highlighted match, and `Esc` clears the search.

Pi Voice makes a small nested request through Pi's model registry, so it automatically reuses Pi's model definitions and API keys (or OAuth). No base URL, key, or timeout is stored in Pi Voice settings.

Behavior:

- **Best-effort only.** If post-processing fails (no usable model, abort, provider/network error, or an empty response), the raw transcript is used unchanged and the failure is logged to `~/.pi/agent/pi-voice.log`. An override that is no longer in the registry falls back to the agent's current model.
- **Reasoning-safe.** A provider's thinking is ignored (Pi reports it as `thinking` blocks), and inline reasoning tags a model may embed in its text are stripped. If only reasoning comes back, the raw transcript is kept.
- **Discrete, not streaming.** Refinement happens after the full transcript is produced, so there is no live preview of the polished text.
- **Applies to all transcription.** Microphone dictation and the `transcribe_file` tool both go through the same post-processing step when it is enabled.

## Upgrading from pi-transcribe

It's recommended to install Pi Voice via NPM. If you have an older install of pi-transcribe uninstall it via: 

```bash
pi remove git:github.com/earendil-works/pi-transcribe
```

If you installed it into a project with `-l`, run `pi remove -l git:github.com/earendil-works/pi-transcribe` from that project instead. Then install Pi Voice with:

```bash
pi install npm:@tychenjiajun/pi-voice
```

## File transcription and FFmpeg

The agent can call `transcribe_file` for local audio or video files. Decoded audio is limited to 512 MiB (about 2.3 hours). File decoding requires the `ffmpeg` executable. Install FFmpeg with your system package manager if you don't already have it installed

```bash
# macOS with Homebrew
brew install ffmpeg

# Debian or Ubuntu
sudo apt install ffmpeg

# Windows with winget
winget install Gyan.FFmpeg
```

If FFmpeg is installed outside `PATH`, point Pi Voice at it before starting Pi:

```bash
export PI_VOICE_FFMPEG_PATH=/path/to/ffmpeg
```

The legacy `PI_TRANSCRIBE_FFMPEG_PATH` variable remains supported when `PI_VOICE_FFMPEG_PATH` is not set.

When FFmpeg is unavailable, `transcribe_file` reports platform-specific guidance to the agent. The agent should ask before running a package-manager command. Model setup is still explicit: run `/voice-settings` once in the interactive TUI to choose a mode and, in local mode, confirm the download of a local model.

## Changelog

### 0.7.0

**Added — Searchable post-processing model picker**

- `/voice-settings` → **Post-processing** → model now has a search box, so a registry with a thousand-plus models can be narrowed by typing instead of arrowing through the whole list.
- The search uses the same fuzzy matcher as the transcription model picker (`fuzzyFilter` from `@earendil-works/pi-tui`) and matches the model name as well as `provider/id`, so `wspr` finds `openai/whisper-1` and `claude` finds `anthropic/claude-opus-4-5`.
- Results are sorted by match quality with the cursor on the best match (Enter picks it), `Esc` clears the search and restores the full list, and the subtitle reminds you that typing filters the models.

### 0.6.0

**Changed — Fuzzy model search**

- The model picker now uses the same fuzzy filter Pi's own model selector uses (`fuzzyFilter` from `@earendil-works/pi-tui`), so typing partial or abbreviated names finds matches that exact substring search could not — e.g. `wspr` matches `whisper-medium`, and `pkrt` matches `parakeet`. Results within each section are also sorted by match quality, putting the best-scoring model at the top.
- While a search query is active the cursor stays on the best match instead of following a model that may have moved or dropped out of the results, matching Pi's model selector interaction.

### 0.5.0

**Changed — Exclusive local / remote modes (no fallback)**

- Local and remote transcription are now mutually exclusive: remote settings store no local model, and selecting a local model drops any remote configuration. Settings files with both are normalized to remote-only on read.
- First-run setup in remote mode skips the model step entirely; no local model is downloaded (onboarding jumps from step 2 to step 4, the Try it pane).
- Removed the local fallback for remote ASR. Network, quota, HTTP, and unset-API-key failures now surface directly and are logged to `~/.pi/agent/pi-voice.log`.
- The settings menu hides the **Model** and **Transcription language** rows in remote mode and always shows **Chinese output** there; switching the backend to local asks you to pick a model first, and switching to remote clears the local model.
- Try it shows a **Local model** row in remote mode; choosing a model from it switches setup to local mode.
- `transcribe_file` works in either mode and reports the remote model name in its details when remote.

### 0.4.0

**Added — Backend choice in first-run setup**

- `/voice-settings` (and the first shortcut press) now starts by asking **Local model** or **Remote ASR (OpenAI-compatible)**, so the remote backend no longer requires finishing local setup first. A local model is still downloaded as the fallback.
- The remote endpoint prompts (base URL, model, API-key env var name) are shared by first-run setup and the settings menu.

**Fixed — Settings reachability and remote consistency**

- `/voice-settings` opens the settings menu after recovering a missing model file, instead of returning and making you run the command a second time.
- **Chinese output** is shown for detecting models that support Chinese, so it is reachable when the transcription language is automatic.
- Remote transcripts apply the Chinese output preference when the transcript contains Han characters, not only when the configured language is Chinese.
- Settings and errors no longer assume local-only transcription: the **Transcription language** row explains that a remote endpoint detects the language itself, and the transcription error, `transcribe_file` setup guidance, and Try-it model row describe the remote backend.

**Changed**

- Onboarding progress counts the backend step (1 backend → 2 languages → 3 model → 4 Try it).
- Try it's **change model** keeps the configured transcription language for the new model.

### 0.3.0

**Added — Post-processing (compaction-style refinement)**

- After ASR, transcripts can be refined with the agent's current model and provider, reusing the same nested-model path as conversation compaction.
- Configure in `/voice-settings` → **Post-processing**: toggle **Off / On**, then use **Pi's current model** or pick a different model from Pi's registry (its model definitions and authentication are reused).
- **Best-effort only:** no usable model, aborts, provider failures, and empty responses all keep the raw transcript; an override that disappears falls back to the agent's current model. Diagnostics go to `~/.pi/agent/pi-voice.log`.
- **Reasoning-safe:** provider thinking blocks are ignored, inline reasoning tags (`think` … `response`) are stripped, and a response that is only reasoning keeps the raw transcript.
- Applies to both microphone dictation and the `transcribe_file` tool.
- Existing settings remain valid: post-processing defaults to **Off**.

### 0.2.0

First release of `@tychenjiajun/pi-voice` — a fork of [`@earendil-works/pi-voice`](https://github.com/earendil-works/pi-voice) 0.1.0, published independently under the `@tychenjiajun` scope.

**Added — Remote ASR backend**

- Recordings can be transcribed by any OpenAI-compatible chat-completions ASR endpoint via the `input_audio` content block.
- Configure in `/voice-settings` → **Transcription backend** → **Remote ASR (OpenAI-compatible)**: base URL, model, and the *name* of an env var holding the API key (the key itself is never stored in settings). First-run setup also offers the remote backend directly.
- Audio is uploaded as a 16 kHz mono WAV base64 data URL. Remote transcription is batch-only (no streaming preview).
- **Local model fallback:** if a remote request fails (network, quota, HTTP error, or the API key is unset), the full recording is transcribed with the configured local model; the failure is logged to `~/.pi/agent/pi-voice.log`. Aborted/cancelled transcriptions are never retried locally.

**Changed**

- Package name, repository, homepage, and bugs URLs updated to the fork (`tychenjiajun/pi-voice`).
- Chinese script conversion for remote transcripts mirrors the local backend (applies only when the configured language is Chinese).

### 0.1.0

Upstream `@earendil-works/pi-voice` initial release.

## Developing & Building Pi Voice

To develop or run it from a checkout:

```bash
git clone git@github.com:tychenjiajun/pi-voice.git
cd pi-voice
npm install --ignore-scripts
pi -e .
```

If you want to be able to re-run onboarding you can enable the debug env var when starting Pi. This enables the `/voice-onboarding` command.

```bash
PI_VOICE_DEBUG=1 pi -e /absolute/path/to/pi-voice
```
