/*
 * Minimal CSInterface bridge for CEP panels.
 *
 * The full Adobe CSInterface.js is ~1000 lines and exposes the whole host API;
 * this panel only needs a handful of calls, so we implement a compact, correct
 * subset over the `window.__adobe_cep__` object that CEP injects into every
 * panel. Behavior of the methods used here matches Adobe's library.
 *
 *   evalScript(script, cb)   run ExtendScript in the host, cb(result:String)
 *   getSystemPath(type)      resolve a well-known path (extension dir, etc.)
 *   getHostEnvironment()     { appName, appVersion, appLocale, ... }
 *   addEventListener/…       CEP event bus (used for host->panel messages)
 *   openURLInDefaultBrowser  open a link in the OS browser
 *
 * If Adobe's full CSInterface.js is dropped in beside this file it can replace
 * it wholesale — the API surface used by the panel is identical.
 */
"use strict";

/* eslint-disable no-var */

function SystemPath() {}
SystemPath.USER_DATA = "userData";
SystemPath.COMMON_FILES = "commonFiles";
SystemPath.MY_DOCUMENTS = "myDocuments";
SystemPath.APPLICATION = "application";
SystemPath.EXTENSION = "extension";
SystemPath.HOST_APPLICATION = "hostApplication";

function CSEvent(type, scope, appId, extensionId) {
  this.type = type;
  this.scope = scope || "APPLICATION";
  this.appId = appId;
  this.extensionId = extensionId;
  this.data = "";
}

function CSInterface() {}

/** Run ExtendScript in the host app. Callback receives the result as a string. */
CSInterface.prototype.evalScript = function (script, callback) {
  if (window.__adobe_cep__) {
    window.__adobe_cep__.evalScript(script, callback || function () {});
  } else if (callback) {
    callback("EvalScript error: not running inside CEP host");
  }
};

CSInterface.prototype.getSystemPath = function (pathType) {
  if (!window.__adobe_cep__) return "";
  var path = window.__adobe_cep__.getSystemPath(pathType);
  // CEP returns file:// URLs on some hosts; normalize to a plain OS path.
  try {
    path = decodeURIComponent(path);
  } catch (e) {
    /* leave as-is */
  }
  if (path.indexOf("file:///") === 0) {
    path = path.replace("file:///", "");
    // On macOS the leading slash is part of the path; keep it.
    if (navigator.platform.indexOf("Mac") === 0) path = "/" + path;
  }
  return path;
};

CSInterface.prototype.getHostEnvironment = function () {
  if (!window.__adobe_cep__) return {};
  try {
    return JSON.parse(window.__adobe_cep__.getHostEnvironment());
  } catch (e) {
    return {};
  }
};

CSInterface.prototype.getApplicationID = function () {
  return this.getHostEnvironment().appId || "PPRO";
};

CSInterface.prototype.addEventListener = function (type, listener, obj) {
  if (window.__adobe_cep__) window.__adobe_cep__.addEventListener(type, listener, obj);
};

CSInterface.prototype.removeEventListener = function (type, listener, obj) {
  if (window.__adobe_cep__) window.__adobe_cep__.removeEventListener(type, listener, obj);
};

CSInterface.prototype.dispatchEvent = function (event) {
  if (typeof event.data === "object") event.data = JSON.stringify(event.data);
  if (window.__adobe_cep__) window.__adobe_cep__.dispatchEvent(event);
};

CSInterface.prototype.openURLInDefaultBrowser = function (url) {
  if (window.cep) return window.cep.util.openURLInDefaultBrowser(url);
};

CSInterface.prototype.getExtensionID = function () {
  return window.__adobe_cep__ ? window.__adobe_cep__.getExtensionId() : "com.istv.reeltool.panel";
};

// Expose globals the panel scripts expect (classic CEP style — no modules).
window.SystemPath = SystemPath;
window.CSEvent = CSEvent;
window.CSInterface = CSInterface;
