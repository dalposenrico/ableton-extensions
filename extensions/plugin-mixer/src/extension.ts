import {
  initialize,
  type ActivationContext,
  DataModelObject,
  AudioTrack,
  MidiTrack,
} from "@ableton-extensions/sdk";
import * as fs from "fs";
import * as path from "path";
import { BUILTIN_DEVICES } from "./devices.js";

type AnyTrack = AudioTrack<"1.0.0"> | MidiTrack<"1.0.0">;

interface TrackData {
  index: number;
  name: string;
  type: "audio" | "midi";
  isGroup: boolean;
  devices: { name: string; index: number }[];
}

interface MixerAction {
  action: "insert" | "delete" | "duplicate" | "move" | "copy";
  trackIndex: number;
  deviceName?: string;
  deviceIndex?: number;
  position?: number;
  toTrackIndex?: number;
  toPosition?: number;
  deleteSource?: boolean; // for "copy": true = move with preset, false = copy with preset
}

function getAllTracks(context: ReturnType<typeof initialize>): AnyTrack[] {
  const song = context.application.song;
  if (!song) return [];
  return song.tracks.filter(
    (t): t is AnyTrack => t instanceof AudioTrack || t instanceof MidiTrack,
  );
}

function buildTrackData(tracks: AnyTrack[]): TrackData[] {
  // Detect group tracks: any track that is the groupTrack of another track
  const groupTrackSet = new Set<AnyTrack>();
  for (const t of tracks) {
    const parent = t.groupTrack;
    if (parent) groupTrackSet.add(parent as AnyTrack);
  }

  return tracks.map((t, i) => ({
    index: i,
    name: t.name,
    type: t instanceof AudioTrack ? "audio" : "midi",
    isGroup: groupTrackSet.has(t),
    devices: t.devices.map((d, j) => ({ name: d.name, index: j })),
  }));
}

function actionLabel(msg: MixerAction, tracks: AnyTrack[]): string {
  const trackName = tracks[msg.trackIndex]?.name ?? `track ${msg.trackIndex}`;
  if (msg.action === "insert") return `Insert "${msg.deviceName}" → ${trackName}`;
  if (msg.action === "delete") {
    const devName = msg.deviceIndex !== undefined
      ? tracks[msg.trackIndex]?.devices[msg.deviceIndex]?.name ?? `device ${msg.deviceIndex}`
      : "device";
    return `Delete "${devName}" from ${trackName}`;
  }
  if (msg.action === "duplicate") {
    const devName = msg.deviceIndex !== undefined
      ? tracks[msg.trackIndex]?.devices[msg.deviceIndex]?.name ?? `device ${msg.deviceIndex}`
      : "device";
    return `Duplicate "${devName}" on ${trackName}`;
  }
  if (msg.action === "move") {
    const toName = msg.toTrackIndex !== undefined ? tracks[msg.toTrackIndex]?.name ?? `track ${msg.toTrackIndex}` : "?";
    return `Move device from ${trackName} → ${toName}`;
  }
  if (msg.action === "copy") {
    const devName = msg.deviceIndex !== undefined
      ? tracks[msg.trackIndex]?.devices[msg.deviceIndex]?.name ?? "device"
      : "device";
    const toName = msg.toTrackIndex !== undefined ? tracks[msg.toTrackIndex]?.name ?? `track ${msg.toTrackIndex}` : "?";
    return msg.deleteSource
      ? `Move "${devName}" ${trackName} → ${toName} (with preset)`
      : `Copy "${devName}" ${trackName} → ${toName} (with preset)`;
  }
  return msg.action;
}

function buildErrorSummaryHtml(errors: string[]): string {
  const rows = errors
    .map(e => `<li>${e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</li>`)
    .join("\n");
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #1c1c1c; color: #ccc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 12px; padding: 20px; display: flex; flex-direction: column; gap: 14px; height: 100vh; }
  h2 { font-size: 13px; color: #f08080; font-weight: 600; }
  p { font-size: 11px; color: #888; line-height: 1.5; }
  ul { list-style: none; display: flex; flex-direction: column; gap: 5px; overflow-y: auto; flex: 1; }
  li { background: #2a1a1a; border: 1px solid #4a2a2a; border-radius: 3px; padding: 5px 10px;
    color: #e08080; font-size: 11px; }
  button { align-self: flex-end; background: #2a3a2a; border: 1px solid #3a5a3a; border-radius: 4px;
    color: #9fd09f; padding: 6px 18px; font-size: 11px; cursor: pointer; }
  button:hover { background: #344834; }
</style></head><body>
  <h2>⚠ ${errors.length} action${errors.length > 1 ? "s" : ""} failed</h2>
  <p>These could not be applied — third-party plugins (VST/AU) cannot be inserted cross-track via the SDK, and audio effects cannot be added to MIDI tracks.</p>
  <ul>${rows}</ul>
  <button onclick="
    if(window.webkit?.messageHandlers?.live) window.webkit.messageHandlers.live.postMessage({method:'close_and_send',params:['']});
    else if(window.chrome?.webview) window.chrome.webview.postMessage({method:'close_and_send',params:['']});
  ">Close</button>
</body></html>`;
}

const BRIDGE_URL = "http://127.0.0.1:8765";

async function pingBridge(): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_URL}/ping`, { signal: AbortSignal.timeout(600) });
    const data = await res.json() as { status?: string };
    return data.status === "ok";
  } catch {
    return false;
  }
}

async function callBridge(endpoint: string, body: object): Promise<Record<string, unknown>> {
  const res = await fetch(`${BRIDGE_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  return await res.json() as Record<string, unknown>;
}

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  async function openMixer() {
    const tracks = getAllTracks(context);
    if (!tracks.length) {
      console.log("[Plugin Mixer] No tracks found.");
      return;
    }

    const trackData = buildTrackData(tracks);
    const bridgeAvailable = await pingBridge();
    console.log(`[Plugin Mixer] Opening with ${tracks.length} tracks — bridge: ${bridgeAvailable ? "✓ connected" : "✗ not running"}`);

    const uiPath = path.resolve(__dirname, "ui", "index.html");
    let html: string;
    try {
      html = fs.readFileSync(uiPath, "utf8");
    } catch (e) {
      console.error("[Plugin Mixer] Could not read ui/index.html:", e);
      return;
    }

    html = html
      .replace("'__TRACKS_DATA__'", JSON.stringify(trackData))
      .replace("'__DEVICES_DATA__'", JSON.stringify(BUILTIN_DEVICES));

    const dataUrl = `data:text/html,${encodeURIComponent(html)}`;

    let resultJson: string;
    try {
      resultJson = await context.ui.showModalDialog(dataUrl, 1200, 650);
    } catch {
      return;
    }

    if (!resultJson) return;

    let actions: MixerAction[];
    try {
      actions = JSON.parse(resultJson) as MixerAction[];
    } catch {
      return;
    }

    console.log(`[Plugin Mixer] Applying ${actions.length} action(s):`, JSON.stringify(actions, null, 2));

    const errors: string[] = [];

    await context.ui.withinProgressDialog(
      "Plugin Mixer: applying changes…",
      { progress: 0 },
      async (update, signal) => {
        let lastInsertFailed = false;
        for (let i = 0; i < actions.length; i++) {
          if (signal.aborted) {
            console.log("[Plugin Mixer] Cancelled by user.");
            break;
          }
          const msg = actions[i];
          if (!msg) continue;

          // Skip delete if the preceding insert failed (insert-before-delete drag pattern)
          if (msg.action === "delete" && lastInsertFailed) {
            const prev = actions[i - 1];
            if (prev?.action === "insert" && prev.trackIndex !== msg.trackIndex) {
              console.warn(`[Plugin Mixer] Skipping delete on track ${msg.trackIndex} — preceding insert failed, preserving source device.`);
              lastInsertFailed = false;
              continue;
            }
          }

          const label = actionLabel(msg, tracks);
          const progress = Math.round((i / actions.length) * 100);
          await update(`${label} (${i + 1}/${actions.length})`, progress);

          const failed = await handleAction(msg, tracks, bridgeAvailable);
          lastInsertFailed = failed;
          if (failed) errors.push(label);
        }
        await update("Done", 100);
      }
    );

    console.log(`[Plugin Mixer] Done. ${errors.length} failure(s).`);

    if (errors.length > 0) {
      const errorHtml = buildErrorSummaryHtml(errors);
      try {
        await context.ui.showModalDialog(
          `data:text/html,${encodeURIComponent(errorHtml)}`,
          420, 320
        );
      } catch { /* dismissed */ }
    }
  }

  async function handleAction(msg: MixerAction, tracks: AnyTrack[], bridgeAvailable = false): Promise<boolean> {
    const track = tracks[msg.trackIndex];
    if (!track) {
      console.error(`[Plugin Mixer] handleAction: no track at index ${msg.trackIndex} (action: ${msg.action})`);
      return true; // treat as failed
    }

    const trackLabel = `"${track.name}" [${msg.trackIndex}]`;

    if (msg.action === "insert" && msg.deviceName !== undefined) {
      const pos = msg.position ?? track.devices.length;
      console.log(`[Plugin Mixer] insert "${msg.deviceName}" on ${trackLabel} at pos ${pos}`);
      try {
        await track.insertDevice(msg.deviceName, pos);
        return false; // success
      } catch (e) {
        console.error(`[Plugin Mixer] insert FAILED — device: "${msg.deviceName}", track: ${trackLabel}, pos: ${pos}\n  Reason: ${e instanceof Error ? e.message : String(e)}`);
        return true; // failed
      }

    } else if (msg.action === "delete" && msg.deviceIndex !== undefined) {
      const device = track.devices[msg.deviceIndex];
      if (!device) {
        console.error(`[Plugin Mixer] delete FAILED — no device at index ${msg.deviceIndex} on ${trackLabel} (track has ${track.devices.length} devices)`);
        return true;
      }
      console.log(`[Plugin Mixer] delete "${device.name}" [${msg.deviceIndex}] on ${trackLabel}`);
      try {
        await track.deleteDevice(device);
        return false;
      } catch (e) {
        console.error(`[Plugin Mixer] delete FAILED — device: "${device.name}", track: ${trackLabel}\n  Reason: ${e instanceof Error ? e.message : String(e)}`);
        return true;
      }

    } else if (msg.action === "duplicate" && msg.deviceIndex !== undefined) {
      const device = track.devices[msg.deviceIndex];
      if (!device) {
        console.error(`[Plugin Mixer] duplicate FAILED — no device at index ${msg.deviceIndex} on ${trackLabel} (track has ${track.devices.length} devices)`);
        return true;
      }
      console.log(`[Plugin Mixer] duplicate "${device.name}" [${msg.deviceIndex}] on ${trackLabel}`);
      try {
        await track.duplicateDevice(device);
        return false;
      } catch (e) {
        console.error(`[Plugin Mixer] duplicate FAILED — device: "${device.name}", track: ${trackLabel}\n  Reason: ${e instanceof Error ? e.message : String(e)}`);
        return true;
      }

    } else if (msg.action === "copy" && msg.toTrackIndex !== undefined && msg.deviceIndex !== undefined) {
      const device = track.devices[msg.deviceIndex];
      if (!device) {
        console.error(`[Plugin Mixer] copy FAILED — no device at index ${msg.deviceIndex} on ${trackLabel}`);
        return true;
      }
      const toTrack = tracks[msg.toTrackIndex];
      if (!toTrack) {
        console.error(`[Plugin Mixer] copy FAILED — no target track at index ${msg.toTrackIndex}`);
        return true;
      }
      const toPos = msg.toPosition ?? toTrack.devices.length;
      const toLabel = `"${toTrack.name}" [${msg.toTrackIndex}]`;

      // ── Bridge path: clipboard copy (preserves VSTs, racks, full preset) ──
      if (bridgeAvailable) {
        console.log(`[Plugin Mixer] copy "${device.name}" via bridge: ${trackLabel} → ${toLabel}`);
        try {
          const result = await callBridge("/copy-device", {
            fromTrack: msg.trackIndex,
            fromDevice: msg.deviceIndex,
            toTrack: msg.toTrackIndex,
            toPosition: toPos,
            deleteSource: msg.deleteSource ?? false,
          });
          if (result["success"]) {
            console.log(`[Plugin Mixer] copy OK via bridge (method: ${result["method"]})`);
            return false;
          }
          console.warn(`[Plugin Mixer] bridge copy failed (${result["error"]}), falling back to param transfer`);
        } catch (e) {
          console.warn(`[Plugin Mixer] bridge unreachable, falling back: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // ── SDK fallback: parameter-by-parameter transfer (built-in devices only) ──
      console.log(`[Plugin Mixer] copy "${device.name}" via param transfer: ${trackLabel} → ${toLabel} pos ${toPos} (${device.parameters.length} params)`);

      const paramValues: number[] = [];
      for (const param of device.parameters) {
        try { paramValues.push(await param.getValue()); }
        catch { paramValues.push(NaN); }
      }

      let newDevice;
      try {
        newDevice = await toTrack.insertDevice(device.name, toPos);
      } catch (e) {
        console.error(`[Plugin Mixer] copy insert FAILED — "${device.name}" → ${toLabel}\n  Reason: ${e instanceof Error ? e.message : String(e)}`);
        return true;
      }

      let transferred = 0;
      for (let pi = 0; pi < Math.min(paramValues.length, newDevice.parameters.length); pi++) {
        const val = paramValues[pi];
        const param = newDevice.parameters[pi];
        if (val !== undefined && !isNaN(val) && param !== undefined) {
          try { await param.setValue(val); transferred++; }
          catch { /* read-only param, skip */ }
        }
      }
      console.log(`[Plugin Mixer] param transfer: ${transferred}/${paramValues.length} params → ${toLabel}`);

      if (msg.deleteSource) {
        try { await track.deleteDevice(device); }
        catch (e) { console.error(`[Plugin Mixer] move-delete FAILED — ${trackLabel}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      return false;

    } else if (msg.action === "move" && msg.toTrackIndex !== undefined && msg.deviceIndex !== undefined) {
      const device = track.devices[msg.deviceIndex];
      if (!device) {
        console.error(`[Plugin Mixer] move FAILED — no device at index ${msg.deviceIndex} on ${trackLabel}`);
        return true;
      }
      const toTrack = tracks[msg.toTrackIndex];
      if (!toTrack) {
        console.error(`[Plugin Mixer] move FAILED — no target track at index ${msg.toTrackIndex}`);
        return true;
      }
      const toPos = msg.toPosition ?? toTrack.devices.length;
      const toLabel = `"${toTrack.name}" [${msg.toTrackIndex}]`;
      console.log(`[Plugin Mixer] move "${device.name}" from ${trackLabel} → ${toLabel} pos ${toPos}`);
      try {
        await toTrack.insertDevice(device.name, toPos);
      } catch (e) {
        console.error(`[Plugin Mixer] move insert FAILED — device: "${device.name}", target: ${toLabel}\n  Reason: ${e instanceof Error ? e.message : String(e)}`);
        return true;
      }
      try {
        await track.deleteDevice(device);
        return false;
      } catch (e) {
        console.error(`[Plugin Mixer] move delete FAILED — device: "${device.name}", source: ${trackLabel}\n  Reason: ${e instanceof Error ? e.message : String(e)}`);
        return true;
      }
    }
    return false;
  }

  context.commands.registerCommand(
    "pluginmixer.open",
    () => void openMixer().catch(console.error),
  );

  void Promise.all([
    context.ui.registerContextMenuAction("AudioTrack", "Plugin Mixer", "pluginmixer.open"),
    context.ui.registerContextMenuAction("MidiTrack", "Plugin Mixer", "pluginmixer.open"),
  ]).then(() => {
    console.log("[Plugin Mixer] Ready.");
  }).catch(console.error);
}
