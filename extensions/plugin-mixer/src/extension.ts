import type { ArrangementSelection, ClipSlotSelection } from "@ableton-extensions/sdk";
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
  devices: { name: string; index: number }[];
}

interface MixerAction {
  action: "insert" | "insert_all" | "delete" | "duplicate";
  trackIndex?: number;
  deviceName?: string;
  deviceIndex?: number;
  position?: number;
}

async function getTrackData(track: AnyTrack, index: number): Promise<TrackData> {
  return {
    index,
    name: track.name,
    devices: track.devices.map((d, i) => ({ name: d.name, index: i })),
  };
}

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  async function openMixer(tracks: AnyTrack[]) {
    const trackData = await Promise.all(tracks.map((t, i) => getTrackData(t, i)));

    // Inline the HTML with data injected
    const uiPath = path.resolve(process.cwd(), "dist", "ui", "index.html");
    let html = fs.readFileSync(uiPath, "utf8");
    html = html
      .replace('"__TRACKS_DATA__"', JSON.stringify(trackData))
      .replace('"__DEVICES_DATA__"', JSON.stringify(BUILTIN_DEVICES));

    const dataUrl = `data:text/html,${encodeURIComponent(html)}`;

    let resultJson: string;
    try {
      resultJson = await context.ui.showModalDialog(dataUrl, 900, 500);
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
    if (msg.action === "insert_all" && msg.deviceName) {
      const name = msg.deviceName;
      const promises = context.withinTransaction(() =>
        tracks.map((track) => track.insertDevice(name, track.devices.length)),
      );
      await Promise.all(promises);
    } else if (msg.action === "insert" && msg.trackIndex !== undefined && msg.deviceName) {
      const track = tracks[msg.trackIndex];
      if (!track) return;
      await track.insertDevice(msg.deviceName, msg.position ?? track.devices.length);
    } else if (msg.action === "delete" && msg.trackIndex !== undefined && msg.deviceIndex !== undefined) {
      const track = tracks[msg.trackIndex];
      if (!track) return;
      const device = track.devices[msg.deviceIndex];
      if (!device) return;
      await track.deleteDevice(device);
    } else if (msg.action === "duplicate" && msg.trackIndex !== undefined && msg.deviceIndex !== undefined) {
      const track = tracks[msg.trackIndex];
      if (!track) return;
      const device = track.devices[msg.deviceIndex];
      if (!device) return;
      await track.duplicateDevice(device);
    }
  }

  // ── Audio track selection (arrangement) ──────────────────────────────────
  context.commands.registerCommand(
    "pluginmixer.openAudio",
    (arg: unknown) =>
      void (async (selection: ArrangementSelection) => {
        const tracks = selection.selected_lanes
          .map((h) => context.getObjectFromHandle(h, DataModelObject))
          .filter((o): o is AudioTrack<"1.0.0"> => o instanceof AudioTrack);
        if (!tracks.length) return;
        await openMixer(tracks);
      })(arg as ArrangementSelection).catch(console.error),
  );

  context.ui.registerContextMenuAction(
    "AudioTrack.ArrangementSelection",
    "Plugin Mixer",
    "pluginmixer.openAudio",
  );

  // ── MIDI track selection (arrangement) ───────────────────────────────────
  context.commands.registerCommand(
    "pluginmixer.openMidi",
    (arg: unknown) =>
      void (async (selection: ArrangementSelection) => {
        const tracks = selection.selected_lanes
          .map((h) => context.getObjectFromHandle(h, DataModelObject))
          .filter((o): o is MidiTrack<"1.0.0"> => o instanceof MidiTrack);
        if (!tracks.length) return;
        await openMixer(tracks);
      })(arg as ArrangementSelection).catch(console.error),
  );

  context.ui.registerContextMenuAction(
    "MidiTrack.ArrangementSelection",
    "Plugin Mixer",
    "pluginmixer.openMidi",
  );

  // ── Clip slot selection (session view) ───────────────────────────────────
  context.commands.registerCommand(
    "pluginmixer.openClipSlot",
    (arg: unknown) =>
      void (async (selection: ClipSlotSelection) => {
        // Deduplicate tracks from clip slot handles
        const seen = new Set<unknown>();
        const tracks: AnyTrack[] = [];
        for (const handle of selection.selected_clip_slots) {
          const obj = context.getObjectFromHandle(handle, DataModelObject);
          if (seen.has(obj)) continue;
          seen.add(obj);
          // ClipSlot's parent track is resolved via the object's track property
          const trackObj = (obj as unknown as { track?: unknown }).track;
          if (!trackObj) continue;
          const track = context.getObjectFromHandle(
            trackObj as Parameters<typeof context.getObjectFromHandle>[0],
            DataModelObject,
          );
          if (track instanceof AudioTrack || track instanceof MidiTrack) {
            tracks.push(track as AnyTrack);
          }
        }
        if (!tracks.length) return;
        await openMixer(tracks);
      })(arg as ClipSlotSelection).catch(console.error),
  );

  context.ui.registerContextMenuAction(
    "ClipSlotSelection",
    "Plugin Mixer",
    "pluginmixer.openClipSlot",
  );
}
