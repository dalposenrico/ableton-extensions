# Ableton Extensions

A collection of custom Ableton Live extensions built with the [Extensions SDK](https://ableton.github.io/extensions-sdk/).

> Requires Live 12.4.5b3 (public beta) and Node.js 23+.

## Extensions

| Extension | Description |
|-----------|-------------|
| *(coming soon)* | |

## Setup

Each extension lives in its own folder under `extensions/`. To run one:

```bash
cd extensions/<name>
npm install
npm start
```

Make sure Live 12.4.5b3 is open before running.

## Dev notes

- Each extension needs a `.env` file with:
  ```
  EXTENSION_HOST_PATH=/Applications/Ableton Live 12 Beta.app
  ```
- The SDK packages are referenced locally from `~/Dev/extensions-sdk-1.0.0-beta.0/`
