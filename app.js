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
const revealState = new Map();
let currentConfig = window.TOWER_POWER_CONFIG || {};

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

const closePaneActionMenu = (viewport) => {
	const toggle = viewport.querySelector(".pane-menu-toggle");
	const menu = viewport.querySelector(".pane-action-menu");
	if (toggle) {
		toggle.setAttribute("aria-expanded", "false");
	}
	if (menu) {
		menu.hidden = true;
	}
};

const closeAllPaneActionMenus = () => {
	for (const viewport of document.querySelectorAll(".pane-viewport")) {
		closePaneActionMenu(viewport);
	}
};

const getPaneAutomationPoint = (paneName, action) => {
	const automation = currentConfig?.AUTOMATION || {};
	const paneConfig =
		paneName === "pane-a" ? automation.paneA || {} : automation.paneB || {};
	if (action === "menuButton") {
		return paneConfig.menuButton || null;
	}
	if (action === "closeMenu") {
		return paneConfig.closeMenu || null;
	}
	if (action.startsWith("actions.")) {
		const actionName = action.slice("actions.".length);
		return paneConfig.actions?.[actionName] || null;
	}
	return null;
};

const syncMenuToggleButton = (viewport) => {
	const toggle = viewport.querySelector(".pane-menu-toggle");
	if (!toggle) {
		return;
	}

	const revealed = revealState.get(viewport.id) === true;
	toggle.dataset.revealed = String(revealed);
};

const updateRevealState = (viewport, cropLeft) => {
	const shouldReveal = revealState.get(viewport.id) === true;
	const effectiveMaskLeft = shouldReveal ? 0 : normalizeCrop(cropLeft);
	viewport.style.setProperty("--effective-mask-left", `${effectiveMaskLeft}px`);
	syncMenuToggleButton(viewport);
};

const runPaneAutomation = async (viewport, action) => {
	const response = await fetch("/__automation", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			pane: viewport.dataset.pane,
			action,
			viewportId: viewport.id,
			point: getPaneAutomationPoint(viewport.dataset.pane, action),
		}),
	});

	const payload = await response.json();
	if (!response.ok || !payload.ok) {
		throw new Error(
			payload.error ||
				payload.stderr ||
				payload.stdout ||
				`HTTP ${response.status}`,
		);
	}

	console.log("[TowerPower automation]", payload);
	return payload;
};

const wirePaneControls = (viewport) => {
	if (viewport.dataset.menuToggleBound === "true") {
		return;
	}

	const toggle = viewport.querySelector(".pane-menu-toggle");
	const menu = viewport.querySelector(".pane-action-menu");
	if (!toggle || !menu) {
		return;
	}

	toggle.addEventListener("click", (event) => {
		event.stopPropagation();
		const opening = toggle.getAttribute("aria-expanded") !== "true";
		closeAllPaneActionMenus();
		toggle.setAttribute("aria-expanded", String(opening));
		menu.hidden = !opening;
	});

	for (const button of menu.querySelectorAll(".pane-action-button")) {
		button.addEventListener("click", async (event) => {
			event.stopPropagation();
			const action = button.dataset.automationAction;
			if (!action) {
				return;
			}

			button.disabled = true;
			closePaneActionMenu(viewport);
			try {
				await runPaneAutomation(viewport, action);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error("[TowerPower automation]", message);
				throw error;
			} finally {
				button.disabled = false;
			}
		});
	}

	viewport.dataset.menuToggleBound = "true";
	syncMenuToggleButton(viewport);
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
	wirePaneControls(viewport);

	viewport.dataset.pane =
		viewport.dataset.pane ||
		(viewportId === "pane-a-viewport" ? "pane-a" : "pane-b");

	const nextSrc = makeUrl(normalizedDeviceId);
	if (iframe.src !== nextSrc) {
		iframe.src = nextSrc;
	}
	iframe.title = `LD Cloud device ${normalizedDeviceId}`;

	viewport.style.setProperty("--crop-top", `${normalizeCrop(cropTop)}px`);
	viewport.style.setProperty("--crop-right", `${normalizeCrop(cropRight)}px`);
	viewport.style.setProperty("--crop-bottom", `${normalizeCrop(cropBottom)}px`);
	viewport.style.setProperty("--crop-left", `${normalizeCrop(cropLeft)}px`);
	viewport.dataset.cropLeft = String(normalizeCrop(cropLeft));
	updateRevealState(viewport, cropLeft);
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

const getPaneViewport = (viewportId) => document.getElementById(viewportId);

const setPaneMenuReveal = (viewportId, revealed) => {
	const viewport = getPaneViewport(viewportId);
	if (!viewport) {
		return false;
	}

	revealState.set(viewport.id, Boolean(revealed));
	const cropLeft = viewport.dataset.cropLeft || "0";
	updateRevealState(viewport, cropLeft);
	return true;
};

const togglePaneMenuReveal = (viewportId) => {
	const viewport = getPaneViewport(viewportId);
	if (!viewport) {
		return false;
	}

	return setPaneMenuReveal(
		viewportId,
		!(revealState.get(viewport.id) === true),
	);
};

const getPaneClientPoint = (viewportId, point) => {
	const viewport = getPaneViewport(viewportId);
	if (!viewport) {
		return null;
	}

	const stage = viewport.querySelector(".pane-stage");
	if (!stage) {
		return null;
	}

	const lockedSize = ensureLockedPaneSize(viewport);
	const stageRect = stage.getBoundingClientRect();
	const scale = Math.min(
		viewport.clientWidth / lockedSize.width,
		viewport.clientHeight / lockedSize.height,
	);

	return {
		clientX: stageRect.left + point.x * scale,
		clientY: stageRect.top + point.y * scale,
		scale,
		lockedWidth: lockedSize.width,
		lockedHeight: lockedSize.height,
	};
};

window.TowerPowerDebug = {
	getPaneClientPoint,
	setPaneMenuReveal,
	togglePaneMenuReveal,
};

let lastConfigSignature = "";

const refreshConfig = async () => {
	try {
		const config = await loadConfigFromSource();
		currentConfig = config;
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

document.addEventListener("click", () => {
	closeAllPaneActionMenus();
});

applyConfig(window.TOWER_POWER_CONFIG || {});
refreshConfig();
window.setInterval(refreshConfig, 1000);
