// Generates Android launcher icons and splash screens from the QuickGrade logo.
// Run: node scripts/android-icons.mjs   (after `npx cap add android`)
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const res = 'android/app/src/main/res';
const full = fs.readFileSync('web/public/icon.svg');
// Adaptive-icon foreground: the bubbles only, kept inside the 66 % safe zone of a 108-unit canvas.
const glyph = (size) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="${size}" height="${size}">
  <g transform="translate(22 22)">
    <circle cx="20" cy="20" r="11" fill="none" stroke="#bfdbfe" stroke-width="3.6"/>
    <circle cx="44" cy="20" r="11" fill="#ffffff"/>
    <circle cx="20" cy="44" r="11" fill="none" stroke="#bfdbfe" stroke-width="3.6"/>
    <circle cx="44" cy="44" r="11" fill="none" stroke="#bfdbfe" stroke-width="3.6"/>
    <path d="M38.5 20.5l4 4 7.5-8" fill="none" stroke="#1e40af" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/>
  </g></svg>`);

const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, px] of Object.entries(densities)) {
  const dir = path.join(res, `mipmap-${d}`);
  await sharp(full, { density: 600 }).resize(px, px).png().toFile(path.join(dir, 'ic_launcher.png'));
  const round = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}"><circle cx="${px / 2}" cy="${px / 2}" r="${px / 2}" fill="#fff"/></svg>`);
  await sharp(full, { density: 600 }).resize(px, px).composite([{ input: round, blend: 'dest-in' }]).png().toFile(path.join(dir, 'ic_launcher_round.png'));
  const fg = Math.round((px * 108) / 48);
  await sharp(glyph(fg), { density: 300 }).resize(fg, fg).png().toFile(path.join(dir, 'ic_launcher_foreground.png'));
}
fs.writeFileSync(
  path.join(res, 'values/ic_launcher_background.xml'),
  '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#1E40AF</color>\n</resources>\n',
);

// Splash screens: logo centred on the app background, keeping each file's existing size.
for (const dir of fs.readdirSync(res).filter((d) => d.startsWith('drawable'))) {
  const file = path.join(res, dir, 'splash.png');
  if (!fs.existsSync(file)) continue;
  const { width, height } = await sharp(file).metadata();
  const logo = Math.round(Math.min(width, height) * 0.28);
  const icon = await sharp(full, { density: 600 }).resize(logo, logo).png().toBuffer();
  await sharp({ create: { width, height, channels: 4, background: '#f5f6f8' } })
    .composite([{ input: icon, gravity: 'center' }])
    .png()
    .toFile(file + '.tmp');
  fs.renameSync(file + '.tmp', file);
}
console.log('Android icons and splash screens generated.');
