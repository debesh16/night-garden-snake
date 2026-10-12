// portal.js - the only file that talks to game-portal SDKs (CrazyGames, Poki,
// Yandex Games, GameDistribution). The portal is picked by data-portal on
// <html>, which tools/build-portals.sh sets for each build; ?portal=name
// overrides it for local testing. On the plain website ("web") every call
// is a no-op, and if an SDK fails to load the game carries on without ads.
// Portal builds put the SDK <script> in <head>; it is only loaded here when
// testing with ?portal=name.

import * as audio from './audio.js';

const root = document.documentElement;
const override = new URLSearchParams(location.search).get('portal');
export const name = (override || root.dataset.portal || 'web').toLowerCase();

// Inside a portal's iframe the page URL belongs to the portal, so share links
// would point nowhere, and portals forbid links out of the game.
export const embedded = name !== 'web' || window.self !== window.top;
export const allowLinks = !embedded;

const BREAK_GAP_MS = 3 * 60 * 1000;   // portals reject ads more often than this
const FIRST_BREAK_MS = 60 * 1000;     // no ad in the first minute of a visit
const INIT_TIMEOUT_MS = 6000;

let sdk = null;                       // active adapter, or null for no ads
let playing = false;
let busy = false;
let lastBreak = performance.now() - BREAK_GAP_MS + FIRST_BREAK_MS;
let pauseRequest = () => {};

const adAudio = (on) => audio.hold('ad', on);

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(s);
  });
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

// ---- adapters -----------------------------------------------------------------
// Each one: init(), loadingDone(), gameplay(on), commercial() -> Promise,
// rewarded() -> Promise<boolean>, happy().

const adapters = {
  crazygames() {
    let S = null;
    const request = (type) => new Promise((resolve) => {
      S.ad.requestAd(type, {
        adStarted: () => adAudio(true),
        adFinished: () => { adAudio(false); resolve(true); },
        adError: () => { adAudio(false); resolve(false); },
      });
    });
    return {
      async init() {
        if (!window.CrazyGames) await loadScript('https://sdk.crazygames.com/crazygames-sdk-v3.js');
        S = window.CrazyGames.SDK;
        await S.init();
        if (S.environment === 'disabled') throw new Error('CrazyGames SDK disabled on this domain');
        const apply = (st) => audio.hold('portal', !!(st && st.muteAudio));
        apply(S.game.settings);
        S.game.addSettingsChangeListener(apply);
        S.game.loadingStart();
      },
      loadingDone: () => S.game.loadingStop(),
      gameplay: (on) => (on ? S.game.gameplayStart() : S.game.gameplayStop()),
      commercial: () => request('midgame'),
      rewarded: () => request('rewarded'),
      happy: () => S.game.happytime(),
    };
  },

  poki() {
    let P = null;
    return {
      async init() {
        if (!window.PokiSDK) await loadScript('https://game-cdn.poki.com/scripts/v2/poki-sdk.js');
        P = window.PokiSDK;
        await P.init().catch(() => {});   // Poki: load the game even if init fails
      },
      loadingDone: () => P.gameLoadingFinished(),
      gameplay: (on) => (on ? P.gameplayStart() : P.gameplayStop()),
      commercial: () => P.commercialBreak(() => adAudio(true)).finally(() => adAudio(false)),
      rewarded: () => P.rewardedBreak(() => adAudio(true)).then((ok) => !!ok).finally(() => adAudio(false)),
      happy: () => {},
    };
  },

  yandex() {
    let Y = null;
    const fullscreen = () => new Promise((resolve) => {
      Y.adv.showFullscreenAdv({ callbacks: {
        onOpen: () => adAudio(true),
        onClose: () => { adAudio(false); resolve(); },
        onError: () => { adAudio(false); resolve(); },
      } });
    });
    const rewardedVideo = () => new Promise((resolve) => {
      let rewarded = false;
      Y.adv.showRewardedVideo({ callbacks: {
        onOpen: () => adAudio(true),
        onRewarded: () => { rewarded = true; },
        onClose: () => { adAudio(false); resolve(rewarded); },
        onError: () => { adAudio(false); resolve(false); },
      } });
    });
    return {
      async init() {
        if (!window.YaGames) await loadScript('/sdk.js');   // served by Yandex next to the game
        Y = await window.YaGames.init();
        if (typeof Y.on === 'function') {
          Y.on('game_api_pause', () => { audio.hold('portal', true); pauseRequest(); });
          Y.on('game_api_resume', () => audio.hold('portal', false));
        }
      },
      loadingDone: () => Y.features.LoadingAPI?.ready(),
      gameplay: (on) => (on ? Y.features.GameplayAPI?.start() : Y.features.GameplayAPI?.stop()),
      commercial: fullscreen,
      rewarded: rewardedVideo,
      happy: () => {},
    };
  },

  gamedistribution() {
    let rewardDone = false;
    let ready = null;
    return {
      init() {
        const gameId = root.dataset.gdId;
        if (!gameId) return Promise.reject(new Error('set data-gd-id on <html> (GD_GAME_ID when building)'));
        ready = new Promise((resolve, reject) => {
          window.GD_OPTIONS = {
            gameId,
            onEvent(event) {
              switch (event.name) {
                case 'SDK_READY': resolve(); break;
                case 'SDK_ERROR': reject(new Error('GameDistribution SDK error')); break;
                case 'SDK_GAME_PAUSE': adAudio(true); pauseRequest(); break;
                case 'SDK_GAME_START': adAudio(false); break;
                case 'SDK_REWARDED_WATCH_COMPLETE': rewardDone = true; break;
                default: break;
              }
            },
          };
        });
        return loadScript('https://html5.api.gamedistribution.com/main.min.js').then(() => ready);
      },
      loadingDone: () => {},
      gameplay: () => {},
      commercial: () => Promise.resolve(window.gdsdk.showAd()).catch(() => {}).finally(() => adAudio(false)),
      async rewarded() {
        rewardDone = false;
        try { await window.gdsdk.showAd('rewarded'); } catch { /* no fill */ }
        adAudio(false);
        return rewardDone;
      },
      happy: () => {},
    };
  },
};

// ---- public API ----------------------------------------------------------------

export async function init() {
  const make = adapters[name];
  if (!make) return false;
  const a = make();
  try {
    await withTimeout(a.init(), INIT_TIMEOUT_MS);
    sdk = a;
  } catch (err) {
    console.warn('[portal] running without ads:', err.message);
    sdk = null;
  }
  return !!sdk;
}

const safe = (fn) => { try { return fn(); } catch (err) { console.warn('[portal]', err); return undefined; } };

/** The game asks to be paused (the portal is showing something over it). */
export function onPauseRequest(fn) { pauseRequest = fn; }

export function loadingDone() { if (sdk) safe(() => sdk.loadingDone()); }

/** Tell the portal whether the snake is moving. Repeated calls are ignored. */
export function gameplay(on) {
  if (!sdk || playing === on) return;
  playing = on;
  safe(() => sdk.gameplay(on));
}

/** A moment of delight (new best score). Only CrazyGames uses it. */
export function happy() { if (sdk) safe(() => sdk.happy()); }

export const hasRewarded = () => !!sdk;

/**
 * Run next() after an interstitial ad, if one is due. Called from the
 * buttons on the game-over screen, never during play.
 */
export async function breakThen(next) {
  if (busy) return;
  if (!sdk || performance.now() - lastBreak < BREAK_GAP_MS) { next(); return; }
  busy = true;
  gameplay(false);
  try { await safe(() => sdk.commercial()); } catch { /* no ad is fine */ }
  lastBreak = performance.now();
  busy = false;
  next();
}

/** Show a rewarded ad. Resolves true only if the player earned the reward. */
export async function rewarded() {
  if (!sdk || busy) return false;
  busy = true;
  gameplay(false);
  let ok = false;
  try { ok = !!(await safe(() => sdk.rewarded())); } catch { ok = false; }
  lastBreak = performance.now();   // rewarded ads count toward the ad interval
  busy = false;
  return ok;
}
