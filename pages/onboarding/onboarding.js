"use strict";
(() => {
  // src/pages/onboarding/onboarding.ts
  (function() {
    var TOTAL = 6, i = 0;
    var steps = [].slice.call(document.querySelectorAll(".step"));
    var rail = document.getElementById("rail"), back = document.getElementById("back"), next = document.getElementById("next"), stepno = document.getElementById("stepno");
    for (var d = 0; d < TOTAL; d++) {
      var e = document.createElement("span");
      e.className = "dot";
      rail.appendChild(e);
    }
    var dots = [].slice.call(rail.children);
    function render() {
      steps.forEach(function(s, n) {
        s.classList.toggle("on", n === i);
      });
      dots.forEach(function(dt, n) {
        dt.className = "dot" + (n < i ? " done" : n === i ? " now" : "");
      });
      back.style.visibility = i === 0 ? "hidden" : "visible";
      stepno.textContent = i + 1 + " of " + TOTAL;
      next.textContent = i === TOTAL - 1 ? "Start reading" : i === 4 ? "Maybe later" : "Next step";
      next.className = "btn " + (i === TOTAL - 1 ? "btn--primary" : "btn--primary");
      if (i === 1) setTimeout(runDemo, 350);
    }
    function go(n) {
      i = Math.max(0, Math.min(TOTAL - 1, n));
      render();
      try {
        chrome.storage && chrome.storage.local && chrome.storage.local.set({ pape4a9d_onboard_step: i });
      } catch (e2) {
      }
    }
    next.addEventListener("click", function() {
      if (i === TOTAL - 1) {
        finish();
      } else go(i + 1);
    });
    back.addEventListener("click", function() {
      go(i - 1);
    });
    document.getElementById("skip").addEventListener("click", finish);
    document.addEventListener("keydown", function(e2) {
      var ae = document.activeElement;
      if (e2.key === "ArrowRight" || e2.key === "Enter") {
        if (ae && ae.tagName !== "INPUT" && ae.tagName !== "A") next.click();
      }
      if (e2.key === "ArrowLeft") back.click();
    });
    function finish() {
      try {
        chrome.storage && chrome.storage.local && chrome.storage.local.set({ pape4a9d_onboardingComplete: true, onboarded: true });
      } catch (e2) {
      }
      try {
        if (chrome.tabs && chrome.tabs.getCurrent) {
          chrome.tabs.getCurrent(function(t) {
            t && t.id != null ? chrome.tabs.remove(t.id) : window.close();
          });
        } else window.close();
      } catch (e2) {
        window.close();
      }
    }
    var demoRan = false;
    function runDemo() {
      var boxes = [].slice.call(document.querySelectorAll('[data-step="1"] .box[data-fill]'));
      boxes.forEach(function(b) {
        b.classList.remove("filled");
        b.textContent = " ";
      });
      demoRan = true;
      boxes.forEach(function(b, n) {
        setTimeout(function() {
          var val = b.getAttribute("data-fill") || "";
          b.textContent = "";
          b.classList.add("filled");
          var k = 0;
          (function type() {
            b.textContent = val.slice(0, k);
            if (k <= val.length) {
              k++;
              setTimeout(type, 22);
            }
          })();
        }, 260 * n);
      });
    }
    document.getElementById("demoBtn").addEventListener("click", runDemo);
    var saveBtn = document.getElementById("saveBtn");
    saveBtn && saveBtn.addEventListener("click", function() {
      var b = saveBtn;
      var doi = document.getElementById("pn").value || "10.1126/science.1225829";
      try {
        chrome.storage && chrome.storage.local && chrome.storage.local.set({ pape4a9d_onboard_doi: doi, pape4a9d_onboard_saved: true });
      } catch (e2) {
      }
      document.getElementById("saved").classList.add("show");
      b.textContent = "Row saved";
      b.disabled = true;
      b.style.opacity = "0.7";
    });
    render();
  })();
})();
