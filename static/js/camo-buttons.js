/**
 * Assign each .btn / .tab / label.btn-file a random camo stack (1–22).
 * If Camouflage_png/stack_N.png exists (served as /camo/stack_N.png on the API host),
 * that texture is used; otherwise seven different filters/offsets apply to the shared SVG tile.
 */
(function () {
  "use strict";

  var STACKS = 22;

  function getApiBase() {
    try {
      var html = document.documentElement;
      var b = (html && html.getAttribute("data-samsel-api-base")) || "";
      b = (b || "").trim();
      if (!b) {
        var m = document.querySelector('meta[name="samsel-api-base"]');
        if (m) b = (m.getAttribute("content") || "").trim();
      }
      return b.replace(/\/$/, "");
    } catch (e) {
      return "";
    }
  }

  function camoStackUrl(n) {
    var api = getApiBase();
    var path = api ? api + "/camo/stack_" + n + ".png" : "/camo/stack_" + n + ".png";
    if (/^https?:\/\//i.test(path)) return path;
    try {
      return new URL(path, window.location.origin).href;
    } catch (e) {
      return path;
    }
  }

  function assignStacks(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll(".btn, .tab, label.btn-file").forEach(function (el) {
      if (el.hasAttribute("data-camo-stack-fixed")) return;
      el.setAttribute("data-camo-stack", String(1 + Math.floor(Math.random() * STACKS)));
    });
  }

  function probePngStacks() {
    var html = document.documentElement;
    for (var i = 1; i <= STACKS; i++) {
      (function (n) {
        var src = camoStackUrl(n);
        var img = new Image();
        img.onload = function () {
          html.classList.add("camo-stack-" + n + "-ok");
          html.style.setProperty("--camo-bg-" + n, 'url("' + src + '")');
        };
        img.onerror = function () {};
        img.src = src;
      })(i);
    }
  }

  function init() {
    var app = document.getElementById("app");
    var automix = document.getElementById("automix-app");
    if (app) assignStacks(app);
    if (automix) assignStacks(automix);
    probePngStacks();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
