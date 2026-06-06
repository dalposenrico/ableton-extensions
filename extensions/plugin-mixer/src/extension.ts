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
  action: "insert" | "delete" | "duplicate" | "move";
  trackIndex: number;
  deviceName?: string;
  deviceIndex?: number;
  position?: number;
  toTrackIndex?: number;
  toPosition?: number;
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

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  async function openMixer() {
    const tracks = getAllTracks(context);
    if (!tracks.length) {
      console.log("[Plugin Mixer] No tracks found.");
      return;
    }

    const trackData = buildTrackData(tracks);
    console.log(`[Plugin Mixer] Opening with ${tracks.length} tracks`);

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

    for (const msg of actions) {
      await handleAction(msg, tracks);
    }
  }

  async function handleAction(msg: MixerAction, tracks: AnyTrack[]) {
    const track = tracks[msg.trackIndex];
    if (!track) return;

    if (msg.action === "insert" && msg.deviceName !== undefined) {
      const pos = msg.position ?? track.devices.length;
      await track.insertDevice(msg.deviceName, pos);

    } else if (msg.action === "delete" && msg.deviceIndex !== undefined) {
      const device = track.devices[msg.deviceIndex];
      if (device) await track.deleteDevice(device);

    } else if (msg.action === "duplicate" && msg.deviceIndex !== undefined) {
      const device = track.devices[msg.deviceIndex];
      if (device) await track.duplicateDevice(device);

    } else if (msg.action === "move" && msg.toTrackIndex !== undefined && msg.deviceIndex !== undefined) {
      // Move = insert same device name on target, then delete from source
      // (SDK can't physically move a device cross-track, so we re-insert by name)
      const device = track.devices[msg.deviceIndex];
      if (!device) return;
      const toTrack = tracks[msg.toTrackIndex];
      if (!toTrack) return;
      const toPos = msg.toPosition ?? toTrack.devices.length;
      await toTrack.insertDevice(device.name, toPos);
      await track.deleteDevice(device);
    }
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
