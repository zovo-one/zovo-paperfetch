/* zovo-sidebar.js — sidebar behavior for the options page (PaperFetch).
   Copied from engine/5-design-ux-ui-monetization/monetization/zovo-sidebar.js
   and adapted:
     - tier key is this extension's canonical Pro cache: chrome.storage.local
       `pro` = {active: boolean, verifiedAt: string|null} (storage.ts), not
       the engine template's generic zovo_license.
     - the rate-card gating is dropped entirely (review solicitation is a
       CWS §A violation; the template ships no rate card anymore).
     - no conversion beacon: the funnel log is local-only and lives in
       shared/funnel.ts; the sidebar stays purely presentational.
   Loaded by options.ts AFTER the sidebar markup mounts. */
(function () {
  'use strict';

  async function initSidebar() {
    try {
      var bag = await chrome.storage.local.get('pro');
      var cache = bag && bag['pro'];
      var isPro = !!(cache && cache.active === true);
      var proCard = document.querySelector('[data-zs="pro"]');
      if (proCard) proCard.hidden = isPro;
    } catch (e) {
      // storage unavailable: leave the card visible (free-tier default).
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSidebar);
  } else {
    initSidebar();
  }
})();
