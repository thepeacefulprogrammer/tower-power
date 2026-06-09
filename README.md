# Tower Power

A minimal static web app that shows two LD Cloud devices in side-by-side panes.

## Configuration

Copy the example file and add your own LD Cloud device IDs:

```bash
cp config.toml.example config.toml
```

In `config.toml`:

```toml
DEVICE_A = "YOUR_FIRST_DEVICE_ID"
DEVICE_B = "YOUR_SECOND_DEVICE_ID"
```

`DEVICE_A` and `DEVICE_B` are the `deviceId` values from your LD Cloud URLs.
For example, in a URL like:

```text
https://www.ldcloud.net/web/webRtcNew?deviceId=1234567&type=my
```

The `deviceId` is the number after `deviceId=`.

If `config.toml` is missing, `dev.sh` creates it from `config.toml.example` and asks you to fill in your device IDs.

`dev.sh` reads `config.toml` and generates `config.js` before starting the server.

## Run locally

```bash
./dev.sh
```

By default it:

- serves the app at `http://127.0.0.1:8080`
- stops anything already listening on that port
- starts the server in the background and returns control to your console
- regenerates `config.js` from `config.toml`

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
- `styles.css` — full-screen two-pane layout
- `app.js` — loads the configured device IDs into the panes
- `config.toml.example` — example config with placeholder device IDs
- `config.toml` — your local device IDs, ignored by git
- `dev.sh` — generates config and starts the local server
