# RATT Agent Library

Welcome to the **RATT Agent Library **! 🎧⚡
This tiny TypeScript client streams microphone (or external) audio over WebSocket, handles reconnection and heartbeats, and emits **typed events** for live transcription and UI state. It works in browsers (with AudioWorklets) and in Node (via external PCM).

---

## 🚀 Features

-   **Low-latency audio streaming** (16 kHz, 16-bit PCM) over WebSocket
-   **Browser + Node**: use the mic in browsers or push external PCM in any runtime
-   **Typed events**: ready, mic state, amplitude (VAD energy), transcription, socket messages, errors
-   **Prebuffering & gating**: capture early, start sending when the server says `start_audio`
-   **Resilient WS**: single-flight connect, StrictMode-safe reuse, heartbeats & auto-reconnect
-   **Safe defaults**: echo cancellation, AGC, noise suppression (browser)
-   **Tiny API**: a single class `AssistantClient` you can drop into your app

---

## 📦 Installation

```bash
npm i ratt-lib
# or
pnpm add ratt-lib
```

---

## ✨ Quick Start (Browser)

```ts
import { AssistantClient, AssistantOptions, AssistantEvent } from "ratt-lib";

// Simple mutable ref for requestId (works well with React useRef) and this id will be unique for each req
const requestId = { current: "" };

const chatSessionId = "test"; //Unique for whole session
const clientId = "test"; //Unique for whole session

// ✅ Build the REQUIRED rattAgentDetails object
const rattAgentDetails = {
    conciergeId: chatbotData?.id, // Your chatbot Id
    conciergeName: chatbotData?.name ?? chatbotData?.assistantDetails?.name,
    organizationId: chatbotData?.organization,
    organizationName: chatbotData?.organizationName,
    requestId: requestId.current, // will be overridden with a fresh value when session starts
    agentSettings: {
        voiceAgentMongoId: chatbotData?.agents?.filter((a: any) => a.title === "RATTAgent")?.[0]?._id,
    },
    username: user?.provider?.name, // user name
    useremailId: user?.email, // user email
    chatSessionId: chatSessionId,
    rlefVoiceTaskId: chatbotData?.audioTranscription?.modelId || CREATE_AUDIO_RELF_VOICE_TASK_ID_DEFAULT_VALUE, // rlef model id
    assistant_type: chatbotData?.assistant_type, // your assistant type
    isAudioRequest: true, //always true
    client_id: clientId,
    userId: encodeParam(USER_ID_DEFAULT_VALUE), // your user id
    // keep below three as it is if test instant learning is not there , otherwise please send these values as well as per the requirements.
    testQuestion: "",
    testAnswer: "",
    testVariants: JSON.stringify({ Edit: [], Add: [], Delete: [] }),
} as const;

const client = new AssistantClient({
    url: "wss://dev-egpt.techo.camp/audioStreamingWebsocket?clientId=${clientId}&sessionId=${chatSessionId}", // Required: your WS endpoint
    requestId, // Required: { current: string }
    rattAgentDetails, // ✅ pass the full required object
    onSend: () => console.log("Transcript submitted"),
    showToast: (type, title, msg) => console.log(type, title, msg),
    // optional tunables:
    pingIntervalMs: 5000,
    maxMissedPongs: 2,
    workletBasePath: "/", // where recorder/vad worklets are served from
});

// Listen to events
client.on(AssistantEvent.READY, () => {
    console.log("WS ready:", client.wsReady);
});

client.on(AssistantEvent.MIC_CONNECTING, ({ detail }) => {
    console.log("Mic connecting:", detail.connecting);
});

client.on(AssistantEvent.MIC_OPEN, ({ detail }) => {
    console.log("Mic open:", detail.open);
});

client.on(AssistantEvent.AMPLITUDE, ({ detail }) => {
    // 0..~1 energy (not dB) to drive a mic meter UI
    console.log("Amplitude:", detail.value);
});

client.on(AssistantEvent.TRANSCRIPTION, ({ detail }) => {
    // progressive or final text
    console.log("Transcript:", detail.text);
});

client.on(AssistantEvent.ERROR, ({ detail }) => {
    console.error("Assistant error:", detail.error);
});

// Start a session (ask server to begin, then it will reply with start_audio)
document.querySelector("#start")!.addEventListener("click", () => {
    client.startSession(); // toggles ON (opens mic flow) basically handleMicClick function
});

// Stop (ask server to disconnect and teardown locally)
document.querySelector("#stop")!.addEventListener("click", () => {
    client.stopAudio(); // toggles OFF
});
```

### What happens under the hood?

1. `startSession()` sends your `rattAgentDetails` + a new `requestId`.
2. When your server responds with `{ "start_audio": true }`, the client:

    - marks the mic as open,
    - starts converting to PCM16,
    - and **begins streaming**.

3. As your server streams partial ASR, send either:

    - `{"streaming_data":{"previous_transcription":"...", "new_transcription":"..."}}` (chunked delta)
      _or_
    - `{"transcription":"final text"}` (full updates)

4. End with `{"stop_audio": true}` and/or `{"disconnect": true}` when you’re done.

---

## 🧩 React one-liner (optional)

```ts
useEffect(() => {
    const unsub = client.on(AssistantEvent.TRANSCRIPTION, ({ detail }) => {
        setText(detail.text);
    });
    return unsub; // cleanly removes listener
}, []);
```

---

## 🖥️ Node / External Audio (no browser mic)

If you're not in a browser (or you have your own capture pipeline), set `externalAudio: true` and push PCM yourself.

```ts
import { AssistantClient } from "ratt-lib";
import fs from "node:fs";

const requestId = { current: "" };
const client = new AssistantClient({
    url: "wss://dev-egpt.techo.camp/audioStreamingWebsocket?clientId=${clientId}&sessionId=${chatSessionId}",
    requestId,
    externalAudio: true, // ⬅️ no AudioContext, no mic
    externalAmplitudeRms: true, // optional: compute amplitude from PCM
});

// Start session -> wait for server {"start_audio": true}
await client.connect();
await client.startSession();

// Now stream your PCM16 mono 16kHz data
const pcm = fs.readFileSync("./audio.raw"); // Int16 little-endian mono 16kHz
client.pushPCM16(new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2));

// ...push more chunks as they arrive...
// When done: or it will be auto stop by server when it detects some silence is there
await client.stopAudio();
```

> **PCM format**: **16 kHz**, **16-bit**, **mono**, **little-endian**.
> If you have `Float32Array [-1..1]`, call `pushFloat32()` instead.

---

## 🔔 Events

All events are emitted as standard `CustomEvent`s and strongly typed via `AssistantEvents` type.

-   `READY` — WebSocket is ready (connected & open)
-   `MIC_CONNECTING` — `{ connecting: boolean }` while we prep/prompt for mic
-   `MIC_OPEN` — `{ open: boolean }` mic flow is active/inactive
-   `AMPLITUDE` — `{ value: number }` live energy (for a mic meter)
-   `TRANSCRIPTION` — `{ text: string, delta?: string }` progressive or final
-   `SOCKET_MESSAGE` — `{ raw: MessageEvent, parsed?: any }` every incoming WS message
-   `ERROR` — `{ error: unknown }` any operational error

```ts
const off = client.on(AssistantEvent.TRANSCRIPTION, ({ detail }) => {
    console.log(detail.text);
});
off(); // unsubscribe
```

---

## ⚙️ Options

```ts
type AssistantOptions = {
    url: string; // WS endpoint
    requestId: { current: string }; // mutable ref; client writes new ID per session
    rattAgentDetails?: Record<string, any>;
    onSend?: () => void; // called when server requests "disconnect"
    showToast?: (type: "error" | "info" | "success", title: string, msg: string) => void;

    // Connection / heartbeat
    pingIntervalMs?: number; // default 5000
    maxMissedPongs?: number; // default 2

    // Audio (browser)
    workletBasePath?: string; // default "/"
    mediaStreamProvider?: () => Promise<MediaStream>; // default: getUserMedia (1ch, 16k, AGC/NS/EC enabled)
    audioContextFactory?: () => AudioContext | null; // default: new AudioContext() in browser, null in Node
    workletLoader?: (base: string) => Promise<AudioContext | null>; // default: ensureAudioContextAndWorklets

    // External audio (Node or custom capture)
    externalAudio?: boolean; // default: false in browser, true in Node
    externalAmplitudeRms?: boolean; // default: true
    pcmChunkSize?: number; // default: TARGET_SAMPLES (typically 16000)
};
```

---

## 🧪 Common Methods

```ts
await client.connect(); // single-flight; reuses active WS if present
await client.startSession(); // begin mic flow or external audio session
await client.stopAudio(); // stop current session (sends {disconnect:true})
client.disconnect(); // local teardown (no forced WS close)
client.teardown(); // local teardown helpers
client.closeSocket(); // forcibly close WS and detach handlers

// Mic helpers
await client.beginPrebuffering(); // start capturing locally; don't send yet
client.stopPrebuffering(); // stop & clear buffered audio
await client.startMic(); // explicitly start mic capture
client.stopMic(); // explicitly stop mic (and send {disconnect:true})

// External audio
client.pushPCM16(int16ArrayOrBuffer);
client.pushFloat32(float32Array);

// State getters
client.wsReady; // boolean
client.micOpen; // boolean
client.micConnecting; // boolean
client.amplitude; // number (0..~1)
client.transcription; // latest accumulated text
```

---

## 🧯 Troubleshooting

-   **No audio sent**
    Ensure your server replies with `{"start_audio": true}`. The client **buffers** until the gate opens.
-   **Mic blocked**
    Browser will throw `NotAllowedError`. The client emits `ERROR` and calls `showToast(...)`.
-   **Noisy audio / echo**
    The default constraints enable echo cancellation, AGC, and noise suppression. Override `mediaStreamProvider` if needed.
-   **Multiple connects in React StrictMode**
    This client reuses a global `ACTIVE_WS` and a single `CONNECT_PROMISE`—you’re safe.
-   **Heartbeat timeouts**
    Increase `pingIntervalMs` or `maxMissedPongs` if your WS hops are choppy.

---

## 🔐 Permissions & Security

-   Browsers require a **user gesture** to start the microphone.
-   Only minimal audio data is sent; handle it securely on your server. Use `wss://` in production.

---

## 👥 Community & Support

Questions, bugs, or ideas? Open an issue in your repo or ping your team chat. Happy streaming! 🎙️💬
