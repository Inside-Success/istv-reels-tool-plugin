/*
 * Minimal JSON polyfill for Premiere's ExtendScript engine (which has no native
 * JSON). Deliberately avoids the classic json2.js control-character regexes,
 * which the old ExtendScript parser rejects with a SyntaxError. Character
 * escaping is done with a plain per-character loop instead — pure ES3, safe on
 * every Adobe ExtendScript build.
 *
 * Scope: the payloads this plugin exchanges (objects, arrays, strings, numbers,
 * booleans, null). JSON.parse uses eval on trusted, internally-produced JSON
 * (the panel builds it with the browser's real JSON.stringify), which is the
 * standard approach for ExtendScript.
 */
if (typeof JSON !== "object") {
  JSON = {};
}
(function () {
  function quote(string) {
    var s = '"';
    var l = string.length;
    for (var i = 0; i < l; i++) {
      var c = string.charAt(i);
      if (c === '"' || c === "\\") {
        s += "\\" + c;
      } else if (c === "\b") {
        s += "\\b";
      } else if (c === "\f") {
        s += "\\f";
      } else if (c === "\n") {
        s += "\\n";
      } else if (c === "\r") {
        s += "\\r";
      } else if (c === "\t") {
        s += "\\t";
      } else if (c < " ") {
        var hex = c.charCodeAt(0).toString(16);
        s += "\\u" + "0000".substring(hex.length) + hex;
      } else {
        s += c;
      }
    }
    return s + '"';
  }

  function str(value) {
    var i, l, partial, k, v;
    switch (typeof value) {
      case "string":
        return quote(value);
      case "number":
        return isFinite(value) ? String(value) : "null";
      case "boolean":
        return String(value);
      case "object":
        if (!value) return "null";
        partial = [];
        if (Object.prototype.toString.apply(value) === "[object Array]") {
          l = value.length;
          for (i = 0; i < l; i++) {
            v = str(value[i]);
            partial[i] = v === undefined ? "null" : v;
          }
          return "[" + partial.join(",") + "]";
        }
        for (k in value) {
          if (Object.prototype.hasOwnProperty.call(value, k)) {
            v = str(value[k]);
            if (v !== undefined) partial.push(quote(k) + ":" + v);
          }
        }
        return "{" + partial.join(",") + "}";
    }
    return undefined; // functions / undefined are dropped
  }

  if (typeof JSON.stringify !== "function") {
    JSON.stringify = function (value) {
      return str(value);
    };
  }

  if (typeof JSON.parse !== "function") {
    JSON.parse = function (text) {
      return eval("(" + String(text) + ")");
    };
  }
})();
