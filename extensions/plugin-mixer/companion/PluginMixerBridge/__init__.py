"""
Plugin Mixer Bridge — Ableton Live MIDI Remote Script
======================================================
Runs a local HTTP server on localhost:8765 that the Plugin Mixer extension
connects to for enhanced device copy/paste with full preset preservation,
including third-party VSTs/AUs (via clipboard) and rack chain support.

Installation (handled by `npm run setup`):
  Copy the PluginMixerBridge/ folder to your MIDI Remote Scripts directory,
  then select "PluginMixerBridge" in Live's Preferences > Link / MIDI > Control Surface.
"""

import Live
import threading
import json
import subprocess
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = 8765
BRIDGE_VERSION = "1.0.0"


# ── HTTP Handler ─────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    controller = None  # set by PluginMixerBridge.__init__

    def log_message(self, fmt, *args):
        pass  # silence HTTP access logs

    def send_json(self, code, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        if self.path == "/ping":
            self.send_json(200, {"status": "ok", "version": BRIDGE_VERSION, "platform": sys.platform})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        try:
            body = self.read_body()
            c = self.controller

            if self.path == "/get-device-info":
                self.send_json(200, c.get_device_info(body["trackIndex"], body["deviceIndex"]))

            elif self.path == "/copy-device":
                # Copy a device to one target track, preserving full preset
                # On macOS: uses clipboard (works for VSTs too)
                # On Windows: falls back to parameter transfer
                result = c.copy_device(
                    from_track=body["fromTrack"],
                    from_device=body["fromDevice"],
                    to_track=body["toTrack"],
                    to_position=body.get("toPosition", -1),
                    delete_source=body.get("deleteSource", False),
                )
                self.send_json(200, result)

            else:
                self.send_json(404, {"error": "unknown endpoint"})

        except Exception as e:
            self.send_json(500, {"error": str(e)})


# ── Main bridge class ─────────────────────────────────────────────────────────

class PluginMixerBridge:

    def __init__(self, c_instance):
        self._c = c_instance
        Handler.controller = self
        self._server = HTTPServer(("127.0.0.1", PORT), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        self._log("Bridge v{} ready on localhost:{}".format(BRIDGE_VERSION, PORT))

    def _log(self, msg):
        self._c.log_message("[PluginMixerBridge] " + str(msg))

    def _show(self, msg):
        self._c.show_message("[Plugin Mixer] " + str(msg))

    def song(self):
        return self._c.song()

    def disconnect(self):
        self._server.shutdown()
        self._log("Bridge stopped.")

    # ── Device info ──────────────────────────────────────────────────────────

    def get_device_info(self, track_idx, device_idx):
        try:
            track = self.song().tracks[track_idx]
            device = track.devices[device_idx]
            params = {}
            for p in device.parameters:
                try:
                    params[p.name] = {"value": p.value, "min": p.min, "max": p.max}
                except Exception:
                    pass
            chains = []
            if device.can_have_chains:
                for chain in device.chains:
                    chain_devs = []
                    for dev in chain.devices:
                        chain_devs.append({
                            "name": dev.name,
                            "class_name": dev.class_name,
                            "params": {p.name: p.value for p in dev.parameters},
                        })
                    chains.append({"name": chain.name, "devices": chain_devs})
            return {
                "name": device.name,
                "class_name": device.class_name,
                "can_have_chains": device.can_have_chains,
                "params": params,
                "chains": chains,
            }
        except Exception as e:
            return {"error": str(e)}

    # ── Copy device ───────────────────────────────────────────────────────────

    def copy_device(self, from_track, from_device, to_track, to_position, delete_source):
        """
        Copy a device to another track, preserving its preset.
        On macOS: uses clipboard (Cmd+C / Cmd+V) — works for VSTs and racks.
        On other platforms: uses parameter-value transfer (built-in devices only).
        If delete_source=True, the source device is deleted after copy (move).
        """
        if sys.platform == "darwin":
            return self._copy_via_clipboard(from_track, from_device, to_track, delete_source)
        else:
            return self._copy_via_params(from_track, from_device, to_track, to_position, delete_source)

    def _copy_via_clipboard(self, from_track_idx, from_device_idx, to_track_idx, delete_source):
        """macOS: select source device → Cmd+C → select target track → Cmd+V"""
        try:
            song = self.song()
            from_track = song.tracks[from_track_idx]
            from_device = from_track.devices[from_device_idx]
            to_track = song.tracks[to_track_idx]

            # Select source device in Live's UI
            song.view.selected_track = from_track
            song.view.select_device(from_device)
            time.sleep(0.15)

            # Copy to clipboard
            subprocess.call([
                "osascript", "-e",
                'tell application "System Events" to keystroke "c" using command down'
            ])
            time.sleep(0.15)

            # Select target track and paste
            song.view.selected_track = to_track
            time.sleep(0.15)
            subprocess.call([
                "osascript", "-e",
                'tell application "System Events" to keystroke "v" using command down'
            ])
            time.sleep(0.2)

            # Delete source if this is a move operation
            if delete_source:
                # Re-grab device since paste may have shifted indices
                from_device_ref = from_track.devices[from_device_idx]
                from_track.delete_device(from_device_ref)  # Note: Python API uses delete_device

            self._log("Clipboard copy: {} → track {}".format(from_device.name, to_track_idx))
            return {"success": True, "method": "clipboard"}

        except Exception as e:
            self._log("Clipboard copy failed: " + str(e))
            return {"success": False, "error": str(e)}

    def _copy_via_params(self, from_track_idx, from_device_idx, to_track_idx, to_position, delete_source):
        """
        Fallback: read parameter values from source, insert new device, apply values.
        Works for built-in Ableton devices only (same limitation as JS SDK).
        """
        try:
            song = self.song()
            from_track = song.tracks[from_track_idx]
            from_device = from_track.devices[from_device_idx]
            to_track = song.tracks[to_track_idx]

            # Snapshot all parameter values synchronously (much faster than JS SDK async calls)
            param_values = {}
            for p in from_device.parameters:
                try:
                    param_values[p.name] = p.value
                except Exception:
                    pass

            # We can't insert by name from Python — signal back to JS to handle insert
            # Then JS will call us back to apply params
            return {
                "success": True,
                "method": "params",
                "deviceName": from_device.name,
                "params": param_values,
                "toPosition": to_position,
            }

        except Exception as e:
            return {"success": False, "error": str(e)}


# ── Entry point required by Ableton ──────────────────────────────────────────

def create_instance(c_instance):
    return PluginMixerBridge(c_instance)
