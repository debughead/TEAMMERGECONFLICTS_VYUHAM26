// Tiny static server for the demo sites (port 8080). Also serves /samples and, for automated runs,
// accepts POST /__result (written to demo-sites/.last-result.json).
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const roots = { "/samples/": join(here, "..", "samples") };
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "POST" && url.pathname === "/__trace") {
    let body = "";
    for await (const c of req) body += c;
    await writeFile(join(here, ".trace.log"), body + "\n", { flag: "a" });
    res.writeHead(204).end();
    return;
  }
  if (req.method === "POST" && url.pathname === "/__result") {
    let body = "";
    for await (const c of req) body += c;
    await writeFile(join(here, ".last-result.json"), body);
    res.writeHead(204).end();
    return;
  }
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith("/")) path += "index.html";
  const [prefix, dir] = Object.entries(roots).find(([p]) => path.startsWith(p)) ?? ["/", here];
  const file = normalize(join(dir, path.slice(prefix.length)));
  if (!file.startsWith(normalize(dir))) return res.writeHead(403).end();
  let body;
  try {
    body = await readFile(file);
  } catch {
    return res.writeHead(404).end("not found");
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
}).listen(8080, () => console.log("demo sites: http://localhost:8080/job-portal/  http://localhost:8080/bank-kyc/"));
