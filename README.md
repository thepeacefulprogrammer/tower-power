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
};
```

`DEVICE_A` and `DEVICE_B` are the `deviceId` values from your LD Cloud URLs.
For example, in a URL like:

```text
https://www.ldcloud.net/web/webRtcNew?deviceId=1234567&type=my
```

The `deviceId` is the number after `deviceId=`.

The optional `*_CROP_*` values are pixel offsets that visually trim the iframe:

- `*_CROP_TOP` hides pixels from the top
- `*_CROP_RIGHT` hides pixels from the right
- `*_CROP_BOTTOM` hides pixels from the bottom
- `*_CROP_LEFT` hides pixels from the left

The remaining visible area is centered inside each pane, so increasing left crop will not push the visible screen sideways across the panel.

Each pane also locks to its initial on-load size and then scales as a whole if the browser window moves to a different monitor or changes size. That keeps your crop offsets stable instead of retuning them for every display width.

Start with `0` and increase the values until only the device screen is visible.

Important: this is a visual crop only. The LD Cloud UI is still loaded inside the iframe, but because it is cross-origin, this page cannot directly script or click hidden LD Cloud controls from this wrapper page.

If `config.js` is missing, `dev.sh` creates it from `config.js.example` and asks you to fill in your device IDs.

## Run locally

```bash
./dev.sh
```

By default it:

- serves the app at `http://127.0.0.1:8080`
- stops anything already listening on that port
- starts the server in the background and returns control to your console
- serves files with no-cache headers for dev use
- watches `config.js` from the browser and reapplies changes about once per second without requiring a page reload

Optional environment variables:

```bash
PORT=9000 HOST=0.0.0.0 ./dev.sh
NO_BROWSER=1 ./dev.sh
```

Runtime files:

- `.dev-server.pid`
- `.dev-server.log`
- `config.js`

## Files

- `index.html` — two iframe panes only
- `styles.css` — full-screen two-pane layout with centered clipped viewports
- `app.js` — loads the configured device IDs, locks pane size on first load, and reapplies live crop offsets into the panes
- `config.js.example` — example config with placeholder device IDs and crop settings
- `config.js` — your local device IDs and crop settings, ignored by git
- `dev.sh` — starts the local dev server
- `dev_server.py` — no-cache static server for local development
