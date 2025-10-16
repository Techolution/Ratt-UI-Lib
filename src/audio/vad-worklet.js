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
