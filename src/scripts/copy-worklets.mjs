import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const srcDir = path.resolve(__dirname, "../audio");
const outDir = path.resolve(__dirname, "../../dist/audio");

fs.mkdirSync(outDir, { recursive: true });

const files = ["recorder-worklet.js", "vad-worklet.js"];
for (const f of files) {
  const from = path.join(srcDir, f);
  const to = path.join(outDir, f);
  if (!fs.existsSync(from)) {
    console.warn(`[copy-worklets] missing: ${from}`);
    continue;
  }
  fs.copyFileSync(from, to);
  console.log(`[copy-worklets] copied ${from} -> ${to}`);
}
