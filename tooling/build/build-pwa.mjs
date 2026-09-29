/**
 * Runs after the client build to generate dist/client/sw.js.
 * Uses a content hash to version the static-file cache; API requests bypass that cache.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, relative } from "node:path";
const root = resolve("dist/client");
const files = readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map(
    (entry) =>
      "/" +
      relative(root, resolve(entry.parentPath, entry.name)).replaceAll(
        "\\",
        "/",
      ),
  )
  .filter((path) => path !== "/sw.js" && !path.endsWith(".map"));
const hash = createHash("sha256");
for (const path of files.sort())
  hash.update(readFileSync(resolve(root, "." + path)));
const cache = "campus-shell-" + hash.digest("hex").slice(0, 12);
// Worker lifecycle: precache files on install, wait for an explicit update,
// then delete old app caches. Page loads try the network before the cached shell.
const worker = `const CACHE=${JSON.stringify(cache)};
const FILES=${JSON.stringify(files)};
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES))));
self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')self.skipWaiting()});
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('campus-shell-')&&key!==CACHE).map(key=>caches.delete(key))))));
self.addEventListener('fetch',event=>{
 const req=event.request; const url=new URL(req.url);
 if(req.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
 if(req.mode==='navigate'){
  event.respondWith(fetch(req).catch(()=>caches.open(CACHE).then(cache=>cache.match('/index.html')).then(cached=>cached||new Response('Reconnect to open Campus Store.',{status:503}))));return;
 }
 if(FILES.includes(url.pathname))event.respondWith(caches.open(CACHE).then(cache=>cache.match(url.pathname)).then(cached=>cached||fetch(req)));
});`;
writeFileSync(resolve(root, "sw.js"), worker);
console.log(
  `PWA: ${files.length} static assets in ${cache}; API responses are never cached.`,
);
