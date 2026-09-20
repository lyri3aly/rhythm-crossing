# Rhythm Crossing

<img width="909" height="454" alt="image" src="https://github.com/user-attachments/assets/deb1248f-deec-4a2a-88ac-c4da40cb1c0f" />

This project was inspired by the VR game Beat Saber! Requires two devices: your phone and a laptop. Use your phone to scan the QR code that comes up when you press play!

<img width="307" height="451" alt="image" src="https://github.com/user-attachments/assets/ba9e6982-fc8c-47eb-ad4b-bb484d4bdcd0" />

QR Code EXAMPLE

Use your phone as a controller for a block-slicing rhythm game on your computer. After calibration, select a song and swing your phone to slice blocks in time with the music.

<img width="905" height="449" alt="image" src="https://github.com/user-attachments/assets/44046a91-fecf-4f7e-90fa-54720588f924" />

gameplay example

## access the live server web link at https://rhythm-crossing.onrender.com/

### alternatively, download the latest release (v1), unzip the files, and open the game's folder in your code editor. find instructions for downloading and using a local version after the features section.

## features:
- time your movements to the beat while navigating the level
- uses `DeviceMotion` and `DeviceOrientation` APIs for smartphone controls
- converts physical device movement into in-game input
- physically move your device to control your character
- no installation required
- designed around smartphone motion sensors
- combines music, timing, and physical interaction
- publicly accessible through Render
- fun!

## Quick start

```bash
npm install
npm run dev
```
if you don't have node js installed yet, follow the following steps:
1. go to https://nodejs.org/en and install node
2. verify its installation by running node -v, then npm -v in your terminal
3. then, to run the project, use the two quick start commands above (install, run dev)

Open **http://localhost:5173** on your computer, scan the QR code with your phone, and allow motion access.

## How it works

- **Computer (host):** Shows a QR code, then a full-screen rhythm arena once your phone connects
- **Phone (controller):** Tilt/swing to move and slice on screen
- **Any network:** Uses a Cloudflare tunnel so your phone doesn't need the same Wi-Fi

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start server + Vite on port 5173 |
| `npm run build` | Type-check and build for production |
| `dev.bat` | Windows: kill port 5173 and start dev server |
| `allow-firewall.bat` | Windows firewall rule for local Wi-Fi fallback |