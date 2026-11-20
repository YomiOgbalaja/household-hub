# Household Hub

A two-person household money app: bills, debts, payments, a 12-month plan, settle-up, actions and joint decisions. It works on phones (add it to the home screen) and on desktop. Every input happens in the app, and everything exports to Excel.

## What is here

| File | Purpose |
|---|---|
| `index.html` | The page |
| `styles.css` | Light theme; phone layout with a bottom tab bar, desktop layout with a side menu |
| `app.js` | Data, calculations, screens, forms, Excel and JSON import and export |
| `more.js` | Pay schedules, per-paycheck emails, calendar files, My view, statements, activity |
| `agree.js` | Miscellaneous costs and the two-signature responsibility agreement |
| `manifest.webmanifest`, `icon*.png`, `icon.svg` | Install to the home screen |
| `sw.js` | Offline cache. Bump `VERSION` in it on every release so phones pick up the new files |

No build step and no dependencies to install. The Excel library (SheetJS 0.18.5) loads from cdnjs only when you import or export.

## Hosting

It is a static site, so any static host works: Vercel, Netlify, Cloudflare Pages or GitHub Pages. Upload this folder as the site root. It needs HTTPS for install and offline use (every one of those hosts provides it).

- Vercel: `vercel deploy` from this folder, or drag the folder into the dashboard.
- Netlify: drag the folder onto app.netlify.com/drop.

On a phone, open the site, then use Share → Add to Home Screen (iPhone) or Install app (Android).

## Where the data lives

On each device, in the browser's local storage. Nothing is sent to any server, including the host.

- **Export to Excel**: a full workbook with Summary, Bills, Debts, Payments, Plan, Settle Up, Actions, Decisions, Cash Flow, Accounts and Settings.
- **Backup file (.json)**: an exact copy of everything.
- **Import** accepts either of those, or the original Household Finance Hub workbook (the one-time migration).

Because each device keeps its own copy, two people sharing one household should pick one device as the main one, or pass the export back and forth. Live sync between two phones needs a small backend with sign-in; `load()` and `save()` in `app.js` are the only two functions that touch storage, so that is where it would plug in.

## How the numbers work

- **Bills** repeat by frequency from their due day, or from the first due date for annual, semi-annual and one-time bills.
- **Debts** are scheduled at the monthly payment from the balance date onward. Balance today = balance minus counted payments made on or after the balance date.
- **Payments** count straight away unless they are not Scheduled and at or above the approval amount. Those need both partners to approve. A No from either partner means the payment never counts.
- **Miscellaneous costs** are one-off or manual entries outside the bill list. They count in the plan, each person's share and settle up. Shared ones, or ones paid for the other person, at or above the approval amount need both approvals.
- **Responsibility changes bind only when both sign.** Adding or removing a bill or debt, or changing its owner, share, amount, frequency or due day, the split, the shared default, the approval amount or the written agreements creates a proposal. Each partner signs by typing their name. Until both have signed, the current terms stay in force and the proposal is left out of every total. Either partner can decline, and the proposer can withdraw. The JSON backup keeps open proposals; the Excel export lists them on the Agreement tab.
- **Settle up** compares each person's payments with their fair share of everything that was paid that month. Fair share follows the split: By owner, By income or 50/50. Joint payments count half each, and transfers between partners move the balance.
