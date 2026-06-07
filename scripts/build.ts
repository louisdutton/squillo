import { mkdir, rm, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const dist = new URL("dist/", root);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const result = await Bun.build({
  entrypoints: [new URL("src/main.ts", root).pathname],
  outdir: dist.pathname,
  target: "browser",
  format: "esm",
  minify: true,
  naming: "app.js",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const html = await Bun.file(new URL("index.html", root)).text();
const productionHtml = html.replace("/styles.css", "./styles.css").replace("/app.js", "./app.js");
await writeFile(new URL("index.html", dist), productionHtml);
await writeFile(new URL("styles.css", dist), await Bun.file(new URL("src/styles.css", root)).text());

console.log("Built dist/");
