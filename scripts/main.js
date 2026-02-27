/**
 * RMU Phase Tracker v3 (Foundry VTT v13)
 * Baseline build: 0.6.19.37.35.15-fix136-movepace-totalbmr
 *
 * This module adds a Phase Tracker UI to RMU combat and enforces movement rules by phase.
 *
 * IMPORTANT STATE (high-level)
 * - MODULE_ID: Foundry flag namespace used on Combat documents.
 * - UI_VERSION: string shown in the tracker header (keep in sync with code changes).
 *
 * - Authoritative combat state (GM-written):
 *   - Stored on the Combat document under flags[MODULE_ID].state
 *   - Contains per-combatant planning selections (planActions/planCosts/planAuto, bonusCount, etc.)
 *
 * - Pending (optimistic) state (local per-client):
 *   - Lets the UI + movement checks react instantly to dropdown/toggle changes
 *   - Cleared/merged once the GM flag update arrives
 *
 * MOVEMENT TRACKING (per token)
 * - _moveTrack: committed movement used so far this round, broken down by internal slots
 * - _movePreview: live drag preview allocations (updates the overlay while dragging)
 * - _prevPhaseCarry: snapshot of the previous round's last phase movement totals
 *   (used for the 1.25× BMR eligibility lookback across round boundaries)
 *
 * KEY WORKFLOWS (where to look)
 * - UI lifecycle:
 *   - openTracker()/closeTracker() : create/destroy the Application
 *   - renderCombatTracker hook      : injects the header button and auto-opens
 *   - updateCombat/combatTurn hooks : keep phase/round view current
 *
 * - Planning selections:
 *   - applyVddValue(...)            : handles dropdown/toggle changes and writes state
 *   - requestStatePathUpdate(...)   : routes writes via GM (socket for players)
 *
 * - Movement enforcement & overlays:
 *   - preUpdateToken hook           : clamps/blocks movement and sets pending overlay payload
 *   - updateToken hook              : updates overlay text after movement commits
 *   - buildMovePreview(...)         : computes live-drag overlay values
 *   - computeMoveCaps(...)          : resolves caps from BMR, concentration, load, instant action
 *
 * NOTE
 * - This file is large by design (single-entry module). When editing, keep overlay math
 *   consistent between: enforcement (preUpdateToken), live preview, and UI overlay render.
 */



// ---------------------------------------------------------------------------
// Module settings & initialization
// ---------------------------------------------------------------------------
Hooks.once("init", () => {
  
  // Client: how many rounds worth of phases to display (1-5)
  game.settings.register(MODULE_ID, "roundsShown", {
    name: "Rounds Shown",
    hint: "How many rounds of phases to show in the tracker UI.",
    scope: "client",
    config: false,
    type: Number,
    default: 1
  });

  // World: optional JSON override of action definitions. If empty/invalid, defaults are used.
  game.settings.register(MODULE_ID, "actionsConfig", {
    name: "Actions Config",
    hint: "JSON array override for actions list; leave blank to use built-in defaults.",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });


  // Client: show action images next to selectors (if assigned).
  game.settings.register(MODULE_ID, "showActionImages", {
    name: "Show Action Images",
    hint: "Display assigned action images next to the currently selected action for each selector.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  // World: actionKey -> image path mapping.
  game.settings.register(MODULE_ID, "actionImageMap", {
    name: "Action Image Map",
    hint: "Mapping of action keys to image paths.",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  // World: stores the JournalEntry id for the built-in Player Guide.
  // The module will create the JournalEntry automatically (GM only) if it does not exist.
  game.settings.register(MODULE_ID, "playerGuideJournalId", {
    name: "Player Guide Journal Id",
    hint: "Internal id of the Player Guide JournalEntry created by the module.",
    scope: "world",
    config: false,
    type: String,
    default: "",
    restricted: true
  });

  // World: configuration UI for assigning action images.
  game.settings.registerMenu(MODULE_ID, "actionImagesConfig", {
    name: "Action Images...",
    label: "Configure Action Images",
    hint: "Assign images to actions using the file picker.",
    scope: "world",
    config: true,
    type: ActionImagesConfig,
    restricted: true
  });

// Settings
});

const MODULE_ID = "rmu-phase-tracker-v3";

// UI build/version label: shown in the tracker header.
// Update this whenever code changes so the UI always reflects the latest generation of code,
// even if module.json is unchanged.
const UI_VERSION = "0.6.19.37.35.15-fix145-movecomplete-gated";

// --- Player Guide JournalEntry --------------------------------------------
const PLAYER_GUIDE_TITLE = "RMU Phase Tracker v3 — Player Guide";
const PLAYER_GUIDE_PAGE_NAME = "Player Guide";

function _getPlayerGuideHtml() {
  // Inline styles only (Foundry journal-safe). Keep this verbose but scannable.
  return `
<div style="font-family: Vollkorn, serif; color:#111; line-height:1.35; background:#f5f0dc !important; background-image:none !important; padding:14px 16px; border:2px solid rgba(75,58,163,0.25); border-radius:12px;">
  <h2 style="color:#4b3aa3 !important; font-family:'Ghost Theory', serif; font-weight:800; margin:0 0 10px 0;">RMU Phase Tracker v3 — Player Guide</h2>
  <p style="margin:0 0 14px 0;"><span style="font-family: Vollkorn, serif;">This tracker is a phase-by-phase planner and record. When combat advances, you pick what you are doing in the current phase (or the current slot inside a phase card). The tracker also handles bonus AP spending, ongoing state toggles (like concentration/held position), multi-phase action chains, and contextual reminders/warnings.</span></p>

  <table style="width:100%; border-collapse:collapse; margin:0 0 18px 0;"><tr><td style="border:2px solid #1aa59a; border-radius:10px; padding:10px;">
    <div style="font-family: Vollkorn, serif;"><strong style="color:#1aa59a !important;">Your loop each phase:</strong>
      <span>Check Round/Phase → set ongoing toggles (if relevant) → decide Bonus AP (if any) → pick the action for the current phase/slot → repeat when the phase advances.</span>
    </div>
  </td></tr></table>

  <h3 style="color:#4b3aa3 !important; font-family:'Ghost Theory', serif; font-weight:800; margin:0 0 8px 0;">1. Round And Phase Header</h3>
  <p style="margin:0 0 18px 0;"><span style="font-family: Vollkorn, serif;">At the top you will see the current <strong>Round</strong> and <strong>Phase</strong> (for example, “Round 3 — Phase 2 of 4”). Always check this before selecting anything. If you are in a compressed mode (1 or 2 phases per round), the header still matters—your choices are being placed into the current phase’s slots.</span></p>

  <h3 style="color:#4b3aa3 !important; font-family:'Ghost Theory', serif; font-weight:800; margin:0 0 8px 0;">2. Bonus Action Controls</h3>
  <p style="margin:0 0 10px 0;"><span style="font-family: Vollkorn, serif;">The <strong>Bonus Action</strong> controls (− / number / +) indicate how many <strong>Bonus AP</strong> you intend to spend. If you have no bonus AP, leave it at <strong>0</strong>. If you raise it, the tracker may display bonus-action slots/cards so you can choose what the bonus action actually is.</span></p>
  <table style="width:100%; border-collapse:collapse; margin:0 0 18px 0;"><tr><td style="border:1px solid rgba(0,0,0,0.15); border-radius:10px; padding:10px;">
    <div style="font-family: Vollkorn, serif;"><strong style="color:#1aa59a !important;">Tip:</strong>
      <span>Only increase Bonus AP when you truly intend to take a bonus action. It is a declaration that can change what the tracker expects you to pick.</span>
    </div>
  </td></tr></table>

  <h3 style="color:#4b3aa3 !important; font-family:'Ghost Theory', serif; font-weight:800; margin:0 0 8px 0;">3. Instantaneous Actions</h3>
  <p style="margin:0 0 18px 0;"><span style="font-family: Vollkorn, serif;">The <strong>Instantaneous Actions</strong> dropdown is for table-approved “quick” actions that do not replace your main phase action. Use it only when it applies. If you do not need it, leave it alone.</span></p>

  <h3 style="color:#4b3aa3 !important; font-family:'Ghost Theory', serif; font-weight:800; margin:0 0 8px 0;">4. Concentrating On… Toggles</h3>
  <p style="margin:0 0 10px 0;"><span style="font-family: Vollkorn, serif;">The <strong>Concentrating on…</strong> row is a set of toggles representing ongoing states (e.g., Concentration, Held Position, Partial Dodge/Block, Spell Preparation, Hold Action). Turn a toggle on when you begin maintaining that state, keep it on while you maintain it, and turn it off when you stop.</span></p>
  <table style="width:100%; border-collapse:collapse; margin:0 0 18px 0;"><tr><td style="border:2px solid #4b3aa3; border-radius:10px; padding:10px;">
    <div style="font-family: Vollkorn, serif;"><strong style="color:#4b3aa3 !important;">Two-at-once lockout:</strong>
      <span>If you activate <strong>two concentration-type toggles</strong> at the same time, the tracker shows a warning and the <strong>action selectors are locked out</strong>. To continue selecting actions, switch off the extra toggle so you return to an allowed state.</span>
    </div>
  </td></tr></table>
  <p style="margin:0 0 18px 0;"><span style="font-family: Vollkorn, serif;">Best practice: set your toggles <strong>before</strong> choosing your phase action for the current phase/slot, so the tracker interprets costs and reminders correctly.</span></p>

  <h3 style="color:#4b3aa3 !important; font-family:'Ghost Theory', serif; font-weight:800; margin:0 0 8px 0;">5. Phase Cards And Action Slots</h3>
  <p style="margin:0 0 10px 0;"><span style="font-family: Vollkorn, serif;">Phase cards contain the dropdowns where you choose your main actions. Your world may be configured for <strong>4</strong>, <strong>2</strong>, or <strong>1</strong> phase per round:</span></p>
  <ul style="margin:0 0 14px 22px;">
    <li style="margin:0 0 8px 0;"><span style="font-family: Vollkorn, serif;"><strong style="color:#1aa59a !important;">4 phases:</strong> one card per phase, typically one selector per phase. Choose in the current phase’s selector.</span></li>
    <li style="margin:0 0 8px 0;"><span style="font-family: Vollkorn, serif;"><strong style="color:#1aa59a !important;">2 phases:</strong> fewer cards, but each phase card can contain multiple selectors (slots). Treat these as separate spends inside that phase—pick the slot you are meant to pick right now.</span></li>
    <li style="margin:0;"><span style="font-family: Vollkorn, serif;"><strong style="color:#1aa59a !important;">1 phase:</strong> a single phase card contains multiple selectors (slots) across the round. Again: pick the current slot when prompted.</span></li>
  </ul>

  <h4 style="color:#1aa59a !important; font-family: Vollkorn, serif; margin:0 0 6px 0;">Multi-phase actions (chains)</h4>
  <p style="margin:0 0 18px 0;"><span style="font-family: Vollkorn, serif;">Some actions cost more than 1 AP. The tracker represents these as a multi-slot/multi-phase commitment (a “chain”). If you start a multi-phase action, the tracker expects follow-through selections until the action completes. If you change your selection mid-way, you can break the chain and lose the unpaid remainder (depending on table rules). If you intended to continue, keep selecting the matching follow-through action as the phase advances.</span></p>

  <h3 style="color:#4b3aa3 !important; font-family:'Ghost Theory', serif; font-weight:800; margin:0 0 8px 0;">6. Reminders And Warnings</h3>
  <p style="margin:0 0 10px 0;"><span style="font-family: Vollkorn, serif;">Reminders do <strong>not</strong> all behave the same way. Some are interval-based (e.g., a periodic “(RNDx6)” style reminder), some are conditional (only show when an interval is reached <em>and</em> a specific state is true), and some are immediate state warnings (for example, the two-concentration lockout).</span></p>

  <table style="width:100%; border-collapse:collapse; margin:0 0 12px 0;"><tr><td style="border:1px solid rgba(0,0,0,0.15); border-radius:10px; padding:10px;">
    <div style="font-family: Vollkorn, serif;"><strong style="color:#1aa59a !important;">Buttons vs labels:</strong>
      <span>Some reminders appear as <strong>buttons</strong>. After you make the roll, you can click the reminder button to acknowledge/clear it. Other reminders are <strong>labels</strong> that serve as a warning or condition note and are not always meant to be clicked away.</span>
    </div>
  </td></tr></table>

  <p style="margin:0 0 10px 0;"><span style="font-family: Vollkorn, serif;"><strong>Endurance Roll REQ (RNDx6)</strong> is an example of an interval reminder that can be shown as a button. When it appears, make the roll as your GM instructs, then acknowledge it if it is presented as a button.</span></p>
  <p style="margin:0 0 18px 0;"><span style="font-family: Vollkorn, serif;"><strong>Mental Focus roll REQ (RNDx6)</strong> is an example of a conditional reminder: it depends on a concentration state being maintained (and the tracker’s internal conditions for when the check is due). If it is shown as a button, acknowledge it after the roll. If you see an additional label (for example pace notes), treat that as a condition note and follow your table’s rule.</span></p>

  <h3 style="color:#4b3aa3 !important; font-family:'Ghost Theory', serif; font-weight:800; margin:0 0 8px 0;">7. Quick troubleshooting</h3>
  <ul style="margin:0 0 0 22px;">
    <li style="margin:0 0 8px 0;"><span style="font-family: Vollkorn, serif;"><strong style="color:#1aa59a !important;">Selectors are disabled:</strong> check if you have two concentration-type toggles on; turn one off to unlock.</span></li>
    <li style="margin:0 0 8px 0;"><span style="font-family: Vollkorn, serif;"><strong style="color:#1aa59a !important;">Reminder won’t go away:</strong> if it is a label, it is informational. If it is a button, click it after making the roll.</span></li>
    <li style="margin:0;"><span style="font-family: Vollkorn, serif;"><strong style="color:#1aa59a !important;">Actions look inconsistent across slots:</strong> you may be mid-chain. Continue the chain selections until complete (or accept that you are abandoning the remainder).</span></li>
  </ul>
</div>
  `;
}

// ---------------------------------------------------------------------------
// Player Guide: load from bundled HTML file (preferred) and keep the world
// journal entry up to date.
// ---------------------------------------------------------------------------

async function _loadPlayerGuideHtml() {
  // Prefer the bundled file so the guide is editable without touching JS.
  try {
    const mod = game.modules?.get?.(MODULE_ID);
    const base = (mod?.path ?? `modules/${MODULE_ID}`);
    const url = `${base}/docs/player-guide.html`;
    const res = await fetch(url, { cache: "no-store" });
    if (res?.ok) {
      const txt = await res.text();
      if (typeof txt === "string" && txt.trim().length) return txt;
    }
  } catch (e) {
    console.warn(`${MODULE_ID} | Failed to load docs/player-guide.html, falling back to inline guide`, e);
  }

  // Fallback: older inline guide (kept for resilience).
  try { return String(_getPlayerGuideHtml?.() ?? ""); } catch (_) { return ""; }
}

async function _updatePlayerGuideJournal(journalEntry, html) {
  if (!journalEntry || typeof html !== "string") return;

  // Try to find the page by name. If missing, create it.
  const page = journalEntry.pages?.find?.(p => p?.name === PLAYER_GUIDE_PAGE_NAME) ?? null;

  const flags = { [MODULE_ID]: { isPlayerGuide: true, guideVersion: String(game.modules?.get?.(MODULE_ID)?.version ?? "") } };

  try {
    // Keep a flag on the entry so we can safely update it in future builds.
    await journalEntry.update({ flags });
  } catch (_) {}

  if (!page) {
    try {
      await journalEntry.createEmbeddedDocuments("JournalEntryPage", [{
        name: PLAYER_GUIDE_PAGE_NAME,
        type: "text",
        text: { content: html, format: 1 },
        flags: { [MODULE_ID]: { isPlayerGuidePage: true } }
      }]);
    } catch (e) { console.error(e); }
    return;
  }

  // Update only if the content is different (prevents needless DB writes).
  const current = String(page?.text?.content ?? "");
  if (current.trim() === html.trim()) return;

  try {
    await journalEntry.updateEmbeddedDocuments("JournalEntryPage", [{
      _id: page.id,
      text: { content: html, format: 1 },
      flags: { [MODULE_ID]: { isPlayerGuidePage: true } }
    }]);
  } catch (e) {
    console.error(e);
  }
}

async function _ensurePlayerGuideJournal() {
  const existingId = String(game.settings.get(MODULE_ID, "playerGuideJournalId") ?? "").trim();
  try {
    if (existingId) {
      const existing = game.journal?.get?.(existingId);
      if (existing) {
        try {
          // Keep the in-world journal entry up to date with the module's current guide.
          if (game.user?.isGM) {
            const html = await _loadPlayerGuideHtml();
            await _updatePlayerGuideJournal(existing, html);
          }
        } catch (e) { console.error(e); }
        return existing;
      }
    }
  } catch (_) {}

  // If not found by id, try by name (in case the world already has it).
  try {
    const byName = game.journal?.find?.(j => j?.name === PLAYER_GUIDE_TITLE);
    if (byName) {
      await game.settings.set(MODULE_ID, "playerGuideJournalId", byName.id);
      try {
        if (game.user?.isGM) {
          const html = await _loadPlayerGuideHtml();
          await _updatePlayerGuideJournal(byName, html);
        }
      } catch (e) { console.error(e); }
      return byName;
    }
  } catch (_) {}

  // Create (GM only).
  if (!game.user?.isGM) return null;

  const html = await _loadPlayerGuideHtml();
  const OBSERVER = (globalThis?.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2);

  const created = await JournalEntry.create({
    name: PLAYER_GUIDE_TITLE,
    ownership: { default: OBSERVER },
    flags: { [MODULE_ID]: { isPlayerGuide: true, guideVersion: String(game.modules?.get?.(MODULE_ID)?.version ?? "") } },
    pages: [
      {
        name: PLAYER_GUIDE_PAGE_NAME,
        type: "text",
        text: { content: html, format: 1 },
        flags: { [MODULE_ID]: { isPlayerGuidePage: true } }
      }
    ]
  }, { renderSheet: false });

  if (created?.id) {
    await game.settings.set(MODULE_ID, "playerGuideJournalId", created.id);
  }
  return created ?? null;
}

async function _openPlayerGuideJournal() {
  try {
    let je = null;
    // If GM, auto-create if missing. If player, try to open the stored id.
    if (game.user?.isGM) {
      je = await _ensurePlayerGuideJournal();
    }
    if (!je) {
      const id = String(game.settings.get(MODULE_ID, "playerGuideJournalId") ?? "").trim();
      if (id) je = game.journal?.get?.(id) ?? null;
    }
    if (je) {
      je.sheet?.render?.(true);
      return;
    }
    ui.notifications?.warn?.("Player Guide is not available yet.");
  } catch (e) {
    console.error(e);
    ui.notifications?.error?.("Failed to open Player Guide. See console.");
  }
}


// ---------------------------------------------------------------------------
// Ready hook: wire up runtime behavior after Foundry is fully initialized
// ---------------------------------------------------------------------------
Hooks.once("ready", () => {
  // Movement HUD overlay has been removed; if a prior build injected the element,
  // clean it up on load so it cannot linger across hot-reloads.
  try { document.getElementById("rmu-cpt-move-hud")?.remove?.(); } catch (_) {}

  // Create the Player Guide journal entry automatically (GM only) so players can open it.
  try {
    if (game.user?.isGM) _ensurePlayerGuideJournal().catch(console.error);
  } catch (_) {}

  // If the world is reloaded while combat is already active, ensure the shared
  // combat state exists so movement enforcement works even before the UI is opened.
  try {
    const c = game.combat;
    if (c?.active) requestInitState(c.id);
  } catch (_) {}


// Patch token drag handlers so Move overlays can update while the token is being dragged
// (Foundry only commits token position on drop).
try {
  const proto = Token?.prototype;
  if (proto && !proto.__rmuCptMoveDragPatched) {
    proto.__rmuCptMoveDragPatched = true;

    const _origMove = proto._onDragLeftMove;
    const _origDrop = proto._onDragLeftDrop;
    const _origCancel = proto._onDragLeftCancel;

    if (typeof _origMove === "function") {
      proto._onDragLeftMove = function (...args) {
        const r = _origMove.apply(this, args);
        try {
          // If the tracker UI is not open on this client, do not run drag-preview overlays.
          if (!(globalThis._rmuCptApp?.rendered)) return r;
          // Throttle preview refresh to avoid excessive renders.
          const tokenUuid = getTokenUuid(this.document);
          const now = Date.now();
          const last = _moveHudThrottle.get(tokenUuid + ":pv") ?? 0;
          if (now - last > 60) {
            _moveHudThrottle.set(tokenUuid + ":pv", now);
            _updateMovePreviewForToken(this);
            requestAppRefresh();
          }
        } catch (_) {}
        return r;
      };
    }

    if (typeof _origDrop === "function") {
      proto._onDragLeftDrop = function (...args) {
        try {
          if (globalThis._rmuCptApp?.rendered) {
            _clearMovePreviewForToken(this.document);
            requestAppRefresh();
          }
        } catch (_) {}
        return _origDrop.apply(this, args);
      };
    }

    if (typeof _origCancel === "function") {
      proto._onDragLeftCancel = function (...args) {
        try {
          if (globalThis._rmuCptApp?.rendered) {
            _clearMovePreviewForToken(this.document);
            requestAppRefresh();
          }
        } catch (_) {}
        return _origCancel.apply(this, args);
      };
    }
  }
} catch (e) {
  console.error(`${MODULE_ID} | token drag patch error`, e);
}

});

async function openPlayerGuide() {
  try {
    let id = String(game.settings.get(MODULE_ID, "playerGuideJournalId") ?? "").trim();
    if (!id) {
      const doc = await _ensurePlayerGuideJournal();
      id = doc?.id ? String(doc.id) : "";
    }
    if (!id) {
      ui.notifications?.warn?.("Player Guide is not available yet.");
      return;
    }
    const je = game.journal?.get?.(id) || game.journal?.find?.(j => j?.id === id);
    if (!je) {
      // Try re-create if GM.
      const doc = await _ensurePlayerGuideJournal();
      if (doc?.sheet) doc.sheet.render(true);
      else ui.notifications?.warn?.("Player Guide JournalEntry not found.");
      return;
    }
    je.sheet.render(true);
  } catch (e) {
    console.error(e);
    ui.notifications?.error?.("Failed to open Player Guide. See console.");
  }
}

// ---------------------------------------------------------------------------
// History window
// ---------------------------------------------------------------------------

let _historyDialog = null;

function _actionLabelForKey(actionsMap, key) {
  const k = String(key ?? "none");
  if (!k || k === "none" || k === "-") return "-";
  if (k === MOVE_ACTION_KEY) return "Move Your BMR";
  const def = actionsMap?.get?.(k);
  return String(def?.label ?? k);
}

async function openHistoryWindowForCurrentCombatant() {
  const combat = game.combat;
  if (!combat?.active) {
    ui.notifications?.warn?.("No active combat.");
    return;
  }
  const cur = combat.combatant;
  if (!cur) {
    ui.notifications?.warn?.("No current combatant.");
    return;
  }

  // Ensure we have a state blob to read from (GM creates immediately; player requests via socket).
  try { requestInitState(combat.id); } catch (_) {}

  const state = getStateForRead(combat) ?? {};
  const cd = state?.combatants?.[cur.id] ?? {};
  const planActions = cd?.planActions ?? {};

  const actions = parseActionsConfig();
  const actionsMap = actionsToMap(actions);

  const pi = detectPhaseInfo(combat);
  const nowRound = getReminderRound(combat, state, pi);
  const roundsShown = 5;
  const startRound = Math.max(1, nowRound - (roundsShown - 1));

  const rows = [];
  for (let r = startRound; r <= nowRound; r++) {
    for (let p = 1; p <= 4; p++) {
      const km = phaseKey(r, p, "m");
      const kb = phaseKey(r, p, "b");
      const vm = planActions?.[km];
      const vb = planActions?.[kb];

      // Only show rows that have *something* selected in either slot.
      if ((vm === undefined || String(vm) === "none") && (vb === undefined || String(vb) === "none")) continue;

      rows.push({
        round: r,
        slot: p,
        main: _actionLabelForKey(actionsMap, vm),
        bonus: _actionLabelForKey(actionsMap, vb)
      });
    }
  }

  const actorName = cur?.actor?.name ?? "Combatant";

  let content = "";
  if (!rows.length) {
    content = `<div style="padding:8px 4px;">No history stored yet for <b>${foundry.utils.escapeHTML(actorName)}</b>.</div>`;
  } else {
    const headerStyle = "text-align:left; padding:4px 8px; border-bottom:1px solid #666;";
    const cellStyle = "padding:4px 8px; border-bottom:1px solid #333;";
    content = `
      <div style="max-height:60vh; overflow:auto;">
        <table style="width:100%; border-collapse:collapse;">
          <thead>
            <tr>
              <th style="${headerStyle}">Round</th>
              <th style="${headerStyle}">Slot</th>
              <th style="${headerStyle}">Main</th>
              <th style="${headerStyle}">Bonus</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td style="${cellStyle}">${r.round}</td>
                <td style="${cellStyle}">${r.slot}</td>
                <td style="${cellStyle}">${foundry.utils.escapeHTML(r.main)}</td>
                <td style="${cellStyle}">${foundry.utils.escapeHTML(r.bonus)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <div style="opacity:0.85; font-size:12px; padding-top:6px;">
        Showing the last ${roundsShown} rounds (when data exists).
      </div>
    `;
  }

  try { _historyDialog?.close?.(); } catch (_) {}
  _historyDialog = new Dialog(
    {
      title: `History — ${actorName}`,
      content,
      buttons: {
        close: { label: "Close" }
      },
      default: "close"
    },
    { width: 720 }
  );
  _historyDialog.render(true);
}

const BUILD_VERSION_FALLBACK = "0.6.19.22";

// Cache info parsed from the Combat Tracker sidebar so the tracker UI can render correctly
// immediately when combat starts (before any user interaction triggers a refresh).
const _combatTrackerInfoCache = new Map(); // combatId -> { apPerPhase, phaseCount, phase, ts }

// Watch the Combat Tracker sidebar for label changes (some RMU builds update the phase/AP text
// without re-rendering the combat tracker app). When it changes, refresh our UI immediately.
let _combatTrackerObserver = null;
let _combatTrackerObserverCombatId = null;
let _combatTrackerLastParsed = null;

// Parse "Spend X AP per Phase" and "Phase A of B" from Combat Tracker HTML/root text.
function _parseCombatTrackerInfoFromRoot(root) {
  try {
    const text = String(root?.textContent ?? "").replace(/\s+/g, " ");
    let apPerPhase = null;
    let phaseCount = null;
    let phase = null;

    // AP per phase label variants seen across RMU builds.
    // Examples:
    //  - "Spend 2 AP per Phase"
    //  - "Spend 2 AP/Phase"
    //  - "Spend 2 AP per Action Phase"
    //  - "Spend 2 AP/Action Phase"
    const mAp =
      text.match(/Spend\s*([0-9]+(?:\.[0-9]+)?)\s*AP\s*(?:\/\s*Phase|\/\s*Action\s*Phase|per\s*Phase|per\s*Action\s*Phase)/i)
      || text.match(/AP\s*per\s*(?:Action\s*)?Phase\s*:?\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (mAp) {
      const n = Number(mAp[1] ?? mAp[0]);
      if (Number.isFinite(n) && n > 0) apPerPhase = n;
    }

    // Phase count label variants.
    // Examples:
    //  - "Phase 1 of 2"
    //  - "Phase 1/2"
    //  - "Action Phase 1 of 2"
    const mPh =
      text.match(/(?:Action\s*)?Phase\s*(\d+)\s*(?:of|\/)\s*(\d+)/i)
      || text.match(/Phases\s*:?\s*(\d+)/i);
    if (mPh) {
      if (mPh.length >= 3) {
        const p = parseInt(mPh[1], 10);
        const pc = parseInt(mPh[2], 10);
        if (Number.isFinite(pc) && pc >= 1 && pc <= 20) phaseCount = pc;
        if (Number.isFinite(p) && p >= 1 && (phaseCount ? p <= phaseCount : true)) phase = p;
      } else {
        const pc = parseInt(mPh[1], 10);
        if (Number.isFinite(pc) && pc >= 1 && pc <= 20) phaseCount = pc;
      }
    }

    return { apPerPhase, phaseCount, phase };
  } catch (_) {
    return { apPerPhase: null, phaseCount: null, phase: null };
  }
}

function _updateCombatTrackerInfoCache(combatId, root) {
  if (!combatId) return;
  const info = _parseCombatTrackerInfoFromRoot(root);
  const prev = _combatTrackerInfoCache.get(combatId) ?? {};
  const merged = {
    apPerPhase: (info.apPerPhase ?? prev.apPerPhase ?? null),
    phaseCount: (info.phaseCount ?? prev.phaseCount ?? null),
    phase: (info.phase ?? prev.phase ?? null),
    ts: Date.now()
  };
  _combatTrackerInfoCache.set(combatId, merged);
}

function _getCachedCombatTrackerInfo(combatId) {
  return _combatTrackerInfoCache.get(combatId) ?? null;
}

function _ensureCombatTrackerObserver(combatId, root) {
  try {
    if (!combatId) return;
    const el = (root instanceof HTMLElement) ? root : (root?.[0] ?? root);
    if (!el) return;

    // If combat changes, restart the observer.
    if (_combatTrackerObserver && _combatTrackerObserverCombatId !== combatId) {
      try { _combatTrackerObserver.disconnect(); } catch (_) {}
      _combatTrackerObserver = null;
      _combatTrackerObserverCombatId = null;
      _combatTrackerLastParsed = null;
    }

    if (_combatTrackerObserver) return;

    _combatTrackerObserverCombatId = combatId;
    _combatTrackerLastParsed = _parseCombatTrackerInfoFromRoot(el);

    _combatTrackerObserver = new MutationObserver(() => {
      try {
        const next = _parseCombatTrackerInfoFromRoot(el);
        const prev = _combatTrackerLastParsed ?? {};
        const changed =
          (next.apPerPhase && next.apPerPhase !== prev.apPerPhase) ||
          (next.phaseCount && next.phaseCount !== prev.phaseCount) ||
          (next.phase && next.phase !== prev.phase);

        if (changed) {
          _combatTrackerLastParsed = next;
          _updateCombatTrackerInfoCache(combatId, el);
          requestAppRefresh();
        }
      } catch (_) {}
    });

    _combatTrackerObserver.observe(el, { subtree: true, childList: true, characterData: true });
  } catch (_) {}
}

// Warm up the Combat Tracker info cache by polling the sidebar DOM a few times.
// On a fresh Foundry login, the Combat Tracker may render first without the RMU
// "Spend X AP per Phase" label populated, which would otherwise make us default
// to 1 AP/phase (and thus show the wrong selector spread) until the next user action.
async function _warmCombatTrackerInfo(combat) {
  try {
    const combatId = combat?.id;
    if (!combatId) return;
    const maxTries = 8;
    for (let i = 0; i < maxTries; i++) {
      const root = ui?.combat?.element?.[0] ?? ui?.combat?.element ?? document.getElementById("combat") ?? document.querySelector("#combat") ?? document.querySelector(".combat-sidebar");
      if (root) {
        _updateCombatTrackerInfoCache(combatId, root);
        _ensureCombatTrackerObserver(combatId, root);
        const cached = _getCachedCombatTrackerInfo(combatId);
        const ap = Number(cached?.apPerPhase);
        // Break as soon as AP-per-phase becomes available.
        if (Number.isFinite(ap) && ap > 0) break;
        // If the label exists but regex didn't catch it yet, try a short wait.
        const txt = String(root.textContent ?? "");
        if (/Spend\s*\d+\s*AP/i.test(txt)) break;
      }
      // wait a tick; RMU sometimes populates labels slightly after render on first load
      await new Promise(r => setTimeout(r, 60));
    }
  } catch (_) {}
}

/**
 * World configuration UI: assign an image path to each action key.
 * Stored in game.settings (world) as an object: { [actionKey]: "path/to/img.webp" }
 */
class ActionImagesConfig extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "rmu-action-images-config",
      title: "RMU Action Images",
      template: `modules/${MODULE_ID}/templates/action-images-config.hbs`,
      width: 1500,
      height: "auto",
      closeOnSubmit: true,
      submitOnChange: false,
      resizable: false
    });
  }

  async getData(options={}) {
    let actions = parseActionsConfig();
    if (!Array.isArray(actions) || !actions.length) actions = getDefaultActions();
    const map = foundry.utils.deepClone(game.settings.get(MODULE_ID, "actionImageMap") ?? {});
    // Include a configurable image for the "none" (-) option as well.
    const rows = [
      { key: "none", label: "- (No Action / None)", path: map?.none ?? "" },
      ...actions.map(a => ({
        key: a.key,
        label: a.label,
        path: map?.[a.key] ?? ""
      }))
    ];
    return { rows };
  }

  activateListeners(html) {
    super.activateListeners(html);

    try {
      this.element.toggleClass("rmu-cpt--gm-ui", !!game.user.isGM);
      this.element.toggleClass("rmu-cpt--player-ui", !game.user.isGM);
    } catch (_) {}

    html.find("button[data-browse]").on("click", (ev) => {
      ev.preventDefault();
      const key = ev.currentTarget.dataset.browse;
      const input = html.find(`input[name="img.${key}"]`)[0];
      const fp = new FilePicker({
        type: "image",
        current: input?.value || "",
        callback: (path) => { if (input) input.value = path; }
      });
      fp.browse();
    });

    html.find("button[data-clear]").on("click", (ev) => {
      ev.preventDefault();
      const key = ev.currentTarget.dataset.clear;
      const input = html.find(`input[name="img.${key}"]`)[0];
      if (input) input.value = "";
    });
  }

  async _updateObject(event, formData) {
    const map = {};
    for (const [k, v] of Object.entries(formData || {})) {
      if (!k.startsWith("img.")) continue;
      const key = k.slice(4);
      const path = String(v ?? "").trim();
      if (path) map[key] = path;
    }
    await game.settings.set(MODULE_ID, "actionImageMap", map);
  }
}


// Ensure we only register our socket listeners once per client.
let _socketRegistered = false;
// Debounced UI refresh (keeps selections because they are stored in combat flags/state)
let _refreshTimer = null;
function requestAppRefresh() {
  if (!_app?.rendered) return;
  if (_refreshTimer) clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(() => {
    try { _app.render(false); }
catch (e) { console.error(e); }
  }, 0);
}

async function setBonusCount(combatantId, n) {
  const c = game.combat;
  if (!c) return;
  const cid = String(combatantId || "");
  if (!cid) return;
  let val = Number(n);
  if (!Number.isFinite(val)) val = 0;
  val = Math.max(0, Math.min(4, Math.trunc(val)));
  await requestStatePathUpdate({ combatId: c.id, path: `combatants.${cid}.bonusCount`, value: val });
}


function clamp(n, min, max) {
  n = Number(n ?? 0);
  if (Number.isNaN(n)) n = 0;
  return Math.min(max, Math.max(min, n));
}

function isGmOwnedActor(actor) {
  try {
    if (!actor) return false;
    const own = actor.ownership ?? {};
    for (const [userId, level] of Object.entries(own)) {
      const u = game.users?.get(userId);
      if (!u) continue;
      if (u.isGM) continue;
      // Treat any non-GM OWNER as "player-owned"
      if (Number(level) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

// GM read-only mode for player-owned actors:
// The GM may VIEW a player's actor UI but must not be able to change any of that actor's selections.
// This remains enabled for NPCs / GM-owned actors (no non-GM OWNER).
function isGmReadOnlyActor(actor) {
  try {
    if (!game.user?.isGM) return false;
    if (!actor) return false;
    return !isGmOwnedActor(actor);
  } catch (_) {
    return false;
  }
}

function isGmReadOnlyCombatant(combatantId) {
  try {
    if (!game.user?.isGM) return false;
    const cid = String(combatantId || "");
    if (!cid) return false;
    const cbt = game.combat?.combatants?.get?.(cid) ?? null;
    const actor = cbt?.actor ?? null;
    return isGmReadOnlyActor(actor);
  } catch (_) {
    return false;
  }
}


function getPrimaryOwnerUser(actor) {
  try {
    if (!actor) return null;
    const own = actor.ownership ?? {};
    const owners = [];
    for (const [userId, level] of Object.entries(own)) {
      if (Number(level) < CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) continue;
      const u = game.users?.get(userId);
      if (!u) continue;
      owners.push(u);
    }
    if (!owners.length) return null;
    // Prefer a non-GM owner if present; otherwise fall back to any GM owner.
    const nonGm = owners.filter(u => !u.isGM).sort((a,b) => (a.name||"").localeCompare(b.name||""));
    if (nonGm.length) return nonGm[0];
    const gm = owners.filter(u => u.isGM).sort((a,b) => (a.name||"").localeCompare(b.name||""));
    return gm[0] ?? null;
  } catch (_) {
    return null;
  }
}

function hexToRgba(hex, alpha) {
  try {
    if (!hex || typeof hex !== "string") return "";
    let h = hex.trim();
    if (!h) return "";

    // Support rgb()/rgba() strings (Foundry sometimes stores user color this way)
    if (/^rgba?\(/i.test(h)) {
      const m = h.match(/rgba?\(([^)]+)\)/i);
      if (!m) return "";
      // Support both comma-separated and space-separated rgb formats.
      const parts = m[1].replace(/,/g, " ").split(/\s+/).map(s => s.trim()).filter(Boolean);
      if (parts.length < 3) return "";
      const r = Number(parts[0]);
      const g = Number(parts[1]);
      const b = Number(parts[2]);
      if ([r, g, b].some(n => Number.isNaN(n))) return "";
      const a = Math.max(0, Math.min(1, Number(alpha)));
      return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
    }

    // Normalize hex strings that may omit the leading '#', or include 0x prefix
    if (h.toLowerCase().startsWith("0x")) h = h.slice(2);
    if (h.startsWith("#")) h = h.slice(1);
    // Handle #RGBA / #RRGGBBAA by dropping alpha
    if (h.length === 4) h = h.slice(0, 3);
    if (h.length === 8) h = h.slice(0, 6);
    if (h.length === 3) h = h.split("").map(ch => ch+ch).join("");
    if (h.length !== 6) return "";
    const r = parseInt(h.slice(0,2), 16);
    const g = parseInt(h.slice(2,4), 16);
    const b = parseInt(h.slice(4,6), 16);
    if ([r,g,b].some(n => Number.isNaN(n))) return "";
    const a = Math.max(0, Math.min(1, Number(alpha)));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  } catch (_) {
    return "";
  }
}

function normalizeColorToHex(color) {
  try {
    if (!color || typeof color !== "string") return "";
    let c = color.trim();
    if (!c) return "";
    if (/^rgba?\(/i.test(c)) {
      const m = c.match(/rgba?\(([^)]+)\)/i);
      if (!m) return "";
      // Support both comma-separated and space-separated rgb formats.
      const parts = m[1].replace(/,/g, " ").split(/\s+/).map(s => s.trim()).filter(Boolean);
      if (parts.length < 3) return "";
      const r = Math.max(0, Math.min(255, Math.round(Number(parts[0]))));
      const g = Math.max(0, Math.min(255, Math.round(Number(parts[1]))));
      const b = Math.max(0, Math.min(255, Math.round(Number(parts[2]))));
      if ([r, g, b].some(n => Number.isNaN(n))) return "";
      return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    }
    if (c.toLowerCase().startsWith("0x")) c = c.slice(2);
    if (!c.startsWith("#") && /^[0-9a-f]{3,8}$/i.test(c)) c = `#${c}`;
    if (!c.startsWith("#")) return "";
    let h = c.slice(1);
    if (h.length === 4) h = h.slice(0, 3);
    if (h.length === 8) h = h.slice(0, 6);
    if (h.length === 3) h = h.split("").map(ch => ch + ch).join("");
    if (h.length !== 6) return "";
    if (!/^[0-9a-f]{6}$/i.test(h)) return "";
    return `#${h.toLowerCase()}`;
  } catch (_) {
    return "";
  }
}

// Accept Foundry Color objects, numbers, or strings and normalize to #rrggbb.
function normalizeAnyColorToHex(color) {
  try {
    if (color == null) return "";
    if (typeof color === "string") return normalizeColorToHex(color);
    if (typeof color === "number" && Number.isFinite(color)) {
      const n = (Math.trunc(color) >>> 0) & 0xFFFFFF;
      return `#${n.toString(16).padStart(6, "0")}`;
    }
    if (typeof color === "object") {
      // Foundry Color often provides css() -> "rgb(...)" or "#rrggbb".
      if (typeof color.css === "function") {
        const css = color.css();
        const hex = normalizeColorToHex(String(css));
        if (hex) return hex;
      }
      // valueOf() on Foundry Color commonly returns a number.
      const v = (typeof color.valueOf === "function") ? color.valueOf() : color;
      if (typeof v === "number" && Number.isFinite(v)) {
        const n = (Math.trunc(v) >>> 0) & 0xFFFFFF;
        return `#${n.toString(16).padStart(6, "0")}`;
      }
      // Last resort: try toString()
      const s = String(color);
      return normalizeColorToHex(s);
    }
    return "";
  } catch (_) {
    return "";
  }
}

// Best-effort retrieval of the *configured* Foundry User color (the same color used for the user dot).
// Foundry has shifted where this lives across versions; we probe several likely locations.
function getCurrentUserColorHex() {
  try {
    const u = game?.user;
    if (!u) return "#888888";
    const candidates = [
      u.color,
      u?.document?.color,
      u?._source?.color,
      u?.document?._source?.color,
      u?.data?.color,
      u?.flags?.core?.color,
      u?.document?.flags?.core?.color,
      game?.users?.get?.(u.id)?.color,
      game?.users?.get?.(u.id)?.document?.color
    ].filter(Boolean);
    for (const c of candidates) {
      const hex = normalizeAnyColorToHex(c);
      if (hex) return hex;
    }
    return "#888888";
  } catch (_) {
    return "#888888";
  }
}

// Resolve a Foundry user's configured "dot" color to a hex string.
// Handles Foundry Color objects, numbers, hex strings, and rgb() strings.
function getUserDotColorHex(user) {
  try {
    if (!user) return "";
    const candidates = [
      user.color,
      user?.document?.color,
      user?._source?.color,
      user?.document?._source?.color,
      user?.data?.color,
      user?.flags?.core?.color,
      user?.document?.flags?.core?.color,
      game?.users?.get?.(user.id)?.color,
      game?.users?.get?.(user.id)?.document?.color
    ].filter(Boolean);
    for (const c of candidates) {
      const hex = normalizeAnyColorToHex(c);
      if (hex) return hex;
    }
    return "";
  } catch (_) {
    return "";
  }
}

// For GM clients: tint the UI to match the *player who owns the current-turn combatant* (if any).
// For player clients: always tint to the current logged-in user.
function getTintHexForCombatant(combatant) {
  try {
    // Non-GM: always use the current logged-in user color.
    if (!game.user?.isGM) return getCurrentUserColorHex();

    const actor = combatant?.actor;
    const ownerUser = getPrimaryOwnerUser(actor);
    // If there is a non-GM OWNER, use that player's configured dot color.
    if (ownerUser && !ownerUser.isGM) {
      const hex = getUserDotColorHex(ownerUser);
      if (hex) return hex;
    }
    // Otherwise (GM-owned combatant or no owner), fall back to GM user's own dot color.
    return getCurrentUserColorHex();
  } catch (_) {
    return getCurrentUserColorHex();
  }
}

// For window instances: compute tint based on what this tracker is currently showing.
function getTintHexForTrackerWindow(html) {
  try {
    // Non-GM: current user.
    if (!game.user?.isGM) return getCurrentUserColorHex();

    // GM: match the owner of the combatant currently displayed by this tracker window.
    const row = html?.[0]?.querySelector?.(".rmu-cpt__row");
    const cid = row?.dataset?.combatantId;
    const c = game.combat;
    const combatant = (cid && c?.combatants?.get?.(cid)) ? c.combatants.get(cid) : c?.combatant;
    return getTintHexForCombatant(combatant);
  } catch (_) {
    return getCurrentUserColorHex();
  }
}



function closeAnyVddPortal() {
  const existing = document.querySelector(".rmu-vdd__portal");
  if (existing) existing.remove();
  document.querySelectorAll(".rmu-vdd.is-open").forEach(el => el.classList.remove("is-open"));
}

function openVddPortal(triggerEl, opts, currentValue, onSelect) {
  closeAnyVddPortal();

  const rect = triggerEl.getBoundingClientRect();
  const portal = document.createElement("div");
  portal.className = "rmu-vdd__portal";
  portal.style.width = `${Math.max(220, rect.width)}px`;
  portal.setAttribute("data-open", "1");

  // Build option list
  for (const o of opts || []) {
    const row = document.createElement("div");
    row.className = "rmu-vdd__opt" + (o.value === currentValue ? " is-selected" : "");
    row.setAttribute("data-value", o.value);
    row.innerHTML = `${o.icon ? `<i class="${o.icon}"></i>` : ""}<span class="rmu-vdd__label">${o.label}</span>`;
    row.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try { onSelect(o.value); } catch (_) {}
      closeAnyVddPortal();
    });
    portal.appendChild(row);
  }

  // Position: open upward if near bottom
  const viewportH = window.innerHeight;
  const uiTop = document.querySelector("#ui-top") || document.querySelector("#interface") || document.body;
  uiTop.appendChild(portal);
  const menuH = Math.min(portal.scrollHeight, 320);
  const spaceBelow = viewportH - rect.bottom;
  const openUp = spaceBelow < (menuH + 20);

  const top = openUp ? Math.max(8, rect.top - menuH - 6) : Math.min(viewportH - menuH - 8, rect.bottom + 6);
  const left = Math.min(window.innerWidth - rect.width - 8, Math.max(8, rect.left));

  portal.style.position = "fixed";
  portal.style.left = `${left}px`;
  portal.style.top = `${top}px`;
  portal.style.maxHeight = "320px";
  portal.style.overflow = "auto";
  portal.style.zIndex = "2147483000";
  portal.style.pointerEvents = "auto";
  portal.style.opacity = "1";

  const onDocDown = (ev) => {
    if (!portal.contains(ev.target) && ev.target !== triggerEl && !triggerEl.contains(ev.target)) {
      closeAnyVddPortal();
      document.removeEventListener("mousedown", onDocDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll, true);
    }
  };
  const onScroll = () => {
    // Reposition on scroll/resize
    const r = triggerEl.getBoundingClientRect();
    const vh = window.innerHeight;
    const sb = vh - r.bottom;
    const ou = sb < (menuH + 20);
    const t = ou ? Math.max(8, r.top - menuH - 6) : Math.min(vh - menuH - 8, r.bottom + 6);
    const l = Math.min(window.innerWidth - r.width - 8, Math.max(8, r.left));
    portal.style.left = `${l}px`;
    portal.style.top = `${t}px`;
  };

  document.addEventListener("mousedown", onDocDown, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScroll, true);
}


function getDefaultActions() {
  return [
  {
    "key": "drop-item",
    "label": "Drop Item (Instant)",
    "minCost": 0,
    "maxCost": 0,
    "icon": "fa-solid fa-hand"
  },
  {
    "key": "shift-item",
    "label": "Shift Item to Other Hand",
    "minCost": 1,
    "maxCost": 1,
    "icon": "fa-solid fa-right-left"
  },
  {
    "key": "draw-weapon",
    "label": "Draw Weapon/Item",
    "minCost": 1,
    "maxCost": 1,
    "icon": "fa-solid fa-hand-sparkles"
  },
  {
    "key": "get-item",
    "label": "Get Item from Ground",
    "minCost": 3,
    "maxCost": 3,
    "icon": "fa-solid fa-box-open"
  },
  {
    "key": "move-bmr",
    "label": "Move Your BMR",
    "minCost": 1,
    "maxCost": 1,
    "icon": "fa-solid fa-person-running"
  },
  {
    "key": "maneuver",
    "label": "Maneuver",
    "minCost": 1,
    "maxCost": 1,
    "icon": "fa-solid fa-person-walking"
  },
  {
    "key": "prone-stand",
    "label": "Drop Prone / Stand Up",
    "minCost": 2,
    "maxCost": 2,
    "icon": "fa-solid fa-person-falling"
  },
  {
    "key": "mount-dismount",
    "label": "Mount / Dismount",
    "minCost": 4,
    "maxCost": 4,
    "icon": "fa-solid fa-horse"
  },
  {
    "key": "melee",
    "label": "Melee",
    "minCost": 2,
    "maxCost": 4,
    "icon": "fa-solid fa-swords"
  },
  {
    "key": "ranged",
    "label": "Ranged Attack",
    "minCost": 1,
    "maxCost": 3,
    "icon": "fa-solid fa-bullseye"
  },
  {
    "key": "draw-ammo",
    "label": "Draw Ammo and Load",
    "minCost": 1,
    "maxCost": 1,
    "icon": "fa-solid fa-boxes-stacked"
  },
  {
    "key": "string-bow",
    "label": "String Bow",
    "minCost": 6,
    "maxCost": 6,
    "icon": "fa-solid fa-bow-arrow"
  },
  {
    "key": "load-light-crossbow",
    "label": "Load Light or Hand Crossbow",
    "minCost": 6,
    "maxCost": 6,
    "icon": "fa-solid fa-bow-arrow"
  },
  {
    "key": "load-heavy-crossbow",
    "label": "Load Heavy Crossbow",
    "minCost": 14,
    "maxCost": 14,
    "icon": "fa-solid fa-bow-arrow"
  },
  {
    "key": "full-dodge-block",
    "label": "Full Dodge / Full Block",
    "minCost": 4,
    "maxCost": 4,
    "icon": "fa-solid fa-shield"
  },
  {
    "key": "cast-spell",
    "label": "Cast Spell",
    "minCost": 2,
    "maxCost": 4,
    "icon": "fa-solid fa-wand-sparkles"
  },
  {
    "key": "cast-inst",
    "label": "Cast Instantaneous Spell (Instant)",
    "minCost": 0,
    "maxCost": 0,
    "icon": "fa-solid fa-bolt-lightning"
  },
  {
    "key": "perception",
    "label": "Perception",
    "minCost": 0,
    "maxCost": 2,
    "icon": "fa-solid fa-eye"
  },
  {
    "key": "eat-drink",
    "label": "Eat or Drink (Herb/Potion)",
    "minCost": 2,
    "maxCost": 2,
    "icon": "fa-solid fa-mug-hot"
  },
  {
    "key": "pick-lock",
    "label": "Pick Lock / Disarm Trap",
    "minCost": 20,
    "maxCost": 20,
    "icon": "fa-solid fa-key"
  }
];
}

function parseActionsConfig() {
  // Never allow dropdowns to go empty. If settings are missing/invalid/empty -> defaults.
  let raw = null;
  try {
    raw = game.settings.get(MODULE_ID, "actionsConfig");
  } catch (_) {
    raw = null;
  }

  // Accept JSON string or array
  let parsed = null;
  try {
    if (Array.isArray(raw)) parsed = raw;
    else if (typeof raw === "string" && raw.trim()) parsed = JSON.parse(raw);
  } catch (_) {
    parsed = null;
  }

  if (!Array.isArray(parsed) || !parsed.length) return getDefaultActions();

  const cleaned = [];
  for (const a of parsed) {
    if (!a || typeof a !== "object") continue;
    const key = String(a.key ?? "").trim();
    const label = String(a.label ?? "").trim();
    if (!key || !label) continue;

    const minCost = Number(a.minCost ?? a.cost ?? 0);
    const maxCost = Number(a.maxCost ?? a.cost ?? minCost);
    if (!Number.isFinite(minCost) || !Number.isFinite(maxCost)) continue;

    cleaned.push({
      key,
      label,
      minCost: Math.max(0, minCost),
      maxCost: Math.max(0, maxCost),
      icon: String(a.icon ?? "").trim()
    });
  }

  if (!cleaned.length) return getDefaultActions();

  // If the user has previously saved a custom actionsConfig, it may not include
  // newly-added default actions (e.g. Maneuver). Merge any missing defaults
  // into the end of the list so they appear in dropdowns and the image picker.
  try {
    const defaults = getDefaultActions();
    const seen = new Set(cleaned.map(a => a.key));
    for (const d of defaults) {
      if (seen.has(d.key)) continue;
      cleaned.push(foundry?.utils?.deepClone ? foundry.utils.deepClone(d) : { ...d });
    }
  } catch (_) {
    // no-op
  }

  return cleaned;
}

function actionsToMap(actions) {
  const map = new Map();
  for (const a of actions) map.set(a.key, a);
  return map;
}

function buildVddOptionsForActions(actions, currentValue) {
  if (!Array.isArray(actions) || !actions.length) actions = getDefaultActions();
  const opts = [{ value: "none", label: "-", selected: (currentValue === "none" || !currentValue) }];
  for (const a of actions) {
    const range = (a.minCost === a.maxCost) ? `${a.minCost}` : `${a.minCost}-${a.maxCost}`;
    const label = `${a.label} (${range})`;
    opts.push({ value: a.key, label, selected: (a.key === currentValue) });
  }
  const displayText = (opts.find(o => o.selected)?.label) || "-";
  return { opts, displayText };
}

function buildInstantOptionsForActions(actions, currentValue) {
  if (!Array.isArray(actions) || !actions.length) actions = getDefaultActions();
  const opts = [{ value: "available", label: "Instantaneous Action Available", selected: (currentValue === "available" || !currentValue) }];
  for (const a of actions) {
    const mn = Number(a.minCost ?? 0);
    // Any action with minimum cost 0 is considered instantaneous for this selector.
    if (mn !== 0) continue;
    const mx = Number(a.maxCost ?? mn);
    const range = (mn === mx) ? `${mn}` : `${mn}-${mx}`;
    // Special-case label tweak requested: instantaneous Perception should read "Perception (0) -50".
    // This affects only the Instantaneous Actions selector (not the phase action dropdowns).
    const label = (a.key === "perception") ? "Perception (0) -50" : `${a.label} (${range})`;
    opts.push({ value: a.key, label, selected: (a.key === currentValue) });
  }
  const displayText = (opts.find(o => o.selected)?.label) || "Instantaneous Action Available";
  return { opts, displayText };
}

function buildVddOptionsForCost(costObj) {
  if (!costObj) return { opts: [], displayText: "" };
  const opts = costObj.options.map(n => ({ value: String(n), label: String(n), selected: Number(n) === Number(costObj.value) }));
  const displayText = (opts.find(o => o.selected)?.label) || String(costObj.value ?? "");
  return { opts, displayText };
}

// Bonus AP may be spent starting from the last phase, then earlier phases.
// Example: bonusCount=1 => phase 4 has a bonus slot; bonusCount=2 => phases 3-4, etc.
function hasBonusInPhase(phaseNumber, bonusCount) {
  const threshold = 5 - clamp(bonusCount, 0, 4);
  return phaseNumber >= threshold;
}

/**
 * Build a stable per-slot key for storing selections.
 * round: combat round number
 * phase: internal slot index (1..4)
 * kind: 'm' main selector, 'b' bonus selector
 */
function phaseKey(round, phase, kind) { return `r${round}p${phase}${kind}`; }

function buildPhases({ baseRound, roundsShown, bonusCount, phaseCount }) {
  const pc = clamp(Number(phaseCount ?? 4), 1, 20);
  const phases = [];
  for (let r = 0; r < roundsShown; r++) {
    for (let p = 1; p <= pc; p++) {
      phases.push({ roundOffset: r, round: (baseRound + r), phase: p, hasBonus: hasBonusInPhase(p, bonusCount) });
    }
  }
  return phases;
}

function maxUpperCost(actions) {
  let max = 0;
  for (const a of (actions ?? [])) {
    const mn = Number(a?.minCost ?? 0);
    const mx = Number(a?.maxCost ?? mn);
    if (Number.isFinite(mx)) max = Math.max(max, mx);
  }
  return max;
}

/**
 * Build a phases list that includes enough PRIOR rounds to correctly evaluate multi-phase action chains
 * that continue across round boundaries (especially while concentrating, where each selector contributes 0.5 AP).
 *
 * We keep the UI display unchanged; this is only for chain math/overlays.
 */
function buildPhasesForAnalysis({ phaseInfo, roundsShown, bonusCount, actions, planActions, phaseCount }) {
  const maxCost = maxUpperCost(actions);
  // Worst case is concentrating: 0.5 AP per selector => 2 selectors per 1 AP.
  // With 4 phases/round (no bonus), rounds needed for maxCost is ceil((2*maxCost)/4) = ceil(maxCost/2).
  const lookbackRounds = clamp(Math.ceil(maxCost / 2), 0, 4);
  const baseRound = Math.max(1, Number(phaseInfo?.round ?? 1) - lookbackRounds);
  const offsetToCurrent = Number(phaseInfo?.round ?? 1) - baseRound;
  const analysisRoundsShown = clamp(offsetToCurrent + Number(roundsShown ?? 1), 1, 9);

  // Build phases for analysis, then *promote* bonus slots for any phases that already have
  // a recorded bonus selection in planActions. This is critical when bonusCount is decreased
  // after spending bonus AP: we must still count those already-used bonus selectors so chains
  // remain continuous across round boundaries.
  const phases = buildPhases({ baseRound, roundsShown: analysisRoundsShown, bonusCount, phaseCount: (phaseCount ?? phaseInfo?.phaseCount) });
  if (planActions && typeof planActions === "object") {
    for (const ph of phases) {
      const kb = phaseKey(ph.round, ph.phase, "b");
      const v = planActions[kb] ?? "none";
      if (v && v !== "none") ph.hasBonus = true;
    }
  }
  return phases;
}

function baseCap(concentrating, apPerPhase = 1) {
  const base = Number(apPerPhase);
  const b = (Number.isFinite(base) && base > 0) ? base : 1;
  return concentrating ? (b / 2) : b;
}


function normalizeConcFlags(cd) {
  const f = foundry.utils.deepClone(cd?.concFlags ?? {});
  // Back-compat: older state used `concentrating` boolean.
  if (cd?.concentrating && f.concentration === undefined) f.concentration = true;
  return {
    concentration: !!f.concentration,
    holdPosition: !!f.holdPosition,
    partialDodgeBlock: !!f.partialDodgeBlock,
    spellPreparation: !!f.spellPreparation,
    holdAction: !!f.holdAction
  };
}

function countConcOn(flags) {
  let n = 0;
  for (const k of ["concentration", "holdPosition", "partialDodgeBlock", "spellPreparation", "holdAction"]) {
    if (flags?.[k]) n++;
  }
  return n;
}

function buildCapByKey({ phasesAnalysis, flags, holdMeta, apPerPhase = 1 }) {
  const out = {};
  const keys = [];
  for (const ph of (phasesAnalysis ?? [])) {
    const km = phaseKey(ph.round, ph.phase, "m");
    keys.push(km);
    if (ph.hasBonus) keys.push(phaseKey(ph.round, ph.phase, "b"));
  }

  const immediateOn = !!(flags?.concentration || flags?.holdPosition || flags?.partialDodgeBlock || flags?.spellPreparation);
  const holdOn = !!flags?.holdAction;

  // Special: Hold Action delays the concentrating mechanic until AFTER the selector that completed.
  const pendingKey = holdMeta?.pendingKey ?? null;
  const pendingIdx = pendingKey ? keys.indexOf(pendingKey) : -1;

  const base = Number(apPerPhase);
  const b = (Number.isFinite(base) && base > 0) ? base : 1;

  for (let i = 0; i < keys.length; i++) {
    let cap = b;
    if (immediateOn) {
      cap = b / 2;
    } else if (holdOn) {
      if (pendingIdx >= 0) {
        cap = (i <= pendingIdx) ? b : (b / 2);
      } else {
        cap = b / 2;
      }
    }
    out[keys[i]] = cap;
  }
  return out;
}

function buildSlots(phases, concentrating, apPerPhase = 1) {
  const cap = baseCap(concentrating, apPerPhase);
  const slots = [];
  for (const ph of phases) {
    slots.push({ planKey: phaseKey(ph.round, ph.phase, "m"), capacity: cap, ph });
    if (ph.hasBonus) slots.push({ planKey: phaseKey(ph.round, ph.phase, "b"), capacity: cap, ph });
  }
  return slots;
}

// Best-effort phase detection across RMU variants. Falls back to Foundry turn if no phase exists.
/**
 * Get the current combat round + real phase from RMU combat data.
 * Falls back safely if RMU fields are absent (e.g. no combat active).
 */
function detectPhaseInfo(combat) {
  // We MUST NOT advance phase on player turns. We only trust an explicit phase value on the combat doc.
  // So: (1) check known RMU-ish paths, (2) deep-scan system/flags for a numeric phase/currentPhase, (3) if not found, hold at 1.
  function toNum(v) {
    const n = Number(v);
    return (Number.isFinite(n) ? n : null);
  }

  function deepFindNumber(obj, keySet, maxDepth = 5) {
    const seen = new Set();
    function walk(o, depth) {
      if (!o || typeof o !== "object") return null;
      if (seen.has(o)) return null;
      seen.add(o);
      if (depth > maxDepth) return null;

      for (const [k, v] of Object.entries(o)) {
        if (keySet.has(k)) {
          const n = toNum(v);
          if (n !== null) return n;
        }
      }
      for (const v of Object.values(o)) {
        if (v && typeof v === "object") {
          const found = walk(v, depth + 1);
          if (found !== null) return found;
        }
      }
      return null;
    }
    return walk(obj, 0);
  }

  // Phase
  const phaseCandidates = [
    () => combat?.system?.phase,
    () => combat?.system?.currentPhase,
    () => combat?.system?.phases?.current,
    () => combat?.flags?.rmu?.phase,
    () => combat?.flags?.rmu?.currentPhase,
    () => combat?.flags?.rmu?.combat?.phase,
    () => combat?.flags?.rmusystem?.phase,
    () => combat?.getFlag?.("rmu", "phase"),
    () => combat?.getFlag?.("rmu", "currentPhase"),
    () => combat?.getFlag?.("rmusystem", "phase"),
  ];

  let phase = null;
  for (const fn of phaseCandidates) {
    try {
      const v = fn();
      const n = toNum(v);
      if (n !== null) { phase = n; break; }
    } catch (_) {}
  }

  if (phase === null) {
    // Deep-scan for any phase-like numeric field.
    const keySet = new Set(["phase", "currentPhase", "phaseIndex", "phaseNumber"]);
    phase = deepFindNumber(combat?.system, keySet) ?? deepFindNumber(combat?.flags, keySet);
  }

  // Phase count (default 4)
  const countCandidates = [
    () => combat?.system?.phaseCount,
    () => combat?.system?.phases?.count,
    () => combat?.flags?.rmu?.phaseCount,
    () => combat?.flags?.rmu?.combat?.phaseCount,
    () => combat?.getFlag?.("rmu", "phaseCount"),
  ];

  let phaseCount = null;
  for (const fn of countCandidates) {
    try {
      const v = fn();
      const n = toNum(v);
      if (n !== null) { phaseCount = n; break; }
    } catch (_) {}
  }

  if (phaseCount === null) {
    const keySet = new Set(["phaseCount", "phasesCount", "numPhases"]);
    phaseCount = deepFindNumber(combat?.system, keySet) ?? deepFindNumber(combat?.flags, keySet);
  }

  // Cache assist: when combat starts, some RMU builds do not expose phaseCount immediately on the Combat doc.
  // Use the last parsed Combat Tracker sidebar value if available so the UI is correct on first render.
  try {
    const cached = _getCachedCombatTrackerInfo(combat?.id);
    if (cached?.phaseCount && Number.isFinite(cached.phaseCount)) phaseCount = cached.phaseCount;
    if ((phase === null || !Number.isFinite(phase) || phase <= 0) && cached?.phase && Number.isFinite(cached.phase)) phase = cached.phase;
  } catch (_) {}

  if (!phaseCount || Number.isNaN(phaseCount)) phaseCount = 4;

  // If phase is still unknown, we HOLD at 1 (do not derive from combat.turn).
  if (phase === null || Number.isNaN(phase)) phase = 1;

  // Round handling (robust):
  // - Core Foundry uses combat.round (0 before start, then 1,2,...).
  // - Some systems/modules store a round/currentRound value in combat.system or combat.flags.
  // We try to find the BEST explicit round value available, preferring larger (more specific) values
  // instead of accidentally locking to combat.round=1 when the system stores a higher round elsewhere.

  const roundCandidates = [
    () => combat?.round,
    () => combat?.system?.round,
    () => combat?.system?.currentRound,
    () => combat?.system?.combat?.round,
    () => combat?.flags?.rmu?.round,
    () => combat?.flags?.rmu?.combat?.round,
    () => combat?.flags?.rmusystem?.round,
    () => combat?.getFlag?.("rmu", "round"),
    () => combat?.getFlag?.("rmu", "currentRound"),
    () => combat?.getFlag?.("rmusystem", "round"),
  ];

  const roundVals = [];
  for (const fn of roundCandidates) {
    try {
      const v = fn();
      const n = toNum(v);
      if (n !== null) roundVals.push(n);
    } catch (_) {}
  }

  // Deep-scan as a fallback (can find system-stored rounds even if not in the known paths above).
  const keySet = new Set(["round", "currentRound", "roundNumber", "roundIndex"]);
  const deepRound = deepFindNumber(combat?.system, keySet) ?? deepFindNumber(combat?.flags, keySet);
  if (deepRound !== null && deepRound !== undefined) {
    const n = toNum(deepRound);
    if (n !== null) roundVals.push(n);
  }

  // Choose the maximum finite value (this prevents "stuck at 1" when other round fields are higher).
  let round = 1;
  for (const n of roundVals) {
    if (Number.isFinite(n) && n > round) round = n;
  }

  // Normalize 0-based -> 1-based if needed
  round = (round >= 1) ? round : (round + 1);
  if (!Number.isFinite(round) || round <= 0) round = 1;

  // UI fallback: parse Combat Tracker label "Phase X of Y" if present.
  // This helps when the system does not expose phaseCount on the Combat document.
  try {
    const root = ui?.combat?.element?.[0] ?? ui?.combat?.element ?? document.getElementById("combat") ?? document.querySelector("#combat") ?? null;
    const text = (root && root.textContent) ? String(root.textContent) : "";
    const m = text.match(/Phase\s*(\d+)\s*of\s*(\d+)/i);
    if (m) {
      const p = parseInt(m[1], 10);
      const pc = parseInt(m[2], 10);
      if (Number.isFinite(pc) && pc >= 1 && pc <= 20) {
        phaseCount = pc;
        if (Number.isFinite(p) && p >= 1 && p <= pc) phase = p;
      }
    }
  } catch (_) {}
  return { round, phase: clamp(phase, 1, phaseCount), phaseCount };
}

// AP per Phase detection. Prefer system/flags; fall back to parsing the Combat Tracker sidebar label
// like: "Spend 2 AP per Phase".
/**
 * Detect how many internal action slots exist per real phase (AP-per-phase).
 * (e.g. 1 = normal; 2 = two selectors per phase; 4 = one selector spans multiple phases)
 */
function detectApPerPhase(combat) {
  function toNum(v) {
    const n = Number(v);
    return (Number.isFinite(n) ? n : null);
  }

  function deepFindNumber(obj, keySet, maxDepth = 5) {
    const seen = new Set();
    function walk(o, depth) {
      if (!o || typeof o !== "object") return null;
      if (seen.has(o)) return null;
      seen.add(o);
      if (depth > maxDepth) return null;

      for (const [k, v] of Object.entries(o)) {
        if (keySet.has(k)) {
          const n = toNum(v);
          if (n !== null) return n;
        }
      }
      for (const v of Object.values(o)) {
        if (v && typeof v === "object") {
          const found = walk(v, depth + 1);
          if (found !== null) return found;
        }
      }
      return null;
    }
    return walk(obj, 0);
  }

  // Direct candidates
  const candidates = [
    () => combat?.system?.apPerPhase,
    () => combat?.system?.actionPointsPerPhase,
    () => combat?.system?.apPerActionPhase,
    () => combat?.flags?.rmu?.apPerPhase,
    () => combat?.flags?.rmu?.combat?.apPerPhase,
    () => combat?.getFlag?.("rmu", "apPerPhase"),
  ];

  let ap = null;
  for (const fn of candidates) {
    try {
      const n = toNum(fn());
      if (n !== null) { ap = n; break; }
    } catch (_) {}
  }

  if (ap === null) {
    const keySet = new Set(["apPerPhase", "apPerActionPhase", "actionPointsPerPhase", "apPhase", "phaseAP"]);
    ap = deepFindNumber(combat?.system, keySet) ?? deepFindNumber(combat?.flags, keySet);
  }


  // Cache assist: prefer the last parsed Combat Tracker "Spend X AP per Phase" value if present.
  if (ap === null) {
    try {
      const cached = _getCachedCombatTrackerInfo(combat?.id);
      const n = Number(cached?.apPerPhase);
      if (Number.isFinite(n) && n > 0) ap = n;
    } catch (_) {}
  }

  // Fallback: parse combat tracker label text
  if (ap === null) {
    try {
      const root = (ui?.combat?.element?.[0] ?? ui?.combat?.element) || document.getElementById("combat") || document.querySelector("#combat") || document.querySelector(".combat-sidebar");
      const text = String(root?.textContent ?? "").replace(/\s+/g, " ");
      const m =
        text.match(/Spend\s*([0-9]+(?:\.[0-9]+)?)\s*AP\s*(?:\/\s*Phase|\/\s*Action\s*Phase|per\s*Phase|per\s*Action\s*Phase)/i)
        || text.match(/AP\s*per\s*(?:Action\s*)?Phase\s*:?\s*([0-9]+(?:\.[0-9]+)?)/i);
      if (m) ap = toNum(m[1]);
    } catch (_) {}
  }

  if (!Number.isFinite(ap) || ap === null || ap <= 0) ap = 1;
  // Clamp to avoid pathological values.
  ap = clamp(ap, 0.25, 20);
  return ap;
}

async function ensureCombatState(combat) {
  if (!combat) return null;
  let state = combat.getFlag(MODULE_ID, "state");
  if (!state || typeof state !== "object") {
    if (!game.user.isGM) return { combatants: {} };
    state = { combatants: {} };
    await combat.setFlag(MODULE_ID, "state", state);
  }
  if (!state.combatants) state.combatants = {};
  if (!state.meta) state.meta = {};
  return state;
}

// Local virtual-round cache (per client) so periodic reminders can work even if the system does not advance combat.round
// and the GM-written state flag is unavailable (or delayed).
const _virtualRoundCache = new Map();

function updateLocalVirtualRound(combat, phaseInfo=null) {
  try {
    const c = combat ?? game.combat;
    if (!c?.id) return;
    const pi = phaseInfo ?? detectPhaseInfo(c);
    const phase = Number(pi?.phase ?? 1);
    const phaseCount = Number(pi?.phaseCount ?? 4) || 4;
    const detectedRound = Number(pi?.round ?? 1);

    const turn = Number(c?.turn ?? 0);
    const cached = _virtualRoundCache.get(c.id) ?? { virtualRound: 1, lastPhase: phase, lastPhaseCount: phaseCount, lastTurn: turn };
    let vr = Number(cached.virtualRound ?? 1);
    if (!Number.isFinite(vr) || vr <= 0) vr = 1;

    // If the system provides a real round > 1, sync to it.
    if (Number.isFinite(detectedRound) && detectedRound > 1) {
      vr = detectedRound;
    } else {
      const lastPhase = Number(cached.lastPhase ?? phase);
      const lastPhaseCount = Number(cached.lastPhaseCount ?? phaseCount) || phaseCount;
      const lastTurn = Number(cached.lastTurn ?? turn);

      // Detect phase-wrap (last phase -> phase 1) only when there is more than 1 phase per round.
      // If phaseCount === 1, phase is always 1 and we'd otherwise increment virtualRound on every render.
      const wrappedByPhase = ((phaseCount > 1) && (phase === 1) && (lastPhase === lastPhaseCount)) || (phase < lastPhase);
      const wrappedByTurn = (turn < lastTurn);
      if (wrappedByPhase || wrappedByTurn) vr = vr + 1;
    }

    _virtualRoundCache.set(c.id, { virtualRound: vr, lastPhase: phase, lastPhaseCount: phaseCount, lastTurn: turn });
  } catch (_) {}
}

// Mental Focus / reminder round: use the best available round number,
// falling back to an internal virtualRound counter when the system does not advance combat.round.
function getReminderRound(combat, state, phaseInfo=null) {
  let detected = null;
  try {
    const pi = phaseInfo ?? detectPhaseInfo(combat);
    detected = Number(pi?.round ?? null);
  } catch (_) {}
  const virt = Number(state?.meta?.virtualRound ?? 1);
  const cachedVirt = Number(_virtualRoundCache.get(combat?.id)?.virtualRound ?? 1);
  if (Number.isFinite(detected) && detected > 1) return detected;
  if (Number.isFinite(virt) && virt > 1) return virt;
  if (Number.isFinite(cachedVirt) && cachedVirt > 1) return cachedVirt;
  if (Number.isFinite(detected) && detected >= 1) return detected;
  return 1;
}

// Optimistic client cache so player selections "stick" immediately while waiting for GM write + flag replication.
const _pending = new Map(); // key: `${combatId}:${path}` => value
function pendingKey(combatId, path) { return `${combatId}:${path}`; }
function applyPendingToState(combatId, state) {
  if (!state) return state;
  const clone = foundry.utils.deepClone(state);
  for (const [k, v] of _pending.entries()) {
    if (!k.startsWith(`${combatId}:`)) continue;
    const path = k.slice(combatId.length + 1);
    foundry.utils.setProperty(clone, path, v);
  }
  return clone;
}

/**
 * Write a single path in the combat flag state.
 * - GM: writes directly to Combat flags
 * - Player: requests GM write via module socket
 */
async function requestStatePathUpdate({ combatId, path, value }) {
  const combat = game.combats?.get(combatId);
  if (!combat) return;

  // Optimistic local update for BOTH GM and players so immediate reads (movement) see the change
  // even if the flag write/socket round-trip hasn't completed yet.
  const pKey = pendingKey(combatId, path);
  _pending.set(pKey, value);

  if (game.user.isGM) {
    try {
      const state = await ensureCombatState(combat);
      const clone = foundry.utils.deepClone(state);
      foundry.utils.setProperty(clone, path, value);
      await combat.setFlag(MODULE_ID, "state", clone);
      // Once the authoritative flag is updated, clear the optimistic entry to avoid stale overrides.
      _pending.delete(pKey);
    } catch (e) {
      console.warn("requestStatePathUpdate GM setFlag failed", e);
      // Keep pending so UI/movement remains consistent with the user's last selection.
    }
  } else {
    game.socket.emit(`module.${MODULE_ID}`, { type: "setStatePath", combatId, path, value });
  }

  // Refresh UI immediately for both GM and players (pending cache keeps selections sticky).
  try { if (_app?.rendered) _app.render(false); } catch (_) {}
}

/**
 * Ensure the combat flag state exists for this combat.
 * Called on open/render so the UI never starts against an undefined state blob.
 */
function requestInitState(combatId) {
  const combat = game.combats?.get(combatId);
  if (!combat) return;
  if (game.user.isGM) ensureCombatState(combat);
  else game.socket.emit(`module.${MODULE_ID}`, { type: "initState", combatId });
}

function registerSocket() {
  if (_socketRegistered) return;
  _socketRegistered = true;
  game.socket.on(`module.${MODULE_ID}`, async (msg) => {
    try {
      if (!game.user.isGM) return;
      if (!msg || !msg.type) return;

      const combat = game.combats?.get(msg.combatId);
      if (!combat) return;

      if (msg.type === "initState") {
        await ensureCombatState(combat);
        // Ensure any open GM tracker UI reflects the initialized state.
        try { requestAppRefresh(); } catch (_) {}
        return;
      }
      if (msg.type !== "setStatePath") return;

      const state = await ensureCombatState(combat);
      const clone = foundry.utils.deepClone(state);
      foundry.utils.setProperty(clone, msg.path, msg.value);
      await combat.setFlag(MODULE_ID, "state", clone);

      // Live-update GM view as players make selections.
      try { requestAppRefresh(); } catch (_) {}
    } catch (e) {
      console.error(e);
    }
  });
}

function applyAutofillToPlan({ phases, actionsMap, concentrating, planActions, planAuto, planCosts, apPerPhase = 1 }) {
  const slots = buildSlots(phases, concentrating, apPerPhase);

  const cleaned = foundry.utils.deepClone(planActions ?? {});
  const autoPrev = foundry.utils.deepClone(planAuto ?? {});
  const costs = foundry.utils.deepClone(planCosts ?? {});
  const newAuto = foundry.utils.deepClone(planAuto ?? {});

  // Remove old auto-filled values (explicitly overwrite so Foundry merges do not preserve stale keys)
  for (const k of Object.keys(autoPrev)) {
    if (autoPrev[k]) {
      cleaned[k] = "none";
      costs[k] = null;
      newAuto[k] = false;
    }
  }

  function costForStartSlot(planKey, actionKey) {
    const meta = actionsMap.get(actionKey);
    if (!meta) return 0;

    const mn = Number(meta.minCost ?? 0);
    const mx = Number(meta.maxCost ?? mn);

    // Range-cost actions: always auto-fill only to the starting (minimum) value.
    // Also store the chosen start cost so refreshes stay consistent.
    if (mx > mn) {
      costs[planKey] = mn;
      return mn;
    }

    // Fixed-cost actions: use the fixed cost (mn).
    costs[planKey] = mn;
    return mn;
  }

  // For every "start slot" that has a costed action, auto-fill forward across slots until cost is paid.
  for (let i = 0; i < slots.length; i++) {
    const startKey = slots[i].planKey;
    const actionKey = cleaned[startKey] ?? "none";
    const meta = actionsMap.get(actionKey);
    const isStart = actionKey !== "none" && meta && Number(meta.maxCost ?? meta.minCost ?? 0) > 0;
    if (!isStart) continue;

    let remaining = costForStartSlot(startKey, actionKey);
    if (remaining <= 0) continue;

    // Start slots are manual.
    newAuto[startKey] = false;

    for (let j = i; j < slots.length && remaining > 1e-9; j++) {
      const pk = slots[j].planKey;
      const cap = slots[j].capacity;

      // Don't overwrite another manual start slot (chain break point).
      if (j !== i) {
        const ahead = cleaned[pk] ?? "none";
        const aheadMeta = actionsMap.get(ahead);
        const aheadIsStart = ahead !== "none" && aheadMeta && Number(aheadMeta.maxCost ?? aheadMeta.minCost ?? 0) > 0 && !autoPrev[pk];
        if (aheadIsStart) break;
      }

      const existing = cleaned[pk] ?? "none";

      // Only fill empty "-" slots. Never overwrite another action.
      if (existing === "none") {
        cleaned[pk] = actionKey;
        newAuto[pk] = (pk !== startKey);
      }

      remaining -= cap;
    }
  }

  return { planActions: cleaned, planAuto: newAuto, planCosts: costs };
}

/**
 * Evaluate multi-selector action chains (main/bonus) and produce overlay/label metadata.
 *
 * - Uses capByKey (per slot AP capacity) so concentration can halve contribution (0.5 AP per selector).
 * - Applies special handling for range-cost actions (min/max AP) and FIN/ACT override.
 * - Returns: chain continuity markers used to drive Complete/Incomplete + Lost/Broken overlays.
 */
function evaluateChainsWithPenalty({ phases, planActions, actionsMap, concentrating, capByKey, planCosts, finActs, currentPhase, currentRound, apPerPhase = 1 }) {
  const capDefault = baseCap(concentrating, apPerPhase);
  const capForKey = (k) => {
    const v = capByKey?.[k];
    return (typeof v === "number") ? v : capDefault;
  };
  const curPhase = clamp(Number(currentPhase ?? 1), 1, 20);
  const curRound = clamp(Number(currentRound ?? 1), 1, 9999);

  let currentAction = null;
  let remaining = 0;
  let spentAP = 0;

  // Cached meta for currentAction
  let minCost = 0;
  let maxCost = 0;
  let isRange = false;

  // Track which PAST phases have already contributed AP to the current chain (only these can become LOST).
  let spentPhaseIdxs = [];

  const results = [];

  function startChain(actionKey) {
    currentAction = actionKey;
    const meta = actionsMap.get(actionKey);
    minCost = Number(meta?.minCost ?? 0);
    maxCost = Number(meta?.maxCost ?? minCost);
    isRange = (maxCost > minCost);

    // IMPORTANT:
    // - Fixed-cost actions: chain must be paid in full.
    // - Range-cost actions: we track up to MAX for penalty overlays, but if the chain breaks AFTER MIN is met,
    //   there is NO LOST/BROKEN condition (only the penalty overlay applies). That means the chain can end
    //   silently once MIN is satisfied.
    remaining = isRange ? maxCost : minCost;
    spentAP = 0;
    spentPhaseIdxs = [];
  }

  function resetChain() {
    currentAction = null;
    remaining = 0;
    spentAP = 0;
    minCost = 0;
    maxCost = 0;
    isRange = false;
    spentPhaseIdxs = [];
  }

  function markLost() {
    for (const i of spentPhaseIdxs) {
      if (results[i]) results[i].lost = true;
    }
    spentPhaseIdxs = [];
  }

  for (let idx = 0; idx < phases.length; idx++) {
    const ph = phases[idx];

    // Compare by (round, phase)
    const isPast = (ph.round < curRound) || (ph.round === curRound && ph.phase < curPhase);
    const isCurrent = (ph.round === curRound) && (ph.phase === curPhase);
    const isFuture = !isPast && !isCurrent;

    const km = phaseKey(ph.round, ph.phase, "m");
    const kb = phaseKey(ph.round, ph.phase, "b");

    const mainSel = planActions?.[km] ?? "none";
    const bonusSel = ph.hasBonus ? (planActions?.[kb] ?? "none") : "none";

    const mainMeta = actionsMap.get(mainSel);
    const bonusMeta = actionsMap.get(bonusSel);

    // Default per-phase result
    const r = { contrib: 0, broke: false, penalty: 0, lost: false, expectedAction: "" };
    results.push(r);

    // Detect a chain start only in PAST phases; chains that start in current/future are not "paid for" yet.
    if (!currentAction && isPast) {
      let start = null;
      if (mainSel !== "none" && mainMeta && Number(mainMeta.maxCost ?? mainMeta.minCost ?? 0) > 0) start = mainSel;
      else if (bonusSel !== "none" && bonusMeta && Number(bonusMeta.maxCost ?? bonusMeta.minCost ?? 0) > 0) start = bonusSel;

      if (start) startChain(start);
    }

    if (!currentAction) continue;

    // Compute this phase's contribution to the chain.
    let contrib = 0;
    if (mainSel === currentAction) contrib += capForKey(km);
    if (ph.hasBonus && bonusSel === currentAction) contrib += capForKey(kb);
    r.contrib = contrib;

    // FIN ACT? : for range-cost actions, allow the user to end the chain early at this selector.
    if (contrib <= 1e-9) {
      // Chain break: only meaningful if it happens in a phase that has already occurred (past or current).
      // If it is in the future, just stop simulation silently.
      if (isFuture) {
        resetChain();
        continue;
      }

      // For RANGE-cost actions: once MIN is met, there is no LOST/BROKEN if the chain stops.
      const minMet = isRange && (spentAP + 1e-9 >= minCost);
      if (minMet) {
        resetChain();
        continue;
      }

      // Otherwise, breaking early wastes any spent PAST phases.
      markLost();
      r.broke = true;
      r.expectedAction = currentAction || "";

      if (isRange) {
        const remainingAP = Math.max(0, (maxCost - spentAP));
        const steps = Math.round(remainingAP); // nearest whole AP shortfall
        r.penalty = -25 * steps;
      }

      resetChain();
      continue;
    }

    // If this phase is in the past, it has actually "spent" AP toward the chain.
    if (isPast && contrib > 0) spentPhaseIdxs.push(idx);

    spentAP += contrib;
    remaining -= contrib;

    // Early-finish toggle for range-cost actions: treat this selector as COMPLETE regardless of remaining cost.
    // This intentionally clears any LOST/BROKEN outcomes and stops the chain here.
    if (isRange) {
      const finMain = (mainSel === currentAction) && !!finActs?.[km];
      const finBonus = ph.hasBonus && (bonusSel === currentAction) && !!finActs?.[kb];
      if (finMain || finBonus) {
        resetChain();
        continue;
      }
    }

    if (remaining <= 1e-9) {
      resetChain();
    }
  }

  return results;
}

/**
 * Convert chain evaluation results into a UI-friendly map keyed by phaseKey.
 *
 * The UI reads this to show:
 * - Complete!! vs Incomplete labels
 * - Lost/Broken overlays when a chain is interrupted
 * - Range-cost penalty overlays (after min cost met)
 */
function analyzeChainsForUI({ phases, planActions, actionsMap, concentrating, capByKey, planCosts, finActs, currentPhase, currentRound, apPerPhase = 1 }) {
  const invalid = new Set();
  const need = new Map(); // key -> expected actionKey when chain must continue (even if selector is '-')
  const complete = new Set();
  const purple = new Map(); // key -> penalty text displayed on the selector
  const short = new Map(); // key -> chain shortfall penalty text (reserved)

  const capDefault = baseCap(!!concentrating, apPerPhase);
  const capForKey = (k) => {
    const v = capByKey?.[k];
    return (typeof v === "number") ? v : capDefault;
  };
  const curPhase = clamp(Number(currentPhase ?? 1), 1, 20);
  // The module uses 1-based round indices for plan keys and UI.
  const curRound = Math.max(1, Number(currentRound ?? 1));

  function metaFor(actionKey) {
    const meta = actionsMap.get(actionKey);
    if (!meta) return null;
    const mn = Number(meta.minCost ?? 0);
    const mx = Number(meta.maxCost ?? mn);
    return { mn, mx };
  }

  // For range-cost actions: treat the cost as the upper range number (mx).
  // For fixed-cost: cost is mn (==mx).
  function costUpper(actionKey) {
    const m = metaFor(actionKey);
    if (!m) return 0;
    return m.mx;
  }

  // Build per-phase view
  const phaseList = phases.map(ph => {
    const km = phaseKey(ph.round, ph.phase, "m");
    const kb = phaseKey(ph.round, ph.phase, "b");
    const mainSel = planActions?.[km] ?? "none";
    const bonusSel = ph.hasBonus ? (planActions?.[kb] ?? "none") : "none";
    return { ph, km, kb, mainSel, bonusSel };
  });

  // Collect action keys present per phase (ignoring 'none')
  const presentByIdx = phaseList.map(p => {
    const set = new Set();
    if (p.mainSel && p.mainSel !== "none") set.add(p.mainSel);
    if (p.bonusSel && p.bonusSel !== "none") set.add(p.bonusSel);
    return set;
  });

  // For each actionKey, analyze chains. IMPORTANT:
  // If an action completes (all required selector-contributions paid) and the same action
  // is chosen again in the next selector, that begins a NEW chain immediately.
  const allActions = new Set();
  for (const s of presentByIdx) for (const a of s) allActions.add(a);

  for (const actionKey of allActions) {
    const m = metaFor(actionKey);
    if (!m) continue;

    const totalCost = costUpper(actionKey);
    if (totalCost <= 0) continue;
    const targetAP = totalCost;

    let chainActive = false;
    let chainStartPh = null;      // {round, phase}
    let chainEndPh = null;        // {round, phase} where last contribution occurred
    let contributedKeys = new Set();
    let ordinal = 0;
    let spentAP = 0;

    const resetChain = () => {
      chainActive = false;
      chainStartPh = null;
      chainEndPh = null;
      contributedKeys = new Set();
      ordinal = 0;
      spentAP = 0;
    };

    const isBeforeCurrent = (phObj) => (phObj.round < curRound) || (phObj.round === curRound && phObj.phase < curPhase);
    const isCurrentPh = (phObj) => (phObj.round === curRound) && (phObj.phase === curPhase);

    const finalizeIncompleteChain = () => {
      if (!chainActive) return;
      if (spentAP + 1e-9 >= targetAP) { resetChain(); return; }

      const endPh = chainEndPh ?? chainStartPh;
      const startPh = chainStartPh ?? endPh;
      if (!endPh || !startPh) { resetChain(); return; }

      const segmentEndedBeforeCurrent = isBeforeCurrent(endPh);
      const startedInPast = isBeforeCurrent(startPh);

      const minMet = (m.mx > m.mn) ? (spentAP + 1e-9 >= m.mn) : false;
      // Range actions are only "lost" if the chain breaks BEFORE meeting the minimum.
      if (startedInPast && segmentEndedBeforeCurrent && (!minMet)) {
        for (const k of contributedKeys) invalid.add(k);

        // If the break happens right before current phase, highlight current phase occupied selectors (wrong continuation)
        const endIsImmediatelyBeforeCurrent = (
          (endPh.round === curRound && endPh.phase === (curPhase - 1)) ||
          (curPhase === 1 && endPh.round === (curRound - 1) && endPh.phase === 4)
        );

        if (endIsImmediatelyBeforeCurrent) {
          const cur = phaseList.find(p => (p.ph.round === curRound) && (p.ph.phase === curPhase));
          if (cur) {
            const curMain = cur.mainSel ?? "none";
            const curBonus = cur.ph.hasBonus ? (cur.bonusSel ?? "none") : "none";

            const continues = (curMain === actionKey) || (cur.ph.hasBonus && curBonus === actionKey);
            if (!continues) {
              // Mark the current-phase selectors as needing the chain action to continue, even if they are currently '-' / none.
              need.set(cur.km, actionKey);
              if (cur.ph.hasBonus) need.set(cur.kb, actionKey);

              if (curMain !== "none" && curMain !== actionKey) invalid.add(cur.km);
              if (cur.ph.hasBonus && curBonus !== "none" && curBonus !== actionKey) invalid.add(cur.kb);
              if (curMain === "none" && (!cur.ph.hasBonus || curBonus === "none")) invalid.add(cur.km);
            }
          }
        }
      }

      resetChain();
    };

    const applyContribution = (key, phObj) => {
      const isPast = isBeforeCurrent(phObj);
      const isCurrent = isCurrentPh(phObj);

      chainEndPh = phObj;
      ordinal += 1;
      spentAP += capForKey(key);

      if (isPast || isCurrent) contributedKeys.add(key);

      // Early-finish toggle for range-cost actions: treat this selector as COMPLETE regardless of remaining cost.
      // Special-case: DO NOT remove the penalty label when force-finishing.
      if ((m.mx > m.mn) && !!finActs?.[key]) {
        // Preserve the same penalty computation that would have applied at this point in the chain.
        if (spentAP + 1e-9 >= m.mn) {
          const remainingAP = Math.max(0, (m.mx - spentAP));
          const steps = Math.round(remainingAP); // nearest whole AP shortfall
          const pen = -25 * steps;
          if (steps > 0) purple.set(key, String(pen));
          else purple.delete(key);
        } else {
          purple.delete(key);
        }

        complete.add(key);
        resetChain();
        return;
      }

      // Range-cost penalty overlay: applies only after MIN is met, and rounds to nearest -25.
      if (m.mx > m.mn) {
        if (spentAP + 1e-9 >= m.mn) {
          const remainingAP = Math.max(0, (m.mx - spentAP));
          const steps = Math.round(remainingAP); // nearest whole AP shortfall
          const pen = -25 * steps;
          if (steps > 0) purple.set(key, String(pen));
          else purple.delete(key);
        } else {
          purple.delete(key);
        }
      }

      if (spentAP + 1e-9 >= targetAP) {
        // Chain completed at this selector.
        complete.add(key);
        // IMPORTANT: immediately reset so subsequent same-action selectors start a NEW chain.
        resetChain();
      }
    };

    for (let j = 0; j < phaseList.length; j++) {
      const p = phaseList[j];
      const keys = [];
      if (p.mainSel === actionKey) keys.push(p.km);
      if (p.ph.hasBonus && p.bonusSel === actionKey) keys.push(p.kb);

      if (keys.length === 0) {
        // A gap ends the current chain (if any)
        finalizeIncompleteChain();
        continue;
      }

      // If we are about to contribute and no chain active, start a new one here.
      if (!chainActive) {
        chainActive = true;
        chainStartPh = p.ph;
        chainEndPh = p.ph;
        contributedKeys = new Set();
        ordinal = 0;
        spentAP = 0;
      }

      // Apply contributions in deterministic order (main then bonus).
      for (const k of keys) {
        // If previous contribution completed a chain and resetChain() fired,
        // start a fresh chain immediately (same phase / next selector).
        if (!chainActive) {
          chainActive = true;
          chainStartPh = p.ph;
          chainEndPh = p.ph;
          contributedKeys = new Set();
          ordinal = 0;
          spentAP = 0;
        }
        applyContribution(k, p.ph);
      }
    }

    // Finalize any trailing incomplete chain
    finalizeIncompleteChain();
  }

  // A completed selector is never considered lost/invalid.
  for (const k of complete) invalid.delete(k);
  // A selector with a range penalty overlay is also part of a valid (continued) chain.
  for (const k of purple.keys()) invalid.delete(k);
  for (const k of short.keys()) invalid.delete(k);

  return { invalid, complete, purple, short, need };
}



/**
 * Determine which combatants this user should see in the tracker right now.
 * - GM: can see all
 * - Player: sees only owned combatants, typically current-turn
 */
function getVisibleCombatants(combat) {
  // Always show ONLY the current-turn combatant.
  const combatants = combat?.combatants?.contents ?? [];
  const curId = combat?.combatantId ?? combat?.combatant?.id ?? null;
  if (!curId) return [];

  const cur = combatants.find(c => c.id === curId) || null;
  if (!cur) return [];

  // GM always sees it. Players see it only if they OWN the actor.
  if (game.user.isGM) return [cur];
  if (cur.actor?.testUserPermission(game.user, "OWNER")) return [cur];
  return [];
}

let _vddOutsideHandler = null;


// Auto-size <select> elements so their width fits the longest option label.
// This improves readability when selectors are displayed side-by-side.
function autosizeSelectElement(selectEl) {
  try {
    const el = selectEl;
    if (!el || !el.options || !el.options.length) return;

    const style = getComputedStyle(el);

    // Measure the longest option label using a hidden probe that matches the select's font styling.
    const probe = document.createElement("span");
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.whiteSpace = "nowrap";
    probe.style.fontFamily = style.fontFamily;
    probe.style.fontSize = style.fontSize;
    probe.style.fontWeight = style.fontWeight;
    probe.style.letterSpacing = style.letterSpacing;
    probe.style.textTransform = style.textTransform;
    document.body.appendChild(probe);

    let maxW = 0;
    for (const opt of Array.from(el.options)) {
      const t = String(opt?.text ?? "").trim();
      if (!t) continue;
      probe.textContent = t;
      maxW = Math.max(maxW, probe.offsetWidth);
    }
    probe.remove();

    // Add only the padding + a small allowance for the native dropdown arrow.
    const padL = parseFloat(style.paddingLeft) || 0;
    const padR = parseFloat(style.paddingRight) || 0;
    const arrowAllowance = 26; // keep tight; just enough for the arrow + gap
    const extra = Math.ceil(padL + padR + arrowAllowance);

    const target = Math.max(90, Math.ceil(maxW + extra));
    el.style.width = `${target}px`;
  } catch (_) {}
}

class RMUCombatPhaseTrackerApp extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "rmu-phase-tracker-v3",
      title: "RMU Phase Tracker v3",
      template: `modules/${MODULE_ID}/templates/tracker.hbs`,
      classes: ["rmu-cpt", "rmu-cpt-app"],
      width: 1500,
      height: 460,
      minHeight: 320,
      minWidth: 1200,
      resizable: false,
    });
  }

  get combat() { return game.combat; }

  async getData() {
    const combat = this.combat;
    if (!combat) return { noCombat: true };

    const rawState = await ensureCombatState(combat);
    const state = game.user.isGM ? rawState : applyPendingToState(combat.id, rawState);

    let actions = parseActionsConfig();
    if (!Array.isArray(actions) || !actions.length) actions = getDefaultActions();
    // Keep original actions for Instantaneous selector logic (minCost=0) but treat them as minCost=1 in phase selectors.
    const actionsOrig = actions;
    const actionsPhase = actionsOrig.map(a => {
      const mn = Number(a?.minCost ?? 0);
      if (mn === 0) {
        const mx = Number(a?.maxCost ?? mn);
        return { ...a, minCost: 1, maxCost: Math.max(1, mx) };
      }
      return a;
    });
    const instantKeys = new Set(actionsOrig.filter(a => Number(a?.minCost ?? 0) === 0).map(a => a.key));
    const actionsMap = actionsToMap(actionsPhase);

    let roundsShown = 1;
    try { roundsShown = clamp(game.settings.get(MODULE_ID, "roundsShown"), 1, 5); }
    catch (_) { roundsShown = 1; }
    const phaseInfo = detectPhaseInfo(combat);
    const apPerPhase = detectApPerPhase(combat);

    // Use the Foundry user color from the current logged-in user configuration.
    // This is the same color shown as the user's dot in the UI.
    let userColorHex = getCurrentUserColorHex();

    // Background tint derived from the CURRENT logged-in user's configured color.
    // Keep it readable by layering a moderate tint over a dark base.
    let userBgTop = hexToRgba(userColorHex, 0.38) || "rgba(0,0,0,0.55)";
    let userBgBot = hexToRgba(userColorHex, 0.16) || "rgba(0,0,0,0.40)";

    // Current round/phase as presented by the UI. Used for UI-only affordances
    // like enabling FIN/ACT? unchecking within the current round.
    const curRound = Number(phaseInfo?.round ?? 1);

    const showActionImages = !!game.settings.get(MODULE_ID, "showActionImages");
    const actionImageMap = game.settings.get(MODULE_ID, "actionImageMap") ?? {};

    // Normalize image paths so they always resolve from the Foundry server root.
    // Users often store relative paths like "assets/..."; without a leading slash
    // the browser may resolve them relative to the current route (e.g. "/game"),
    // which results in 404s and a missing image.
    const normalizeImagePath = (p) => {
      if (!p || typeof p !== "string") return "";
      const s = p.trim();
      if (!s) return "";
      if (/^(https?:)?\/\//i.test(s)) return s;
      if (s.startsWith("/")) return s;
      return `/${s}`;
    };



    const visibleCombatants = getVisibleCombatants(combat);

    // GM view: match the current-turn combatant's owning player's dot color (if any).
    // This means the GM's UI changes color as turns pass between different players.
    try {
      if (game.user.isGM && Array.isArray(visibleCombatants) && visibleCombatants.length) {
        const tintHex = getTintHexForCombatant(visibleCombatants[0]);
        if (tintHex && tintHex !== userColorHex) {
          userColorHex = tintHex;
          userBgTop = hexToRgba(userColorHex, 0.38) || "rgba(0,0,0,0.55)";
          userBgBot = hexToRgba(userColorHex, 0.16) || "rgba(0,0,0,0.40)";
        }
      }
    } catch (_) {}

    // If the current-turn combatant isn't visible to this user, avoid rendering an empty/blank UI.
    if (!visibleCombatants || visibleCombatants.length === 0) {
      return {
        noCombat: false,
      isGM: game.user.isGM,
      showActionImages: !!game.settings.get(MODULE_ID, "showActionImages"),
        noVisibleCombatant: true,
        isGM: game.user.isGM,
        uiTheme: game.user.isGM ? "gm" : "player",
        uiVersion: UI_VERSION,
        userColorHex,
        userBgTop,
        userBgBot,
        showActionImages: !!game.settings.get(MODULE_ID, "showActionImages"),
        round: phaseInfo.round,
        phase: phaseInfo.phase,
        phaseCount: phaseInfo.phaseCount,
        roundsShown,
        actions: actionsOrig,
        rows: []
      };
    }


    const rows = visibleCombatants.map(c => {
      const cd = (state.combatants?.[c.id]) ?? {};
      const bonusCount = clamp(cd.bonusCount ?? 0, 0, 4);
      const concFlags = normalizeConcFlags(cd);
      const holdMeta = foundry.utils.deepClone(cd.holdAction ?? {});
      const concentrating = countConcOn(concFlags) > 0;

      // Hide instantaneous (minCost 0) actions from phase selectors unless an instantaneous action has been chosen.
      const instantAction = (cd.instantAction ?? "available");
      const instantUnlocked = (instantAction !== "available");
      const selectorActionsBase = instantUnlocked ? actionsPhase : actionsPhase.filter(a => !instantKeys.has(a.key));
      const selectorActionsForValue = (value) => {
        // When TWO concentration toggles are ON, only allow "Move Your BMR" (and the default "—") in phase selectors.
        // Keep an already-selected legacy value visible so the <select> can still render it, but do not offer other actions.
        const concOnCount = countConcOn(concFlags);
        if (concOnCount >= 2) {
          const v = String(value ?? "none");
          const base = selectorActionsBase.filter(a => a.key === "move-bmr");
          const meta = actionsMap.get(v);
          if (meta && v !== "none" && v !== "move-bmr") return [meta, ...base.filter(a => a.key !== meta.key)];
          return base;
        }

        if (instantUnlocked) return selectorActionsBase;
        const meta = actionsMap.get(value);
        // If a legacy instantaneous action is already selected in a phase slot, keep it visible so the <select> can render it.
        if (meta && instantKeys.has(meta.key)) return [meta, ...selectorActionsBase];
        return selectorActionsBase;
      };


      // IMPORTANT: planActions must be available before building analysis phases.
      // Analysis needs to "promote" bonus selectors that were already used in prior phases,
      // even if bonusCount has since been reduced to 0 after spending bonus AP.
      const planActions = cd.planActions ?? {};
      const planAuto = cd.planAuto ?? {};
      const planCosts = cd.planCosts ?? {};
      const finActs = cd.finActs ?? {};

      // Token uuid for local movement tracking + UI overlays.
      const tokenUuid = (() => {
        try { if (c?.token?.uuid) return c.token.uuid; } catch (_) {}
        try {
          const tid = c?.tokenId ?? c?.token?.id;
          const td = (tid && canvas?.scene?.tokens?.get(tid)) ? canvas.scene.tokens.get(tid) : null;
          if (td?.uuid) return td.uuid;
          return tid ? String(tid) : "";
        } catch (_) {}
        return "";
      })();

      // Movement overlays compute caps dynamically per internal slot (Dash can be conditionally allowed on the last slot).

      // Display phases follow the Combat Tracker phase count, but each phase can provide more than 1 AP.
      // To keep existing chain mechanics intact, we continue to model 4 internal "action slots" per round
      // and group them into the visible number of phases based on the Combat Tracker "Spend X AP per Phase".
      const realPhaseCount = clamp(Number(phaseInfo.phaseCount ?? 4), 1, 20);
      const slotsPerRealPhase = clamp(Number(apPerPhase ?? 1), 1, 4);
      const internalPhaseCount = 4;

      // Map current real phase -> current internal slot range.
      const curRealPhase = clamp(Number(phaseInfo.phase ?? 1), 1, realPhaseCount);
      const currentInternalStart = clamp(((curRealPhase - 1) * slotsPerRealPhase) + 1, 1, internalPhaseCount);
      const currentInternalEnd = clamp(currentInternalStart + slotsPerRealPhase - 1, 1, internalPhaseCount);

// In 1–2 real-phase modes, a visible phase contains multiple internal slots.
// We want to detect breaks between sequential selectors *as soon as the user makes them*,
// but we must NOT falsely break a chain that continues across round boundaries when a new round starts.
// So: treat the chain-eval "current" internal phase as the RIGHTMOST internal slot in the current
// visible phase that already has a selection; if none are selected yet, use the first internal slot.
let currentInternalForChainEval = currentInternalStart;
for (let ip = currentInternalStart; ip <= currentInternalEnd; ip++) {
  const kmEval = phaseKey(phaseInfo.round, ip, "m");
  const kbEval = phaseKey(phaseInfo.round, ip, "b");
  const mvEval = planActions[kmEval] ?? "none";
  const bvEval = planActions[kbEval] ?? "none";
  if (mvEval !== "none" || bvEval !== "none") currentInternalForChainEval = ip;
}

const phaseInfoInternal = { ...phaseInfo, phaseCount: internalPhaseCount, phase: currentInternalStart };

      // "Move Your BMR" is a special case for the green "Complete!!" label.
      // Even though it is a 1 AP action (and therefore chain-complete immediately), we only want to
      // show "Complete!!" once the token has actually moved during the *current visible phase*.
      // This value sums any Move-BMR distance committed to Move-BMR slots within the current phase group.
      const currentPhaseMoveUsed = (() => {
        try {
          if (!tokenUuid) return 0;
          const tr = _moveTrack.get(tokenUuid);
          if (!tr || !tr.usedBySlot) return 0;

          const moveKeys = [];
          for (let ip = currentInternalStart; ip <= currentInternalEnd; ip++) {
            for (const t of ["m", "b"]) {
              const k = phaseKey(phaseInfo.round, ip, t);
              const v = String(planActions?.[k] ?? "none");
              if (v === "move-bmr") moveKeys.push(k);
            }
          }
          if (!moveKeys.length) return 0;

          let sum = 0;
          for (const k of moveKeys) sum += Number(tr.usedBySlot?.[k] ?? 0);

          // Include any live-drag preview allocation for the current round so the label can appear immediately.
          const pv = _movePreview.get(tokenUuid);
          if (pv && pv.mode === "move" && Number(pv.round ?? 0) === Number(phaseInfo.round ?? 0)) {
            for (const k of moveKeys) sum += Number(pv.allocations?.[k] ?? 0);
          }

          return Number.isFinite(sum) ? sum : 0;
        } catch (_) {
          return 0;
        }
      })();


      const internalPhases = buildPhases({ baseRound: phaseInfo.round, roundsShown, bonusCount, phaseCount: internalPhaseCount });
      const phasesAnalysis = buildPhasesForAnalysis({ phaseInfo: phaseInfoInternal, roundsShown, bonusCount, phaseCount: internalPhaseCount, actions: actionsPhase, planActions });

      // Each internal slot contributes 1 AP (or 0.5 while concentrating). Total per visible phase is slotsPerRealPhase.
      const capByKey = buildCapByKey({ phasesAnalysis, flags: concFlags, holdMeta, apPerPhase: 1 });

      const chainEvalArr = evaluateChainsWithPenalty({
        phases: phasesAnalysis, planActions, actionsMap, concentrating, capByKey, apPerPhase: 1, planCosts, finActs,
        currentPhase: currentInternalForChainEval, currentRound: phaseInfo.round
      });
      const chainEvalByPhase = new Map();
      for (let i = 0; i < phasesAnalysis.length; i++) {
        const aph = phasesAnalysis[i];
        chainEvalByPhase.set(`r${aph.round}p${aph.phase}`, chainEvalArr[i]);
      }

      const chainUI = analyzeChainsForUI({ phases: phasesAnalysis, planActions, actionsMap, concentrating, capByKey, apPerPhase: 1, planCosts, finActs, currentPhase: currentInternalForChainEval, currentRound: phaseInfo.round });
      const invalidKeys = chainUI.invalid;
      const completeKeys = chainUI.complete;
      const purpleMap = chainUI.purple;
      const shortMap = chainUI.short;

      // Build per-internal-slot cell data first (plan keys remain rXpYm / rXpYb).
      const internalCells = internalPhases.map((ph) => {
        const label = `Phase ${ph.phase}`;
        const isCurrent = (ph.round === phaseInfo.round) && (ph.phase >= currentInternalStart) && (ph.phase <= currentInternalEnd);

        const km = phaseKey(ph.round, ph.phase, "m");
        const kb = phaseKey(ph.round, ph.phase, "b");

        const mainValue = planActions[km] ?? "none";
        const bonusValue = ph.hasBonus ? (planActions[kb] ?? "none") : "none";

        const mainMeta = actionsMap.get(mainValue);
        const bonusMeta = actionsMap.get(bonusValue);

        const mainImg = (showActionImages ? normalizeImagePath(actionImageMap?.[mainValue] ?? "") : "");
        const bonusImg = (showActionImages ? normalizeImagePath(actionImageMap?.[bonusValue] ?? "") : "");

        // If this slot is "Move Your BMR", overlay local tracked distance + inferred Pace on top of the action image.
        // The overlay persists on every Move slot image across phases, and resets on new round.
        const moveOverlay = (() => {
          try {
            // Overlay must render even when no image is configured (or images are disabled).
            // The template will place it on the left inside the phase frame in that case.
            // (Previously this returned early, which is why overlays disappeared when images were off.)
            if (String(mainValue) !== "move-bmr") return "";
            if (!tokenUuid) return "";
            const tr = _moveTrack.get(tokenUuid);
            const committedUsed = Number(tr?.usedBySlot?.[km] ?? 0);
            const pv = _movePreview.get(tokenUuid);
            const pvApplies = Boolean(pv && pv.activeSlotKey === km && Number(pv.round ?? 0) === Number(phaseInfo?.round ?? 1));
            const pvAlloc = pvApplies ? Number(pv.allocations?.[km] ?? 0) : 0;
            const used = committedUsed + (Number.isFinite(pvAlloc) ? pvAlloc : 0);
            const u = Number.isFinite(used) ? used : 0;

            // Work out the cap for THIS internal slot.
            const a = c?.actor ?? null;
            const p = getActorPaceRates(a);
            const rates = p?.rates ?? [];
            // Per user rule: each "Move Your BMR" selector grants up to 1×BMR distance for that selector.
            // Pace classification is based on the *round total* vs BMR multipliers, not on per-selector caps.
            const bmrPerSelectorRaw = Number(p?.bmrPerPhase ?? 0);
            const concOnCount = countConcOn(concFlags);
            // Single concentration halves BMR itself; double concentration caps movement at Creep (0.5×BMR) for the selector.
            // Two concentration toggles => movement capped at Creep (0.5×BMR) for the selector.
            const bmrPerSelector = (concOnCount >= 2) ? (bmrPerSelectorRaw * 0.5) : (concOnCount === 1) ? (bmrPerSelectorRaw * 0.5) : bmrPerSelectorRaw;
            // User rule: for "Move Your BMR", pace is ALWAYS inferred from the CURRENT TOTAL moved
            // compared to the actor's real BMR (not the per-selector effective cap while concentrating).
            const bmrBase = bmrPerSelectorRaw;
            const maxPaceLabelUsed = (concOnCount >= 2) ? "Creep" : p?.maxPaceLabel;
            const dashScale = (concOnCount === 1) ? 0.5 : 1;
            const dashRate = (rates || []).find(r => r.pace === "Dash" && r.allowed && Number.isFinite(r.perPhase) && r.perPhase > 0);

            const isLastInternalSlot = (ph.phase === internalPhaseCount);
            const inLastVisiblePhase = (currentInternalEnd === internalPhaseCount);
            const instantStillAvailable = String(instantAction ?? "available") === "available";

            // Dash is only considered if:
            // - we're in a view that includes the final internal slot
            // - instantaneous is still available
            // - load gate allows it
            // - and the final internal slot is also a Move Your BMR selection (so there is a Dash opportunity)
            const lastMoveKeyM = phaseKey(phaseInfo.round, internalPhaseCount, "m");
                const lastMoveKeyB = phaseKey(phaseInfo.round, internalPhaseCount, "b");
                const lastIsMoveAny = (String(planActions?.[lastMoveKeyM] ?? "none") === "move-bmr") || (String(planActions?.[lastMoveKeyB] ?? "none") === "move-bmr");
            const dashOk = Boolean((concOnCount < 2) && inLastVisiblePhase && instantStillAvailable && dashRate && isDashEligibleByLoad(a) && lastIsMoveAny && (!maxPaceLabelUsed || paceOrderIndex(normalizePaceName(maxPaceLabelUsed)) >= paceOrderIndex("Dash")));
            // Base per-selector cap is 1×BMR, except the special 1.25× Move-BMR rule.
            // IMPORTANT: This overlay must match the enforcement logic.
            const slotsPerReal = clamp(Number(slotsPerRealPhase ?? 1), 1, 4);
            const grpStart = (Math.floor((Number(ph.phase ?? 1) - 1) / slotsPerReal) * slotsPerReal) + 1;
            const grpEnd = Math.min(Number(internalPhaseCount ?? 4), grpStart + slotsPerReal - 1);
            const prev = getPrevActionPhaseRange(phaseInfo?.round ?? 1, grpStart, grpEnd, slotsPerReal, internalPhaseCount);
            const prevRound = prev.round;
            const prevStart = prev.start;
            const prevEnd = prev.end;
            const combatId = game?.combat?.id;
            const prevPhaseKeyId = (combatId && prevRound >= 1) ? `${combatId}:${prevRound}:${prevStart}-${prevEnd}` : null;
            let prevMovedFt = (prevRound >= 1) ? sumMovementForInternalRange(tr, prevRound, prevStart, prevEnd) : 0;
            // If we crossed a round boundary, _moveTrack may have been reset. Use carryover snapshot.
            if (prevMovedFt <= MOVE_EPS_FT && (prevRound >= 1)) {
              const snap = _prevPhaseCarry.get(tokenUuid);
              if (snap && snap.combatId === combatId && Number(snap.round) === Number(prevRound) && Number(snap.start) === Number(prevStart) && Number(snap.end) === Number(prevEnd)) {
                prevMovedFt = Number(snap.totalFt ?? 0);
              }
            }
            const effectiveBmrForThreshold = (concOnCount === 1) ? (bmrPerSelectorRaw * 0.5) : bmrPerSelectorRaw;
            const lightLoadOk = isLightLoadAtMost15(a);
            const prevMovedEnough = (prevMovedFt >= (0.5 * effectiveBmrForThreshold) - MOVE_EPS_FT);
            // 1.25x Move-BMR boost may apply in ANY Move slot as long as the rules are met.
            // (Light load ≤15%, and in the previous action-phase the actor moved ≥ 1/2 their effective BMR.)
            const canUseMoveBoost = Boolean(lightLoadOk && prevMovedEnough && concOnCount === 0);
            const cap = canUseMoveBoost ? (bmrPerSelector * 1.25) : bmrPerSelector;
            // Pace is derived from TOTAL distance moved in the round compared to the Actor's BMR base value.
            // For "history" readability, each slot shows total-so-far (up to this internal phase).
            // Live (during drag) preview only updates on the active Move slot overlay.
            const roundN = Number(phaseInfo?.round ?? 1);
            const committedRoundTotal = getRoundTotal(tr, roundN);
            const committedTotalHere = getRoundTotalUpToInternal(tr, roundN, ph.phase);

            const pvTotal = (pvApplies && Number(pv.round ?? 0) === roundN) ? Number(pv.allocatedTotal ?? 0) : 0;
            const total = pvApplies ? (committedRoundTotal + (Number.isFinite(pvTotal) ? pvTotal : 0)) : committedTotalHere;

// RMU BMR table is per-round. Our movementBlock values are per internal phase, so scale up.
// Pace is inferred from TOTAL distance moved in the round compared to the Actor's BMR base value.
// User rule: multiplier thresholds are based on the BMR value itself (not scaled by phase-count).
            const dashOkTable = Boolean((concOnCount < 2) && instantStillAvailable && isDashEligibleByLoad(a));
            const inf = inferPaceFromBmrTable(total, bmrBase, dashOkTable, maxPaceLabelUsed);
// Show per-slot usage plus TOTAL moved this round (pace is inferred from total).
            // Also show cap if we can determine one for this slot (Dash cap only on last internal slot when allowed).
            const slotCap = (isLastInternalSlot && dashOk) ? (Number(dashRate?.perPhase ?? bmrPerSelector) * dashScale) : cap;
            if (Number.isFinite(slotCap) && slotCap > 0) return `${u.toFixed(1)} / ${slotCap.toFixed(1)} ft\nTotal ${total.toFixed(1)} ft\n${inf.pace}`;
            return `${u.toFixed(1)} ft\nTotal ${total.toFixed(1)} ft\n${inf.pace}`;
          } catch (_) { return ""; }
        })();

        const bonusMoveOverlay = (() => {
  try {
    // Bonus Move-BMR overlay must render even without an image (or when images are disabled).
    if (String(bonusValue) !== "move-bmr") return "";
    if (!tokenUuid) return "";
    const tr = _moveTrack.get(tokenUuid);
    const committedUsed = Number(tr?.usedBySlot?.[kb] ?? 0);
    const pv = _movePreview.get(tokenUuid);
    const pvApplies = Boolean(pv && pv.activeSlotKey === kb && Number(pv.round ?? 0) === Number(phaseInfo?.round ?? 1));
    const pvAlloc = pvApplies ? Number(pv.allocations?.[kb] ?? 0) : 0;
    const used = committedUsed + (Number.isFinite(pvAlloc) ? pvAlloc : 0);
    const u = Number.isFinite(used) ? used : 0;

    const a = c?.actor ?? null;
    const p = getActorPaceRates(a);
    const rates = p?.rates ?? [];
    const bmrPerSelectorRaw = Number(p?.bmrPerPhase ?? 0);
    const concOnCount = countConcOn(concFlags);
    // Two concentration toggles => movement capped at Creep (0.5×BMR) for the selector.
    const bmrPerSelector = (concOnCount >= 2) ? (bmrPerSelectorRaw * 0.5) : (concOnCount === 1) ? (bmrPerSelectorRaw * 0.5) : bmrPerSelectorRaw;
    // User rule: for "Move Your BMR", pace is ALWAYS inferred from the CURRENT TOTAL moved
    // compared to the actor's real BMR (not the per-selector effective cap while concentrating).
    const bmrBase = bmrPerSelectorRaw;
    const maxPaceLabelUsed = (concOnCount >= 2) ? "Creep" : p?.maxPaceLabel;
    const dashScale = (concOnCount === 1) ? 0.5 : 1;
    const dashRate = (rates || []).find(r => r.pace === "Dash" && r.allowed && Number.isFinite(r.perPhase) && r.perPhase > 0);

    const isLastInternalSlot = (ph.phase === internalPhaseCount);
    const inLastVisiblePhase = (currentInternalEnd === internalPhaseCount);
    const instantStillAvailable = String(instantAction ?? "available") === "available";

    // Dash is considered if final internal slot has any Move selector (main or bonus) available.
    const lastMoveKeyM = phaseKey(phaseInfo.round, internalPhaseCount, "m");
    const lastMoveKeyB = phaseKey(phaseInfo.round, internalPhaseCount, "b");
    const lastIsMoveAny = (String(planActions?.[lastMoveKeyM] ?? "none") === "move-bmr") || (String(planActions?.[lastMoveKeyB] ?? "none") === "move-bmr");

    const dashOkBase = Boolean(
      (concOnCount < 2) && inLastVisiblePhase && instantStillAvailable && dashRate &&
      isDashEligibleByLoad(a) &&
      lastIsMoveAny &&
      (!maxPaceLabelUsed || paceOrderIndex(normalizePaceName(maxPaceLabelUsed)) >= paceOrderIndex("Dash"))
    );

    // Base per-selector cap is 1×BMR, except the special 1.25× Move-BMR rule.
    // IMPORTANT: This overlay must match the enforcement logic.
    const slotsPerReal = clamp(Number(slotsPerRealPhase ?? 1), 1, 4);
    const grpStart = (Math.floor((Number(ph.phase ?? 1) - 1) / slotsPerReal) * slotsPerReal) + 1;
    const grpEnd = Math.min(Number(internalPhaseCount ?? 4), grpStart + slotsPerReal - 1);
            const prev = getPrevActionPhaseRange(phaseInfo?.round ?? 1, grpStart, grpEnd, slotsPerReal, internalPhaseCount);
            const prevRound = prev.round;
            const prevStart = prev.start;
            const prevEnd = prev.end;
    const combatId = game?.combat?.id;
    const prevPhaseKeyId = (combatId && prevRound >= 1) ? `${combatId}:${prevRound}:${prevStart}-${prevEnd}` : null;
    let prevMovedFt = (prevRound >= 1) ? sumMovementForInternalRange(tr, prevRound, prevStart, prevEnd) : 0;
    // If we crossed a round boundary, _moveTrack may have been reset. Use carryover snapshot.
    if (prevMovedFt <= MOVE_EPS_FT && (prevRound >= 1)) {
      const snap = _prevPhaseCarry.get(tokenUuid);
      if (snap && snap.combatId === combatId && Number(snap.round) === Number(prevRound) && Number(snap.start) === Number(prevStart) && Number(snap.end) === Number(prevEnd)) {
        prevMovedFt = Number(snap.totalFt ?? 0);
      }
    }
    const effectiveBmrForThreshold = (concOnCount === 1) ? (bmrPerSelectorRaw * 0.5) : bmrPerSelectorRaw;
    const lightLoadOk = isLightLoadAtMost15(a);
    const prevMovedEnough = (prevMovedFt >= (0.5 * effectiveBmrForThreshold) - MOVE_EPS_FT);
    // 1.25x Move-BMR boost may apply in ANY Move slot as long as the rules are met.
    const canUseMoveBoost = Boolean(lightLoadOk && prevMovedEnough && concOnCount === 0);
    const cap = canUseMoveBoost ? (bmrPerSelector * 1.25) : bmrPerSelector;

    const roundN = Number(phaseInfo?.round ?? 1);
    const committedRoundTotal = getRoundTotal(tr, roundN);
    const committedTotalHere = getRoundTotalUpToInternal(tr, roundN, ph.phase);

    const pvTotal = (pvApplies && Number(pv.round ?? 0) === roundN) ? Number(pv.allocatedTotal ?? 0) : 0;
    const total = pvApplies ? (committedRoundTotal + (Number.isFinite(pvTotal) ? pvTotal : 0)) : committedTotalHere;

    const dashOkTable = Boolean((concOnCount < 2) && instantStillAvailable && isDashEligibleByLoad(a));
    const inf = inferPaceFromBmrTable(total, bmrBase, dashOkTable, maxPaceLabelUsed);

    const slotCap = (isLastInternalSlot && dashOkBase) ? (Number(dashRate?.perPhase ?? cap) * dashScale) : cap;
    if (Number.isFinite(slotCap) && slotCap > 0) return `${u.toFixed(1)} / ${slotCap.toFixed(1)} ft\nTotal ${total.toFixed(1)} ft\n${inf.pace}`;
    return `${u.toFixed(1)} ft\nTotal ${total.toFixed(1)} ft\n${inf.pace}`;
  } catch (_) { return ""; }
})();

        // If this slot is NOT "Move Your BMR" but still represents an action, we allow limited (per-phase) movement.
        // Show a Move-style overlay on the action image with the phase cap + pace + penalty.
        const incidentalOverlay = (() => {
          try {
            // Incidental overlays must render even without an action image (or when images are disabled).
            // The template will place it on the left inside the phase frame in that case.
            const mv = String(mainValue ?? "none");
            if (mv === "none" || mv === "move-bmr") return { text: "", pen: "" };
            if (!tokenUuid) return { text: "", pen: "" };

            const tr = _moveTrack.get(tokenUuid);

            // Compute this internal slot's visible phase-group range.
            const grpStart = (Math.floor((Number(ph.phase ?? 1) - 1) / Number(slotsPerRealPhase ?? 1)) * Number(slotsPerRealPhase ?? 1)) + 1;
            const grpEnd = Math.min(Number(internalPhaseCount ?? 4), grpStart + Number(slotsPerRealPhase ?? 1) - 1);
            const incKey = `i${ph.round}p${grpStart}-${grpEnd}`;

            const committedUsed = Number(tr?.usedBySlot?.[incKey] ?? 0);
            const pv = _movePreview.get(tokenUuid);
            const pvApplies = Boolean(pv && pv.mode === "incidental" && pv.activeSlotKey === incKey && Number(pv.round ?? 0) === Number(ph.round ?? 1));
            const pvAlloc = pvApplies ? Number(pv.allocations?.[incKey] ?? 0) : 0;
            const used = committedUsed + (Number.isFinite(pvAlloc) ? pvAlloc : 0);
            if (!(used > 0) && !pvApplies) return { text: "", pen: "" };

            const a = c?.actor ?? null;
            const p = getActorPaceRates(a);
            const rawBmr = Number(p?.bmrPerPhase ?? 0);
            if (!Number.isFinite(rawBmr) || rawBmr <= 0) return { text: "", pen: "" };

            const concOnCount = countConcOn(concFlags);
            const bmrEffective = (concOnCount === 1) ? (rawBmr * 0.5) : rawBmr;
            const capPace = computeIncidentalCapPace({ defaultCap: "Run", loadMaxPaceLabel: p?.maxPaceLabel, concOnCount });
            const capFt = Math.max(0, bmrEffective * phasePaceCapFrac(capPace));

            const inf = inferPhasePacePenalty(used, bmrEffective, capPace);

            const text = `${used.toFixed(1)} / ${capFt.toFixed(1)} ft\n${inf.pace} (cap ${capPace})`;
            const pt = String(inf.penaltyText ?? "—");
            const pen = (pt && pt !== "—" && pt !== "-" && pt !== "0") ? pt : "";
            return { text, pen };
          } catch (_) {
            return { text: "", pen: "" };
          }
        })();

        const mainMn = Number(mainMeta?.minCost ?? 0);
        const mainMx = Number(mainMeta?.maxCost ?? mainMn);
        const bonusMn = Number(bonusMeta?.minCost ?? 0);
        const bonusMx = Number(bonusMeta?.maxCost ?? bonusMn);
        const mainIsRange = !!mainMeta && (mainValue !== "none") && (mainMx > mainMn);
        const bonusIsRange = !!bonusMeta && (bonusValue !== "none") && (bonusMx > bonusMn);

        const ce = chainEvalByPhase.get(`r${ph.round}p${ph.phase}`) ?? { contrib: 0, broke: false, penalty: 0, lost: false };

        let status = "";
        let statusType = "";
        if (ce.lost) {
          status = "LOST";
          statusType = "broken";
        } else if (ce.broke) {
          if (ce.penalty && ce.penalty !== 0) status = "BROKEN";
          else status = "LOST";
          statusType = "broken";
        } else if (ce.contrib > 0) {
          status = `+${ce.contrib} AP`;
        }

        function slotCost(slotKey, actionKey) {
          const meta = actionsMap.get(actionKey);
          if (!meta) return null;
          const mn = Number(meta.minCost ?? 0);
          const mx = Number(meta.maxCost ?? mn);
          if (mn === mx) return null;
          const stored = Number(planCosts?.[slotKey]);
          const val = (!Number.isNaN(stored) && stored >= mn && stored <= mx) ? stored : mn;
          const options = [];
          for (let x = mn; x <= mx; x++) options.push(x);
          return { value: val, options, costOptions: options.map(o => ({ value: o, label: String(o), selected: String(o) === String(val) })), vddOptions: buildVddOptionsForCost({ value: val, options }).opts, vddDisplay: buildVddOptionsForCost({ value: val, options }).displayText };
        }

        return {
          label,
          isCurrent,
          hasBonus: ph.hasBonus,
          status,
          statusType,
          main: {
            key: km,
            value: mainValue,
            icon: mainMeta?.icon ?? "",
            image: mainImg,
            moveOverlay,
            incidentalOverlay: incidentalOverlay?.text ?? "",
            incidentalPenalty: incidentalOverlay?.pen ?? "",
            // When a movement overlay is present on this selector (Move or Incidental),
            // show a small "Reset Move" button in the current phase.
            showResetMove: !!(moveOverlay || (incidentalOverlay?.text ?? "")),
            isAuto: !!planAuto[km],
            isInvalid: invalidKeys?.has(km) ?? false,
            // Gated complete label for Move Your BMR: only show Complete!! once movement has occurred in this phase.
            isComplete: (completeKeys?.has(km) ?? false) && (!isCurrent || String(mainValue) !== "move-bmr" || (Number(currentPhaseMoveUsed) > 1e-6)),
            showFinAct: mainIsRange && isCurrent && ((((purpleMap?.get(km) ?? "") || (shortMap?.get(km) ?? "")) !== "") || !!finActs?.[km]),
            finActChecked: !!finActs?.[km],
            finActDisabled: !isCurrent,
            rangePenalty: purpleMap?.get(km) ?? "",
            shortPenalty: shortMap?.get(km) ?? "",
            penaltyText: (purpleMap?.get(km) ?? "") || (shortMap?.get(km) ?? ""),
            vddOptions: buildVddOptionsForActions(selectorActionsForValue(mainValue), mainValue).opts,
            mainOptions: buildVddOptionsForActions(selectorActionsForValue(mainValue), mainValue).opts.map(o => ({...o, selected: o.value === mainValue})),
            vddDisplay: buildVddOptionsForActions(selectorActionsForValue(mainValue), mainValue).displayText,
            cost: slotCost(km, mainValue)
          },
          bonus: ph.hasBonus ? {
            key: kb,
            value: bonusValue,
            icon: bonusMeta?.icon ?? "",
            image: bonusImg,
              moveOverlay: bonusMoveOverlay,
            // Only Move actions show a movement overlay on bonus selectors.
            showResetMove: !!bonusMoveOverlay,
            isAuto: !!planAuto[kb],
            isInvalid: invalidKeys?.has(kb) ?? false,
            // Gated complete label for Move Your BMR on bonus selectors (rare, but supported).
            isComplete: (completeKeys?.has(kb) ?? false) && (!isCurrent || String(bonusValue) !== "move-bmr" || (Number(currentPhaseMoveUsed) > 1e-6)),
            showFinAct: bonusIsRange && isCurrent && ((((purpleMap?.get(kb) ?? "") || (shortMap?.get(kb) ?? "")) !== "") || !!finActs?.[kb]),
            finActChecked: !!finActs?.[kb],
            finActDisabled: !isCurrent,
            rangePenalty: purpleMap?.get(kb) ?? "",
            shortPenalty: shortMap?.get(kb) ?? "",
            penaltyText: (purpleMap?.get(kb) ?? "") || (shortMap?.get(kb) ?? ""),
            vddOptions: buildVddOptionsForActions(selectorActionsForValue(bonusValue), bonusValue).opts,
            bonusOptions: buildVddOptionsForActions(selectorActionsForValue(bonusValue), bonusValue).opts.map(o => ({...o, selected: o.value === bonusValue})),
            vddDisplay: buildVddOptionsForActions(selectorActionsForValue(bonusValue), bonusValue).displayText,
            cost: slotCost(kb, bonusValue),
          } : null
        };
      });

      const internalByKey = new Map();
      for (const cph of internalCells) {
        // label is not used for lookup; build key from the plan key round/phase
        const m = cph?.main?.key ?? "";
        const match = /^r(\d+)p(\d+)m$/.exec(m);
        if (match) internalByKey.set(`r${match[1]}p${match[2]}`, cph);
      }

      // Group internal slot phases into visible phases.
      const phaseCells = [];
      for (let rOff = 0; rOff < roundsShown; rOff++) {
        const roundN = Number(phaseInfo.round ?? 1) + rOff;
        for (let rp = 1; rp <= realPhaseCount; rp++) {
          const internalStart = ((rp - 1) * slotsPerRealPhase) + 1;
          const internalEnd = internalStart + slotsPerRealPhase - 1;

          const isCurrent = (roundN === Number(phaseInfo.round ?? 1)) && (rp === curRealPhase);

          const mains = [];
          const bonuses = [];

          // Aggregate status from internal phases.
          let anyLost = false;
          let anyBroken = false;
          let contribSum = 0;

          for (let ip = internalStart; ip <= internalEnd; ip++) {
            const cell = internalByKey.get(`r${roundN}p${ip}`);
            if (!cell) continue;
            // Preserve existing per-slot mechanics.
            // IMPORTANT: The LOST/BROKEN state is shown *between* selectors (left-to-right).
            // Our chain evaluator flags the *current* phase as LOST/BROKEN when it fails to
            // continue the chain from the previous phase. Therefore, the separator between
            // slot ip and ip+1 should reflect the evaluation result for ip+1 (not ip).
            // We collect slots first, then assign chainAfter from the next slot in the same
            // visible phase.
            mains.push({
              ...cell.main,
              __ip: ip
            });
            if (cell.hasBonus && cell.bonus) bonuses.push(cell.bonus);

            const ce = chainEvalByPhase.get(`r${roundN}p${ip}`) ?? null;
            if (ce) {
              if (ce.lost) anyLost = true;
              else if (ce.broke) anyBroken = true;
              if (Number.isFinite(ce.contrib)) contribSum += Number(ce.contrib);
            }
          }

// If there is only one main selector in this visible phase (e.g. 4 phases/round),
// we still need the red-overlay + incomplete label to work when a chain from the
// previous phase/round must continue here.
if (mains.length === 1 && isCurrent) {
  const only = mains[0];
  const expectedNeed = (chainUI && chainUI.need) ? chainUI.need.get(only.key) : null;
  if (expectedNeed && !only.chainBefore) {
    // Any truthy value triggers the red overlay via is-chainbroken; the label uses expectedNeed for the name.
    only.chainBefore = "NEED";
  }
}

          // Assign chain separators for multi-selector visible phases.
          // chainAfter is stored on the *left* slot and reflects the state of the *next* slot.
          if (mains.length > 1) {
            // Build a quick lookup of eval state by internal ip within this visible phase.
            const evalByIp = new Map();
            for (const m of mains) {
              const ip = m.__ip;
              if (!ip) continue;
              evalByIp.set(ip, chainEvalByPhase.get(`r${roundN}p${ip}`) ?? null);
            }

            // IMPORTANT (1–2 phase/rnd modes): a chain can cross rounds. If the *first* internal
            // slot in this visible phase fails to continue a chain from the previous internal
            // phase (often in the previous round), there is no left-hand separator inside this
            // visible phase to carry the LOST/BROKEN state. In that case, mark the first slot
            // itself as chain-broken so the selector can turn RED while still showing
            // "Complete!!" for 1 AP actions.
            {
              const first = mains[0];
              const ceFirst = first?.__ip ? (evalByIp.get(first.__ip) ?? null) : null;
              const firstState = ceFirst?.lost ? "LOST" : (ceFirst?.broke ? ((ceFirst?.penalty && ceFirst.penalty !== 0) ? "BROKEN" : "LOST") : "");
              if (first && firstState) first.chainBefore = firstState;
            }

            for (let i = 0; i < mains.length - 1; i++) {
              const left = mains[i];
              const nextIp = (left.__ip ?? 0) + 1;
              const ceNext = evalByIp.get(nextIp) ?? null;
              const state = ceNext?.lost ? "LOST" : (ceNext?.broke ? ((ceNext?.penalty && ceNext.penalty !== 0) ? "BROKEN" : "LOST") : "");
              left.chainAfter = state;
              const right = mains[i + 1];
              if (right) right.chainBefore = state;
            }
          }
          // Derive a short action name for labels (e.g. "Melee" from "Melee (2-4)").
          // In some layouts (esp. 1–2 phase/rnd), a selector can be marked chain-broken even when the
          // immediate cell's eval record doesn't carry expectedAction (e.g. when a prior slot is marked LOST).
          // To ensure the "<Action> Incomplete" label always shows the chain's action name, capture the
          // first non-empty expectedAction for this visible phase and fall back to it when needed.
          let phaseExpectedKey = "";
          if (typeof evalByIp !== "undefined" && evalByIp) {
            for (const mm of mains) {
              const ceAny = mm?.__ip ? (evalByIp.get(mm.__ip) ?? null) : null;
              const kAny = String(ceAny?.expectedAction ?? "");
              if (kAny && kAny !== "none") { phaseExpectedKey = kAny; break; }
            }
            if (!phaseExpectedKey && mains?.length) {
              // Try adjacent internal slots just outside this visible phase.
              const firstIp = mains[0]?.__ip ?? 0;
              const lastIp = mains[mains.length - 1]?.__ip ?? 0;
              const cePrev = firstIp ? (evalByIp.get(firstIp - 1) ?? null) : null;
              const ceNext = lastIp ? (evalByIp.get(lastIp + 1) ?? null) : null;
              phaseExpectedKey = String(cePrev?.expectedAction ?? "") || String(ceNext?.expectedAction ?? "") || "";
            }
          }

          for (const m of mains) {
            const txt = String(m?.vddDisplay ?? "-");
            const name = txt.split(" (")[0].trim();

            // If this selector is RED due to breaking an in-progress chain, show the
            // *expected* chain action name (the action that was left incomplete),
            // even if the current selector is "-" / "No Action".
            let expectedKey = "";
            if (m?.chainBefore) {
              // Prefer the UI chain analyzer's expected action when the chain spans phases/rounds and this selector is still '-'.
              expectedKey = String(chainUI?.need?.get(m.key) ?? "");

              const ceHere = (typeof evalByIp !== "undefined" && evalByIp) ? (evalByIp.get(m.__ip) ?? null) : null;
              if (!expectedKey) expectedKey = String(ceHere?.expectedAction ?? "") || phaseExpectedKey;

              // Last-resort: check nearby internal slots inside the same visible phase.
              if (!expectedKey && m?.__ip) {
              if (typeof evalByIp !== "undefined" && evalByIp) {
                const ceP = evalByIp.get(m.__ip - 1) ?? null;
                const ceN = evalByIp.get(m.__ip + 1) ?? null;
                expectedKey = String(ceP?.expectedAction ?? "") || String(ceN?.expectedAction ?? "") || "";
              }
              }
            }
            if (expectedKey && expectedKey !== "none") {
              const meta = actionsMap.get(expectedKey);
              const lbl = String(meta?.label ?? expectedKey);
              const base = lbl.split(" (")[0].trim();
              m.actionName = base || lbl || expectedKey;
            } else {
              m.actionName = name || txt || "-";
            }

            // Show the label ONLY under the currently-active internal selector.
            m.showIncompleteLabel =
              isCurrent &&
              (Number(m.__ip) === Number(currentInternalForChainEval)) &&
              Boolean(m.chainBefore);
          }
          for (const b of bonuses) {
            const txt = String(b?.vddDisplay ?? "-");
            const name = txt.split(" (")[0].trim();
            b.actionName = name || txt || "-";
            b.showIncompleteLabel = Boolean(b.chainBefore) && Boolean(b.value) && b.value !== "none";
          }

          // Clean up internal helper fields so they don't leak to the template unintentionally.
          for (const m of mains) {
            if (m && Object.prototype.hasOwnProperty.call(m, '__ip')) delete m.__ip;
          }

          let status = "";
          let statusType = "";
          if (anyLost) {
            status = "LOST";
            statusType = "broken";
          } else if (anyBroken) {
            status = "BROKEN";
            statusType = "broken";
          } else if (contribSum > 0) {
            status = `+${contribSum} AP`;
          }

          phaseCells.push({
            label: `Phase ${rp}`,
            isCurrent,
            status,
            statusType,
            isMultiSlot: (mains.length > 1),
            mains,
            hasBonus: bonuses.length > 0,
            bonuses
          });
        }
      }
      const hasMultiSlot = (slotsPerRealPhase > 1);

      return {
        combatantId: c.id,
        name: c.name,
        img: (c.actor?.img ?? c.img),
        gmOwnedActor: isGmOwnedActor(c.actor),
        gmReadOnly: isGmReadOnlyActor(c.actor),
        hasMultiSlot,
        bonusCount,
        instantAction,
        instantOptions: buildInstantOptionsForActions(actionsOrig, instantAction).opts,

        // If 2+ concentration toggles are ON, lock phase selectors (main + bonus)
        // until the count drops below 2.
        lockPhaseSelectors: false, // no longer lock selectors on double-concentration
      twoConcMoveOnly: (countConcOn(concFlags) >= 2),

        // Mental Focus reminder:
// Appears 6 rounds after EXACTLY ONE concentration toggle becomes ON (and then every +6 rounds while exactly one remains ON).
// If 2+ toggles are ON, do NOT show it.
// Clicking the button hides it for that reminder round for this combatant.
showMentalFocusLabel: (() => {
  // Label is independent of the MF reminder button.
  // It only appears when TWO (or more) concentration toggles are ON at the same time.
  return (countConcOn(concFlags) >= 2);
})(),

showMentalFocusButton: (() => {
  const r = Number(getReminderRound(combat, state, phaseInfo) ?? 0);
  if (!Number.isFinite(r) || r <= 0) return false;
  if (countConcOn(concFlags) !== 1) return false;

  const start = Number(cd?.mentalFocusStartRound ?? 0);
  if (!Number.isFinite(start) || start <= 0) return false;

  // Inclusive timing: the round the first conc toggle is turned ON counts as round 1 of 6.
  const elapsed = (r - start + 1);
  if (!Number.isFinite(elapsed) || elapsed < 6) return false;
  if ((elapsed % 6) !== 0) return false;

  const ack = Number(cd?.mentalFocusAckRound ?? 0);
  return !(Number.isFinite(ack) && ack === r);
})(),



        // Endurance reminder button (every 6 rounds, always; no concentration requirement).
        // Clicking hides it for that reminder round for this combatant.
        showEnduranceButton: (() => {
          const r = Number(getReminderRound(combat, state, phaseInfo) ?? 0);
          if (!Number.isFinite(r) || r <= 0) return false;
          if (r % 6 !== 0) return false;
          const ack = Number(cd?.enduranceAckRound ?? 0);
          return !(Number.isFinite(ack) && ack === r);
        })(),

        concButtons: (() => {
          const curKm = phaseKey(phaseInfo.round, phaseInfo.phase, "m");
          const curKb = phaseKey(phaseInfo.round, phaseInfo.phase, "b");
          const curHasComplete = (completeKeys?.has(curKm) ?? false) || (completeKeys?.has(curKb) ?? false);
          const holdOn = !!concFlags.holdAction;
          const holdLabel = holdOn && holdMeta?.heldLabel ? `Hold: ${holdMeta.heldLabel}` : "Hold Action";
          const holdDisabled = (!holdOn && !curHasComplete);

          const mk = (flag, label, icon, disabledExtra=false) => {
            const isOn = !!concFlags[flag];
            return {
              flag,
              label: (flag === "holdAction") ? holdLabel : label,
              icon,
              isOn,
              disabled: !!disabledExtra
            };
          };

          return [
            mk("concentration", "Concentration", "fa-solid fa-bullseye"),
            mk("holdPosition", "Hold Position", "fa-solid fa-anchor"),
            mk("partialDodgeBlock", "Partial Dodge/Block", "fa-solid fa-shield-halved"),
            mk("spellPreparation", "Spell Preparation", "fa-solid fa-wand-magic-sparkles"),
            mk("holdAction", "Hold Action", "fa-solid fa-hourglass-half", holdDisabled)
          ];
        })(),
        phases: phaseCells
      };
    });
    // Owner-user color background (only when the combatant has a non-GM owner).
    let ownerBgTop = "";
    let ownerBgBot = "";
    try {
      const firstC = visibleCombatants?.[0];
      const a = firstC?.actor;
      const ownerUser = getPrimaryOwnerUser(a);
      // Only apply owner-color background when there's a real player owner.
      if (ownerUser && !ownerUser.isGM && ownerUser.color && !isGmOwnedActor(a)) {
        ownerBgTop = hexToRgba(ownerUser.color, 0.22);
        ownerBgBot = hexToRgba(ownerUser.color, 0.08);
      }
    } catch (_) {
      ownerBgTop = "";
      ownerBgBot = "";
    }



    return {
      noCombat: false,
      uiTheme: game.user.isGM ? "gm" : "player",
      uiVersion: UI_VERSION,
      userColorHex,
      userBgTop,
      userBgBot,
      ownerBgTop,
      ownerBgBot,
      showActionImages,
      round: phaseInfo.round,
      phase: phaseInfo.phase,
      phaseCount: phaseInfo.phaseCount,
      roundsShown,
      actions: actionsOrig,
      rows
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    // Apply the CURRENT logged-in user's configured Foundry color (the same one used for the user-dot)
    // directly to this app window's content. This avoids any ambiguity from theme defaults and ensures
    // each client sees their own color.
    try {
      const userHex = getTintHexForTrackerWindow(html);
      const tintTop = hexToRgba(userHex, 0.38) || "rgba(0,0,0,0.38)";
      const tintBot = hexToRgba(userHex, 0.16) || "rgba(0,0,0,0.16)";
      const winEl = html?.[0]?.closest?.('.rmu-cpt-app') || html?.[0]?.closest?.('.window-app');
      const wc = winEl?.querySelector?.('.window-content');
      if (wc) {
        wc.style.setProperty('--rmu-user-hex', userHex);
        wc.style.setProperty('--rmu-user-bg-top', tintTop);
        wc.style.setProperty('--rmu-user-bg-bot', tintBot);
        wc.style.background = `linear-gradient(180deg, ${tintTop}, ${tintBot}), rgb(8, 8, 10)`;
        wc.style.backgroundColor = 'rgb(8, 8, 10)';
      }
    } catch (e) {
      // Non-fatal; fall back to CSS defaults.
      console.warn('[RMU CPT] user color theme apply failed', e);
    }

    // Top-bar: open the Player Guide journal.
    html.find('button[data-action="openGuide"]').on('click', async (ev) => {
      ev.preventDefault();
      try {
        await openPlayerGuide();
      } catch (e) {
        console.error(e);
        ui.notifications?.error?.('Player Guide failed. See console.');
      }
    });

    // Top-bar: show the current-turn combatant's recent selections.
    html.find('button[data-action="openHistory"]').on('click', async (ev) => {
      ev.preventDefault();
      try {
        await openHistoryWindowForCurrentCombatant();
      } catch (e) {
        console.error(e);
        ui.notifications?.error?.('History failed. See console.');
      }
    });

    // Per-selector movement undo (only shows on selectors with a movement overlay).
    html.find('button[data-action="resetMove"]').off('click.rmuCpt').on('click.rmuCpt', async (ev) => {
      ev.preventDefault();
      const btn = ev.currentTarget;
      const combatantId = String(btn?.dataset?.combatantId ?? "").trim();
      const c = game.combat;
      if (!c || !combatantId) return;
      if (isGmReadOnlyCombatant(combatantId)) return;

      const ok = await resetMoveForCurrentPhaseGroup(c, combatantId);
      if (!ok) {
        ui.notifications?.warn?.("No movement to reset in the current phase.");
      } else {
        ui.notifications?.info?.("Movement reset.");
      }
      try { requestAppRefresh(); } catch (_) {}
    });

// --- Layout sizing helpers -------------------------------------------------
// HARD RULES (user preference):
// - No wrap-around.
// - No scrollbars.
// Approach:
// - Auto-fit the window width to the rendered content.
// - If the viewport is too narrow, shrink phase frames (CSS var --rmu-phase-w)
//   so everything still stays on one row.
const _debouncedFitNoWrap = (() => {
  let t = null;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      try {
        const root = html?.[0] ?? html;
        const winEl = root?.closest?.('.window-app');
        if (!winEl) return;

        const wc = winEl.querySelector('.window-content');
        const wrap = root?.querySelector?.('.rmu-cpt__wrap');
        const grid = root?.querySelector?.('.rmu-cpt__grid');
        if (!wc || !wrap || !grid) return;

        const phaseCount = Number(wrap?.dataset?.phaseCount ?? wrap?.getAttribute?.('data-phase-count') ?? 4) || 4;
        const viewportW = Math.max(900, Math.floor((window?.innerWidth ?? 1600) - 30));

        // Phase frames should consume most of the width. We keep a little slack
        // for padding/gaps so the math is stable across themes.
        const gap = 12;
        const outerSlack = 80;  // borders + window padding
        const innerPad = 24;    // grid left+right padding

        let phaseW = Math.floor((viewportW - outerSlack - innerPad - (gap * (phaseCount - 1))) / phaseCount);
        phaseW = Math.max(210, Math.min(320, phaseW));

        // Apply phase sizing variables (CSS uses these for phase frame widths).
        wc.style.setProperty('--rmu-phase-w', `${phaseW}px`);

        // Keep action images proportionate within the phase tile.
        const imgW = Math.max(140, phaseW - 20);
        const imgH = Math.max(72, Math.round(imgW * 96 / 170));
        wc.style.setProperty('--rmu-action-img-w', `${imgW}px`);
        wc.style.setProperty('--rmu-action-img-h', `${imgH}px`);

        // After CSS vars apply, measure content width/height and size the window.
        requestAnimationFrame(() => {
          try {
            const needed = Math.ceil(wrap.scrollWidth + 40);
            const targetW = Math.min(viewportW, Math.max(needed, 900));
            const curW = winEl.getBoundingClientRect().width;
            if (Math.abs(curW - targetW) > 8) this.setPosition({ width: targetW });

            // Height: expand when bonus-action UI appears; shrink back when it is removed.
            // NOTE: Foundry height includes header chrome; add it so the content fits with no scrollbars.
            const BASE_H = 460; // "original" tracker height
            const viewportH = Math.max(BASE_H, Math.floor((window?.innerHeight ?? 900) - 24));
            const headerEl = winEl.querySelector('.window-header');
            const headerH = Math.ceil(headerEl?.getBoundingClientRect?.().height ?? 32);
            const contentH = Math.ceil((wrap?.scrollHeight ?? root?.scrollHeight ?? wc.scrollHeight) + 4);
            const neededH = contentH + headerH + 8; // small slack for borders
            const targetH = Math.min(viewportH, Math.max(neededH, BASE_H));
            const curH = winEl.getBoundingClientRect().height;
            if (Math.abs(curH - targetH) > 8) this.setPosition({ height: targetH });
          } catch (_) {}
        });
      } catch (_) {}
    }, 40);
  };
})();



// Re-fit after any action/portrait images finish loading (they can change measured height).
try {
  const imgs = (html?.[0] ?? html)?.querySelectorAll?.('img') ?? [];
  imgs.forEach(img => {
    if (!img) return;
    if (img.complete) return;
    img.addEventListener('load', () => _debouncedFitNoWrap(), { once: true });
    img.addEventListener('error', () => _debouncedFitNoWrap(), { once: true });
  });
} catch (_) {}
// Initial size pass after first paint.
try { requestAnimationFrame(() => _debouncedFitNoWrap()); } catch (_) { _debouncedFitNoWrap(); }

// If any action images load after first paint, re-fit height/width (bonus rows add images).
try {
  const rootEl = html?.[0] ?? html;
  (rootEl?.querySelectorAll?.('img') ?? []).forEach(img => {
    img.addEventListener('load', () => _debouncedFitNoWrap(), { once: true });
    img.addEventListener('error', () => _debouncedFitNoWrap(), { once: true });
  });
} catch (_) {}

// When selectors change, re-fit (labels can change measured widths).
html.find('.rmu-cpt__slot select, .rmu-cpt__inst select').on('change', () => _debouncedFitNoWrap());
// Bonus AP changes can add/remove bonus slots; re-fit after any interaction.
html.find('.rmu-cpt__spinner .rmu-cpt__spinbtn, .rmu-cpt__spinner input, .rmu-cpt__spinner select').on('click change input', () => _debouncedFitNoWrap());
    const applyVddValue = async ({ field, combatantId, planKey, value }) => {
      const c = game.combat;
      if (!c) return;

      if (isGmReadOnlyCombatant(combatantId)) {
        ui.notifications?.warn?.("GM view is read-only for player-owned actors.");
        return;
      }

      // phaseInfo is computed in getData() but NOT in scope here; recompute.
      const phaseInfo = detectPhaseInfo(c);

      const rawState = await ensureCombatState(c);
      const state = game.user.isGM ? rawState : applyPendingToState(c.id, rawState);
      const cd = state.combatants?.[combatantId] ?? {};

      let _actions = parseActionsConfig();
      if (!Array.isArray(_actions) || !_actions.length) _actions = getDefaultActions();
      const actionsOrig = _actions;
      const actionsPhase = actionsOrig.map(a => {
        const mn = Number(a?.minCost ?? 0);
        if (mn === 0) {
          const mx = Number(a?.maxCost ?? mn);
          return { ...a, minCost: 1, maxCost: Math.max(1, mx) };
        }
        return a;
      });
      const actionsMap = actionsToMap(actionsPhase);

      let roundsShown = 1;
      try { roundsShown = clamp(game.settings.get(MODULE_ID, "roundsShown"), 1, 5); } catch (_) { roundsShown = 1; }
      const bonusCount = clamp(cd.bonusCount ?? 0, 0, 4);
      const phases = buildPhases({ baseRound: phaseInfo.round, roundsShown, bonusCount, phaseCount: phaseInfo.phaseCount });

      const planActions = foundry.utils.deepClone(cd.planActions ?? {});
      const planAuto = foundry.utils.deepClone(cd.planAuto ?? {});
      const planCosts = foundry.utils.deepClone(cd.planCosts ?? {});
      const finActs = foundry.utils.deepClone(cd.finActs ?? {});

      
      if (field === "instantAction") {
        const v = value || "available";
        await requestStatePathUpdate({ combatId: c.id, path: `combatants.${combatantId}.instantAction`, value: v });
        try { requestAppRefresh(); } catch (_) {}
        return;
      }

if (field === "phaseAction") {
        // No autofill: user manually plans chains.
        const prevValue = planActions[planKey] ?? "none";
        planActions[planKey] = value;
        planAuto[planKey] = false;

        // If the token has already moved this phase and a Move selector is changed AWAY from Move,
        // undo that movement and clear any Move selections/overlays for the current phase.
        try {
          const moveChangedAway = (prevValue === MOVE_ACTION_KEY) && (String(value) !== String(MOVE_ACTION_KEY));
          if (moveChangedAway && String(prevValue) !== String(value)) {
            const didUndo = await undoMoveAndClearSelectorsForPhase(c, combatantId, planActions, planAuto, planCosts, finActs);
            // Only clear the current selector if an undo actually happened (i.e., movement was used in this phase).
            if (didUndo) {
              planActions[planKey] = "none";
              planAuto[planKey] = false;
              planCosts[planKey] = null;
              finActs[planKey] = false;
              value = "none";
            }
          }
        } catch (e) { console.warn("Undo-move failed", e); }

        // FIN ACT? applies only to range-cost actions. If the selected action changes away from a range-cost action,
        // clear any existing finAct flag for this selector.
        if (!value || value === "none") {
          finActs[planKey] = false;
        } else {
          const meta = actionsMap.get(value) ?? null;
          const mn = Number(meta?.minCost ?? 0);
          const mx = Number(meta?.maxCost ?? mn);
          if (!(mx > mn)) finActs[planKey] = false;
        }

        // Clear stored cost when selecting blank
        if (!value || value === "none") {
          planCosts[planKey] = null;
        } else {
          const meta = actionsMap.get(value) ?? null;
          if (meta) {
            const mn = Number(meta.minCost ?? 0);
            const mx = Number(meta.maxCost ?? mn);

            // For range-cost actions: cost is assumed as the upper bound; no per-slot cost input.
            planCosts[planKey] = null;
          } else {
            planCosts[planKey] = null;
          }
        }
      } else if (field === "phaseCost") {
        const n = Number(value);
        if (Number.isFinite(n)) planCosts[planKey] = n;
      } else if (field === "finAct") {
        // Checkbox to force-complete range-cost actions early at this selector.
        // Only the CURRENT selector (current round+phase main/bonus) is editable.
        // Past/future phases cannot be toggled.
        // slotsPerRealPhase = how many internal selectors exist per displayed phase card (1..4).
        // In 1-2 phase modes we still track 4 internal slots; these values map real-phase -> internal slot ranges.
        const slotsPerRealPhase = clamp(Number(detectApPerPhase(game.combat) ?? 1), 1, 4);
        const realPhaseCount = clamp(Number(phaseInfo.phaseCount ?? 4), 1, 4);
        const curRealPhase = clamp(Number(phaseInfo.phase ?? 1), 1, realPhaseCount);
        // Convert the user-facing phase (1..phaseCount) into the first internal slot index (1..4).
        // Example: 2 real phases with 2 slots/phase => real phase 2 starts at internal slot 3.
        // Map the *real* phase (1..phaseCount) into internal selector slots (1..4).
        // Example: slotsPerRealPhase=2, curRealPhase=2 => internal slots 3..4.
        const currentInternalStart = clamp(((curRealPhase - 1) * slotsPerRealPhase) + 1, 1, 4);
        const currentInternalEnd = clamp(currentInternalStart + slotsPerRealPhase - 1, 1, 4);

        let ok = false;
        for (let ip = currentInternalStart; ip <= currentInternalEnd; ip++) {
          const curKm = phaseKey(phaseInfo.round, ip, "m");
          const curKb = phaseKey(phaseInfo.round, ip, "b");
          if (planKey === curKm || planKey === curKb) { ok = true; break; }
        }

        if (!ok) {
          try { requestAppRefresh(); } catch (_) {}
          return;
        }
        const checked = !!value;
        if (checked) finActs[planKey] = true;
        else finActs[planKey] = false;
      }

      // persist: always route through requestStatePathUpdate (GM writes, players socket to GM)
      await requestStatePathUpdate({ combatId: c.id, path: `combatants.${combatantId}.planActions`, value: planActions });
      await requestStatePathUpdate({ combatId: c.id, path: `combatants.${combatantId}.planAuto`, value: planAuto });
      await requestStatePathUpdate({ combatId: c.id, path: `combatants.${combatantId}.planCosts`, value: planCosts });
      await requestStatePathUpdate({ combatId: c.id, path: `combatants.${combatantId}.finActs`, value: finActs });


      try { requestAppRefresh(); } catch (_) {}
    };

    
    // No autofill in this module: bonus/concentration changes only re-render.

// Native selects (built-in dropdowns)
    html.find("select.rmu-cpt__select[data-field]").off("change.rmuCpt").on("change.rmuCpt", async (ev) => {
      const sel = ev.currentTarget;
      const field = sel.dataset.field;
      const combatantId = sel.dataset.combatantId;
      const planKey = sel.dataset.planKey;
      const value = sel.value;
      try { await applyVddValue({ field, combatantId, planKey, value }); } catch (e) { console.error(e); }
    });

    // FIN ACT? checkbox for range-cost actions
    html.find('input[type="checkbox"][data-field="finAct"]')
      .off("change.rmuCpt")
      .on("change.rmuCpt", async (ev) => {
        const cb = ev.currentTarget;
        const field = cb.dataset.field;
        const combatantId = cb.dataset.combatantId;
        const planKey = cb.dataset.planKey;
        const value = !!cb.checked;
        try { await applyVddValue({ field, combatantId, planKey, value }); } catch (e) { console.error(e); }
      });

    // Bonus Action spinner (0-4)
    html.find(".rmu-cpt__bonusap-input, input[data-field=\"bonusCount\"]")
      .off("change.rmuCpt input.rmuCpt")
      .on("input.rmuCpt change.rmuCpt", async (ev) => {
        const input = ev.currentTarget;
        let n = Number(input.value);
        if (!Number.isFinite(n)) n = 0;
        n = Math.max(0, Math.min(4, Math.trunc(n)));
        input.value = String(n);

        const combatantId = String(input.dataset.combatantId || "");
        if (!combatantId) return;


        if (isGmReadOnlyCombatant(combatantId)) return;

        try { await setBonusCount(combatantId, n); } catch (e) { console.error(e); }
        try { requestAppRefresh(); } catch (_) {}
      });
    // Bonus Action +/- buttons
    html.find('[data-action="bonusInc"], [data-action="bonusDec"]').off("click.rmuCpt").on("click.rmuCpt", async (ev) => {
      ev.preventDefault();
      const btn = ev.currentTarget;
      const action = btn.dataset.action;
      const combatantId = String(btn.dataset.combatantId || "");
      if (!combatantId) return;


      if (isGmReadOnlyCombatant(combatantId)) return;

      const input = html.find(`.rmu-cpt__bonusap-input[data-combatant-id="${combatantId}"]`).get(0);
      let n = Number(input?.value);
      if (!Number.isFinite(n)) n = 0;

      n += (action === "bonusInc") ? 1 : -1;
      n = Math.max(0, Math.min(4, Math.trunc(n)));

      if (input) input.value = String(n);
      try { await setBonusCount(combatantId, n); } catch (e) { console.error(e); }
      try { requestAppRefresh(); } catch (_) {}
    });

    const root = html?.[0] ?? html;
    if (!root) return;

    const combat = () => this.combat;

    const closeAllDropdowns = () => {
      root.querySelectorAll("[data-vdd].is-open").forEach(el => el.classList.remove("is-open", "is-dropup"));
    };

    const applyDropUpIfNeeded = (wrap) => {
      try {
        const btn = wrap.querySelector("[data-vdd-btn]");
        const menu = wrap.querySelector("[data-vdd-menu]");
        if (!btn || !menu) return;

        const wasOpen = wrap.classList.contains("is-open");
        wrap.classList.add("is-open");
        menu.style.visibility = "hidden";
        menu.style.display = "block";

        const rect = btn.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const margin = 12;
        const wouldOverflowDown = (rect.bottom + menuRect.height + margin) > window.innerHeight;
        wrap.classList.toggle("is-dropup", wouldOverflowDown);

        menu.style.display = "";
        menu.style.visibility = "";
        if (!wasOpen) wrap.classList.remove("is-open");
      } catch (_) {}
    };

    // Document-level click to close open dropdowns.
    if (!this._rmuCptDocClose) {
      this._rmuCptDocClose = (ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLElement)) return;
        if (!t.closest(".rmu-cpt-app")) return;
        if (t.closest("[data-vdd]")) return;
        closeAllDropdowns();
      };
      document.addEventListener("mousedown", this._rmuCptDocClose);
    }

root.addEventListener("click", async (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLElement)) return;

      // Mental Focus acknowledgement button (appears every 6 rounds)
      const mfBtn = t.closest("button[data-action='ackMentalFocus']");
      if (mfBtn) {
        ev.preventDefault();
        try {
          const c = game.combat;
          if (!c) return;
          const combatantId = String(mfBtn.dataset.combatantId || "");
          if (!combatantId) return;
          if (isGmReadOnlyCombatant(combatantId)) return;
          const phaseInfo = detectPhaseInfo(c);
          const apPerPhase = detectApPerPhase(c);
          const rawState = await ensureCombatState(c);
          const st = game.user.isGM ? rawState : applyPendingToState(c.id, rawState);
          const r = Number(getReminderRound(c, st, phaseInfo) ?? 0);
          if (!Number.isFinite(r) || r <= 0) return;
          await requestStatePathUpdate({ combatId: c.id, path: `combatants.${combatantId}.mentalFocusAckRound`, value: r });
          try { requestAppRefresh(); } catch (_) {}
        } catch (e) {
          console.error(e);
        }
        return;
      }

      // Endurance acknowledgement button (appears every 6 rounds)
      const endBtn = t.closest("button[data-action='ackEndurance']");
      if (endBtn) {
        ev.preventDefault();
        try {
          const c = game.combat;
          if (!c) return;
          const combatantId = String(endBtn.dataset.combatantId || "");
          if (!combatantId) return;
          if (isGmReadOnlyCombatant(combatantId)) return;
          const phaseInfo = detectPhaseInfo(c);
          const rawState = await ensureCombatState(c);
          const st = game.user.isGM ? rawState : applyPendingToState(c.id, rawState);
          const r = Number(getReminderRound(c, st, phaseInfo) ?? 0);
          if (!Number.isFinite(r) || r <= 0) return;
          await requestStatePathUpdate({ combatId: c.id, path: `combatants.${combatantId}.enduranceAckRound`, value: r });
          try { requestAppRefresh(); } catch (_) {}
        } catch (e) {
          console.error(e);
        }
        return;
      }

      // Toggle concentration-like flags (cap 2)
      const concBtn = t.closest("button[data-action='toggleConcFlag']");
      if (concBtn) {
        ev.preventDefault();
        const c = game.combat;
        if (!c) return;

        const combatantId = concBtn.dataset.combatantId;
        const flag = concBtn.dataset.flag;
        if (!combatantId || !flag) return;


        if (isGmReadOnlyCombatant(combatantId)) return;

        const rawState = await ensureCombatState(c);
        const state = game.user.isGM ? rawState : applyPendingToState(c.id, rawState);
        const cd = state.combatants?.[combatantId] ?? {};

        const concFlags = normalizeConcFlags(cd);
        const holdMeta = foundry.utils.deepClone(cd.holdAction ?? {});

        const currentOn = countConcOn(concFlags);
        const curIsOn = !!concFlags[flag];
        const nextIsOn = !curIsOn;

        // NEW RULE: A concentration toggle may only be switched ON when all
        // selectors in the CURRENT visible phase are "-" (none).
        // (Hold Action is handled separately and is exempt from this rule.)
        if (nextIsOn && flag !== "holdAction") {
          try {
            const phaseInfoReal = detectPhaseInfo(c);
            const slotsPerRealPhase = clamp(Number(detectApPerPhase(c) ?? 1), 1, 4);
            const realPhaseCount = clamp(Number(phaseInfoReal.phaseCount ?? 4), 1, 4);
            const curRealPhase = clamp(Number(phaseInfoReal.phase ?? 1), 1, realPhaseCount);
            // Convert the user-facing phase (1..phaseCount) into the first internal slot index (1..4).
        // Example: 2 real phases with 2 slots/phase => real phase 2 starts at internal slot 3.
        const currentInternalStart = clamp(((curRealPhase - 1) * slotsPerRealPhase) + 1, 1, 4);
            const currentInternalEnd = clamp(currentInternalStart + slotsPerRealPhase - 1, 1, 4);

            const planActions = cd.planActions ?? {};
            const r = clamp(Number(phaseInfoReal.round ?? 1), 1, 9999);

            let allNone = true;
            for (let ip = currentInternalStart; ip <= currentInternalEnd; ip++) {
              const km = phaseKey(r, ip, "m");
              const kb = phaseKey(r, ip, "b");
              const vm = String(planActions[km] ?? "none");
              const vb = String(planActions[kb] ?? "none");
              if (vm !== "none" || vb !== "none") { allNone = false; break; }
            }

            if (!allNone) {
              ui.notifications?.warn?.("Clear all actions in the current phase (set to '-') before enabling Concentration.");
              return;
            }
          } catch (e) {
            console.warn("[rmu-phase-tracker-v3] concentration precheck failed", e);
            // If we can't verify, be conservative and block.
            ui.notifications?.warn?.("Clear all actions in the current phase (set to '-') before enabling Concentration.");
            return;
          }
        }

        // Enforce cap when turning ON
        if (nextIsOn && currentOn >= 2) {
          ui.notifications?.warn?.("Only 2 concentration toggles can be active at once.");
          return;
        }

        // Special: Hold Action requires a completed selector in the current phase.
        if (flag === "holdAction" && nextIsOn) {
          const phaseInfoReal = detectPhaseInfo(c);
          const slotsPerRealPhase = clamp(Number(detectApPerPhase(c) ?? 1), 1, 4);
          const realPhaseCount = clamp(Number(phaseInfoReal.phaseCount ?? 4), 1, 4);
          const curRealPhase = clamp(Number(phaseInfoReal.phase ?? 1), 1, realPhaseCount);
          // Convert the user-facing phase (1..phaseCount) into the first internal slot index (1..4).
        // Example: 2 real phases with 2 slots/phase => real phase 2 starts at internal slot 3.
        const currentInternalStart = clamp(((curRealPhase - 1) * slotsPerRealPhase) + 1, 1, 4);
          const currentInternalEnd = clamp(currentInternalStart + slotsPerRealPhase - 1, 1, 4);

          // Internal planning uses 4 slots per round.
          const phaseInfo = { ...phaseInfoReal, phaseCount: 4, phase: currentInternalStart };
          const roundsShown = clamp(game.settings.get(MODULE_ID, "roundsShown"), 1, 5);
          const actions = parseActionsConfig();
          const actionsMap = actionsToMap(actions);
          const bonusCount = clamp(cd.bonusCount ?? 0, 0, 4);

          const planActions = cd.planActions ?? {};
          const planCosts = cd.planCosts ?? {};

          const phasesAnalysis = buildPhasesForAnalysis({ phaseInfo, roundsShown, bonusCount, phaseCount: 4, actions, planActions });
          const capByKey = buildCapByKey({ phasesAnalysis, flags: concFlags, holdMeta, apPerPhase: 1 });
          const chainUI = analyzeChainsForUI({ phases: phasesAnalysis, planActions, actionsMap, concentrating: (countConcOn(concFlags) > 0), capByKey, apPerPhase: 1, planCosts, currentPhase: phaseInfo.phase, currentRound: phaseInfo.round });

          let completedKey = null;
          for (let ip = currentInternalStart; ip <= currentInternalEnd; ip++) {
            const km = phaseKey(phaseInfoReal.round, ip, "m");
            const kb = phaseKey(phaseInfoReal.round, ip, "b");
            if (chainUI.complete?.has(km)) { completedKey = km; break; }
            if (chainUI.complete?.has(kb)) { completedKey = kb; break; }
          }

          if (!completedKey) {
            ui.notifications?.warn?.("Hold Action can only be enabled when an action is Complete.");
            return;
          }

          const heldActionKey = planActions[completedKey] ?? "none";
          const heldMeta = actionsMap.get(heldActionKey);
          const heldLabel = heldMeta?.label ?? heldActionKey;

          holdMeta.pendingKey = completedKey;
          holdMeta.heldLabel = heldLabel;
          holdMeta.heldAction = heldActionKey;
        }

        concFlags[flag] = nextIsOn;


// Track when EXACTLY ONE concentration toggle becomes active, so Mental Focus reminder can fire 6 rounds later.
// IMPORTANT: If the user temporarily turns a 2nd concentration toggle ON, we PAUSE the reminder
// (button hidden because count!=1) but we DO NOT reset the start round. When they return to exactly 1,
// the reminder should reappear if it is due.
try {
  const phaseInfoNow = detectPhaseInfo(c);
  const rNow = Number(getReminderRound(c, state, phaseInfoNow) ?? 0);
  if (Number.isFinite(rNow) && rNow > 0) {
    const nextOnCount = countConcOn(concFlags);
    const prevOnCount = currentOn;

    // Start only when we go from 0 -> 1 concentration toggles.
    if (nextOnCount === 1 && prevOnCount === 0) {
      await requestStatePathUpdate({ combatId: c.id, path: `combatants.${combatantId}.mentalFocusStartRound`, value: rNow });
      // Clear any old ack if we're starting a fresh cycle.
      await requestStatePathUpdate({ combatId: c.id, path: `combatants.${combatantId}.mentalFocusAckRound`, value: 0 });
    }

    // Reset only when we drop to 0 toggles (i.e., concentration fully off).
    // Do NOT reset for 1->2 or 2->1 transitions.
    if (nextOnCount === 0 && prevOnCount > 0) {
      await requestStatePathUpdate({ combatId: c.id, path: `combatants.${combatantId}.mentalFocusStartRound`, value: 0 });
      await requestStatePathUpdate({ combatId: c.id, path: `combatants.${combatantId}.mentalFocusAckRound`, value: 0 });
    }
  }
} catch (_) {}
if (flag === "holdAction" && !nextIsOn) {
          holdMeta.pendingKey = null;
          holdMeta.heldLabel = null;
          holdMeta.heldAction = null;
        }

        await requestStatePathUpdate({ combatId: c.id, path: `combatants.${combatantId}.concFlags`, value: concFlags });
        await requestStatePathUpdate({ combatId: c.id, path: `combatants.${combatantId}.holdAction`, value: holdMeta });

        try { if (_app?.rendered) _app.render(false); } catch (_) {}
        return;
      }

      
      // Dropdown button (custom dropdown disabled - using native <select>)
      const vddBtn = t.closest("[data-vdd-btn]");
      if (vddBtn) { return; }
// Dropdown option (custom dropdown disabled - using native <select>)
      const vddOpt = t.closest("[data-vdd-opt]");
      if (vddOpt) { return; }
});

    // bonusCount change (range input)
    root.addEventListener("change", async (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLElement)) return;
      if (!(t instanceof HTMLInputElement)) return;
      if (t.dataset.field !== "bonusCount") return;

      const c = game.combat;
      if (!c) return;
      const combatantId = t.dataset.combatantId;
      const newVal = clamp(t.value, 0, 4);

      await requestStatePathUpdate({ combatId: c.id, path: `combatants.${combatantId}.bonusCount`, value: newVal });

      const rawState = await ensureCombatState(c);
      const state = game.user.isGM ? rawState : applyPendingToState(c.id, rawState);
      const cd = state.combatants?.[combatantId] ?? {};
      let _actions2 = parseActionsConfig();
      if (!Array.isArray(_actions2) || !_actions2.length) _actions2 = getDefaultActions();
      const actionsMap = actionsToMap(_actions2.map(a => {
        const mn = Number(a?.minCost ?? 0);
        if (mn === 0) {
          const mx = Number(a?.maxCost ?? mn);
          return { ...a, minCost: 1, maxCost: Math.max(1, mx) };
        }
        return a;
      }));
      const roundsShown = clamp(game.settings.get(MODULE_ID, "roundsShown"), 1, 5);
      const pi = detectPhaseInfo(this.combat);
      const baseRound = pi.round;

      // Keep planning on 4 internal slots per round so existing chain mechanics remain unchanged.
      const phases = buildPhases({ baseRound, roundsShown, bonusCount: newVal, phaseCount: 4 });

      const updated = applyAutofillToPlan({
        phases,
        actionsMap,
        concentrating: (countConcOn(normalizeConcFlags(cd)) > 0),
        planActions: cd.planActions ?? {},
        planAuto: cd.planAuto ?? {},
        planCosts: cd.planCosts ?? {},
        apPerPhase: 1
      });

      await requestStatePathUpdate({ combatId: c.id, path: `combatants.${combatantId}.planActions`, value: updated.planActions });
      await requestStatePathUpdate({ combatId: c.id, path: `combatants.${combatantId}.planAuto`, value: updated.planAuto });
      await requestStatePathUpdate({ combatId: c.id, path: `combatants.${combatantId}.planCosts`, value: updated.planCosts });

      try { if (_app?.rendered) _app.render(false); } catch (_) {}
    });
  }
  async close(options={}) {
    try {
      if (this._rmuCptDocClose) document.removeEventListener("mousedown", this._rmuCptDocClose);
      this._rmuCptDocClose = null;
    } catch (_) {}
    return super.close(options);
  }

}

let _app = null;
async function openTracker() {
  try {
    // Avoid showing a blank tracker to users who can't see the current-turn combatant.
    // Players should only see the tracker on the turn of a combatant they own.
    const combat = game.combat;
    if (combat?.active) {
      // Ensure the shared combat state exists before rendering.
      // - GM: creates the flag immediately
      // - Player: asks the GM to create it (socket)
      try { requestInitState(combat.id); } catch (_) {}

      const visible = getVisibleCombatants(combat);
      if (!visible || visible.length === 0) {
        // Don't auto-close on "no visible combatant" - keep the window open if already open.
        if (_app?.rendered) {
          try { _app.render(false); } catch (_) {}
        }
        return;
      }
    }

    // IMPORTANT: sample Combat Tracker sidebar labels right now.
    // Some RMU builds do not populate combat.system/flags phaseCount/AP-per-phase immediately on combat start,
    // and may not trigger a re-render of the Combat Tracker after the user changes tracker options.
    // By reading the sidebar DOM directly here, we can render the correct 1/2-phase mode immediately.
    try {
      const root = ui?.combat?.element?.[0] ?? ui?.combat?.element ?? document.getElementById("combat") ?? document.querySelector("#combat") ?? document.querySelector(".combat-sidebar");
      _updateCombatTrackerInfoCache(combat?.id, root);
      _ensureCombatTrackerObserver(combat?.id, root);
      // Re-sample next tick in case the sidebar updates just after combat activates.
      setTimeout(() => {
        try {
          const root2 = ui?.combat?.element?.[0] ?? ui?.combat?.element ?? document.getElementById("combat") ?? document.querySelector("#combat") ?? document.querySelector(".combat-sidebar");
          _updateCombatTrackerInfoCache(combat?.id, root2);
          _ensureCombatTrackerObserver(combat?.id, root2);
          requestAppRefresh();
        } catch (_) {}
      }, 0);
    } catch (_) {}

    // On first Foundry login, RMU's "Spend X AP per Phase" label can populate slightly after
    // the combat tracker and our app open. Warm the cache before first render so the spread
    // logic is correct immediately (no "starts as 4-phase" until a selection is made).
    if (!_app?.rendered) {
      try { await _warmCombatTrackerInfo(combat); } catch (_) {}
    }

    if (_app?.rendered) return _app.bringToTop();
    _app = new RMUCombatPhaseTrackerApp();
    globalThis._rmuCptApp = _app;

    await _app.render(true);
  } catch (e) {
    console.error(e);
  }
}

function closeTracker() {
  try { if (_app?.rendered) _app.close(); } catch (_) {}
}

// Add Combat Tracker header icon + auto-open/close with the Combat tab.

// ---------------------------------------------------------------------------
// Combat Tracker UI integration (adds button + opens the Phase Tracker UI)
// ---------------------------------------------------------------------------
Hooks.on("renderCombatTracker", (app, html) => {
  // Cache the Combat Tracker sidebar values (Spend AP per Phase, Phase X of Y) so our UI can
  // render correctly immediately when combat starts.
  try {
    const root0 = (html instanceof HTMLElement) ? html : (html?.[0] ?? html);
    const combatId = game?.combat?.id;
    _updateCombatTrackerInfoCache(combatId, root0);
    _ensureCombatTrackerObserver(combatId, root0);
    // Some systems update the sidebar labels a tick later; re-sample shortly after render.
    setTimeout(() => {
      try {
        const root1 = ui?.combat?.element?.[0] ?? ui?.combat?.element ?? document.getElementById("combat") ?? document.querySelector("#combat");
        _updateCombatTrackerInfoCache(combatId, root1);
        _ensureCombatTrackerObserver(combatId, root1);
        requestAppRefresh();
      } catch (_) {}
    }, 50);
  } catch (_) {}

  // If the Combat tab is visible, ensure our UI is up.
  try { if (ui?.sidebar?.activeTab === "combat") openTracker(); } catch (_) {}

  // Inject header toggle icon once.
  try {
    const root = (html instanceof HTMLElement) ? html : (html?.[0] ?? html);
    if (!root) return;

    const headerEl =
      root.querySelector(".combat-tracker-header")
      || root.querySelector("header.combat-tracker-header")
      || root.querySelector(".directory-header");

    if (!headerEl) return;

    if (headerEl.querySelector(`[data-rmu-phase-tracker-v3-toggle]`)) return;

    const btn = document.createElement("a");
    btn.className = "header-control";
    btn.setAttribute(`data-rmu-phase-tracker-v3-toggle`, "");
    btn.title = "Toggle RMU Phase Tracker";
    btn.innerHTML = `<i class="fa-solid fa-layer-group"></i>`;

    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      if (_app?.rendered) _app.close();
      else openTracker();
    });

    const controls = headerEl.querySelectorAll(".header-control, a[data-action='configure'], .combat-control");
    if (controls?.length) controls[controls.length - 1].after(btn);
    else headerEl.appendChild(btn);
  } catch (e) {
    console.warn("rmu-phase-tracker-v3 | Could not inject Combat Tracker header button", e);
  }
});

Hooks.on("ready", () => {
  // Sockets are required so player selections are written by the GM to the combat document
  // and become visible to the GM and other clients in real time.
  try { registerSocket(); } catch (e) { console.error(e); }
  // On a fresh login, the Combat Tracker DOM (and RMU's Spend/Phase labels) may not be fully
  // populated at the exact moment the ready hook runs. Delay auto-open slightly so our
  // first render uses the correct 1/2-phase spread immediately.
  try {
    if (ui?.sidebar?.activeTab === "combat") {
      setTimeout(() => { try { openTracker(); } catch (_) {} }, 150);
    }
  } catch (_) {}
});

Hooks.on("changeSidebarTab", (...args) => {
  const tabName = args.find(a => typeof a === "string") ?? "";
  try {
    // Do not force-close the tracker when the user changes sidebar tabs;
    // closing on tab change can feel like it "closes on end turn" depending on UI focus.
    if (tabName === "combat") openTracker();
  } catch (_) {}
});

// v13 uses toggleSidebar; keep collapse/expand for older versions.
Hooks.on("toggleSidebar", (collapsed) => {
  try {
    // Do not auto-close on sidebar collapse; keep the tracker open if the user opened it.
    if (!collapsed && ui?.sidebar?.activeTab === "combat") openTracker();
  } catch (_) {}
});

Hooks.on("collapseSidebar", () => { /* no-op: do not auto-close */ });
Hooks.on("expandSidebar", () => { try { if (ui?.sidebar?.activeTab === "combat") openTracker(); } catch (_) {} });

Hooks.on("closeCombatTracker", () => { /* no-op: do not auto-close */ });


// Auto-open on combat begin / close on combat end
Hooks.on("createCombat", (combatDoc) => {
  try {
    // Auto-open on combat begin if this user can see the current-turn combatant.
    // (Do not require the Combat tab to be active; users often remain on Chat tab.)
    const combat = combatDoc ?? game.combat;
    if (!combat?.active) return;

    // IMPORTANT: initialize shared state even if the UI is never opened on this client.
    // Movement enforcement reads from the combat flag state, so we ensure it exists
    // as soon as combat starts.
    try { requestInitState(combat.id); } catch (_) {}

    const visible = getVisibleCombatants(combat);
    if (visible && visible.length) openTracker();
  } catch (_) {}
});
Hooks.on("deleteCombat", () => { try { if (_app?.rendered) _app.close(); } catch (_) {} });

// ---------------------------------------------------------------------------
// Combat updates: keep UI state in sync as round/turn/phase changes
// ---------------------------------------------------------------------------
Hooks.on("updateCombat", (combatDoc, change) => {
  try {
    if (change?.active === true) {
      try { requestInitState(combatDoc?.id ?? game.combat?.id); } catch (_) {}
      openTracker();
    }
    if (change?.active === false) { closeTracker(); }

    if (typeof change?.active === "boolean" && change.active === false) {
      if (_app?.rendered) _app.close();
    }


    // On turn/round changes, show the tracker for the owning user, and hide it for others.
    if (combatDoc?.active && (change?.turn !== undefined || change?.round !== undefined || change?.combatantId !== undefined)) {
      const visible = getVisibleCombatants(combatDoc);
      if (visible && visible.length) {
        // Auto-open whenever it's this user's turn for a combatant they can see.
        openTracker();
      } else {
        // Don't auto-close when it's not the user's turn; if the app is open, re-render into the "Nothing to show" view.
        if (_app?.rendered) {
          try { _app.render(false); } catch (_) {}
        }
      }
    }

  } catch (_) {}
});


// Refresh UI whenever the combat tracker advances or changes
// When the active combatant changes, ensure the tracker auto-opens for any user who can act
// (GM always; players only if they own the current-turn actor). Never auto-close on turn end.
Hooks.on("combatTurn", (combatDoc) => {
  try {
    const combat = combatDoc ?? game.combat;
    if (combat?.active) {
      const visible = getVisibleCombatants(combat);
      if (visible && visible.length) {
        openTracker();
      } else if (_app?.rendered) {
        // Keep the window open, but render the "waiting" view.
        try { _app.render(false); } catch (_) {}
      }
    }
    updateLocalVirtualRound(combat);
    requestAppRefresh();
  } catch (_) {}
});
Hooks.on("updateCombat", (combatDoc, change) => {
  try {
    updateLocalVirtualRound(combatDoc);
    // Round boundary housekeeping.
    // IMPORTANT: Bonus Action count should persist across rounds unless changed by the user.
    if (change?.round !== undefined) {
      // Local movement tracking is per-round. When a new combat round begins, reset all Move (BMR)
      // overlays/pace labels so each round starts fresh.
      try {
        snapshotPrevPhaseCarryover(combatDoc, change?.round);
        _moveTrack.clear();
        _moveHudThrottle.clear();
        if (_moveHudEl) _moveHudEl.style.display = "none";
        clearAllTokenPaceLabels();
      } catch (_) {}

      (async () => {
        try {
          const c = combatDoc;
          if (!c) return;
          const state = await ensureCombatState(c);
          const combatants = Array.from(c.combatants ?? []);
          for (const cb of combatants) {
            const cid = cb.id;

            // Reset Instantaneous Actions selector each new round
            const curInst = String(state?.combatants?.[cid]?.instantAction ?? "available");
            if (curInst !== "available") {
              await requestStatePathUpdate({ combatId: c.id, path: `combatants.${cid}.instantAction`, value: "available" });
            }
          }
        } catch (_) {}
      })();
    }

    // IMPORTANT: Do NOT auto-clear planned phases. Clearing during phase advancement breaks chaining/range tracking.
    // Planned phase selections are never auto-cleared; chaining/range tracking depends on them.

        // Maintain an internal virtualRound counter (GM writes it) for systems that do not advance combat.round.
    // This lets periodic reminders (e.g., every 6 rounds) work even when only phase is advanced.
    if (game.user.isGM) {
      (async () => {
        try {
          const c = combatDoc;
          if (!c) return;
          const state = await ensureCombatState(c);
          const pi = detectPhaseInfo(c);
          const detectedRound = Number(pi?.round ?? 1);
          const phase = Number(pi?.phase ?? 1);
          const phaseCount = Number(pi?.phaseCount ?? 4) || 4;
          const turn = Number(c?.turn ?? 0);

          const meta = state.meta ?? (state.meta = {});
          const lastPhase = Number(meta.lastPhase ?? phase);
          const lastPhaseCount = Number(meta.lastPhaseCount ?? phaseCount) || phaseCount;
          const lastTurn = Number(meta.lastTurn ?? turn);
          let virtualRound = Number(meta.virtualRound ?? 1);
          if (!Number.isFinite(virtualRound) || virtualRound <= 0) virtualRound = 1;

          // If the system provides a real round > 1, sync virtualRound to it.
          if (Number.isFinite(detectedRound) && detectedRound > 1) {
            virtualRound = detectedRound;
          } else {
            // Otherwise, increment virtualRound when phase wraps (or decreases).
            // If phaseCount === 1, phase is always 1; do NOT treat that as a wrap each render.
            const wrappedByPhase = ((phaseCount > 1) && (phase === 1) && (lastPhase === lastPhaseCount)) || (phase < lastPhase);
            const wrappedByTurn = (turn < lastTurn);
            if (wrappedByPhase || wrappedByTurn) virtualRound = virtualRound + 1;
          }

          const changed = (meta.virtualRound !== virtualRound) || (meta.lastPhase !== phase) || (meta.lastPhaseCount !== phaseCount) || (meta.lastTurn !== turn);
          if (changed) {
            meta.virtualRound = virtualRound;
            meta.lastPhase = phase;
            meta.lastPhaseCount = phaseCount;
            meta.lastTurn = turn;
            const clone = foundry.utils.deepClone(state);
            await c.setFlag(MODULE_ID, 'state', clone);
          }
        } catch (_) {}
      })();
    }

// Refresh when turn/round/phase changes (or any other combat update)
    if (change.round !== undefined || change.turn !== undefined || change.phase !== undefined || change.rounds !== undefined || change.turns !== undefined) {
      requestAppRefresh();
    } else if (Object.keys(change || {}).length) {
      requestAppRefresh();
    }
  } catch (_) {}
});

Hooks.on("updateCombatant", () => { try { requestAppRefresh(); } catch (_) {} });
Hooks.on("renderCombatTracker", () => { try { requestAppRefresh(); } catch (_) {} });



/* -------------------------------------------------------------------------- */
/* Movement gating for "Move Your BMR"                                        */
/* -------------------------------------------------------------------------- */

function escapeHtml(s){return String(s??"").replace(/[&<>"']/g,(c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));}

const MOVE_ACTION_KEY = "move-bmr";
// Allow a tiny tolerance so exact-cap moves are not incorrectly clamped due to floating/grid rounding.
// Floating/precision tolerance so exact-cap moves (e.g. 16.0) are not clamped due to rounding.
// Small epsilon (feet) to tolerate rounding when grid snapping or measuring distances.
const MOVE_EPS_FT = 0.05;

// Per-phase incidental movement caps + penalties (used when NOT selecting "Move Your BMR").
// Fractions are of the Actor's effective BMR for the phase.
const PHASE_PACE_TABLE = [
  { pace: "Creep", frac: 1/8, penalty: 0, penaltyText: "—" },
  { pace: "Walk",  frac: 1/4, penalty: -25, penaltyText: "-25" },
  { pace: "Jog",   frac: 1/2, penalty: -50, penaltyText: "-50" },
  { pace: "Run",   frac: 3/4, penalty: -75, penaltyText: "-75" }
];

function phasePaceIndex(p) {
  const n = String(p ?? "").trim().toLowerCase();
  if (n === "creep") return 0;
  if (n === "walk") return 1;
  if (n === "jog") return 2;
  if (n === "run") return 3;
  return 3;
}

function normalizePhaseCapPace(p) {
  const n = normalizePaceName(String(p ?? ""));
  if (n === "Creep" || n === "Walk" || n === "Jog" || n === "Run") return n;
  // Anything faster than Run still caps at Run for incidental movement.
  return "Run";
}

function phasePaceCapFrac(pace) {
  const n = String(pace ?? "Run");
  const row = PHASE_PACE_TABLE.find(r => r.pace === n);
  return row ? Number(row.frac ?? 0.75) : 0.75;
}

function minPhaseCapPace(a, b) {
  const ia = phasePaceIndex(a);
  const ib = phasePaceIndex(b);
  return (ia <= ib) ? a : b;
}

function computeIncidentalCapPace({ defaultCap = "Run", loadMaxPaceLabel = null, concOnCount = 0 } = {}) {
  let cap = normalizePhaseCapPace(defaultCap);
  const loadCap = loadMaxPaceLabel ? normalizePhaseCapPace(loadMaxPaceLabel) : null;
  if (loadCap) cap = minPhaseCapPace(cap, loadCap);
  if (Number(concOnCount ?? 0) >= 2) cap = "Creep";
  return cap;
}

/**
 * Incidental movement (when NOT selecting Move Your BMR):
 * Choose the highest pace that fits within used distance for this phase,
 * and return its penalty/AP text.
 */
/**
 * For incidental movement (non-"Move Your BMR" actions):
 * - Determine which pace band the moved distance falls into (Creep/Walk/Jog/Run)
 * - Return the penalty that should be displayed in the overlay.
 */
function inferPhasePacePenalty(usedFt, bmrEffective, capPace = "Run") {
  const u = Math.max(0, Number(usedFt ?? 0));
  const b = Math.max(0, Number(bmrEffective ?? 0));
  const capIdx = phasePaceIndex(capPace);

  if (!(b > 0)) return { pace: "—", penalty: 0, penaltyText: "—" };

  // Pick the *slowest* pace that can accommodate the distance, capped by capPace.
  // Example: if u is > 1/2 BMR but <= 3/4 BMR, that's Run (penalty -75), not Jog.
  for (let i = 0; i <= capIdx; i++) {
    const thr = PHASE_PACE_TABLE[i].frac * b;
    if (u <= thr + MOVE_EPS_FT) {
      const row = PHASE_PACE_TABLE[i];
      return { pace: row.pace, penalty: row.penalty, penaltyText: row.penaltyText };
    }
  }
  // If somehow beyond cap (should be clamped), show the cap pace + its penalty.
  const row = PHASE_PACE_TABLE[capIdx] ?? PHASE_PACE_TABLE[PHASE_PACE_TABLE.length - 1];
  return { pace: row.pace, penalty: row.penalty, penaltyText: row.penaltyText };
}

// Local (per-client) movement tracking. This enforces limits for the moving user and provides a live readout.
// Shape: tokenUuid -> { phaseKey, lastCenter:{x,y}, usedBySlot:{[planKey]:number}, totalByRound:{[round]:number}, points:[{x,y}] }
// Committed movement usage for the current round, per token UUID.
// Shape: Map<tokenUuid, { usedBySlot: Record<slotKey, feet>, totalUsed: feet, ... }>
const _moveTrack = new Map();

// Live (during drag) preview allocations so Move overlays can update before the token is committed.
// Shape: tokenUuid -> { phaseKeyId, round, internalPhaseCount, currentInternalEnd, allocations:{[planKey]:number}, allocatedTotal:number, perSlotMax:{[planKey]:number}, canDashThisLastSlot:boolean, paceInfo }
// Live drag preview allocations per token UUID (used to draw dynamic overlay text while dragging).
const _movePreview = new Map();
// Carryover snapshot of previous action-phase total movement.
// We clear _moveTrack on round changes to reset per-round overlays, but the 1.25× Move rule
// needs to look back across round boundaries. We snapshot the final action-phase of the
// previous round here so Phase 1 of the next round can still evaluate the rule.
// tokenUuid -> { combatId, round, start, end, totalFt }
// Cross-round “previous phase” movement snapshot.
// When a round increments we clear _moveTrack, but we keep the last phase total here so Phase 1 can
// still evaluate “moved ≥ 1/2 BMR last phase” even if the last phase was in the previous round.
const _prevPhaseCarry = new Map();

function snapshotPrevPhaseCarryover(combatDoc, newRound) {
  try {
    const c = combatDoc;
    const combatId = c?.id;
    const nr = Number(newRound ?? c?.round ?? 0);
    const pr = nr - 1;
    if (!combatId || !(pr >= 1)) return;

    const slotsPerReal = clamp(Number(detectApPerPhase(c) ?? 1), 1, 4);
    const internalCount = 4;
    const start = clamp(internalCount - slotsPerReal + 1, 1, internalCount);
    const end = internalCount;

    for (const [tokenUuid, tr] of _moveTrack.entries()) {
      const totalFt = sumMovementForInternalRange(tr, pr, start, end);
      _prevPhaseCarry.set(tokenUuid, { combatId, round: pr, start, end, totalFt });
    }
  } catch (e) {
    console.error(`${MODULE_ID} | snapshotPrevPhaseCarryover failed`, e);
  }
}

// We previously drew a movement trail line on the canvas. That has been disabled;
// tracking remains for limit enforcement and UI overlays.
const _moveGraphics = new Map();
// tokenUuid -> last HUD update time (ms)
const _moveHudThrottle = new Map();
let _moveHudEl = null;
let _moveHudHideTimer = null;

// tokenUuid -> PIXI.Text pace label rendered over the token while moving
const _movePaceLabel = new Map();
// tokenUuid -> hide timer id
const _movePaceHideTimer = new Map();

// tokenUuid -> { key:string, t:number } to avoid warning spam while dragging beyond a cap
const _moveWarnCache = new Map();
function warnMoveOnce(tokenUuid, key, msg, ttlMs = 1200) {
  try {
    if (!tokenUuid) { ui?.notifications?.warn?.(msg); return; }
    const now = Date.now();
    const prior = _moveWarnCache.get(tokenUuid);
    if (prior && prior.key === key && (now - prior.t) < ttlMs) return;
    _moveWarnCache.set(tokenUuid, { key, t: now });
    ui?.notifications?.warn?.(msg);
  } catch (_) {}
}

function ensureTokenPaceLabel(token) {
  if (!canvas?.ready) return null;
  const tokenUuid = token?.document?.uuid ?? token?.document?.id;
  if (!tokenUuid) return null;

  let t = _movePaceLabel.get(tokenUuid);
  if (t && !t.destroyed) return t;

  // Use a subtle small font with a stroke so it stays readable on any map.
  t = new PIXI.Text("", {
    fontFamily: "Vollkorn, serif",
    fontSize: 12,
    fill: 0xFFFFFF,
    align: "center",
    stroke: 0x000000,
    strokeThickness: 4
  });
  t.alpha = 0.95;
  t.visible = false;
  t.resolution = 2;

  // Put it on the token's primary container so it moves with the token.
  token.addChild(t);
  _movePaceLabel.set(tokenUuid, t);
  return t;
}

function positionTokenPaceLabel(token, label) {
  if (!token || !label) return;
  // Anchor-ish: center above the token.
  const w = token.w ?? (token.document.width * canvas.grid.size);
  const h = token.h ?? (token.document.height * canvas.grid.size);
  // PIXI.Text origin is top-left; we simulate center by offsetting by half measured width.
  label.x = (w / 2) - (label.width / 2);
  label.y = -Math.max(14, (h * 0.18));
}

function showTokenPaceLabel(token, paceText, ttlMs = 900) {
  const label = ensureTokenPaceLabel(token);
  if (!label) return;
  label.text = String(paceText ?? "");
  label.visible = !!label.text;
  positionTokenPaceLabel(token, label);

  const tokenUuid = token?.document?.uuid ?? token?.document?.id;
  if (!tokenUuid) return;
  const prior = _movePaceHideTimer.get(tokenUuid);
  if (prior) window.clearTimeout(prior);
  const tid = window.setTimeout(() => {
    try {
      const t = _movePaceLabel.get(tokenUuid);
      if (t && !t.destroyed) t.visible = false;
    } catch (_) {}
  }, ttlMs);
  _movePaceHideTimer.set(tokenUuid, tid);
}

function clearAllTokenPaceLabels() {
  for (const tid of _movePaceHideTimer.values()) {
    try { window.clearTimeout(tid); } catch (_) {}
  }
  _movePaceHideTimer.clear();
  for (const t of _movePaceLabel.values()) {
    try { t.destroy?.({ children: true }); } catch (_) {}
  }
  _movePaceLabel.clear();
}

/**
 * Movement HUD overlay (bottom-left floating panel)
 *
 * The user requested this overlay be removed. We keep the functions as no-ops
 * so other code paths can call them without needing extra conditionals.
 *
 * Note: the over-token pace label (small text over the token) is separate and
 * remains enabled.
 */
function ensureMoveHud() {
  return null;
}

function showMoveHud(_html, _ttlMs = 1750) {
  return;
}

function clearMoveTrail(tokenUuid) {
  // Movement trail drawing is disabled (keep function for compatibility).
  return;
}

function getCurrentInternalSlotRange(combat) {
  const phaseInfo = detectPhaseInfo(combat);
  const apPerPhase = detectApPerPhase();
  const realPhaseCount = clamp(Number(phaseInfo.phaseCount ?? 4), 1, 20);
  const slotsPerRealPhase = clamp(Number(apPerPhase ?? 1), 1, 4);
  const internalPhaseCount = 4;

  const curRealPhase = clamp(Number(phaseInfo.phase ?? 1), 1, realPhaseCount);
  const currentInternalStart = clamp(((curRealPhase - 1) * slotsPerRealPhase) + 1, 1, internalPhaseCount);
  const currentInternalEnd = clamp(currentInternalStart + slotsPerRealPhase - 1, 1, internalPhaseCount);

  return {
    phaseInfo,
    apPerPhase,
    realPhaseCount,
    slotsPerRealPhase,
    internalPhaseCount,
    currentInternalStart,
    currentInternalEnd
  };
}

function getCombatantForActor(combat, actorId) {
  if (!combat || !actorId) return null;
  return combat.combatants?.find(c => c?.actorId === actorId) ?? null;
}

function getStateForRead(combat) {
  const raw = combat?.getFlag?.(MODULE_ID, "state");
  // Everyone (including GM) may have optimistic local "pending" state during in-flight updates.
  // Merge it for reads that must reflect immediate UI selections (e.g., movement enforcement during the same phase).
  return applyPendingToState(combat?.id, raw);
}

function getPlanActionsForCombatant(combat, combatantId) {
  const state = getStateForRead(combat);
  const cd = state?.combatants?.[combatantId] ?? {};
  return cd?.planActions ?? {};
}

function getMoveSlotsForActor(combat, actorId) {
  const c = getCombatantForActor(combat, actorId);
  if (!c) return { combatant: null, moveSlotKeys: [], movementDisabled: false };

  const { phaseInfo, currentInternalStart, currentInternalEnd } = getCurrentInternalSlotRange(combat);
  const planActions = getPlanActionsForCombatant(combat, c.id);

  // If the user hasn't made ANY selection in the current phase (all selectors show "-" in UI),
  // disable token movement entirely for this phase.
  const hasAnySelectionThisPhase = (() => {
    // Treat any "blank" selector value as no-selection. Some UI widgets emit dash variants.
    const noneVals = new Set(["none", "-", "—", "–", "", "null", "undefined"]);
    for (let ip = currentInternalStart; ip <= currentInternalEnd; ip++) {
      for (const t of ["m","b"]) {
        const k = phaseKey(phaseInfo.round, ip, t);
        const v = String(planActions?.[k] ?? "none").trim().toLowerCase();
        if (!noneVals.has(v)) return true;
      }
    }
    return false;
  })();
  if (!hasAnySelectionThisPhase) return { combatant: c, moveSlotKeys: [], movementDisabled: true };

  const out = [];
  for (let ip = currentInternalStart; ip <= currentInternalEnd; ip++) {
    for (const t of ["m","b"]) {
      const k = phaseKey(phaseInfo.round, ip, t);
      const v = planActions[k] ?? "none";
      if (v === MOVE_ACTION_KEY) out.push(k);
    }
  }
  return { combatant: c, moveSlotKeys: out, movementDisabled: false };
}

function _phaseGroupKeysForCurrent(combat) {
  const { phaseInfo, currentInternalStart, currentInternalEnd } = getCurrentInternalSlotRange(combat);
  const keys = [];
  for (let ip = currentInternalStart; ip <= currentInternalEnd; ip++) {
    for (const t of ["m","b"]) keys.push(phaseKey(phaseInfo.round, ip, t));
  }
  return { keys, phaseInfo, currentInternalStart, currentInternalEnd };
}

async function undoMoveAndClearSelectorsForPhase(combat, combatantId, planActions, planAuto, planCosts, finActs) {
  if (!canvas?.ready) return false;

  const { keys, phaseInfo, currentInternalStart, currentInternalEnd } = _phaseGroupKeysForCurrent(combat);
  const phaseKeyId = `${combat.id}:${phaseInfo.round}:${currentInternalStart}-${currentInternalEnd}`;

  // Find a token for this combatant's actor.
  const comb = combat.combatants?.get(combatantId);
  const actorId = comb?.actor?.id;
  const tokenObj = canvas.tokens?.placeables?.find(t => t?.document?.actorId === actorId) ?? null;
  const tokenDoc = tokenObj?.document;
  const tokenUuid = tokenDoc ? getTokenUuid(tokenDoc) : null;
  if (!tokenUuid) return false;

  const track = _moveTrack.get(tokenUuid);
  const usedThisPhase = keys.some(k => Number(track?.usedBySlot?.[k] ?? 0) > 1e-6);

  if (!usedThisPhase) return false;

  // Snap back to the phase origin (where the token started before any Move in this phase).
  const origin = track?.phaseOrigin ?? track?.points?.[0] ?? track?.lastCenter;
  if (origin) {
    const w = tokenDoc.width ?? 1;
    const h = tokenDoc.height ?? 1;
    const halfW = (canvas.grid.size * w) / 2;
    const halfH = (canvas.grid.size * h) / 2;
    const x = origin.x - halfW;
    const y = origin.y - halfH;

    try {
      await tokenDoc.update({ x, y }, { animate: false, rmuCptUndo: true });
    } catch (_) {}
  }

  const usedKeys = new Set();
  for (const k of keys) {
    if (Number(track?.usedBySlot?.[k] ?? 0) > 1e-6) usedKeys.add(k);
  }

  // Clear per-slot usage for this phase group.
  if (track?.usedBySlot) {
    for (const k of keys) delete track.usedBySlot[k];
  }

  // Reset tracking for this phase group so future drags start clean.
  if (track) {
    track.phaseKey = phaseKeyId;
    if (origin) {
      track.phaseOrigin = { x: origin.x, y: origin.y };
      track.lastCenter = { x: origin.x, y: origin.y };
      track.points = [{ x: origin.x, y: origin.y }];
    }
  }

  // Clear preview and any cached overlay state.
  try { _movePreview.delete(tokenUuid); } catch (_) {}

  // Clear selectors in THIS phase group: any selector that is Move OR had an overlay gets reset to blank.
  for (const k of keys) {
    const isMoveSel = (planActions?.[k] === MOVE_ACTION_KEY);
    const hadOverlay = usedKeys.has(k);
    if (isMoveSel || hadOverlay) {
      planActions[k] = "none";
      planAuto[k] = false;
      planCosts[k] = null;
      finActs[k] = false;
    }
  }

  ui.notifications?.info?.("Movement undone (a Move selector changed). Move actions in this phase were cleared.");

  return true;
}

// Reset token movement for the *current* phase group without clearing any selector values.
// This is used by the "Reset Move" button shown on selectors with movement overlays.
async function resetMoveForCurrentPhaseGroup(combat, combatantId) {
  if (!canvas?.ready) return false;
  if (!combat || !combatantId) return false;

  const { keys, phaseInfo, currentInternalStart, currentInternalEnd } = _phaseGroupKeysForCurrent(combat);
  const phaseKeyId = `${combat.id}:${phaseInfo.round}:${currentInternalStart}-${currentInternalEnd}`;

  // Find the *combatant's* token first (more reliable than actorId lookups),
  // then fall back to the first placeable token for that actor.
  const comb = combat.combatants?.get(combatantId);
  const actorId = comb?.actor?.id;

  let tokenDoc = null;
  try {
    // Foundry often exposes tokenId on Combatant; resolve it against the current scene.
    const tid = comb?.tokenId ?? comb?.token?.id ?? null;
    if (tid && canvas?.scene?.tokens?.get(tid)) tokenDoc = canvas.scene.tokens.get(tid);
  } catch (_) {}
  if (!tokenDoc) {
    try {
      // Some versions expose the TokenDocument directly.
      const td = comb?.token ?? comb?.token?.document ?? null;
      if (td?.actorId) tokenDoc = td;
    } catch (_) {}
  }
  if (!tokenDoc && actorId) {
    const tokenObj = canvas.tokens?.placeables?.find(t => t?.document?.actorId === actorId) ?? null;
    tokenDoc = tokenObj?.document ?? null;
  }
  if (!tokenDoc) return false;

  // Movement tracking has historically keyed by either token.uuid or token.id depending on
  // which hook produced the event. To ensure Reset Move always clears the displayed totals,
  // clear both possible keys.
  const tokenKeys = Array.from(new Set([
    tokenDoc?.uuid ? String(tokenDoc.uuid) : null,
    tokenDoc?.id ? String(tokenDoc.id) : null
  ].filter(Boolean)));
  if (!tokenKeys.length) return false;

  const tracks = tokenKeys
    .map(k => [k, _moveTrack.get(k)])
    .filter(([, tr]) => !!tr);
  if (!tracks.length) return false;

  const incKey = `i${phaseInfo.round}p${currentInternalStart}-${currentInternalEnd}`;
  const allKeys = [...keys, incKey];

  // Find whether ANY tracked key has movement in this phase.
  const usedThisPhase = tracks.some(([, tr]) => allKeys.some(k => Number(tr?.usedBySlot?.[k] ?? 0) > 1e-6));
  // Prefer the stored *top-left* origin if available so the token returns to the
  // exact pixel it started this phase at.
  const primaryTrack = tracks.find(([, tr]) => tr?.phaseOriginTL)?.[1] ?? tracks[0][1];
  const originTL = primaryTrack?.phaseOriginTL;
  const originCenter = primaryTrack?.phaseOrigin ?? primaryTrack?.points?.[0] ?? primaryTrack?.lastCenter;
  if (!usedThisPhase || (!originTL && !originCenter)) return false;

  // Snap back to the phase origin (where the token started before any move in this phase group).
  let x;
  let y;
  if (originTL && Number.isFinite(originTL.x) && Number.isFinite(originTL.y)) {
    x = originTL.x;
    y = originTL.y;
  } else {
    const w = Number(tokenDoc.width ?? 1) || 1;
    const h = Number(tokenDoc.height ?? 1) || 1;
    const gs = Number(canvas.grid.size ?? 0) || 0;
    const halfW = (gs * w) / 2;
    const halfH = (gs * h) / 2;
    x = originCenter.x - halfW;
    y = originCenter.y - halfH;
  }

  try {
    await tokenDoc.update({ x, y }, { animate: false, rmuCptUndo: true });
  } catch (_) {
    // Even if the update fails, we still try to clear local state to avoid stuck overlays.
  }

  // Clear per-slot usage + reset phase tracking for *all* matching token keys.
  for (const [tk, tr] of tracks) {
    if (tr?.usedBySlot) {
      for (const k of allKeys) delete tr.usedBySlot[k];
    }
    tr.phaseKey = phaseKeyId;
    const oc = originCenter ?? tokenCenterFromTopLeft(x, y, tokenDoc);
    tr.phaseOrigin = { x: oc.x, y: oc.y };
    tr.phaseOriginTL = { x, y };
    tr.lastCenter = { x: oc.x, y: oc.y };
    tr.points = [{ x: oc.x, y: oc.y }];
    try { _movePreview.delete(tk); } catch (_) {}
  }

  return true;
}

function toNumOrNull(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    // Be tolerant of unit-suffixed values like "20 ft" or "15.5".
    const s = v.trim().replace(/,/g, "");
    const m = s.match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function readPerPhaseFeetFromPaceRate(p) {
  if (!p || typeof p !== "object") return null;
  const keys = [
    "perPhase","perPhaseDistance","per_phase","phaseDistance","distancePerPhase",
    "perPhaseFt","perPhaseFeet","phase","pp"
  ];
  for (const k of keys) {
    if (k in p) {
      const n = toNumOrNull(p[k]);
      if (n !== null) return n;
    }
  }
  // fallback: scan any key that looks like per-phase
  for (const [k, v] of Object.entries(p)) {
    const kk = String(k).toLowerCase();
    if (kk.includes("perphase") || kk.includes("phase") || kk === "pp") {
      const n = toNumOrNull(v);
      if (n !== null) return n;
    }
  }
  return null;
}

function readPenaltyTextFromPaceRate(p) {
  if (!p || typeof p !== "object") return "";
  const keys = ["penalty","penaltyAP","penaltyAp","apCost","AP","ap","modifier","mod","malus","pen","notes","note"];
  for (const k of keys) {
    if (k in p) return String(p[k] ?? "").trim();
  }
  for (const [k, v] of Object.entries(p)) {
    const kk = String(k).toLowerCase();
    if (kk.includes("penal") || kk.includes("apcost") || kk.includes("modifier") || kk === "ap" || kk === "mod" || kk === "malus") {
      return String(v ?? "").trim();
    }
  }
  return "";
}

function normalizePaceName(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s.includes("creep")) return "Creep";
  if (s.includes("walk")) return "Walk";
  if (s.includes("jog")) return "Jog";
  if (s.includes("run")) return "Run";
  if (s.includes("sprint")) return "Sprint";
  if (s.includes("dash") || s.includes("dead run") || s.includes("flat out") || s.includes("run fast")) return "Dash";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const _PACE_ORDER = ["Creep","Walk","Jog","Run","Sprint","Dash"];

function paceOrderIndex(pace) {
  const i = _PACE_ORDER.indexOf(pace);
  return i >= 0 ? i : 999;
}

function resolveMovementOption(actor) {
  const mb = actor?.system?._movementBlock;
  if (!mb || typeof mb !== "object") return { mb: null, opt: null, optKey: null };
  const selected = mb.selected;
  const options = mb.options;

  let opt = null;
  let optKey = null;

  const tryMatch = (o) => {
    if (!o || typeof o !== "object") return false;
    const fields = ["value","label","name","key","type","mode"];
    for (const f of fields) {
      const v = o[f];
      if (v == null) continue;
      if (String(v).toLowerCase() === String(selected).toLowerCase()) return true;
    }
    return false;
  };

  if (Array.isArray(options)) {
    const selNum = toNumOrNull(selected);
    if (selNum !== null && selNum >= 0 && selNum < options.length) opt = options[selNum];
    if (!opt && selected != null) opt = options.find(o => tryMatch(o)) ?? null;
  } else if (options && typeof options === "object") {
    if (selected != null && Object.prototype.hasOwnProperty.call(options, selected)) {
      opt = options[selected];
      optKey = selected;
    } else if (selected != null) {
      const s = String(selected).toLowerCase();
      for (const [k, o] of Object.entries(options)) {
        if (String(k).toLowerCase() === s || tryMatch(o)) {
          opt = o; optKey = k; break;
        }
      }
    }
  }

  return { mb, opt, optKey };
}

function getCarriedAndBodyWeight(actor) {
  try {
    const { mb, opt } = resolveMovementOption(actor);
    if (!mb) return { carried: null, bodyWeight: null };

    // Carried load fallback chain.
    const carried = toNumOrNull(
      opt?.currentLoad ?? opt?.carried ??
      mb?.currentLoad ?? mb?.load ?? mb?.carried ??
      actor?.system?.encumbrance?.carried
    );

    // Body weight fallback chain.
    const bodyWeight = toNumOrNull(
      opt?.bodyWeight ?? opt?.weight ??
      mb?.bodyWeight ?? mb?.weight ??
      actor?.system?.weight?.value ?? actor?.system?.weight ??
      actor?.system?.attributes?.weight ??
      actor?.system?.characteristics?.weight ??
      actor?.system?.characteristics?.physical?.weight?.value ??
      actor?.system?.details?.weight
    );

    return { carried, bodyWeight };
  } catch (_) {
    return { carried: null, bodyWeight: null };
  }
}

// Try to read an encumbrance/load percentage as a fraction in [0..1].
// RMU data can vary across versions; we probe a few common shapes.
function getLoadFraction(actor) {
  try {
    const { mb, opt } = resolveMovementOption(actor);

    const cand = (
      opt?.loadFraction ?? opt?.loadRatio ??
      opt?.loadPercent ?? opt?.loadPct ?? opt?.pctLoad ?? opt?.encumbrancePct ??
      mb?.loadFraction ?? mb?.loadRatio ??
      mb?.loadPercent ?? mb?.loadPct ?? mb?.pctLoad ??
      actor?.system?.encumbrance?.percent ?? actor?.system?.encumbrance?.pct ??
      actor?.system?.encumbrance?.loadPercent ?? actor?.system?.encumbrance?.loadPct ??
      actor?.system?.encumbrance?.carriedPct ?? actor?.system?.encumbrance?.ratio ??
      actor?.system?.encumbrance?.value?.percent ?? actor?.system?.encumbrance?.value?.pct ??
      actor?.system?.attributes?.encumbrance?.percent ?? actor?.system?.attributes?.encumbrance?.pct
    );

    const n = toNumOrNull(cand);
    if (!Number.isFinite(n)) return null;

    // Normalize: 0.15, 15, or 15% style values.
    if (n > 1.5) return clamp(n / 100, 0, 10);
    return clamp(n, 0, 10);
  } catch (_) {
    return null;
  }
}

// Fallback heuristic: if the RMU movement option explicitly allows Dash as a pace,
// that's typically only possible at very light load (<=15%).
// We use this ONLY when we cannot read a numeric load percentage or carried/bodyWeight.
function inferLightLoadFromMovementOption(actor) {
  try {
    const { mb, opt } = resolveMovementOption(actor);
    if (!mb) return false;

    const maxPace = normalizePaceName(opt?.maxPace ?? mb?.maxPace);
    if (maxPace === "Dash") return true;

    const paceRates = Array.isArray(opt?.paceRates) ? opt.paceRates : (Array.isArray(mb?.paceRates) ? mb.paceRates : []);
    const dash = paceRates.find(pr => normalizePaceName(pr?.name ?? pr?.pace ?? pr?.label) === "Dash");
    if (!dash) return false;

    const per = readPerPhaseFeetFromPaceRate(dash);
    const blocked = (dash?.maxPaceReached === true || dash?.blocked === true || dash?.allowed === false || dash?.disabled === true);
    if (blocked) return false;
    return Number.isFinite(Number(per)) && Number(per) > 0;
  } catch (_) {
    return false;
  }
}

// Dash eligibility gate: carried <= 15% of body weight. If unknown, be permissive.
function isDashEligibleByLoad(actor) {
  const lf = getLoadFraction(actor);
  if (Number.isFinite(lf) && lf != null) return lf <= 0.15;
  const { carried, bodyWeight } = getCarriedAndBodyWeight(actor);
  if (!Number.isFinite(carried) || !Number.isFinite(bodyWeight) || carried <= 0 || bodyWeight <= 0) return true;
  return (carried / bodyWeight) <= 0.15;
}

// Strict light-load check for the 1.25x BMR rule: require known weights.
function isLightLoadAtMost15(actor) {
  const lf = getLoadFraction(actor);
  if (Number.isFinite(lf) && lf != null) return lf <= 0.15;
  const { carried, bodyWeight } = getCarriedAndBodyWeight(actor);
  if (Number.isFinite(carried) && Number.isFinite(bodyWeight) && carried >= 0 && bodyWeight > 0) {
    return (carried / bodyWeight) <= 0.15;
  }
  // Last-resort heuristic when RMU doesn't expose numeric load stats.
  return inferLightLoadFromMovementOption(actor);
}

function sumMovementForInternalRange(track, roundNum, startIp, endIp) {
  if (!track || !track.usedBySlot) return 0;
  const r = Number(roundNum ?? 0);
  const s = Number(startIp ?? 0);
  const e = Number(endIp ?? 0);
  if (!(r > 0) || !(s > 0) || !(e > 0) || e < s) return 0;

  let total = 0;
  // Move allocations can be stored per selector key (main/bonus).
  for (let ip = s; ip <= e; ip++) {
    total += Number(track.usedBySlot?.[phaseKey(r, ip, "m")] ?? 0);
    total += Number(track.usedBySlot?.[phaseKey(r, ip, "b")] ?? 0);
  }
  // Incidental movement allocations are stored per range key.
  total += Number(track.usedBySlot?.[`i${r}p${s}-${e}`] ?? 0);
  return total;
}

// Previous action-phase range (across round boundaries).
// Returns {round,start,end}. If no previous phase exists (round 1, phase 1), round=0.
function getPrevActionPhaseRange(curRound, grpStart, grpEnd, slotsPerReal, internalCount) {
  const r = Number(curRound ?? 1);
  const s = Number(grpStart ?? 1);
  const e = Number(grpEnd ?? s);
  const spr = clamp(Number(slotsPerReal ?? 1), 1, 4);
  const ic = clamp(Number(internalCount ?? 4), 1, 99);
  if (!(r >= 1)) return { round: 0, start: 1, end: 1 };
  if ((s - spr) >= 1) return { round: r, start: s - spr, end: e - spr };
  const pr = r - 1;
  if (pr < 1) return { round: 0, start: 1, end: 1 };
  const ps = clamp(ic - spr + 1, 1, ic);
  return { round: pr, start: ps, end: ic };
}


// Reads movementBlock + selected option paceRates.
// Returns: { bmrPerPhase:number|null, optionLabel:string, maxPaceLabel:string|null, rates:[{pace, perPhase, penaltyText, allowed}] }
function getActorPaceRates(actor) {
  const mb = actor?.system?._movementBlock;
  if (!mb || typeof mb !== "object") {
    return { bmrPerPhase: null, optionLabel: "Unknown", maxPaceLabel: null, rates: [] };
  }

  const bmrPerPhase = toNumOrNull(mb.bmr);

  const { opt, optKey } = resolveMovementOption(actor);
  const optionLabel = String(opt?.label ?? opt?.name ?? opt?.value ?? optKey ?? mb.selected ?? "Movement").trim();

  const maxPaceLabel = opt?.maxPace ? normalizePaceName(opt.maxPace) : (mb?.maxPace ? normalizePaceName(mb.maxPace) : null);

  const paceRates = Array.isArray(opt?.paceRates) ? opt.paceRates : (Array.isArray(mb?.paceRates) ? mb.paceRates : []);
  const rates = [];
  for (const pr of paceRates) {
    const pace = normalizePaceName(pr?.name ?? pr?.pace ?? pr?.label);
    if (!pace) continue;

    const perPhase = readPerPhaseFeetFromPaceRate(pr);
    if (perPhase == null) continue;

    // Dash gate: if the pace itself is marked blocked/disabled, treat as not allowed.
    // Also apply the RMU load gate (carried <= 15% of body weight) when data is available.
    let allowed = true;
    if (pace === "Dash") {
      if (pr?.maxPaceReached === true || pr?.blocked === true || pr?.allowed === false || pr?.disabled === true) allowed = false;
      if (perPhase <= 0) allowed = false;
      if (!isDashEligibleByLoad(actor)) allowed = false;
    }
    rates.push({
      pace,
      perPhase: Number(perPhase),
      penaltyText: readPenaltyTextFromPaceRate(pr),
      allowed
    });
  }

  // Apply maxPace cap if provided.
  let cappedRates = rates.slice();
  if (maxPaceLabel) {
    const capIdx = paceOrderIndex(maxPaceLabel);
    cappedRates = cappedRates.filter(r => paceOrderIndex(r.pace) <= capIdx);
  }

  // If we have no paceRates, fall back to BMR as Walk.
  if (cappedRates.length === 0 && bmrPerPhase != null) {
    cappedRates = [{ pace: "Walk", perPhase: bmrPerPhase, penaltyText: "", allowed: true }];
  }

  // Sort by perPhase increasing.
  cappedRates.sort((a,b) => a.perPhase - b.perPhase);

  return { bmrPerPhase, optionLabel, maxPaceLabel, rates: cappedRates };
}

// Infer pace label using RMU Table 5-3 style multipliers vs BMR.
// distTotal: total distance moved (feet) for the round (or other period).
// bmrPerRound: BMR distance (feet) for that same period.
// dashOk: whether Dash (x5) is permitted; if false, max is Sprint (x4).
function paceMultiplierForLabel(pace) {
  const p = normalizePaceName(pace);
  if (p === "Creep") return 0.5;
  if (p === "Walk") return 1;
  if (p === "Jog") return 2;
  if (p === "Run") return 3;
  if (p === "Sprint") return 4;
  if (p === "Dash") return 5;
  return null;
}

/**
 * Convert RMU pace caps into a multiplier of BMR per round.
 * Dash may be disabled when Instantaneous Action is unavailable.
 */
/**
 * Convert a max pace label (Creep..Dash) to a multiplier of BMR for the round.
 *
 * Example (BMR=16):
 * - Walk => 1.0× (16)
 * - Sprint => 4.0× (64)
 * - Dash => 5.0× (80)
 */
function capMultiplierForBmrTable(dashOk, maxPaceLabel) {
  // Default: Sprint cap (x4) unless Dash is permitted (x5).
  let capMult = dashOk ? 5 : 4;

  // RMU may provide an encumbrance-based pace cap. In practice we've seen some actors report
  // "Sprint" even when Dash is permitted by the <=15% load rule; when dashOk is true, treat
  // a Sprint cap as compatible with Dash so the UI/enforcement remain consistent.
  const m = paceMultiplierForLabel(maxPaceLabel);
  if (Number.isFinite(m) && m > 0) {
    if (!(dashOk && m === 4)) capMult = Math.min(capMult, m);
  }
  return capMult;
}

// Infer pace label using RMU Table 5-3 style multipliers vs BMR.
// distTotal: total distance moved (feet) for the round (or other period).
// bmrPerRound: BMR distance (feet) for that same period.
// dashOk: whether Dash (x5) is permitted (special-case last phase).
// maxPaceLabel: RMU-supplied pace cap (encumbrance/load), e.g. "Walk", "Jog", "Run", etc.
// Convert total distance moved this round into a pace label using the actor’s BMR table.
// IMPORTANT: For "Move Your BMR" overlays, pace is based on *TOTAL moved this round* vs real BMR.
function inferPaceFromBmrTable(distTotal, bmrPerRound, dashOk, maxPaceLabel) {
  const dist = Number(distTotal);
  const bmr = Number(bmrPerRound);

  const capMult = capMultiplierForBmrTable(Boolean(dashOk), maxPaceLabel);
  const capFt = (Number.isFinite(bmr) && bmr > 0) ? (bmr * capMult) : 0;

  if (!Number.isFinite(dist) || dist <= 0 || !Number.isFinite(bmr) || bmr <= 0) {
    // If no movement happened (or data is missing), show the default no-penalty pace.
    return { pace: "Walk", mult: 1, cap: capFt, capMult };
  }

  // Pace is the *minimum* band that can accommodate the distance moved this round:
  //   <= 0.5×BMR => Creep
  //   <= 1.0×BMR => Walk
  //   <= 2.0×BMR => Jog
  //   <= 3.0×BMR => Run
  //   <= 4.0×BMR => Sprint
  //   <= 5.0×BMR => Dash
  if (capMult <= 0.5 + 1e-9) {
    return { pace: "Creep", mult: 0.5, cap: capFt, capMult };
  }

  const bands = [
    { pace: "Creep", mult: 0.5 },
    { pace: "Walk", mult: 1 },
    { pace: "Jog", mult: 2 },
    { pace: "Run", mult: 3 },
    { pace: "Sprint", mult: 4 },
    { pace: "Dash", mult: 5 },
  ].filter(t => t.mult <= capMult + 1e-9);

  let chosen = bands[0] ?? { pace: "Walk", mult: 1 };
  for (const t of bands) {
    const thrFt = bmr * t.mult;
    if (dist <= thrFt + MOVE_EPS_FT) { chosen = t; break; }
    chosen = t; // if we exceed this band, keep climbing
  }

  return { pace: chosen.pace, mult: chosen.mult, cap: capFt, capMult };
}

function measureFtBetweenCenters(a, b) {
  if (!canvas?.ready) return 0;
  const ray = new Ray(a, b);
  const d = canvas.grid.measureDistances([{ ray }], { gridSpaces: true })?.[0];
  return Number(d ?? 0);
}

function tokenCenterFromTopLeft(x, y, tokenDoc) {
  // We measure movement in feet using rays between token centers.
  // IMPORTANT: canvas.grid.getCenter(x,y) returns the center of a *single grid space*
  // whose top-left is (x,y). For tokens larger than 1x1, that is not the token's true center.
  // To ensure Reset Move returns the token to the exact phase-start position and movement
  // totals match what players see on the canvas, compute the true token center using
  // token dimensions.
  const gs = Number(canvas?.grid?.size ?? 0) || 0;
  const w = Number(tokenDoc?.width ?? 1) || 1;
  const h = Number(tokenDoc?.height ?? 1) || 1;
  if (gs > 0) {
    return { x: Number(x) + (gs * w) / 2, y: Number(y) + (gs * h) / 2 };
  }
  // Fallback (gridless): behave like getCenter.
  const c = canvas.grid.getCenter(Number(x) || 0, Number(y) || 0);
  return { x: c[0], y: c[1] };
}

function getTokenUuid(doc) {
  return doc?.uuid ?? doc?.id ?? null;
}

function resetMoveTrackForToken(tokenUuid, phaseKeyId, startCenter, startTopLeft) {
  _moveTrack.set(tokenUuid, {
    phaseKey: phaseKeyId,
    // phaseOrigin stores the *center* at the start of the current phase group
    // (used for measuring and as a fallback snap-back point).
    phaseOrigin: { x: startCenter.x, y: startCenter.y },
    // Also store the *top-left* origin so Reset Move can return the token to the exact
    // pixel coordinates it began this phase with (no center math drift).
    phaseOriginTL: startTopLeft ? { x: startTopLeft.x, y: startTopLeft.y } : null,
    lastCenter: { x: startCenter.x, y: startCenter.y },
    usedBySlot: {},
    points: [{ x: startCenter.x, y: startCenter.y }],
    // PhaseKeyId of the most recent phase group where a 1.25x Move-BMR was actually used
    // (i.e., the actor exceeded their normal per-slot Move cap). Used to prevent chaining.
    lastBoostedPhaseKeyId: null
  });
  clearMoveTrail(tokenUuid);
}

function getRoundTotal(track, round) {
  const pref = `r${round}p`;
  let total = 0;
  for (const [k, v] of Object.entries(track.usedBySlot ?? {})) {
    if (k.startsWith(pref)) total += Number(v ?? 0);
  }
  return total;
}

// Sum committed Move distance for a round up to (and including) a given internal phase.
// This lets per-slot overlays show a useful "history" (total-so-far) rather than the final round total.
function getRoundTotalUpToInternal(track, round, internalPhase) {
  const r = Number(round);
  const ipMax = clamp(Number(internalPhase ?? 0), 1, 99);
  let total = 0;
  for (let ip = 1; ip <= ipMax; ip++) {
    for (const t of ["m","b"]) {
      const k = phaseKey(r, ip, t);
      total += Number(track?.usedBySlot?.[k] ?? 0);
    }
  }
  return total;
}

// Count how many Move slots have been USED (non-zero distance) this round.
// We infer pace from the round total divided by this count, so pace reflects
// average movement per Move slot across the whole round (not just the current phase).

// Allocate a segment distance across move slots in order.
// perSlotMax can be a number (same cap for all slots) or a map { [slotKey]: cap }.
// Returns { allocations:{[slotKey]:number}, overflow:number }
function allocateAcrossSlots(moveSlotKeys, track, segmentFt, perSlotMax) {
  let remaining = segmentFt;
  const allocations = {};
  for (const k of moveSlotKeys) {
    const used = Number(track.usedBySlot?.[k] ?? 0);
    const capRaw = (perSlotMax && typeof perSlotMax === "object") ? perSlotMax[k] : perSlotMax;
    const cap = Math.max(0, Number(capRaw ?? 0) - used);
    if (cap <= 0) continue;
    const take = Math.min(cap, remaining);
    if (take > 0) {
      allocations[k] = (allocations[k] ?? 0) + take;
      remaining -= take;
      if (remaining <= 1e-6) break;
    }
  }
  return { allocations, overflow: Math.max(0, remaining) };
}



// Build a live preview of Move allocations during token drag, so overlays can update in real time.
// This does NOT commit distance; commit still occurs in updateToken.
function _updateMovePreviewForToken(token) {
  try {
    if (!token?.document?.actor) return;
    if (!canvas?.ready) return;
    if (!game?.combat?.started) return;

    // Do not clamp/block token movement unless the tracker UI is currently open on this client.
    if (!(globalThis._rmuCptApp?.rendered)) return;

    const combat = game.combat;
    const cur = combat?.combatant;
    if (!cur || cur.actorId !== token.document.actor.id) return;

    const { moveSlotKeys, movementDisabled } = getMoveSlotsForActor(combat, token.document.actor.id);
    if (movementDisabled) {
      _movePreview.delete(getTokenUuid(token.document));
      return;
    }

    const { phaseInfo, currentInternalStart, currentInternalEnd, internalPhaseCount } = getCurrentInternalSlotRange(combat);
    const phaseKeyId = `${combat.id}:${phaseInfo.round}:${currentInternalStart}-${currentInternalEnd}`;

    const tokenUuid = getTokenUuid(token.document);
    const doc = token.document;

    const curCenter = tokenCenterFromTopLeft(token.x, token.y, doc);

    let track = _moveTrack.get(tokenUuid);
    if (!track) {
      const startCenter = tokenCenterFromTopLeft(doc.x, doc.y, doc);
      const startTL = { x: Number(doc.x) || 0, y: Number(doc.y) || 0 };
      resetMoveTrackForToken(tokenUuid, phaseKeyId, startCenter, startTL);
      track = _moveTrack.get(tokenUuid);
    }
    if (!track) return;

    // Ensure phaseKey matches the current internal slot range.
    if (track.phaseKey !== phaseKeyId || !track.lastCenter) {
      // New visible phase group: reset both the origin (for Reset Move) and the live line.
      const startCenter = tokenCenterFromTopLeft(doc.x, doc.y, doc);
      const startTL = { x: Number(doc.x) || 0, y: Number(doc.y) || 0 };
      track.phaseKey = phaseKeyId;
      track.phaseOrigin = { x: startCenter.x, y: startCenter.y };
      track.phaseOriginTL = { x: startTL.x, y: startTL.y };
      track.lastCenter = { x: startCenter.x, y: startCenter.y };
      track.points = [{ x: startCenter.x, y: startCenter.y }];
    }

    const segmentFt = measureFtBetweenCenters(track.lastCenter, curCenter);
    if (!Number.isFinite(segmentFt) || segmentFt <= 0) {
      _movePreview.delete(tokenUuid);
      return;
    }

    const paceInfo = getActorPaceRates(doc.actor);
    const rawBmr = Number(paceInfo.bmrPerPhase ?? 0);
    // Per user rule: each Move selector grants movement.
    if (!Number.isFinite(rawBmr) || rawBmr <= 0) return;

    // If we're in a "Move Your BMR" phase, build the existing per-slot preview.
    const isMovePhase = Array.isArray(moveSlotKeys) && moveSlotKeys.length > 0;

    // Dash special case (same rules as enforcement).
    const st = (combat.getFlag?.(MODULE_ID, "state") ?? {}) || {};
    const cd = (st.combatants && cur?.id) ? (st.combatants[cur.id] ?? {}) : {};
    const planActions = cd.planActions ?? {};
    const instantAvailable = (cd.instantAction == null || cd.instantAction === "available" || cd.instantAction === "");
    const concOnCount = countConcOn(normalizeConcFlags(cd));
    // === PREVIEW MODE A: Move Your BMR ===
    if (isMovePhase) {
    let baseCap = rawBmr;
    let bmrBaseTotal = rawBmr;
    let maxPaceLabelUsed = paceInfo?.maxPaceLabel;
    let dashScale = 1;
    if (concOnCount === 1) {
      baseCap = rawBmr * 0.5;
      bmrBaseTotal = rawBmr * 0.5;
      dashScale = 0.5;
    } else if (concOnCount >= 2) {
      // Two concentration toggles => movement capped at Creep (0.5×BMR), but BMR base remains unchanged for the table.
      baseCap = rawBmr * 0.5;
      bmrBaseTotal = rawBmr;
      maxPaceLabelUsed = "Creep";
    }
    const dashRate = (paceInfo.rates ?? []).find(r => r.pace === "Dash" && r.allowed);
    // Dash is only meaningful if the FINAL internal slot is also a "Move Your BMR" selection.
    const lastMoveKeyM = phaseKey(phaseInfo.round, internalPhaseCount, "m");
    const lastMoveKeyB = phaseKey(phaseInfo.round, internalPhaseCount, "b");
    const lastIsMoveAny = (String(planActions?.[lastMoveKeyM] ?? "none") === MOVE_ACTION_KEY) || (String(planActions?.[lastMoveKeyB] ?? "none") === MOVE_ACTION_KEY);
    const canDashThisLastSlot = Boolean((concOnCount < 2) && instantAvailable && dashRate && isDashEligibleByLoad(doc.actor) && lastIsMoveAny && (currentInternalEnd === internalPhaseCount));

    // Determine whether the 1.25x Move-BMR boost applies for this action-phase.
    // NOTE: This is used for LIVE PREVIEW allocations so the overlay "used" value can exceed 1x BMR
    // when the boost is active.
    const slotsPerReal = clamp(Number(detectApPerPhase(combat) ?? 1), 1, 4);
    const grpStart = currentInternalStart;
    const grpEnd = currentInternalEnd;

    const prev = getPrevActionPhaseRange(phaseInfo?.round ?? 1, grpStart, grpEnd, slotsPerReal, internalPhaseCount);

const prevR = prev.round;
const prevS = prev.start;
const prevE = prev.end;

// For the 1.25x rule, we use TOTAL movement made in the previous action-phase (all selectors in that phase),
// and round boundaries do not matter (we wrap to the previous round when needed).
let prevMovedFt = (prevR >= 1) ? sumMovementForInternalRange(track, prevR, prevS, prevE) : 0;
      // If we crossed a round boundary, _moveTrack may have been reset. Use carryover snapshot.
      if (prevMovedFt <= MOVE_EPS_FT && (prevR >= 1)) {
        const snap = _prevPhaseCarry.get(tokenUuid);
        if (snap && snap.combatId === combat.id && Number(snap.round) === Number(prevR) && Number(snap.start) === Number(prevS) && Number(snap.end) === Number(prevE)) {
          prevMovedFt = Number(snap.totalFt ?? 0);
        }
      }
    const effectiveBmrForThreshold = (concOnCount === 1) ? (rawBmr * 0.5) : rawBmr;
    const prevMovedEnough = (prevMovedFt >= (0.5 * effectiveBmrForThreshold) - MOVE_EPS_FT);
    const lightLoadOk = isLightLoadAtMost15(doc.actor);
    const canUseMoveBoost = Boolean(lightLoadOk && prevMovedEnough && concOnCount === 0);
    const boostedCap = canUseMoveBoost ? (baseCap * 1.25) : baseCap;

    const perSlotMax = {};
    for (const k of moveSlotKeys) {
      const m = String(k).match(/^r(\d+)p(\d+)[mb]$/);
      const internalP = m ? Number(m[2]) : null;
      if (canDashThisLastSlot && internalP === internalPhaseCount) perSlotMax[k] = Number(dashRate?.perPhase ?? baseCap) * dashScale;
      else perSlotMax[k] = boostedCap;
    }

    // BMR base used for RMU pace table (may be modified by concentration rules).
        const roundTotalBefore = getRoundTotal(track, phaseInfo?.round ?? 1);
    const dashOkTotal = Boolean((concOnCount < 2) && instantAvailable && isLightLoadAtMost15(doc.actor));
    const capMultTotal = capMultiplierForBmrTable(dashOkTotal, maxPaceLabelUsed);
    const capTotalFt = (Number.isFinite(bmrBaseTotal) && bmrBaseTotal > 0) ? (capMultTotal * bmrBaseTotal) : Infinity;
    const remainingTotalFt = capTotalFt - roundTotalBefore;
    if (Number.isFinite(remainingTotalFt) && remainingTotalFt <= MOVE_EPS_FT) {
      warnMoveOnce(tokenUuid, "cap-total", `Move blocked: movement cap reached.`);
      return false;
    }
    const segmentFtAllowed = Number.isFinite(remainingTotalFt) ? Math.min(segmentFt, Math.max(0, remainingTotalFt)) : segmentFt;
    const totalCapClamped = (segmentFt - segmentFtAllowed) > MOVE_EPS_FT;

    const { allocations, overflow } = allocateAcrossSlots(moveSlotKeys, track, segmentFtAllowed, perSlotMax);
    const allocatedTotal = Object.values(allocations).reduce((a,b)=>a+Number(b??0), 0);
    const allocNet = Math.max(0, Math.min(segmentFt, allocatedTotal)); // net allowance without overflow

    // "Current" live overlay should only update on ONE selector image (the active move slot).
    // If a single drag consumes multiple Move selectors, treat the active slot as the *last* selector that received
    // any preview allocation (i.e. the one currently being "spent").
    let activeSlotKey = null;
    for (const k of moveSlotKeys) {
      if (Number(allocations?.[k] ?? 0) > 1e-6) { activeSlotKey = k; }
    }

    _movePreview.set(tokenUuid, {
      phaseKeyId,
      round: Number(phaseInfo.round ?? 1),
      mode: "move",
      allocations,
      allocatedTotal: allocNet,
      perSlotMax,
      canDashThisLastSlot,
      paceInfo,
      concOnCount,
      bmrBaseTotal,
      maxPaceLabelUsed,
      activeSlotKey
    });
    return;
    }

    // === PREVIEW MODE B: Incidental movement (non-move action selected) ===
    // Use the same cap rules as enforcement, but allocate to a synthetic slot key for this visible phase group.
    const capPace = computeIncidentalCapPace({ defaultCap: "Run", loadMaxPaceLabel: paceInfo?.maxPaceLabel, concOnCount });
    const bmrEffective = (concOnCount === 1) ? (rawBmr * 0.5) : rawBmr;
    const capFt = Math.max(0, bmrEffective * phasePaceCapFrac(capPace));
    const incKey = `i${Number(phaseInfo.round ?? 1)}p${currentInternalStart}-${currentInternalEnd}`;
    const usedBefore = Number(track?.usedBySlot?.[incKey] ?? 0);
    const remaining = capFt - usedBefore;
    if (!(capFt > 0) || remaining <= MOVE_EPS_FT) {
      _movePreview.delete(tokenUuid);
      return;
    }

    const allowed = Math.min(segmentFt, Math.max(0, remaining));
    if (allowed <= 1e-6) {
      _movePreview.delete(tokenUuid);
      return;
    }

    _movePreview.set(tokenUuid, {
      phaseKeyId,
      round: Number(phaseInfo.round ?? 1),
      mode: "incidental",
      allocations: { [incKey]: allowed },
      allocatedTotal: allowed,
      perSlotMax: { [incKey]: capFt },
      paceInfo,
      concOnCount,
      bmrEffective,
      capPace,
      activeSlotKey: incKey
    });
  } catch (e) {
    console.error(`${MODULE_ID} | move preview error`, e);
  }
}


// Fallback: refresh the movement preview/overlay whenever the Token is refreshed.
// This fires continuously while dragging in Foundry, even when TokenDocument updates are only committed on drop.
Hooks.on("refreshToken", (token) => {
  try {
    if (!token || !token.document) return;
    if (!game?.combat?.started) return;

    const combatant = game.combat.combatant;
    const actorId = token.document.actorId ?? token.document.actor?.id;
    if (!combatant || combatant.actorId !== actorId) return;

    const tokenUuid = getTokenUuid(token.document);
    const now = Date.now();
    const throttleKey = `pv:${tokenUuid}`;
    const last = _moveHudThrottle.get(throttleKey) ?? 0;
    if (now - last < 60) return;
    _moveHudThrottle.set(throttleKey, now);

    _updateMovePreviewForToken(token);
    requestAppRefresh();
  } catch (_) {}
});


function _clearMovePreviewForToken(tokenDocOrUuid) {
  try {
    const tokenUuid = (typeof tokenDocOrUuid === "string") ? tokenDocOrUuid : getTokenUuid(tokenDocOrUuid);
    if (!tokenUuid) return;
    _movePreview.delete(tokenUuid);
  } catch (_) {}
}
// Enforce move limits when current action is Move Your BMR.

// ---------------------------------------------------------------------------
// Movement enforcement & overlays (token drag clamping + live preview HUD)
// ---------------------------------------------------------------------------
Hooks.on("preUpdateToken", (doc, change, options, userId) => {
  try {
    if (options && options.rmuCptUndo) return;
    if (options && options.rmuCptClamp) return;
    if (!canvas?.ready) return;
    if (!game?.combat?.started) return;

    // === USER RULE: UI OFF => MODULE MUST NOT AFFECT TOKEN MOVEMENT AT ALL ===
    // If the tracker UI is not currently rendered (hidden/closed), we do not clamp/block
    // movement and we do not update any movement tracking numbers.
    if (!(globalThis._rmuCptApp?.rendered)) return;

    const hasXY = (change && (typeof change.x === "number" || typeof change.y === "number"));
    if (!hasXY) return;

    // Only enforce for the user who is making the move.
    if (userId && userId !== game.user.id) return;

    const token = canvas.tokens?.get(doc.id);
    if (!token || !doc.actor) return;

    const combat = game.combat;
    const cur = combat?.combatant;
    if (!cur || cur.actorId !== doc.actor.id) return;

    const { moveSlotKeys, movementDisabled } = getMoveSlotsForActor(combat, doc.actor.id);
    if (movementDisabled) {
      ui.notifications.warn(`Movement disabled: no actions selected in this phase.`);
      return false;
    }

    const isMovePhase = Array.isArray(moveSlotKeys) && moveSlotKeys.length > 0;

    // Determine the "phase key id" for movement state: combat + round + current internal slot range end.
    const { phaseInfo, currentInternalStart, currentInternalEnd, internalPhaseCount } = getCurrentInternalSlotRange(combat);
    const phaseKeyId = `${combat.id}:${phaseInfo.round}:${currentInternalStart}-${currentInternalEnd}`;

    const tokenUuid = getTokenUuid(doc);
    const oldCenter = tokenCenterFromTopLeft(doc.x, doc.y, doc);
    const nx0 = (typeof change.x === "number") ? change.x : doc.x;
    const ny0 = (typeof change.y === "number") ? change.y : doc.y;
    const newCenter = tokenCenterFromTopLeft(nx0, ny0, doc);

    let track = _moveTrack.get(tokenUuid);
    if (!track) {
      const startTL = { x: Number(doc.x) || 0, y: Number(doc.y) || 0 };
      resetMoveTrackForToken(tokenUuid, phaseKeyId, oldCenter, startTL);
      track = _moveTrack.get(tokenUuid);
    } else if (track.phaseKey !== phaseKeyId || !track.lastCenter) {
      // New phase slot group: reset the origin/line.
      track.phaseKey = phaseKeyId;
      track.phaseOrigin = { x: oldCenter.x, y: oldCenter.y };
      track.phaseOriginTL = { x: Number(doc.x) || 0, y: Number(doc.y) || 0 };
      track.lastCenter = { x: oldCenter.x, y: oldCenter.y };
      track.points = [{ x: oldCenter.x, y: oldCenter.y }];
      clearMoveTrail(tokenUuid);
    }

    // If this move begins from a different position than we think, resync lastCenter.
    if (track && track.lastCenter && (Math.abs(track.lastCenter.x - oldCenter.x) > 2 || Math.abs(track.lastCenter.y - oldCenter.y) > 2)) {
      track.lastCenter = { x: oldCenter.x, y: oldCenter.y };
      track.points = [{ x: oldCenter.x, y: oldCenter.y }];
      clearMoveTrail(tokenUuid);
    }

    const segmentFt = measureFtBetweenCenters(track?.lastCenter ?? oldCenter, newCenter);
    if (!Number.isFinite(segmentFt) || segmentFt <= 0) return;

    const paceInfo = getActorPaceRates(doc.actor);
    const rawBmr = Number(paceInfo.bmrPerPhase ?? 0);
    if (!Number.isFinite(rawBmr) || rawBmr <= 0) return;

    // Pull combatant state (concentration, instantaneous, planActions).
    const st = (combat.getFlag?.(MODULE_ID, "state") ?? {}) || {};
    const cd = (st.combatants && cur?.id) ? (st.combatants[cur.id] ?? {}) : {};
    const planActions = cd.planActions ?? {};
    const instantAvailable = (cd.instantAction == null || cd.instantAction === "available" || cd.instantAction === "");
    const concOnCount = countConcOn(normalizeConcFlags(cd));

    // === MODE A: Move Your BMR ===
    if (isMovePhase) {
      let baseCap = rawBmr;
      let bmrBaseTotal = rawBmr;
      let maxPaceLabelUsed = paceInfo?.maxPaceLabel;
      let dashScale = 1;

      // --- 1.25x Move-BMR rule (light load + prior phase moved >= 1/2 BMR) ---
      // If the actor has <= 15% load AND in the previous action phase they moved at least half their
      // effective BMR, they may move up to 1.25x BMR in a Move slot.
      const slotsPerRealPhase = clamp(Number(detectApPerPhase(combat) ?? 1), 1, 4);
      const prev = getPrevActionPhaseRange(phaseInfo?.round ?? 1, currentInternalStart, currentInternalEnd, slotsPerRealPhase, internalPhaseCount);

const prevR = prev.round;
const prevS = prev.start;
const prevE = prev.end;

// For the 1.25x rule, we use TOTAL movement made in the previous action-phase (all selectors in that phase),
// and round boundaries do not matter (we wrap to the previous round when needed).
// IMPORTANT: _moveTrack is cleared on round changes, so when we cross a round boundary we must fall back
// to the carryover snapshot so enforcement matches the overlay.
let prevMovedFt = (prevR >= 1) ? sumMovementForInternalRange(track, prevR, prevS, prevE) : 0;
if (prevMovedFt <= MOVE_EPS_FT && (prevR >= 1)) {
  const snap = _prevPhaseCarry.get(tokenUuid);
  if (snap && snap.combatId === combat.id && Number(snap.round) === Number(prevR) && Number(snap.start) === Number(prevS) && Number(snap.end) === Number(prevE)) {
    prevMovedFt = Number(snap.totalFt ?? 0);
  }
}
      // Effective BMR (per-phase) for threshold purposes.
      const effectiveBmrForThreshold = (concOnCount === 1) ? (rawBmr * 0.5) : rawBmr;
      const lightLoadOk = isLightLoadAtMost15(doc.actor);
      const prevMovedEnough = (prevMovedFt >= (0.5 * effectiveBmrForThreshold) - MOVE_EPS_FT);
      const canUseMoveBoost = Boolean(lightLoadOk && prevMovedEnough && concOnCount === 0);

      // Concentration rules:
      // - single: BMR itself is halved (so Move selector cap halves)
      // - double: movement is capped at Creep (0.5×BMR) for the selector
      if (concOnCount === 1) {
        baseCap = rawBmr * 0.5;
        bmrBaseTotal = rawBmr * 0.5;
        dashScale = 0.5;
      } else if (concOnCount >= 2) {
        baseCap = rawBmr * 0.5;
        bmrBaseTotal = rawBmr;
        maxPaceLabelUsed = "Creep";
      }

      const dashRate = (paceInfo.rates ?? []).find(r => r.pace === "Dash" && r.allowed);
      // Dash is only meaningful if the FINAL internal slot is also a "Move Your BMR" selection.
      const lastMoveKeyM = phaseKey(phaseInfo.round, internalPhaseCount, "m");
      const lastMoveKeyB = phaseKey(phaseInfo.round, internalPhaseCount, "b");
      const lastIsMoveAny = (String(planActions?.[lastMoveKeyM] ?? "none") === MOVE_ACTION_KEY) || (String(planActions?.[lastMoveKeyB] ?? "none") === MOVE_ACTION_KEY);
      const canDashThisLastSlot = Boolean((concOnCount < 2) && instantAvailable && dashRate && isDashEligibleByLoad(doc.actor) && lastIsMoveAny && (currentInternalEnd === internalPhaseCount));

      const perSlotMax = {};
      const normalPerSlotCap = {};
      for (const k of moveSlotKeys) {
        const mm = String(k).match(/^r(\d+)p(\d+)[mb]$/);
        const internalP = mm ? Number(mm[2]) : null;

        // Base (non-boosted) per-slot cap.
        let normalCapHere = baseCap;

        // Dash is only meaningful as a special last-slot cap and is NOT affected by the 1.25x rule.
        if (canDashThisLastSlot && internalP === internalPhaseCount) {
          normalCapHere = Number(dashRate?.perPhase ?? baseCap) * dashScale;
          normalPerSlotCap[k] = normalCapHere;
          perSlotMax[k] = normalCapHere;
          continue;
        }

        normalPerSlotCap[k] = normalCapHere;
        perSlotMax[k] = canUseMoveBoost ? (normalCapHere * 1.25) : normalCapHere;
      }

      // Total cap across the round from the RMU pace table (do not scale BMR by phase-count).
      const roundTotalBefore = getRoundTotal(track, phaseInfo?.round ?? 1);
      const dashOkTotal = Boolean((concOnCount < 2) && instantAvailable && isLightLoadAtMost15(doc.actor));
    const capMultTotal = capMultiplierForBmrTable(dashOkTotal, maxPaceLabelUsed);
      const capTotalFt = (Number.isFinite(bmrBaseTotal) && bmrBaseTotal > 0) ? (capMultTotal * bmrBaseTotal) : Infinity;
      const remainingTotalFt = capTotalFt - roundTotalBefore;
      if (Number.isFinite(remainingTotalFt) && remainingTotalFt <= MOVE_EPS_FT) {
        warnMoveOnce(tokenUuid, "cap-load", `Move blocked: LOAD pace cap reached.`);
        return false;
      }
      const segmentFtAllowed = Number.isFinite(remainingTotalFt) ? Math.min(segmentFt, Math.max(0, remainingTotalFt)) : segmentFt;
      const totalCapClamped = (segmentFt - segmentFtAllowed) > MOVE_EPS_FT;

      const { allocations, overflow } = allocateAcrossSlots(moveSlotKeys, track, segmentFtAllowed, perSlotMax);

      // If no capacity remains at all, block the move.
      const allocatedTotal = Object.values(allocations).reduce((a,b)=>a+Number(b??0), 0);
      if (allocatedTotal <= 1e-6) {
        ui.notifications.warn(`Move limit reached for this phase.`);
        return false;
      }

      // Clamp the position along the drag vector (do NOT snap back to origin).
      if (overflow > MOVE_EPS_FT || totalCapClamped) {
        const scale = (segmentFt > 0) ? (allocatedTotal / segmentFt) : 0;

        const oldX = Number(doc.x ?? 0);
        const oldY = Number(doc.y ?? 0);
        const tgtX = (typeof change.x === "number") ? change.x : oldX;
        const tgtY = (typeof change.y === "number") ? change.y : oldY;

        let nx = oldX + (tgtX - oldX) * scale;
        let ny = oldY + (tgtY - oldY) * scale;

        // Only snap to grid when the scene is NOT gridless.
        const gridType = canvas?.scene?.grid?.type;
        const isGridless = (gridType === 0);
        if (!isGridless && canvas?.grid?.getSnappedPosition) {
          const snapped = canvas.grid.getSnappedPosition(nx, ny, doc.width ?? 1);
          nx = Array.isArray(snapped) ? snapped[0] : (snapped?.x ?? nx);
          ny = Array.isArray(snapped) ? snapped[1] : (snapped?.y ?? ny);
        }

        // Build the clamped newCenter and scale allocations to match the *actual* clamped move distance.
        const cc = tokenCenterFromTopLeft(nx, ny, doc);
        const actualFt = measureFtBetweenCenters(track.lastCenter, cc);
        const allocScale = (allocatedTotal > 0) ? Math.max(0, Math.min(1, actualFt / allocatedTotal)) : 1;
        for (const k of Object.keys(allocations)) allocations[k] = Number(allocations[k] ?? 0) * allocScale;

	      const pending = { mode: "move", tokenUuid, oldCenter: track.lastCenter, newCenter: cc, allocations, perSlotMax, normalPerSlotCap, moveBoostActive: canUseMoveBoost, phaseKeyId, paceInfo, phaseInfo, canDashThisLastSlot, instantAvailable, concOnCount, bmrBaseTotal, maxPaceLabelUsed };

        const t0 = _moveHudThrottle.get(tokenUuid) ?? 0;
        const now = Date.now();
        if (now - t0 > 600) {
          _moveHudThrottle.set(tokenUuid, now);
          ui.notifications.info(`Move clamped to remaining allowance.`);
        }

        setTimeout(() => {
          try {
            doc.update({ x: nx, y: ny }, { animate: false, rmuCptClamp: true, _rmuCptMovePending: pending });
          } catch (e) {
            console.error(`${MODULE_ID} | clamp update failed`, e);
          }
        }, 0);

        return false;
      }

      // Normal (non-clamped) move; commit in updateToken.
	      options._rmuCptMovePending = { mode: "move", tokenUuid, oldCenter: track.lastCenter, newCenter, allocations, perSlotMax, normalPerSlotCap, moveBoostActive: canUseMoveBoost, phaseKeyId, paceInfo, phaseInfo, canDashThisLastSlot, instantAvailable, concOnCount, bmrBaseTotal, maxPaceLabelUsed };
      return;
    }

    // === MODE B: Incidental movement (non-move action selected) ===
    // Cap is Run by default, unless a lower cap (load, double concentration, etc.) applies.
    const capPace = computeIncidentalCapPace({ defaultCap: "Run", loadMaxPaceLabel: paceInfo?.maxPaceLabel, concOnCount });
    const bmrEffective = (concOnCount === 1) ? (rawBmr * 0.5) : rawBmr;
    const capFt = Math.max(0, bmrEffective * phasePaceCapFrac(capPace));

    const incKey = `i${phaseInfo.round}p${currentInternalStart}-${currentInternalEnd}`;
    const usedBefore = Number(track?.usedBySlot?.[incKey] ?? 0);
    const remaining = capFt - usedBefore;

    if (!(capFt > 0) || remaining <= MOVE_EPS_FT) {
      warnMoveOnce(tokenUuid, "cap-phase", `Move blocked: phase movement cap reached.`);
      return false;
    }

    const allowed = Math.min(segmentFt, Math.max(0, remaining));
    const overflow = Math.max(0, segmentFt - allowed);

    if (allowed <= 1e-6) {
      warnMoveOnce(tokenUuid, "cap-phase", `Move blocked: phase movement cap reached.`);
      return false;
    }

    const allocations = { [incKey]: allowed };
    const perSlotMax = { [incKey]: capFt };

    if (overflow > MOVE_EPS_FT) {
      const scale = (segmentFt > 0) ? (allowed / segmentFt) : 0;

      const oldX = Number(doc.x ?? 0);
      const oldY = Number(doc.y ?? 0);
      const tgtX = (typeof change.x === "number") ? change.x : oldX;
      const tgtY = (typeof change.y === "number") ? change.y : oldY;

      let nx = oldX + (tgtX - oldX) * scale;
      let ny = oldY + (tgtY - oldY) * scale;

      const gridType = canvas?.scene?.grid?.type;
      const isGridless = (gridType === 0);
      if (!isGridless && canvas?.grid?.getSnappedPosition) {
        const snapped = canvas.grid.getSnappedPosition(nx, ny, doc.width ?? 1);
        nx = Array.isArray(snapped) ? snapped[0] : (snapped?.x ?? nx);
        ny = Array.isArray(snapped) ? snapped[1] : (snapped?.y ?? ny);
      }

      const cc = tokenCenterFromTopLeft(nx, ny, doc);
      const actualFt = measureFtBetweenCenters(track.lastCenter, cc);
      allocations[incKey] = Math.max(0, Math.min(allowed, actualFt));

      const pending = { mode: "incidental", tokenUuid, oldCenter: track.lastCenter, newCenter: cc, allocations, perSlotMax, paceInfo, phaseInfo, concOnCount, capPace, bmrEffective, incKey };

      setTimeout(() => {
        try {
          doc.update({ x: nx, y: ny }, { animate: false, rmuCptClamp: true, _rmuCptMovePending: pending });
        } catch (e) {
          console.error(`${MODULE_ID} | incidental clamp update failed`, e);
        }
      }, 0);

      return false;
    }

    options._rmuCptMovePending = { mode: "incidental", tokenUuid, oldCenter: track.lastCenter, newCenter, allocations, perSlotMax, paceInfo, phaseInfo, concOnCount, capPace, bmrEffective, incKey };
  } catch (e) {
    console.error(`${MODULE_ID} | movement preUpdateToken error`, e);
  }
});

Hooks.on("updateToken", (doc, change, options, userId) => {
  try {
    const pending = options?._rmuCptMovePending;
    if (!pending) return;
    if (!canvas?.ready) return;

    const token = canvas.tokens?.get(doc.id);
    if (!token) return;

    const tokenUuid = pending.tokenUuid ?? getTokenUuid(doc);
    const track = _moveTrack.get(tokenUuid);
    if (!track) return;

    // Apply allocations.
    for (const [k, v] of Object.entries(pending.allocations ?? {})) {
      track.usedBySlot[k] = Number(track.usedBySlot[k] ?? 0) + Number(v ?? 0);
    }

    // Note: The 1.25x Move-BMR boost can be used in multiple phases, as long as the eligibility rules
    // are met (light load + prior phase moved >= 1/2 effective BMR). We do not enforce a "no chaining"
    // lockout once the actor exceeds normal BMR.

    // Update last center (we no longer draw a movement line).
    const a = pending.oldCenter;
    const b = pending.newCenter;
    track.lastCenter = { x: b.x, y: b.y };
    track.points.push({ x: b.x, y: b.y });

    // Build HUD text (throttled).
    const now = Date.now();
    const last = _moveHudThrottle.get(tokenUuid) ?? 0;
    const mode = String(pending.mode ?? "move");
    const { phaseInfo, perSlotMax, paceInfo, concOnCount } = pending;

    const allocKeys = Object.keys(pending.allocations ?? {});
    const groupUsed = allocKeys.reduce((s, k) => s + Number(track.usedBySlot?.[k] ?? 0), 0);
    const groupCap = allocKeys.reduce((s, k) => s + Number((perSlotMax && typeof perSlotMax === "object") ? (perSlotMax[k] ?? 0) : (perSlotMax ?? 0)), 0);

    if (mode === "incidental") {
      const incKey = String(pending.incKey ?? allocKeys[0] ?? "");
      const bmrEffective = Number(pending.bmrEffective ?? 0);
      const capPace = String(pending.capPace ?? "Run");

      const usedHere = Number(track.usedBySlot?.[incKey] ?? groupUsed);
      const capHere = (perSlotMax && typeof perSlotMax === "object") ? Number(perSlotMax?.[incKey] ?? groupCap) : Number(groupCap);

      const inf = inferPhasePacePenalty(usedHere, bmrEffective, capPace);

      // Show a small pace label over the token while it moves.
      showTokenPaceLabel(token, inf.pace, 900);

      const penaltyHtml = (inf.penalty !== 0)
        ? `<span style="color:#ff4040; font-weight:800;">${escapeHtml(inf.penaltyText)}</span>`
        : `—`;

      if (now - last > 120) {
        _moveHudThrottle.set(tokenUuid, now);

        const html = `
          <div style="font-weight:700; margin-bottom:4px;">Movement</div>
          <div><b>Actor:</b> ${escapeHtml(doc.actor?.name ?? "—")}</div>
          <div><b>Round:</b> ${Number(phaseInfo?.round ?? 1)} <b>Phase slot:</b> ${escapeHtml(String(phaseInfo?.phase ?? "—"))}</div>
          <div><b>Segment:</b> +${Number(measureFtBetweenCenters(a,b)).toFixed(1)} ft</div>
          <div><b>Move allowance (this phase):</b> ${usedHere.toFixed(1)} / ${capHere.toFixed(1)} ft <span style="opacity:0.85;">(remaining ${(Math.max(0, capHere - usedHere)).toFixed(1)} ft)</span></div>
          <div><b>Pace (this phase):</b> ${escapeHtml(inf.pace)} <span style="opacity:0.85;">(cap ${escapeHtml(capPace)})</span></div>
          <div><b>Penalty:</b> ${penaltyHtml}</div>
          <div style="opacity:0.85;"><b>Load cap:</b> ${escapeHtml(String(paceInfo?.maxPaceLabel ?? "—"))}${(concOnCount === 1) ? ` • <b>Concentration:</b> single` : (concOnCount >= 2) ? ` • <b>Concentration:</b> double` : ""}</div>
        `;
        showMoveHud(html, 1750);
      }
    } else {
	      const { canDashThisLastSlot, bmrBaseTotal, maxPaceLabelUsed, instantAvailable } = pending;
      const roundTotal = getRoundTotal(track, phaseInfo?.round ?? 1);

      // Pace is inferred from the round TOTAL, averaged across used Move slots this round.
      // Dash is only considered in the final internal phase slot when the instantaneous selector is still available.
      // BMR base value used for pace multipliers (do NOT scale by phase-count per user rule).
      const bmrBase = Number(bmrBaseTotal ?? paceInfo?.bmrPerPhase ?? 0);
      const dashOkTotal = Boolean((concOnCount < 2) && instantAvailable && isLightLoadAtMost15(doc.actor));
      const inferred = inferPaceFromBmrTable(roundTotal, bmrBase, dashOkTotal, (maxPaceLabelUsed ?? paceInfo?.maxPaceLabel));

      // Show a small pace label over the token while it moves.
      showTokenPaceLabel(token, inferred.pace, 900);

      if (now - last > 120) {
        _moveHudThrottle.set(tokenUuid, now);

        const html = `
          <div style="font-weight:700; margin-bottom:4px;">Movement</div>
          <div><b>Actor:</b> ${escapeHtml(doc.actor?.name ?? "—")}</div>
          <div><b>Round:</b> ${Number(phaseInfo?.round ?? 1)} <b>Phase slot:</b> ${escapeHtml(String(phaseInfo?.phase ?? "—"))}</div>
          <div><b>Segment:</b> +${Number(measureFtBetweenCenters(a,b)).toFixed(1)} ft</div>
          <div><b>Move allowance (current phase group):</b> ${groupUsed.toFixed(1)} / ${groupCap.toFixed(1)} ft <span style="opacity:0.85;">(remaining ${(Math.max(0, groupCap - groupUsed)).toFixed(1)} ft)</span></div>
          <div><b>Total this round:</b> ${roundTotal.toFixed(1)} ft</div>
          <div><b>Pace (inferred):</b> ${escapeHtml(inferred.pace)}</div>
          <div style="opacity:0.85;"><b>Movement option:</b> ${escapeHtml(paceInfo?.optionLabel ?? "—")}${(maxPaceLabelUsed ?? paceInfo?.maxPaceLabel) ? ` • <b>Max pace:</b> ${escapeHtml(String(maxPaceLabelUsed ?? paceInfo?.maxPaceLabel))}` : ""}${(concOnCount === 1) ? ` • <b>Concentration:</b> single` : (concOnCount >= 2) ? ` • <b>Concentration:</b> double` : ""}</div>
        `;
        showMoveHud(html, 1750);
      }
    }
// Live-update the tracker UI overlays during drag (token position changes are not committed until drop).
try { requestAppRefresh(); } catch (_) {}

// Once we receive a committed token update, any drag preview should be cleared.
try { _movePreview.delete(tokenUuid); } catch (_) {}

  } catch (e) {
    console.error(`${MODULE_ID} | movement updateToken error`, e);
  }
});

// When combat advances, clear local movement paths so each phase starts clean.
Hooks.on("combatTurn", (combat, update, options, userId) => {
  try {
    // Keep per-slot distance totals, but force a fresh origin/line for the next phase slot.
    for (const [tokenUuid, tr] of _moveTrack.entries()) {
      tr.phaseKey = null;
      tr.lastCenter = null;
      tr.points = [];
      clearMoveTrail(tokenUuid);
    }
    for (const g of _moveGraphics.values()) {
      try { g.clear(); } catch (_) {}
    }

    // Hide any over-token pace labels between phases.
    for (const t of _movePaceLabel.values()) {
      try { t.visible = false; } catch (_) {}
    }
  } catch (_) {}
});

Hooks.on("deleteCombat", () => {
  try {
    _moveTrack.clear();
    for (const g of _moveGraphics.values()) {
      try { g.destroy?.({ children: true }); } catch (_) {}
    }
    _moveGraphics.clear();

    clearAllTokenPaceLabels();
  } catch (_) {}
});

