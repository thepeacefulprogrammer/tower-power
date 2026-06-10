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
let currentMobilePane = "pane-a";
let activeCoordinateCaptureViewportId = null;
let swipeStart = null;

const MOBILE_MEDIA_QUERY = "(max-width: 980px)";
const SWIPE_THRESHOLD_PX = 50;
const GEM_DETECTION_REFRESH_MS = 2000;
const GEM_COLLECTION_STORAGE_KEY = "tower-power.collect-gems";
const GEM_CLICK_DITHER_PX = 4;

const gemCollectionEnabled = new Map();
const gemClickInFlight = new Set();
const gemLastAttemptSignature = new Map();

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

const getViewportScale = (viewport) => {
	const lockedSize = ensureLockedPaneSize(viewport);
	const cropRight = normalizeCrop(viewport.dataset.cropRight || "0");
	const cropLeft = normalizeCrop(viewport.dataset.cropLeft || "0");

	if (isMobileLayout()) {
		const visibleWidth = Math.max(lockedSize.width - cropLeft - cropRight, 1);
		return viewport.clientWidth / visibleWidth;
	}

	return Math.min(
		viewport.clientWidth / lockedSize.width,
		viewport.clientHeight / lockedSize.height,
	);
};

const updateViewportScale = (viewport) => {
	const lockedSize = ensureLockedPaneSize(viewport);
	const scale = getViewportScale(viewport);

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

const isMobileLayout = () => window.matchMedia(MOBILE_MEDIA_QUERY).matches;

const syncCoordinateCaptureState = () => {
	for (const viewport of document.querySelectorAll(".pane-viewport")) {
		viewport.dataset.captureActive = String(
			viewport.id === activeCoordinateCaptureViewportId,
		);
		const overlay = viewport.querySelector(".pane-coordinate-overlay");
		if (overlay) {
			overlay.setAttribute(
				"aria-hidden",
				String(viewport.id !== activeCoordinateCaptureViewportId),
			);
		}
	}
};

const clearCoordinateCapture = () => {
	activeCoordinateCaptureViewportId = null;
	syncCoordinateCaptureState();
};

const openCoordinatePopup = async (viewport, point) => {
	const rounded = {
		x: Math.round(point.x),
		y: Math.round(point.y),
	};
	const text = `{ x: ${rounded.x}, y: ${rounded.y} }`;
	try {
		await navigator.clipboard.writeText(text);
	} catch (_error) {
		// ignore clipboard failures
	}
	window.prompt(
		`Coordinates for ${viewport.dataset.pane} copied to clipboard`,
		text,
	);
};

const startCoordinateCapture = (viewportId) => {
	activeCoordinateCaptureViewportId = viewportId;
	closeAllPaneActionMenus();
	syncCoordinateCaptureState();
};

const readCollectGemsPreferences = () => {
	try {
		const raw = window.localStorage.getItem(GEM_COLLECTION_STORAGE_KEY);
		if (!raw) {
			return {};
		}
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch (_error) {
		return {};
	}
};

const writeCollectGemsPreferences = (preferences) => {
	try {
		window.localStorage.setItem(
			GEM_COLLECTION_STORAGE_KEY,
			JSON.stringify(preferences),
		);
	} catch (_error) {
		// ignore storage failures
	}
};

const isCollectGemsEnabled = (paneName) => {
	if (gemCollectionEnabled.has(paneName)) {
		return gemCollectionEnabled.get(paneName) === true;
	}

	const preferences = readCollectGemsPreferences();
	const enabled = preferences[paneName] !== false;
	gemCollectionEnabled.set(paneName, enabled);
	return enabled;
};

const syncCollectGemsToggle = (viewport) => {
	const paneName = viewport.dataset.pane;
	const toggle = viewport.querySelector("[data-collect-gems-toggle]");
	if (!paneName || !toggle) {
		return;
	}

	toggle.checked = isCollectGemsEnabled(paneName);
};

const setCollectGemsEnabled = (paneName, enabled) => {
	const normalizedEnabled = Boolean(enabled);
	gemCollectionEnabled.set(paneName, normalizedEnabled);
	const preferences = readCollectGemsPreferences();
	preferences[paneName] = normalizedEnabled;
	writeCollectGemsPreferences(preferences);

	for (const viewport of document.querySelectorAll(".pane-viewport")) {
		if (viewport.dataset.pane === paneName) {
			syncCollectGemsToggle(viewport);
		}
	}
};

const buildGemAttemptSignature = (result) => {
	const point = result?.wouldClickStagePoint;
	if (!point) {
		return "";
	}
	return `${result?.checkedAt || ""}:${Math.round(point.x)}:${Math.round(point.y)}`;
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const ditherGemClickPoint = (viewport, point) => {
	const lockedSize = ensureLockedPaneSize(viewport);
	const randomOffset = () =>
		Math.round((Math.random() * 2 - 1) * GEM_CLICK_DITHER_PX);

	return {
		x: clamp(Math.round(point.x) + randomOffset(), 0, lockedSize.width),
		y: clamp(Math.round(point.y) + randomOffset(), 0, lockedSize.height),
	};
};

const maybeCollectGem = async (viewport, result) => {
	const paneName = viewport.dataset.pane;
	if (
		!paneName ||
		!isCollectGemsEnabled(paneName) ||
		!result?.found ||
		!result?.wouldClickStagePoint
	) {
		return;
	}

	const signature = buildGemAttemptSignature(result);
	if (
		!signature ||
		gemClickInFlight.has(paneName) ||
		gemLastAttemptSignature.get(paneName) === signature
	) {
		return;
	}

	gemClickInFlight.add(paneName);
	gemLastAttemptSignature.set(paneName, signature);
	try {
		await runPaneStageClick(
			viewport,
			ditherGemClickPoint(viewport, result.wouldClickStagePoint),
		);
	} catch (error) {
		gemLastAttemptSignature.delete(paneName);
		console.error("[TowerPower gem collection]", error);
	} finally {
		gemClickInFlight.delete(paneName);
	}
};

const applyGemDetectionResult = (result) => {
	const paneName = result?.pane;
	const viewportId =
		paneName === "pane-a"
			? "pane-a-viewport"
			: paneName === "pane-b"
				? "pane-b-viewport"
				: null;
	if (!viewportId) {
		return;
	}

	const viewport = document.getElementById(viewportId);
	if (!viewport) {
		return;
	}

	if (result?.state === "error") {
		console.error("[TowerPower gem detection]", paneName, result?.error);
		return;
	}

	void maybeCollectGem(viewport, result);
};

const refreshGemDetection = async () => {
	try {
		const response = await fetch(`/__gem-detection?t=${Date.now()}`, {
			cache: "no-store",
		});
		if (!response.ok) {
			throw new Error(`Gem detection status failed: ${response.status}`);
		}

		const payload = await response.json();
		const results = payload?.results || {};
		applyGemDetectionResult(results["pane-a"] || { pane: "pane-a" });
		applyGemDetectionResult(results["pane-b"] || { pane: "pane-b" });
	} catch (error) {
		console.error("[TowerPower gem detection]", error);
		applyGemDetectionResult({
			pane: "pane-a",
			state: "error",
			error: error instanceof Error ? error.message : String(error),
		});
		applyGemDetectionResult({
			pane: "pane-b",
			state: "error",
			error: error instanceof Error ? error.message : String(error),
		});
	}
};

const applyMobilePaneState = () => {
	document.body.dataset.mobilePane = currentMobilePane;
	for (const viewport of document.querySelectorAll(".pane-viewport")) {
		viewport.dataset.mobileActive = String(
			viewport.dataset.pane === currentMobilePane,
		);
		updateViewportScale(viewport);
	}

	for (const button of document.querySelectorAll(".pane-switch-button")) {
		const isActive = button.dataset.targetPane === currentMobilePane;
		button.setAttribute("aria-selected", String(isActive));
	}
};

const setMobilePane = (paneName) => {
	if (!["pane-a", "pane-b"].includes(paneName)) {
		return false;
	}
	currentMobilePane = paneName;
	closeAllPaneActionMenus();
	applyMobilePaneState();
	return true;
};

const switchMobilePaneByDelta = (delta) => {
	if (!isMobileLayout() || !delta) {
		return false;
	}
	const nextPane = currentMobilePane === "pane-a" ? "pane-b" : "pane-a";
	return setMobilePane(nextPane);
};

const getPaneConfigKey = (paneName) =>
	paneName === "pane-a" ? "paneA" : "paneB";

const getPaneAutomationConfig = (paneName) => {
	const automation = currentConfig?.AUTOMATION || {};
	return automation[getPaneConfigKey(paneName)] || {};
};

const getPaneAutomationPoint = (paneName, action) => {
	const paneConfig = getPaneAutomationConfig(paneName);
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

const normalizeActionList = (action) => {
	if (typeof action === "string") {
		return [action];
	}
	if (Array.isArray(action)) {
		return action.filter((item) => typeof item === "string");
	}
	return [];
};

const getPaneAutomationSequence = (paneName, action) => {
	const actions = normalizeActionList(action);
	if (
		!actions.length ||
		!actions.every((item) => item.startsWith("actions."))
	) {
		return null;
	}

	const paneConfig = getPaneAutomationConfig(paneName);
	const actionPoints = actions
		.map((item) => getPaneAutomationPoint(paneName, item))
		.filter(Boolean);
	if (
		!paneConfig.menuButton ||
		actionPoints.length !== actions.length ||
		!paneConfig.closeMenu
	) {
		return null;
	}

	return {
		menuButton: paneConfig.menuButton,
		actionPoints,
		closeMenu: paneConfig.closeMenu,
	};
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

const runPaneAutomation = async (viewport, action, options = {}) => {
	const paneName = viewport.dataset.pane;
	const primaryAction = Array.isArray(action) ? action[0] : action;
	const response = await fetch("/__automation", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			pane: paneName,
			action: primaryAction,
			viewportId: viewport.id,
			point:
				options.point === undefined
					? getPaneAutomationPoint(paneName, primaryAction)
					: options.point,
			sequence:
				options.sequence === undefined
					? getPaneAutomationSequence(paneName, action)
					: options.sequence,
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

const runPaneStageClick = (viewport, point) =>
	runPaneAutomation(viewport, "stagePoint", { point, sequence: null });

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

	for (const switchButton of viewport.querySelectorAll(".pane-switch-button")) {
		switchButton.addEventListener("click", (event) => {
			event.stopPropagation();
			setMobilePane(switchButton.dataset.targetPane);
		});
	}

	for (const toggleRow of menu.querySelectorAll(".pane-action-toggle")) {
		toggleRow.addEventListener("click", (event) => {
			event.stopPropagation();
		});
	}

	for (const toggle of menu.querySelectorAll("[data-collect-gems-toggle]")) {
		syncCollectGemsToggle(viewport);
		toggle.addEventListener("change", (event) => {
			const target = event.currentTarget;
			if (!target) {
				return;
			}
			setCollectGemsEnabled(viewport.dataset.pane, target.checked);
		});
	}

	for (const captureButton of menu.querySelectorAll(
		"[data-capture-coordinates]",
	)) {
		captureButton.addEventListener("click", (event) => {
			event.stopPropagation();
			startCoordinateCapture(viewport.id);
		});
	}

	const overlay = viewport.querySelector(".pane-coordinate-overlay");
	if (overlay) {
		overlay.addEventListener("click", async (event) => {
			event.preventDefault();
			event.stopPropagation();
			const point = getPaneStagePointFromClient(viewport.id, {
				clientX: event.clientX,
				clientY: event.clientY,
			});
			clearCoordinateCapture();
			if (!point) {
				return;
			}
			await openCoordinatePopup(viewport, point);
		});
	}

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

const wireMobileSwipeNavigation = () => {
	const grid = document.querySelector(".pane-grid");
	if (!grid || grid.dataset.mobileSwipeBound === "true") {
		return;
	}

	grid.addEventListener(
		"touchstart",
		(event) => {
			if (!isMobileLayout() || event.touches.length !== 1) {
				swipeStart = null;
				return;
			}
			const touch = event.touches[0];
			swipeStart = { x: touch.clientX, y: touch.clientY };
		},
		{ passive: true },
	);

	grid.addEventListener(
		"touchend",
		(event) => {
			if (
				!isMobileLayout() ||
				!swipeStart ||
				event.changedTouches.length !== 1
			) {
				swipeStart = null;
				return;
			}

			const touch = event.changedTouches[0];
			const deltaX = touch.clientX - swipeStart.x;
			const deltaY = touch.clientY - swipeStart.y;
			swipeStart = null;

			if (
				Math.abs(deltaX) < SWIPE_THRESHOLD_PX ||
				Math.abs(deltaX) <= Math.abs(deltaY)
			) {
				return;
			}

			if (deltaX < 0) {
				switchMobilePaneByDelta(1);
			} else {
				switchMobilePaneByDelta(-1);
			}
		},
		{ passive: true },
	);

	window.addEventListener("resize", () => {
		applyMobilePaneState();
		for (const viewport of document.querySelectorAll(".pane-viewport")) {
			updateViewportScale(viewport);
		}
	});
	grid.dataset.mobileSwipeBound = "true";
	applyMobilePaneState();
};

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
	syncCollectGemsToggle(viewport);

	viewport.dataset.pane =
		viewport.dataset.pane ||
		(viewportId === "pane-a-viewport" ? "pane-a" : "pane-b");

	const nextSrc = makeUrl(normalizedDeviceId);
	if (iframe.src !== nextSrc) {
		iframe.src = nextSrc;
	}
	iframe.title = `LD Cloud device ${normalizedDeviceId}`;

	const normalizedCropTop = normalizeCrop(cropTop);
	const normalizedCropRight = normalizeCrop(cropRight);
	const normalizedCropBottom = normalizeCrop(cropBottom);
	const normalizedCropLeft = normalizeCrop(cropLeft);
	viewport.style.setProperty("--crop-top", `${normalizedCropTop}px`);
	viewport.style.setProperty("--crop-right", `${normalizedCropRight}px`);
	viewport.style.setProperty("--crop-bottom", `${normalizedCropBottom}px`);
	viewport.style.setProperty("--crop-left", `${normalizedCropLeft}px`);
	viewport.dataset.cropTop = String(normalizedCropTop);
	viewport.dataset.cropRight = String(normalizedCropRight);
	viewport.dataset.cropBottom = String(normalizedCropBottom);
	viewport.dataset.cropLeft = String(normalizedCropLeft);
	updateRevealState(viewport, cropLeft);
	updateViewportScale(viewport);
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
	const scale = stageRect.width / lockedSize.width;

	return {
		clientX: stageRect.left + point.x * scale,
		clientY: stageRect.top + point.y * scale,
		scale,
		lockedWidth: lockedSize.width,
		lockedHeight: lockedSize.height,
	};
};

const getPaneStagePointFromClient = (viewportId, point) => {
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
	const scale = stageRect.width / lockedSize.width;

	return {
		x: (point.clientX - stageRect.left) / scale,
		y: (point.clientY - stageRect.top) / scale,
		scale,
		lockedWidth: lockedSize.width,
		lockedHeight: lockedSize.height,
		stageLeft: stageRect.left,
		stageTop: stageRect.top,
		viewportId,
	};
};

window.TowerPowerDebug = {
	getPaneClientPoint,
	getPaneStagePointFromClient,
	setPaneMenuReveal,
	togglePaneMenuReveal,
};

let lastConfigSignature = "";
let startupAutomationScheduled = false;

const delay = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

const scheduleStartupAutomation = (config) => {
	if (startupAutomationScheduled) {
		return;
	}

	const startup = config?.STARTUP_AUTOMATION;
	if (
		!startup?.enabled ||
		!Array.isArray(startup.actions) ||
		!startup.actions.length
	) {
		return;
	}

	startupAutomationScheduled = true;
	const initialDelayMs = Math.max(Number(startup.initialDelayMs) || 0, 0);
	const betweenActionsMs = Math.max(Number(startup.betweenActionsMs) || 0, 0);

	window.setTimeout(async () => {
		for (const item of startup.actions) {
			const paneName = item?.pane;
			const action = Array.isArray(item?.actions) ? item.actions : item?.action;
			const normalizedActions = normalizeActionList(action);
			if (
				!["pane-a", "pane-b"].includes(paneName) ||
				!normalizedActions.length
			) {
				continue;
			}

			const viewportId =
				paneName === "pane-a" ? "pane-a-viewport" : "pane-b-viewport";
			const viewport = document.getElementById(viewportId);
			if (!viewport) {
				continue;
			}

			try {
				await runPaneAutomation(viewport, normalizedActions);
			} catch (error) {
				console.error("[TowerPower startup automation]", error);
			}

			if (betweenActionsMs > 0) {
				await delay(betweenActionsMs);
			}
		}
	}, initialDelayMs);
};

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
		window.requestAnimationFrame(() => {
			for (const viewport of document.querySelectorAll(".pane-viewport")) {
				updateViewportScale(viewport);
			}
		});
		scheduleStartupAutomation(config);
	} catch (error) {
		console.error(error);
	}
};

document.addEventListener("click", () => {
	closeAllPaneActionMenus();
});

document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") {
		clearCoordinateCapture();
	}
});

wireMobileSwipeNavigation();
applyConfig(window.TOWER_POWER_CONFIG || {});
applyMobilePaneState();
scheduleStartupAutomation(window.TOWER_POWER_CONFIG || {});
refreshConfig();
refreshGemDetection();
window.setInterval(refreshConfig, 1000);
window.setInterval(refreshGemDetection, GEM_DETECTION_REFRESH_MS);
