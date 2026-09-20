# Rhythm Crossing

Phone-as-controller for a block-slicing rhythm game on your computer. Swing your phone to slice blocks in time with the music.

## Quick start

```bash
npm install
npm run dev
```

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