// src/audio/WorkletLoader.ts
export async function ensureAudioContextAndWorklets(basePath = "/") {
    // 1) Ensure secure context (required by AudioWorklet in all modern browsers)
    if (typeof window !== "undefined" && window.isSecureContext === false && location.hostname !== "localhost") {
        throw new Error("[ratt-lib] AudioWorklet requires a secure context. Use HTTPS or http://localhost during dev.");
    }

    const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    const audioCtx = new AC({ sampleRate: 16000 });

    // ── Helper: try to load two modules from given URLs
    const tryLoad = async (recUrl: string, vadUrl: string) => {
        await audioCtx.audioWorklet.addModule(recUrl);
        await audioCtx.audioWorklet.addModule(vadUrl);
    };

    // 2) Try public path (consumer's /public)
    try {
        const norm = basePath.replace(/\/?$/, "/");
        await tryLoad(`${norm}recorder-worklet.js`, `${norm}vad-worklet.js`);
        return audioCtx;
    } catch (err) {
        console.warn("[ratt-lib] public path failed, trying module-relative:", err);
    }

    // 3) Try module-relative (ESM only) – only if available at runtime
    const metaUrl = (() => {
        try {
            // Avoid bundler complaints in CJS by evaluating at runtime
            return (0, eval)("import.meta.url") as string;
        } catch {
            return undefined;
        }
    })();

    if (metaUrl) {
        try {
            const recUrl = new URL("./recorder-worklet.js", metaUrl).toString();
            const vadUrl = new URL("./vad-worklet.js", metaUrl).toString();
            await tryLoad(recUrl, vadUrl);
            return audioCtx;
        } catch (err) {
            console.warn("[ratt-lib] module-relative load failed:", err);
        }
    }

    // 4) Inline fallback via Blob URLs — no network, no CORS
    try {
        const recorderSource = `
        class RecorderProcessor extends AudioWorkletProcessor {
          process(inputs) {
            const input = inputs[0];
            if (input && input[0]) {
              // Copy to avoid SAB issues
              const out = new Float32Array(input[0].length);
              out.set(input[0]);
              this.port.postMessage(out);
            }
            return true;
          }
        }
        registerProcessor('recorder-worklet', RecorderProcessor);
      `.trim();

        const vadSource = `
       class VADProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        // Configuration parameters (these are the defaults for Silero VAD)
        this.positiveSpeechThreshold = 0.5; // Above this, treat frame as speech–positive
        this.negativeSpeechThreshold = 0.35; // Below this, treat frame as speech–negative
        this.redemptionFrames = 20; // Number of consecutive negative frames to consider speech ended
        this.preSpeechPadFrames = 1; // (Optional) number of frames to prepend to a detected segment
        this.minSpeechFrames = 3; // Minimum number of speech–positive frames required for a valid segment
        // Internal state for frame counting and speech segmentation
        this.speaking = false;
        this.speechFramesCount = 0;
        this.silenceFramesCount = 0;
        // Optional: You could buffer frames here if you want to later return the actual audio segment.
        // this.bufferedFrames = [];

        // control: let main thread stop the processor
        this.keepRunning = true;
        this.port.onmessage = (e) => {
            if (e.data?.type === 'shutdown') this.keepRunning = false; // next call => return false
            if (e.data?.type === 'reset') {
                this.keepRunning = true;
                this.resetSpeechState();
            }
        };
    }

    process(inputs) {
        if (!this.keepRunning) return false;

        const input = inputs?.[0]?.[0];
        if (!input || input.length === 0) return true;

        // Compute average energy of the frame (this is our “probability” proxy)
        const energy = input.reduce((acc, val) => acc + val ** 2, 0);

        if (energy > this.positiveSpeechThreshold) {
            // If energy exceeds the positive threshold, count this frame as speech–positive.
            this.handleSpeechDetected(energy);
        } else if (energy < this.negativeSpeechThreshold) {
            // If energy is lower than the negative threshold, count it as a negative frame.
            this.handleSilenceDetected();
        }
        // If energy is between thresholds, do nothing.
        return true;
    }

    handleSpeechDetected(energy) {
        this.silenceFramesCount = 0;

        // Transition from not-speaking to speaking.
        if (!this.speaking) {
            this.speaking = true;
            this.speechFramesCount = 1;

            // Send voice_start event with current energy.
            this.port.postMessage({ event: 'voice_start', energy });
        } else {
            this.speechFramesCount++;
            this.port.postMessage({ event: 'voice_continue', energy });
        }
    }

    handleSilenceDetected() {
        if (!this.speaking) return;
        this.silenceFramesCount++;
        if (this.silenceFramesCount < this.redemptionFrames) return;

        if (this.speechFramesCount >= this.minSpeechFrames) {
            this.port.postMessage({ event: 'voice_stop' });
        }
        this.resetSpeechState();
    }

    resetSpeechState() {
        this.speaking = false;
        this.speechFramesCount = 0;
        this.silenceFramesCount = 0;
        // Optionally clear buffered frames if you were collecting them.
        // this.bufferedFrames = [];
    }
}

registerProcessor('vad-worklet', VADProcessor);
      `.trim();

        const mkBlobUrl = (code: string) => URL.createObjectURL(new Blob([code], { type: "application/javascript" }));

        const recBlobUrl = mkBlobUrl(recorderSource);
        const vadBlobUrl = mkBlobUrl(vadSource);

        await tryLoad(recBlobUrl, vadBlobUrl);

        // let GC reclaim the blob URLs later; audio worklet keeps the module loaded
        return audioCtx;
    } catch (err) {
        console.error("[ratt-lib] inline fallback failed:", err);
        throw new Error(`Unable to load audio worklets (all strategies failed). Original error: ${err}`);
    }
}
