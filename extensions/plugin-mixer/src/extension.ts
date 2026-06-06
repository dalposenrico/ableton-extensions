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
  devices: { name: string; index: number }[];
}

interface MixerAction {
  action: "insert" | "delete" | "duplicate";
  trackIndex: number;
  deviceName?: string;
  deviceIndex?: number;
  position?: number;
}

function getAllTracks(context: ReturnType<typeof initialize>): AnyTrack[] {
  const song = context.application.song;
  if (!song) return [];
  return song.tracks.filter(
    (t): t is AnyTrack => t instanceof AudioTrack || t instanceof MidiTrack,
  );
}

function getTrackData(track: AnyTrack, index: number): TrackData {
  return {
    index,
    name: track.name,
    type: track instanceof AudioTrack ? "audio" : "midi",
    devices: track.devices.map((d, i) => ({ name: d.name, index: i })),
  };
}

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  async function openMixer() {
    const tracks = getAllTracks(context);
    if (!tracks.length) {
      console.log("[Plugin Mixer] No tracks found in song.");
      return;
    }

    const trackData = tracks.map((t, i) => getTrackData(t, i));
    console.log(`[Plugin Mixer] Opening with ${tracks.length} tracks`);

    // __dirname is CJS global — points to dist/ folder where extension.js lives
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
      resultJson = await context.ui.showModalDialog(dataUrl, 1100, 600);
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

    for (const msg of actions) {
      await handleAction(msg, tracks);
    }
  }

  async function handleAction(msg: MixerAction, tracks: AnyTrack[]) {
    const track = tracks[msg.trackIndex];
    if (!track) return;

    if (msg.action === "insert" && msg.deviceName) {
      const pos = msg.position ?? track.devices.length;
      await track.insertDevice(msg.deviceName, pos);
    } else if (msg.action === "delete" && msg.deviceIndex !== undefined) {
      const device = track.devices[msg.deviceIndex];
      if (device) await track.deleteDevice(device);
    } else if (msg.action === "duplicate" && msg.deviceIndex !== undefined) {
      const device = track.devices[msg.deviceIndex];
      if (device) await track.duplicateDevice(device);
    }
  }

  // ── Register on AudioTrack right-click ───────────────────────────────────
  context.commands.registerCommand(
    "pluginmixer.open",
    () => void openMixer().catch(console.error),
  );

  context.ui.registerContextMenuAction(
    "AudioTrack",
    "Plugin Mixer",
    "pluginmixer.open",
  );

  context.ui.registerContextMenuAction(
    "MidiTrack",
    "Plugin Mixer",
    "pluginmixer.open",
  );
}
