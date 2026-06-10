# Tower Power

A minimal static web app that shows two LD Cloud devices in side-by-side panes.

## Configuration

Copy the example file and add your own LD Cloud device IDs:

```bash
cp config.js.example config.js
```

In `config.js`:

```js
window.TOWER_POWER_CONFIG = {
  DEVICE_A: "YOUR_FIRST_DEVICE_ID",
  DEVICE_B: "YOUR_SECOND_DEVICE_ID",

  DEVICE_A_CROP_TOP: 0,
  DEVICE_A_CROP_RIGHT: 0,
  DEVICE_A_CROP_BOTTOM: 0,
  DEVICE_A_CROP_LEFT: 0,

  DEVICE_B_CROP_TOP: 0,
  DEVICE_B_CROP_RIGHT: 0,
  DEVICE_B_CROP_BOTTOM: 0,
  DEVICE_B_CROP_LEFT: 0,

  AUTOMATION: {
    paneA: {
      menuButton: null,
      closeMenu: null,
      actions: {
        resolution1080p: null,
        hidden: null,
        resolution720p: null,
      },
    },
    paneB: {
      menuButton: null,
      closeMenu: null,
      actions: {
        resolution1080p: null,
        hidden: null,
        resolution720p: null,
      },
    },
  },

  STARTUP_AUTOMATION: {
    enabled: false,
    initialDelayMs: 6000,
    betweenActionsMs: 1500,
    actions: [
      { pane: "pane-a", actions: ["actions.resolution1080p", "actions.hidden"] },
      { pane: "pane-b", actions: ["actions.resolution1080p", "actions.hidden"] },
    ],
  },
};
```

`DEVICE_A` and `DEVICE_B` are the `deviceId` values from your LD Cloud URLs.
For example, in a URL like:

```text
https://www.ldcloud.net/web/webRtcNew?deviceId=1234567&type=my
```

The `deviceId` is the number after `deviceId=`.

The optional `*_CROP_*` values are pixel offsets that visually mask parts of the iframe:

- `*_CROP_TOP` hides pixels from the top
- `*_CROP_RIGHT` hides pixels from the right
- `*_CROP_BOTTOM` hides pixels from the bottom
- `*_CROP_LEFT` hides pixels from the left

These values no longer resize or shift the iframe. The full iframe stays in place and black masks are drawn over the unwanted edges, which keeps internal click coordinates stable for browser automation.

Each pane also locks to its initial on-load size and then scales as a whole if the browser window moves to a different monitor or changes size. That keeps your crop offsets stable instead of retuning them for every display width.

Start with `0` and increase the values until only the device screen is visible.

Important: this is a visual mask only. The LD Cloud UI is still loaded inside the iframe, and the masked regions can still receive browser-level clicks. However, because the iframe is cross-origin, this page still cannot directly script or call `.click()` on hidden LD Cloud controls from wrapper-page JavaScript.

For automation helpers:
- `window.TowerPowerDebug.getPaneClientPoint(viewportId, { x, y })` returns a browser client coordinate for a point inside a locked pane stage.
- `window.TowerPowerDebug.setPaneMenuReveal(viewportId, true | false)` forces the left mask to show or hide if you need manual debugging.
- `window.TowerPowerDebug.togglePaneMenuReveal(viewportId)` toggles that reveal state.

`AUTOMATION.paneA` and `AUTOMATION.paneB` are optional local coordinate maps for the browser automation script. Store `menuButton`, `closeMenu`, and any menu item coordinates there after calibration.

`STARTUP_AUTOMATION` is optional. When enabled, the page will trigger the listed pane actions once after load using the current visible Edge tab. Each item can use either a single `action` string or an `actions` array to click multiple menu items before closing the menu.

Example viewport IDs are `pane-a-viewport` and `pane-b-viewport`.

If `config.js` is missing, `dev.sh` creates it from `config.js.example` and asks you to fill in your device IDs.

## Run locally

```bash
./dev.sh
```

By default it:

- serves the app at `http://127.0.0.1:8080`
- stops anything already listening on that port
- starts the server in the background and returns control to your console
- on WSL, opens the app in the same Windows Edge debug window used by pane automation
- supports timer-based gem collection clicks from that same signed-in Edge session when enabled in the pane menu
- serves files with no-cache headers for dev use
- watches `config.js` from the browser and reapplies changes about once per second without requiring a page reload
- on narrow/mobile screens, shows one pane at a time and lets you swipe left/right to switch panes

Optional environment variables:

```bash
PORT=9000 HOST=0.0.0.0 ./dev.sh
NO_BROWSER=1 ./dev.sh
```

### Phone / LAN access from WSL on Windows

If you want to open Tower Power from a phone on the same home network:

1. Start the server bound to all interfaces:

```bash
HOST=0.0.0.0 ./dev.sh
```

2. In WSL, run the helper once and allow the Windows admin prompt:

```bash
./enable-phone-access.sh
```

That helper configures:
- a Windows `portproxy` from LAN port `8080` to the current WSL IP
- a Windows firewall allow rule for TCP `8080`

After that, use one of the printed Windows LAN URLs from your phone, for example:

```text
http://192.168.x.x:8080
```

If your WSL IP changes after reboot, just run `./enable-phone-access.sh` again.

Runtime files:

- `.dev-server.pid`
- `.dev-server.log`
- `config.js`

## Browser automation

Install the single local dependency:

```bash
npm install
```

Commands:

```bash
npm run automate -- capture pane-a
npm run automate -- capture pane-b
npm run automate -- reveal pane-a on
npm run automate -- click pane-a 12 420 --reveal
npm run automate -- open-menu pane-a
npm run automate -- action pane-b actions.resolution1080p
npm run automate -- detect-gem all
```

Notes:

- `capture` is available from the Playwright CLI if you need to recalibrate coordinates later.
- the pane hamburger menu also includes **Pick coordinates**, which temporarily overlays the pane and shows a popup with `{ x, y }` after your next click.
- `open-menu` uses `AUTOMATION.paneA.menuButton` or `AUTOMATION.paneB.menuButton` from `config.js`.
- `action` uses `AUTOMATION.paneA.actions.*` or `AUTOMATION.paneB.actions.*` from `config.js`.
- `detect-gem` screenshots each pane stage, searches for `templates/gem_button.png`, and writes an annotated image in `debug/` with an X at the would-click location.
- `detect-gem` accepts `pane-a`, `pane-b`, or `all` and an optional `--threshold 0.72` override.
- each pane's hamburger menu includes a **Collect gems** toggle; when enabled, the frontend schedules timer-based clicks at `AUTOMATION.paneA.gemButtonCenter` / `AUTOMATION.paneB.gemButtonCenter` using a 15 minute baseline with ±1 minute timing jitter and small click dithering.
- current-tab action sequences also need `closeMenu` for that pane.
- startup sequences can click multiple items before close by using `actions: ["actions.resolution1080p", "actions.hidden"]`.
- Set `BROWSER_PROFILE_DIR=/path/to/chromium-profile` if you want Playwright to launch its own Chromium-family browser profile.
- For Windows Edge from WSL, launching the `.exe` directly may fail. In that case start Edge yourself with a remote debugging port and use `BROWSER_CDP_URL=http://127.0.0.1:9222` instead.
- If the automated browser shows LD Cloud login pages, authenticate in that browser/profile first.

## Files

- `index.html` — two iframe panes only
- `styles.css` — full-screen two-pane layout with fixed-size masked stages and pane action menus
- `app.js` — loads the configured device IDs, locks pane size on first load, reapplies live mask offsets, triggers pane automation, schedules timer-based gem clicks, and exposes coordinate helpers for automation
- `config.js.example` — example config with placeholder device IDs, crop settings, and automation coordinate slots
- `config.js` — your local device IDs and crop settings, ignored by git
- `dev.sh` — starts the local dev server and, on WSL, opens the shared Edge debug window
- `dev_server.py` — no-cache static server plus current-tab automation endpoints and optional gem-detection helpers
- `automation.js` — Playwright-based pane automation for capture, reveal, coordinate clicks, and one-off gem detection screenshots
- `templates/gem_button.png` — template image used by `detect-gem` and background CLAIM polling
- `scripts/detect_template.py` — screenshot template matcher that annotates the would-click point with an X
- `enable-phone-access.sh` — configures Windows portproxy/firewall for phone access to WSL-hosted Tower Power
- `scripts/publish-vm.sh` — opens an SSH reverse tunnel using values from local `.remote-publish.env`
- `scripts/stop-publish-vm.sh` — stops the SSH reverse tunnel started by `publish-vm.sh`
- `.remote-publish.env.example` — example local config for reverse-tunnel publishing, copied to ignored `.remote-publish.env`
- `scripts/towerpower-edge-debug.ps1` — Windows Edge launcher/reuse script for the visible debug window
- `scripts/towerpower-cdp-click.ps1` — Windows CDP click helper for single current-tab menu clicks
- `scripts/towerpower-cdp-run-action.ps1` — Windows CDP helper for current-tab menu → one-or-more actions → close sequences
- `package.json` — local automation dependency and npm script
