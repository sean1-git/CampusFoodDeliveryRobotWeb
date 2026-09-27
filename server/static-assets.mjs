import { existsSync, readFileSync } from "node:fs";

// Honor explicit q=0 exclusions and prefer Brotli when quality values tie.
export function acceptedEncodings(header = "") {
  const qualities = new Map(header.toLowerCase().split(",").map(part => {
    const [name, ...parameters] = part.trim().split(";");
    const parameter = parameters.find(value => value.trim().startsWith("q="));
    const quality = parameter ? Number(parameter.trim().slice(2)) : 1;
    return [name, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0];
  }));
  return ["br", "gzip"].map(name => ({ name, quality: qualities.get(name) ?? qualities.get("*") ?? 0 }))
    .filter(value => value.quality > 0).sort((a, b) => b.quality - a.quality).map(value => value.name);
}
export function staticBody(file, acceptEncoding, headers) {
  headers.Vary = "Accept-Encoding";
  for (const encoding of acceptedEncodings(acceptEncoding)) {
    const compressed = file + (encoding === "br" ? ".br" : ".gz");
    if (!existsSync(compressed)) continue;
    headers["Content-Encoding"] = encoding;
    return readFileSync(compressed);
  }
  return readFileSync(file);
}
