const port = Number(process.env.PORT ?? 3000);
const root = new URL("../", import.meta.url);

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return file("index.html", "text/html; charset=utf-8");
    }

    if (url.pathname === "/styles.css") {
      return file("src/styles.css", "text/css; charset=utf-8");
    }

    if (url.pathname === "/app.js") {
      const result = await Bun.build({
        entrypoints: [new URL("src/main.ts", root).pathname],
        target: "browser",
        format: "esm",
        sourcemap: "inline",
        minify: false,
      });

      if (!result.success) {
        return new Response(result.logs.map(String).join("\n"), { status: 500 });
      }

      return new Response(await result.outputs[0].text(), {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Squillo dev server listening on http://localhost:${port}`);

function file(path: string, contentType: string): Response {
  return new Response(Bun.file(new URL(path, root)), {
    headers: { "content-type": contentType },
  });
}

