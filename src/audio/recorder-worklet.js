class RecorderWorklet extends AudioWorkletProcessor {
    process(inputs) {
        const input = inputs[0];
        if (input && input[0]) {
            const samples = input[0];
            this.port.postMessage(new Float32Array(samples));
        }
        return true;
    }
}
registerProcessor('recorder-worklet', RecorderWorklet);
