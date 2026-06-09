const config = window.TOWER_POWER_CONFIG || {};

const deviceA = String(config.DEVICE_A || "").trim();
const deviceB = String(config.DEVICE_B || "").trim();

const makeUrl = (deviceId) =>
	`https://www.ldcloud.net/web/webRtcNew?deviceId=${encodeURIComponent(deviceId)}&type=my`;

const paneA = document.getElementById("device-a");
const paneB = document.getElementById("device-b");

if (paneA && deviceA) {
	paneA.src = makeUrl(deviceA);
	paneA.title = `LD Cloud device ${deviceA}`;
}

if (paneB && deviceB) {
	paneB.src = makeUrl(deviceB);
	paneB.title = `LD Cloud device ${deviceB}`;
}
