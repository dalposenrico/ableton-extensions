import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const production = process.argv.includes("--production");

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcesContent: false,
  logLevel: "info",
  minify: production,
  sourcemap: !production,
});

// Copy UI folder into dist so the extension can resolve it at runtime
const uiSrc = path.resolve("ui");
const uiDst = path.resolve("dist", "ui");
fs.mkdirSync(uiDst, { recursive: true });
for (const file of fs.readdirSync(uiSrc)) {
  fs.copyFileSync(path.join(uiSrc, file), path.join(uiDst, file));
}
console.log("Copied ui/ → dist/ui/");
