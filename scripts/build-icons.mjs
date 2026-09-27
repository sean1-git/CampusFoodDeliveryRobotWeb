/** Generate browser, header and installed-app icons from the supplied artwork. */
import sharp from "sharp";
const source = "assets/app-logo.png";
for (const [name, size] of [["icon-192.png",192], ["icon-512.png",512],
  ["apple-touch-icon.png",180], ["favicon.png",48], ["app-logo.png",120]]) {
  await sharp(source).resize(size,size,{fit:"contain"}).png().toFile("public/"+name);
}
// Keep the complete artwork inside the central safe circle for launcher masks.
const artwork = await sharp(source).resize(280,280).png().toBuffer();
await sharp({create:{width:512,height:512,channels:4,background:"#062b60"}})
  .composite([{input:artwork,gravity:"centre"}]).png().toFile("public/icon-maskable-512.png");
console.log("Generated bobcat browser, header, Apple and PWA icons.");
