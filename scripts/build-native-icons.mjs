import sharp from "sharp";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const source = "assets/app-logo.png";
const background = "#062b60";
async function padded(size, artworkSize, destination) {
  const image = await sharp(source).resize(artworkSize, artworkSize).toBuffer();
  await sharp({ create: { width: size, height: size, channels: 3, background } })
    .composite([{ input: image, gravity: "centre" }]).png().toFile(destination);
}
const android = "android/app/src/main/res";
if (existsSync(android)) {
  for (const [density, scale] of [["mdpi",1],["hdpi",1.5],["xhdpi",2],["xxhdpi",3],["xxxhdpi",4]]) {
    const dir = join(android, `mipmap-${density}`);
    for (const name of ["ic_launcher.png", "ic_launcher_round.png"])
      await padded(48 * scale, 34 * scale, join(dir, name));
    // Adaptive launchers mask the foreground; keep artwork in its safe center.
    await padded(108 * scale, 54 * scale, join(dir, "ic_launcher_foreground.png"));
  }
  writeFileSync(join(android, "values/ic_launcher_background.xml"),
    `<?xml version="1.0" encoding="utf-8"?><resources><color name="ic_launcher_background">${background}</color></resources>\n`);
}
const ios = "ios/App/App/Assets.xcassets";
if (existsSync(ios)) await sharp(source).resize(1024,1024).flatten({ background })
  .removeAlpha().png().toFile(join(ios, "AppIcon.appiconset/AppIcon-512@2x.png"));

// Preserve the generated splash dimensions while replacing template artwork.
for (const root of [android, ios]) {
  if (!existsSync(root)) continue;
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/^splash.*\.png$/.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    const { width, height } = await sharp(path).metadata();
    const image = await sharp(source).resize(Math.round(Math.min(width,height)*0.3)).toBuffer();
    const result = await sharp({ create: { width, height, channels: 3, background } })
      .composite([{ input: image, gravity: "centre" }]).png().toBuffer();
    writeFileSync(path, result);
  }
}
console.log("Generated native bobcat launcher icons and splash screens.");
