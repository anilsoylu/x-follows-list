# X Following Checker

A Chrome extension that highlights accounts you follow but who don't follow you back, on your own `/following` page (`x.com/@you/following`).

It only runs when you press **▶ Start**. When you press stop (or leave the page), everything is torn down — no RAM or CPU used while idle.

## Install

> **Chrome only, v110+** (Firefox/Safari are not supported — this extension uses Chrome's MV3 service-worker background model).

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder

## Usage

1. Open your `/following` page on X
2. Click the extension icon → **▶ Start**
3. Scroll down; the panel tracks as you go. Accounts that don't follow you back are outlined in red.

Modes (in the popup):

| Mode | What it does |
|---|---|
| Red mark | Outlines non-followers |
| Dim | Fades people who follow you back |
| Only non-followers | Hides everyone else |
| Off | Count only, no marking |

Panel buttons:

- **Next** — jumps to the next non-follower below your view
- **Clean** — unfollows every non-follower, one by one (with pauses)
- **List / CSV / Close** — list panel, CSV export, stop everything

## Ignore list

Each row has a **Ø Ignore** button next to Following. Ignored accounts:

- are stored in IndexedDB (survives restarts)
- are skipped when unfollowing
- are excluded from the count, list and CSV

Manage the list from the panel ("Ignore list" section) or the popup — add, remove, or clear all.

## Notes

- Unfollowing in bulk can look automated to X; use it in small sessions at a casual pace.
- Badges load lazily, so scroll slowly or re-check a row if a red mark looks uncertain.
- The extension reads the DOM and clicks buttons you could click yourself. Nothing is sent anywhere.
- If X changes its UI (`data-testid` names), the selectors may need updating.
