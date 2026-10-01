/**
 * Runs after the client build to generate dist/client/sw.js.
 * Uses a content hash to version the static-file cache; API requests bypass that cache.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
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
  .filter((path) => path !== "/sw.js" && !/\.(map|br|gz)$/.test(path));
const sizes = Object.fromEntries(files.map(path => [path, statSync(resolve(root, "." + path)).size]));
const essential = files.filter(path => /\.(js|css|webmanifest|svg)$/.test(path)
  || ["/index.html", "/icon-192.png", "/app-logo.png", "/uc-merced-campus.jpg"].includes(path));
const shellBytes = essential.reduce((total, path) => total + sizes[path], 0);
if (shellBytes > 2 * 1024 * 1024) throw new Error("Offline shell exceeds its 2 MiB budget. Split or reduce assets before release.");
const optional = Object.fromEntries(files.filter(path => !essential.includes(path) && sizes[path] <= 512 * 1024)
  .map(path => [path, sizes[path]]));
const hash = createHash("sha256");
for (const path of files.sort())
  hash.update(readFileSync(resolve(root, "." + path)));
const cache = "campus-shell-" + hash.digest("hex").slice(0, 12);
// Cache only a budgeted shell up front. Photos are cached when actually viewed.
// No API payloads, external map tiles or unbounded runtime URLs enter these caches.
const worker = `const CACHE=${JSON.stringify(cache)};
const FILES=${JSON.stringify(essential)};
const OPTIONAL=${JSON.stringify(optional)};
const MEDIA=CACHE+'-media';
let writes=Promise.resolve();
const match=async(name,path)=>{try{return await (await caches.open(name)).match(path)}catch{return undefined}};
self.addEventListener('install',event=>event.waitUntil((async()=>{
 try {
  const cache=await caches.open(CACHE);
  for(const path of FILES) {
   try { await cache.add(path); } catch(error) {
    if(error?.name==='QuotaExceededError') break;
    // Partial connectivity must not make an online-only installation unusable.
   }
  }
 } catch { /* Storage can be denied in private or low-storage environments. */ }
})()));
self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')self.skipWaiting()});
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('campus-shell-')&&key!==CACHE&&key!==MEDIA).map(key=>caches.delete(key)))).catch(()=>{})));
async function remember(path,response) {
 if(!response.ok || response.type==='opaque') return;
 try {
  if((await response.clone().blob()).size>OPTIONAL[path]) return;
  const cache=await caches.open(MEDIA);
  await cache.delete(path);
  const keys=await cache.keys();
  let bytes=keys.reduce((total,key)=>total+(OPTIONAL[new URL(key.url).pathname]||0),0);
  while(keys.length && (keys.length>=12 || bytes+OPTIONAL[path]>2*1024*1024)) {
   const oldest=keys.shift(); bytes-=OPTIONAL[new URL(oldest.url).pathname]||0;
   await cache.delete(oldest);
  }
  await cache.put(path,response);
 } catch { /* Cache failures must never hide a successfully downloaded image. */ }
}
self.addEventListener('fetch',event=>{
 const req=event.request; const url=new URL(req.url);
 if(req.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
 if(req.mode==='navigate'){
  // This worker and its HTML share a build hash; explicit activation updates both.
  event.respondWith(match(CACHE,'/index.html').then(cached=>cached||fetch(req).catch(()=>new Response('Reconnect to open Campus Store.',{status:503}))));return;
 }
 if(FILES.includes(url.pathname))event.respondWith(match(CACHE,url.pathname).then(cached=>cached||fetch(req)));
 else if(Object.hasOwn(OPTIONAL,url.pathname)) {
  let downloaded=false;
  const response=match(MEDIA,url.pathname).then(cached=>cached||fetch(req).then(result=>{downloaded=true;return result}));
  event.respondWith(response);
  event.waitUntil(response.then(result=>{if(!downloaded)return;const copy=result.clone(); writes=writes.then(()=>remember(url.pathname,copy)).catch(()=>{}); return writes;}).catch(()=>{}));
 }
});`;
writeFileSync(resolve(root, "sw.js"), worker);
console.log(
  `PWA: ${essential.length} shell assets, ${shellBytes} bytes (2 MiB cap); optional images cached on demand (12 entries / 2 MiB). APIs and external maps never cached.`,
);
