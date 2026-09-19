# Rhythm Crossing
This project was inspired by the VR game Beat Saber! Requires two devices: your phone and a laptop.
Use your phone as a controller for a block-slicing rhythm game on your computer. After calibration, select a song and swing your phone to slice blocks in time with the music.

### Download the latest release (v1), unzip the files, and open the game's folder in your code editor.

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
