// Shared by every public page. Theme first, so a choice made on one page is
// what the next page renders; the landing-page extras run only where their
// elements exist.
(function () {
  var root = document.documentElement;

  // Dark is the default in CSS, the system preference applies to a visitor
  // who has never chosen, and an explicit choice outlives both. The inline
  // script in <head> has already applied the stored choice before first
  // paint; this repeats it so the toggle below starts from the same state
  // even if that script was blocked.
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

  // Mobile navigation drawer. site.css owns the look (data-nav-open on the
  // header opens it below 768px); the behaviour is here: toggle, Escape, click
  // outside, link click, resize past the breakpoint, focus back to the burger.
  var navHeader = document.querySelector(".mctl-site-header");
  var navBurger = document.getElementById("nav-burger");
  var navList = document.getElementById("site-nav");
  if (navHeader && navBurger && navList) {
    var closeNav = function (returnFocus) {
      if (!navHeader.hasAttribute("data-nav-open")) return;
      navHeader.removeAttribute("data-nav-open");
      navBurger.setAttribute("aria-expanded", "false");
      if (returnFocus) navBurger.focus();
    };
    navBurger.addEventListener("click", function () {
      if (navHeader.hasAttribute("data-nav-open")) {
        closeNav(false);
      } else {
        navHeader.setAttribute("data-nav-open", "");
        navBurger.setAttribute("aria-expanded", "true");
      }
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeNav(true);
    });
    document.addEventListener("pointerdown", function (event) {
      if (!navHeader.hasAttribute("data-nav-open")) return;
      if (navList.contains(event.target) || navBurger.contains(event.target)) return;
      closeNav(false);
    });
    navList.addEventListener("click", function (event) {
      if (event.target.closest && event.target.closest("a")) closeNav(false);
    });
    if (window.matchMedia) {
      var wideQuery = window.matchMedia("(min-width: 768px)");
      var onWide = function (event) {
        if (event.matches) closeNav(false);
      };
      // Safari before 14 only has the deprecated addListener.
      if (wideQuery.addEventListener) wideQuery.addEventListener("change", onWide);
      else if (wideQuery.addListener) wideQuery.addListener(onWide);
    }
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
