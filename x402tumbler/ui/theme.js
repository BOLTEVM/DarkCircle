// Applies the saved colour theme and accent colour before the first paint (loaded synchronously in
// <head>; the CSP allows no inline script). Dark is the default theme; red is the default accent.
//
// The accent is a single user-chosen hue+saturation. This module derives readable --accent /
// --accent-strong / --accent-ink / --accent-soft pairs for BOTH the dark and the light theme from it
// (same hue, lightness adjusted per theme so text drawn in the accent colour keeps at least a 4.5:1
// contrast ratio against the app's background and surface colours, and the ink drawn ON the accent fill
// keeps at least 4.5:1 too), so any colour the user picks stays legible in both themes. Values are set as
// inline custom properties on <html>, which always win over the stylesheet's :root rules, so there is no
// flash of the wrong colour when the theme is later toggled without a reload (app.js calls
// window.DarkCircle.applyAccent again with the new theme).
window.DarkCircle = (function () {
  "use strict";

  var THEME_KEY = "darkcircle-theme";
  var ACCENT_KEY = "darkcircle-accent";
  var DEFAULT_ACCENT = "#ef4444"; // red

  // ---- small colour utilities (hex <-> rgb <-> hsl, WCAG relative luminance / contrast) ----
  var HEX_RE = /^#[0-9a-f]{6}$/i;

  function isHex(v) {
    return typeof v === "string" && HEX_RE.test(v);
  }

  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgbToHex(rgb) {
    function c(v) {
      v = Math.round(Math.min(255, Math.max(0, v)));
      var s = v.toString(16);
      return s.length < 2 ? "0" + s : s;
    }
    return "#" + c(rgb.r) + c(rgb.g) + c(rgb.b);
  }

  function rgbToHsl(rgb) {
    var r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return { h: h, s: s, l: l };
  }

  function hslToRgb(hsl) {
    var h = hsl.h, s = hsl.s, l = hsl.l, r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      var hue2rgb = function (p, q, t) {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return { r: r * 255, g: g * 255, b: b * 255 };
  }

  function relLuminance(rgb) {
    function lin(v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
  }

  function contrastRatio(a, b) {
    var l1 = relLuminance(a) + 0.05, l2 = relLuminance(b) + 0.05;
    return l1 > l2 ? l1 / l2 : l2 / l1;
  }

  /** Walks lightness from `start` toward `min`/`max` in `step` increments; returns the first value whose
   *  accent colour hits `target` contrast against every background in `bgs`, or the best one found. */
  function findLightness(h, s, bgs, opts) {
    var best = opts.start, bestC = 0, l;
    for (l = opts.start; opts.step > 0 ? l <= opts.max : l >= opts.min; l += opts.step) {
      var rgb = hslToRgb({ h: h, s: s, l: l });
      var worst = Infinity, i;
      for (i = 0; i < bgs.length; i++) {
        var c = contrastRatio(rgb, bgs[i]);
        if (c < worst) worst = c;
      }
      if (worst > bestC) { bestC = worst; best = l; }
      if (worst >= opts.target) return l;
    }
    return best;
  }

  var DARK_BG = hexToRgb("#0a0e13");
  var DARK_SURFACE = hexToRgb("#121921");
  var LIGHT_BG = hexToRgb("#f2f5f8");
  var LIGHT_SURFACE = hexToRgb("#ffffff");
  var TARGET_CONTRAST = 4.5;

  /** Best readable near-black / white ink for text drawn on `fillRgb`, tinted faintly with the hue. */
  function pickInk(h, s, fillRgb) {
    var dark = hslToRgb({ h: h, s: Math.min(s, 0.5), l: 0.08 });
    var white = { r: 255, g: 255, b: 255 };
    return contrastRatio(dark, fillRgb) >= contrastRatio(white, fillRgb) ? rgbToHex(dark) : rgbToHex(white);
  }

  /** Derives {accent, accentStrong, accentInk, accentSoftRgb} for one theme from a seed hue+saturation. */
  function deriveForTheme(h, s, theme) {
    var bgs = theme === "light" ? [LIGHT_BG, LIGHT_SURFACE] : [DARK_BG, DARK_SURFACE];
    var l = theme === "light"
      ? findLightness(h, s, bgs, { start: 0.60, step: -0.01, min: 0.12, max: 0.60, target: TARGET_CONTRAST })
      : findLightness(h, s, bgs, { start: 0.40, step: 0.01, min: 0.40, max: 0.82, target: TARGET_CONTRAST });
    var accentRgb = hslToRgb({ h: h, s: s, l: l });
    var strongL = theme === "light" ? Math.max(0.05, l - 0.07) : Math.min(0.88, l + 0.09);
    var strongRgb = hslToRgb({ h: h, s: s, l: strongL });
    return {
      accent: rgbToHex(accentRgb),
      accentStrong: rgbToHex(strongRgb),
      accentInk: pickInk(h, s, accentRgb),
      accentSoftRgb: Math.round(accentRgb.r) + "," + Math.round(accentRgb.g) + "," + Math.round(accentRgb.b)
    };
  }

  function readStoredTheme() {
    try {
      var saved = window.localStorage.getItem(THEME_KEY);
      return saved === "light" || saved === "dark" ? saved : "dark";
    } catch (e) {
      return "dark";
    }
  }

  function readStoredAccent() {
    try {
      var saved = window.localStorage.getItem(ACCENT_KEY);
      return isHex(saved) ? saved : DEFAULT_ACCENT;
    } catch (e) {
      return DEFAULT_ACCENT;
    }
  }

  /** Sets data-theme and persists it (best-effort; storage may be blocked). Does not touch the accent. */
  function applyTheme(theme, persist) {
    theme = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", theme);
    if (persist !== false) {
      try { window.localStorage.setItem(THEME_KEY, theme); } catch (e) { /* private mode or blocked storage */ }
    }
    return theme;
  }

  /** Sets the four --accent* custom properties for `theme` from `hex`, and persists the seed (best-effort). */
  function applyAccent(hex, theme, persist) {
    if (!isHex(hex)) hex = DEFAULT_ACCENT;
    theme = theme === "light" ? "light" : "dark";
    var hsl = rgbToHsl(hexToRgb(hex));
    var d = deriveForTheme(hsl.h, hsl.s, theme);
    var style = document.documentElement.style;
    style.setProperty("--accent", d.accent);
    style.setProperty("--accent-strong", d.accentStrong);
    style.setProperty("--accent-ink", d.accentInk);
    style.setProperty("--accent-soft", "rgba(" + d.accentSoftRgb + "," + (theme === "light" ? ".09" : ".12") + ")");
    if (persist !== false) {
      try { window.localStorage.setItem(ACCENT_KEY, hex); } catch (e) { /* private mode or blocked storage */ }
    }
    return hex;
  }

  var theme = applyTheme(readStoredTheme(), false);
  var accent = applyAccent(readStoredAccent(), theme, false);

  return {
    DEFAULT_ACCENT: DEFAULT_ACCENT,
    isHex: isHex,
    theme: theme,
    accent: accent,
    applyTheme: applyTheme,
    applyAccent: applyAccent
  };
})();
