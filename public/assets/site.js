// Shared by every public page. Theme first, so a choice made on one page is
// what the next page renders; the landing-page extras run only where their
// elements exist.
(function () {
  var root = document.documentElement;

  // Dark is the default in CSS, the system preference applies to a visitor
  // who has never chosen, and an explicit choice outlives both.
  var stored = null;
  try { stored = localStorage.getItem("seerrsense-theme"); } catch (e) {}
  if (stored === "light" || stored === "dark") root.setAttribute("data-theme", stored);

  var toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.hidden = false;
    toggle.addEventListener("click", function () {
      var current = root.getAttribute("data-theme");
      if (!current) {
        current = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      }
      var next = current === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("seerrsense-theme", next); } catch (e) {}
    });
  }

  // The endpoint is whatever host this page was served from, so promoting a
  // domain needs no change here.
  var url = window.location.origin + "/mcp";
  var target = document.getElementById("mcp-url");
  if (target) target.textContent = url;
  Array.prototype.forEach.call(document.querySelectorAll(".mcp-url-slot"), function (slot) {
    slot.textContent = url;
  });

  var copy = document.getElementById("copy-url");
  if (copy && navigator.clipboard) {
    copy.addEventListener("click", function () {
      navigator.clipboard.writeText(url).then(function () {
        copy.textContent = copy.dataset.done;
        setTimeout(function () { copy.textContent = copy.dataset.idle; }, 1600);
      });
    });
  } else if (copy) {
    copy.hidden = true;
  }
})();
