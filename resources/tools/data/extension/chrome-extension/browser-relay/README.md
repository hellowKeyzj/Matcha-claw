# MatchaClaw Browser Relay — Chrome Extension

Connect MatchaClaw to your Chrome browser through an encrypted local CDP relay.

## Installation

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked**, then select this folder (the one containing `manifest.json`).
3. Pin the extension to the toolbar.

## Usage

1. Start MatchaClaw with browser control enabled.
2. Open the extension popup and enable the relay. A green dot means the encrypted connection is ready; yellow means it is connecting.
3. Click **Use This Window** for the window you want MatchaClaw to control.
4. Keep the intended page active in that window, then ask MatchaClaw to use the browser.

Each extension connection identifies one Chrome profile with a `browserInstanceId`. MatchaClaw persists the selected browser and window. Without an explicit `targetId`, commands use the selected window's current attached page; they fail rather than guessing another page when no current page is available. Opening or focusing a target brings that page forward.

Only tabs created by the agent may be closed by the agent. Retained tabs and existing user tabs are protected, including when agent groups are cleaned up. Retained tabs have no count limit.

## Permissions

- `debugger`, `tabs`, `windows`, `activeTab`: attach CDP and manage the selected browser pages.
- `scripting`, `<all_urls>`: run page interaction commands on ordinary web pages.
- `cookies`: read and update cookies through the local relay.
- `tabGroups`, `favicon`: group agent-created tabs and display control indicators.
- `downloads`: observe Chrome download events and recover download status for a relay download watch.
- `webNavigation`: identify pages opened by an attached page so their opener relationship remains correct.
- `storage`, `alarms`, `notifications`: persist settings, reconnect after disconnection, and report connection errors.

The extension does not expose an external website bridge or install website-specific content scripts.

## Status and troubleshooting

| Indicator | Meaning |
|-----------|---------|
| Green dot | Encrypted relay connection is ready |
| Yellow dot | Connecting or reconnecting to the local relay |
| No dot | Relay is disabled |

If the dot stays yellow, verify that MatchaClaw is running with browser control enabled. Internal browser pages such as `chrome://` and extension pages cannot be controlled; use an ordinary web page. Connection errors appear in the popup.

The popup is the browser-control entry point: relay status and toggle, window selection, and tab actions. The options page contains control-port settings, CDP logs, and help, without a second live status or tab list. The default control port is `9234`; the relay port is the control port plus `2` (`9236` by default).

## Source layout

- `background.js`: service-worker lifecycle, execution-window selection, and page messages.
- `lib/cdp/relay/`: encrypted relay connection and error state.
- `lib/cdp/tabs/`: discovery, attachment, ownership, groups, and session indicators.
- `lib/cdp/commands/`, `lib/cdp/events/`: command dispatch and CDP event forwarding.
- `lib/content_script/`: programmatically injected page interaction commands.
- `lib/downloads/`: Chrome-backed download tracking.
- `pages/`: MatchaClaw popup, options, and installation guides.
- `icons/`: extension icons.
