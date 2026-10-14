"use strict";

// In-panel updates come only from this project's published GitHub releases.
// The replacement runs after Premiere exits, so files in use are never changed.
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const RELEASE_API = "https://api.github.com/repos/Inside-Success/istv-reels-tool-plugin/releases/latest";
const RELEASE_DOWNLOAD = "https://github.com/Inside-Success/istv-reels-tool-plugin/releases/download/";
const MAX_ZIP_BYTES = 250 * 1024 * 1024;

function platformLabel(platform = process.platform, arch = process.arch) {
  if (platform === "win32" && arch === "x64") return "win-x64";
  if (platform === "darwin" && arch === "arm64") return "mac-arm64";
  if (platform === "darwin" && arch === "x64") return "mac-x64";
  throw new Error(`Updates are unavailable for ${platform}-${arch}.`);
}

function versionParts(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-build\.(\d+))?$/.exec(String(v || ""));
  return m ? [...m.slice(1, 4).map(Number), Number(m[4] || 0)] : null;
}

function isNewer(candidate, installed) {
  const a = versionParts(candidate);
  const b = versionParts(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function request(url, onResponse, redirects = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const allowed = ["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"];
    if (parsed.protocol !== "https:" || !allowed.includes(parsed.hostname)) {
      reject(new Error("Update download redirected outside GitHub."));
      return;
    }
    const req = https.get(parsed, {
      headers: { "User-Agent": "ISTV-Reel-Tool-Updater", Accept: "application/vnd.github+json" },
      timeout: 20000,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (redirects >= 5 || !res.headers.location) return reject(new Error("Too many update redirects."));
        request(new URL(res.headers.location, parsed).toString(), onResponse, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Update server returned ${res.statusCode}.`));
        return;
      }
      Promise.resolve(onResponse(res)).then(resolve, reject);
    });
    req.on("timeout", () => req.destroy(new Error("Update request timed out.")));
    req.on("error", reject);
  });
}

async function latestRelease() {
  const release = await request(RELEASE_API, (res) => new Promise((resolve, reject) => {
    let text = "";
    res.on("data", (chunk) => {
      text += chunk;
      if (text.length > 1024 * 1024) res.destroy(new Error("Update response is too large."));
    });
    res.on("error", reject);
    res.on("end", () => {
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error("Invalid update response.")); }
    });
  }));
  if (!release || release.draft || release.prerelease || !versionParts(release.tag_name)) {
    throw new Error("No stable plugin release is available.");
  }
  return release;
}

function selectAsset(release, label = platformLabel()) {
  const name = `ISTV-Reel-Tool-${label}.zip`;
  const asset = (release.assets || []).find((a) => a.name === name);
  if (!asset) throw new Error(`Release ${release.tag_name} has no ${label} update.`);
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || "");
  const expectedUrl = RELEASE_DOWNLOAD + encodeURIComponent(release.tag_name) + "/" + name;
  if (!digest || asset.browser_download_url !== expectedUrl || asset.size < 1 || asset.size > MAX_ZIP_BYTES) {
    throw new Error("Release asset is missing a valid checksum, URL, or size.");
  }
  return { ...asset, expectedHash: digest[1].toLowerCase() };
}

async function checkForUpdate() {
  const installed = require(path.join(ROOT, "package.json")).version;
  const release = await latestRelease();
  if (!isNewer(release.tag_name, installed)) return { available: false, installed, latest: release.tag_name };
  const asset = selectAsset(release);
  return { available: true, installed, latest: release.tag_name, asset };
}

async function downloadAsset(asset, destination, onProgress) {
  const part = destination + ".part";
  try {
    await request(asset.browser_download_url, (res) => new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      let bytes = 0;
      const out = fs.createWriteStream(part);
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_ZIP_BYTES) res.destroy(new Error("Update ZIP is too large."));
        hash.update(chunk);
        if (onProgress) onProgress(Math.min(1, bytes / asset.size));
      });
      res.on("error", reject);
      out.on("error", reject);
      out.on("finish", () => {
        if (bytes !== asset.size || hash.digest("hex") !== asset.expectedHash) {
          reject(new Error("Update checksum or size did not match the release."));
        } else resolve();
      });
      res.pipe(out);
    }));
    fs.renameSync(part, destination);
  } catch (e) {
    try { fs.unlinkSync(part); } catch (_) {}
    throw e;
  }
}

async function scheduleUpdate(info, onProgress) {
  if (!info || !info.available || !isNewer(info.latest, require(path.join(ROOT, "package.json")).version)) {
    throw new Error("No newer release was selected.");
  }
  const normalizedRoot = ROOT.replace(/\\/g, "/").toLowerCase();
  if (!normalizedRoot.endsWith("/adobe/cep/extensions/com.istv.reeltool")) {
    throw new Error("This panel is not running from the installed CEP extensions folder.");
  }
  const asset = selectAsset({ tag_name: info.latest, assets: [info.asset] });
  const label = platformLabel();
  const work = path.join(os.homedir(), ".istv-reel-tool", "updates", info.latest + "-" + label);
  fs.mkdirSync(work, { recursive: true });
  const zip = path.join(work, asset.name);
  await downloadAsset(asset, zip, onProgress);
  const scriptName = process.platform === "win32" ? "apply-update.ps1" : "apply-update.command";
  const script = path.join(work, scriptName);
  fs.copyFileSync(path.join(ROOT, "updater", scriptName), script);
  if (process.platform !== "win32") fs.chmodSync(script, 0o700);
  const args = process.platform === "win32"
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Zip", zip, "-Destination", ROOT, "-ParentPid", String(process.pid), "-Label", label]
    : [script, zip, ROOT, String(process.pid), label];
  const command = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  child.unref();
  return { version: info.latest, work };
}

function consumeUpdateStatus() {
  const root = path.join(os.homedir(), ".istv-reel-tool", "updates");
  try {
    const statuses = fs.readdirSync(root)
      .map((name) => path.join(root, name, "status.txt"))
      .filter((file) => fs.existsSync(file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (!statuses.length) return "";
    const message = fs.readFileSync(statuses[0], "utf8").trim();
    fs.unlinkSync(statuses[0]);
    return message;
  } catch (_) {
    return "";
  }
}

module.exports = { platformLabel, versionParts, isNewer, selectAsset, checkForUpdate, scheduleUpdate, consumeUpdateStatus };
