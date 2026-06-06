#!/usr/bin/env node
/**
 * Plugin Mixer Bridge — Setup Script
 * Copies the PluginMixerBridge MIDI Remote Script to Ableton's scripts folder.
 * Run via: npm run setup
 */

import fs from "fs";
import path from "path";
import os from "os";

const BRIDGE_SRC = path.resolve(import.meta.dirname, "..", "companion", "PluginMixerBridge");
const SCRIPT_NAME = "PluginMixerBridge";

function findMidiRemoteScriptsDir() {
  const platform = os.platform();

  if (platform === "darwin") {
    // macOS: ~/Library/Application Support/Ableton/Live X.X.X/Resources/MIDI Remote Scripts
    const base = path.join(os.homedir(), "Library", "Application Support", "Ableton");
    if (!fs.existsSync(base)) throw new Error(`Ableton folder not found at: ${base}`);

    const liveDirs = fs.readdirSync(base)
      .filter(d => d.startsWith("Live") && fs.statSync(path.join(base, d)).isDirectory())
      .sort();

    if (liveDirs.length === 0) throw new Error("No Ableton Live installation found in " + base);

    // Use the latest version
    const latest = liveDirs[liveDirs.length - 1];
    const scriptsPath = path.join(base, latest, "Resources", "MIDI Remote Scripts");
    if (!fs.existsSync(scriptsPath)) throw new Error(`MIDI Remote Scripts folder not found at: ${scriptsPath}`);
    return { scriptsPath, liveVersion: latest };
  }

  if (platform === "win32") {
    // Windows: C:\ProgramData\Ableton\Live X\Resources\MIDI Remote Scripts
    const base = path.join("C:\\", "ProgramData", "Ableton");
    if (!fs.existsSync(base)) throw new Error(`Ableton folder not found at: ${base}`);

    const liveDirs = fs.readdirSync(base)
      .filter(d => d.startsWith("Live") && fs.statSync(path.join(base, d)).isDirectory())
      .sort();

    if (liveDirs.length === 0) throw new Error("No Ableton Live installation found in " + base);

    const latest = liveDirs[liveDirs.length - 1];
    const scriptsPath = path.join(base, latest, "Resources", "MIDI Remote Scripts");
    if (!fs.existsSync(scriptsPath)) throw new Error(`MIDI Remote Scripts folder not found at: ${scriptsPath}`);
    return { scriptsPath, liveVersion: latest };
  }

  throw new Error(`Unsupported platform: ${platform}. Install manually by copying companion/PluginMixerBridge/ to your MIDI Remote Scripts folder.`);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const srcEntry = path.join(src, entry);
    const dstEntry = path.join(dst, entry);
    if (fs.statSync(srcEntry).isDirectory()) {
      copyDir(srcEntry, dstEntry);
    } else {
      fs.copyFileSync(srcEntry, dstEntry);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log("🎛  Plugin Mixer Bridge — Setup\n");

try {
  const { scriptsPath, liveVersion } = findMidiRemoteScriptsDir();
  const dst = path.join(scriptsPath, SCRIPT_NAME);

  console.log(`  Live version : ${liveVersion}`);
  console.log(`  Scripts path : ${scriptsPath}`);
  console.log(`  Installing   : ${SCRIPT_NAME}/\n`);

  copyDir(BRIDGE_SRC, dst);

  console.log("✅  Done!\n");
  console.log("Next steps:");
  console.log("  1. Restart Ableton Live (or it may already pick it up)");
  console.log("  2. Go to Preferences → Link / MIDI → Control Surfaces");
  console.log('  3. Add a new surface and select "PluginMixerBridge"');
  console.log("  4. Run npm start — the extension will auto-detect the bridge\n");
  console.log("  On macOS, also grant Accessibility permissions to Live if prompted");
  console.log("  (System Preferences → Privacy & Security → Accessibility → Ableton Live)\n");

} catch (e) {
  console.error("❌  Setup failed:", e.message);
  console.error("\nManual install: copy companion/PluginMixerBridge/ to your MIDI Remote Scripts folder.");
  process.exit(1);
}
