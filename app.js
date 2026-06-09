const makeUrl = (deviceId) =>
	`https://www.ldcloud.net/web/webRtcNew?deviceId=${encodeURIComponent(deviceId)}&type=my`;

const normalizeDeviceId = (value) => String(value || "").trim();

const normalizeCrop = (value) => {
	const number = Number(value);
	if (!Number.isFinite(number) || number < 0) {
		return 0;
	}
	return number;
};

const lockedPaneSizes = new Map();

const buildPaneConfig = (config, prefix) => ({
	deviceId: config[`${prefix}`],
	cropTop: config[`${prefix}_CROP_TOP`],
	cropRight: config[`${prefix}_CROP_RIGHT`],
	cropBottom: config[`${prefix}_CROP_BOTTOM`],
	cropLeft: config[`${prefix}_CROP_LEFT`],
});

const ensureLockedPaneSize = (viewport) => {
	const key = viewport.id;
	if (lockedPaneSizes.has(key)) {
		return lockedPaneSizes.get(key);
	}

	const size = {
		width: Math.max(viewport.clientWidth, 1),
		height: Math.max(viewport.clientHeight, 1),
	};
	lockedPaneSizes.set(key, size);
	return size;
};

const updateViewportScale = (viewport) => {
	const lockedSize = ensureLockedPaneSize(viewport);
	const scale = Math.min(
		viewport.clientWidth / lockedSize.width,
		viewport.clientHeight / lockedSize.height,
	);

	viewport.style.setProperty("--locked-width", `${lockedSize.width}px`);
	viewport.style.setProperty("--locked-height", `${lockedSize.height}px`);
	viewport.style.setProperty("--scale", `${Math.max(scale, 0)}`);
};

const viewportObserver = new ResizeObserver((entries) => {
	for (const entry of entries) {
		updateViewportScale(entry.target);
	}
});

const applyDevice = ({
	iframeId,
	viewportId,
	deviceId,
	cropTop,
	cropRight,
	cropBottom,
	cropLeft,
}) => {
	const iframe = document.getElementById(iframeId);
	const viewport = document.getElementById(viewportId);
	const normalizedDeviceId = normalizeDeviceId(deviceId);

	if (!iframe || !viewport || !normalizedDeviceId) {
		return;
	}

	ensureLockedPaneSize(viewport);
	updateViewportScale(viewport);
	viewportObserver.observe(viewport);

	const nextSrc = makeUrl(normalizedDeviceId);
	if (iframe.src !== nextSrc) {
		iframe.src = nextSrc;
	}
	iframe.title = `LD Cloud device ${normalizedDeviceId}`;

	viewport.style.setProperty("--crop-top", `${normalizeCrop(cropTop)}px`);
	viewport.style.setProperty("--crop-right", `${normalizeCrop(cropRight)}px`);
	viewport.style.setProperty("--crop-bottom", `${normalizeCrop(cropBottom)}px`);
	viewport.style.setProperty("--crop-left", `${normalizeCrop(cropLeft)}px`);
};

const applyConfig = (config) => {
	applyDevice({
		iframeId: "device-a",
		viewportId: "pane-a-viewport",
		...buildPaneConfig(config, "DEVICE_A"),
	});

	applyDevice({
		iframeId: "device-b",
		viewportId: "pane-b-viewport",
		...buildPaneConfig(config, "DEVICE_B"),
	});
};

const loadConfigFromSource = async () => {
	const response = await fetch(`./config.js?t=${Date.now()}`, {
		cache: "no-store",
	});
	if (!response.ok) {
		throw new Error(`Unable to load config.js: ${response.status}`);
	}

	const source = await response.text();
	const sandbox = { TOWER_POWER_CONFIG: {} };
	new Function("window", `${source}\nreturn window.TOWER_POWER_CONFIG;`)(
		sandbox,
	);
	return sandbox.TOWER_POWER_CONFIG || {};
};

let lastConfigSignature = "";

const refreshConfig = async () => {
	try {
		const config = await loadConfigFromSource();
		const signature = JSON.stringify(config);
		if (signature === lastConfigSignature) {
			return;
		}
		lastConfigSignature = signature;
		applyConfig(config);
	} catch (error) {
		console.error(error);
	}
};

applyConfig(window.TOWER_POWER_CONFIG || {});
refreshConfig();
window.setInterval(refreshConfig, 1000);
