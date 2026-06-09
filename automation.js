#!/usr/bin/env node
const os = require("os");
const path = require("path");
const { chromium } = require("playwright-core");

const APP_URL = process.env.APP_URL || "http://127.0.0.1:8080/";
const EXECUTABLE_PATH = process.env.CHROMIUM_PATH || "/usr/sbin/chromium";
const PROFILE_DIR = process.env.BROWSER_PROFILE_DIR || "";
const BROWSER_CDP_URL = process.env.BROWSER_CDP_URL || "";
const HEADLESS = process.env.HEADLESS === "1";
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const STEP_DELAY_MS = Number(process.env.STEP_DELAY_MS || 800);

const [command, ...args] = process.argv.slice(2);

const paneMap = {
	"pane-a": { viewportId: "pane-a-viewport", configKey: "paneA" },
	"pane-b": { viewportId: "pane-b-viewport", configKey: "paneB" },
};

const usage = () => {
	console.log(`Tower Power automation

Usage:
  npm run automate -- capture [pane-a|pane-b]
  npm run automate -- reveal <pane-a|pane-b> <on|off|toggle>
  npm run automate -- click <pane-a|pane-b> <x> <y> [--reveal]
  npm run automate -- action <pane-a|pane-b> <menuButton|closeMenu|actions.NAME>
  npm run automate -- open-menu <pane-a|pane-b>
  npm run automate -- run-action <pane-a|pane-b> <actions.NAME>

Environment:
  APP_URL=http://127.0.0.1:8080/
  CHROMIUM_PATH=/usr/sbin/chromium
  BROWSER_PROFILE_DIR=/path/to/chromium/profile
  BROWSER_CDP_URL=http://127.0.0.1:9222
  HEADLESS=1
`);
};

const fail = (message) => {
	console.error(`Error: ${message}`);
	process.exit(1);
};

const resolvePane = (paneName) => {
	const pane = paneMap[paneName];
	if (!pane) {
		fail(`unknown pane "${paneName}"`);
	}
	return pane;
};

const getUserDataDir = () => {
	if (PROFILE_DIR) {
		return PROFILE_DIR;
	}
	return path.join(os.tmpdir(), "tower-power-playwright-profile");
};

const connectViaCDP = async () => {
	const browser = await chromium.connectOverCDP(BROWSER_CDP_URL);
	const context =
		browser.contexts()[0] ||
		(await browser.newContext({ viewport: DEFAULT_VIEWPORT }));
	const page = context.pages()[0] || (await context.newPage());
	return {
		browser,
		context,
		page,
		close: async () => {
			await browser.close();
		},
	};
};

const launchPersistent = async () => {
	const context = await chromium.launchPersistentContext(getUserDataDir(), {
		headless: HEADLESS,
		executablePath: EXECUTABLE_PATH,
		viewport: DEFAULT_VIEWPORT,
	});
	const page = context.pages()[0] || (await context.newPage());
	return {
		context,
		page,
		close: async () => {
			await context.close();
		},
	};
};

const launch = async () => {
	const session = BROWSER_CDP_URL
		? await connectViaCDP()
		: await launchPersistent();
	await session.page.goto(APP_URL, {
		waitUntil: "domcontentloaded",
		timeout: 30000,
	});
	await session.page.waitForFunction(
		() => window.TowerPowerDebug && window.TOWER_POWER_CONFIG,
		null,
		{ timeout: 30000 },
	);
	await session.page.waitForTimeout(2000);
	return session;
};

const logAuthState = async (page) => {
	const frameUrls = page
		.frames()
		.map((frame) => frame.url())
		.filter((url) => url.includes("ldcloud.net"));
	for (const url of frameUrls) {
		console.log(`LD frame: ${url}`);
	}
	if (frameUrls.some((url) => url.includes("/login"))) {
		console.log(
			"Auth note: at least one LD Cloud pane is showing a login URL in this browser session.",
		);
	}
};

const getAutomationConfig = async (page) => {
	return page.evaluate(() => window.TOWER_POWER_CONFIG?.AUTOMATION || {});
};

const getPointFromConfig = async (page, paneName, selector) => {
	const automation = await getAutomationConfig(page);
	const paneConfig = automation[paneMap[paneName].configKey] || {};

	if (selector === "menuButton") {
		return paneConfig.menuButton || null;
	}

	if (selector === "closeMenu") {
		return paneConfig.closeMenu || null;
	}

	if (selector.startsWith("actions.")) {
		const actionName = selector.slice("actions.".length);
		return paneConfig.actions?.[actionName] || null;
	}

	return null;
};

const setReveal = async (page, paneName, mode) => {
	const pane = resolvePane(paneName);
	const result = await page.evaluate(
		({ viewportId, mode }) => {
			if (mode === "toggle") {
				return window.TowerPowerDebug.togglePaneMenuReveal(viewportId);
			}
			return window.TowerPowerDebug.setPaneMenuReveal(
				viewportId,
				mode === "on",
			);
		},
		{ viewportId: pane.viewportId, mode },
	);

	if (!result) {
		fail(`unable to update reveal state for ${paneName}`);
	}
};

const clickStagePoint = async (page, paneName, point, revealFirst = false) => {
	const pane = resolvePane(paneName);

	if (revealFirst) {
		await setReveal(page, paneName, "on");
		await page.waitForTimeout(200);
	}

	const clientPoint = await page.evaluate(
		({ viewportId, point }) => {
			return window.TowerPowerDebug.getPaneClientPoint(viewportId, point);
		},
		{ viewportId: pane.viewportId, point },
	);

	if (!clientPoint) {
		fail(`could not translate point for ${paneName}`);
	}

	await page.mouse.click(clientPoint.clientX, clientPoint.clientY);
	return clientPoint;
};

const runCapture = async (page, paneName) => {
	const viewportFilter = paneName ? resolvePane(paneName).viewportId : null;

	await page.exposeFunction("towerPowerNodeCaptureLog", (payload) => {
		console.log(JSON.stringify(payload));
	});

	await page.evaluate(
		({ viewportFilter }) => {
			const handler = (event) => {
				const viewport = event.target.closest?.(".pane-viewport");
				if (!viewport) {
					return;
				}
				if (viewportFilter && viewport.id !== viewportFilter) {
					return;
				}

				const point = window.TowerPowerDebug.getPaneStagePointFromClient(
					viewport.id,
					{
						clientX: event.clientX,
						clientY: event.clientY,
					},
				);

				if (!point) {
					return;
				}

				window.towerPowerNodeCaptureLog({
					viewportId: viewport.id,
					x: Math.round(point.x),
					y: Math.round(point.y),
					preciseX: point.x,
					preciseY: point.y,
					scale: point.scale,
				});
			};

			window.__towerPowerCaptureHandler = handler;
			document.addEventListener("click", handler, true);
		},
		{ viewportFilter },
	);

	console.log(
		"Capture mode active. Click inside a pane to print locked stage coordinates. Press Ctrl+C to stop.",
	);
	await new Promise(() => {});
};

const main = async () => {
	if (!command || command === "--help" || command === "help") {
		usage();
		return;
	}

	const session = await launch();
	const { page } = session;
	await logAuthState(page);

	try {
		if (command === "capture") {
			const paneName = args[0] || "";
			await runCapture(page, paneName || null);
			return;
		}

		if (command === "reveal") {
			const paneName = args[0];
			const mode = args[1];
			if (!paneName || !["on", "off", "toggle"].includes(mode)) {
				usage();
				process.exitCode = 1;
				return;
			}
			await setReveal(page, paneName, mode);
			console.log(`Reveal ${mode} applied for ${paneName}`);
			return;
		}

		if (command === "click") {
			const paneName = args[0];
			const x = Number(args[1]);
			const y = Number(args[2]);
			const revealFirst = args.includes("--reveal");
			if (!paneName || !Number.isFinite(x) || !Number.isFinite(y)) {
				usage();
				process.exitCode = 1;
				return;
			}
			const point = await clickStagePoint(
				page,
				paneName,
				{ x, y },
				revealFirst,
			);
			console.log(
				`Clicked ${paneName} at stage(${x}, ${y}) -> client(${Math.round(point.clientX)}, ${Math.round(point.clientY)})`,
			);
			return;
		}

		if (command === "open-menu") {
			const paneName = args[0];
			if (!paneName) {
				usage();
				process.exitCode = 1;
				return;
			}
			const point = await getPointFromConfig(page, paneName, "menuButton");
			if (!point) {
				fail(
					`missing AUTOMATION.${paneMap[paneName].configKey}.menuButton in config.js`,
				);
			}
			const clickPoint = await clickStagePoint(page, paneName, point, true);
			console.log(
				`Menu click sent for ${paneName} at client(${Math.round(clickPoint.clientX)}, ${Math.round(clickPoint.clientY)})`,
			);
			return;
		}

		if (command === "action") {
			const paneName = args[0];
			const selector = args[1];
			if (!paneName || !selector) {
				usage();
				process.exitCode = 1;
				return;
			}
			const point = await getPointFromConfig(page, paneName, selector);
			if (!point) {
				fail(
					`missing ${selector} for ${paneName} in config.js AUTOMATION block`,
				);
			}
			const revealFirst = selector !== "menuButton" && selector !== "closeMenu";
			const clickPoint = await clickStagePoint(
				page,
				paneName,
				point,
				revealFirst,
			);
			console.log(
				`Action ${selector} sent for ${paneName} at client(${Math.round(clickPoint.clientX)}, ${Math.round(clickPoint.clientY)})`,
			);
			return;
		}

		if (command === "run-action") {
			const paneName = args[0];
			const actionName = args[1];
			if (!paneName || !actionName || !actionName.startsWith("actions.")) {
				usage();
				process.exitCode = 1;
				return;
			}

			const menuPoint = await getPointFromConfig(page, paneName, "menuButton");
			const actionPoint = await getPointFromConfig(page, paneName, actionName);
			const closePoint = await getPointFromConfig(page, paneName, "closeMenu");
			if (!menuPoint || !actionPoint || !closePoint) {
				fail(
					`run-action requires menuButton, ${actionName}, and closeMenu for ${paneName}`,
				);
			}

			await clickStagePoint(page, paneName, menuPoint, true);
			await page.waitForTimeout(STEP_DELAY_MS);
			await clickStagePoint(page, paneName, actionPoint, false);
			await page.waitForTimeout(STEP_DELAY_MS);
			await clickStagePoint(page, paneName, closePoint, false);
			console.log(`Completed ${actionName} sequence for ${paneName}`);
			return;
		}

		usage();
		process.exitCode = 1;
	} finally {
		if (command !== "capture") {
			await session.close();
		}
	}
};

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
