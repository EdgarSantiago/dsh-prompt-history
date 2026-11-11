# Prompt history for DeepSeek Harness

Find and reuse previous prompts in the Harness composer without sending them automatically.

## Plugin submission

The sections below follow the [dsh-plugin.org submission template](https://dsh-plugin.org/submit). This is an independent plugin, not an official DeepSeek product.

### Repository

[EdgarSantiago/dsh-prompt-history](https://github.com/EdgarSantiago/dsh-prompt-history)

Public source repository maintained by [EdgarSantiago](https://github.com/EdgarSantiago). Package: `@local/dsh-prompt-history`, version `0.1.9`. The existing package and Slot identifiers are retained for compatibility with local installations.

### One-line value

Adds searchable human-prompt history to Harness so you can copy or reuse previous text in the composer without sending it automatically.

### Category

**Sessions & Messages**

### Install command

Requires **DeepSeek Harness `0.2.2-rc.1`** and **Node.js 18+**. Choose the profile you use:

**Desktop**

```sh
dsh plugin --profile desktop add github:EdgarSantiago/dsh-prompt-history
```

**Web**

```sh
dsh plugin --profile web add github:EdgarSantiago/dsh-prompt-history
```

The repository includes the prebuilt Client. Follow the plugin manager's application/reload guidance; do not edit profile manifests manually.

This is a **GitHub-only source release**, not an npm release. The `private: true` flag prevents accidental npm publication; it does not prevent installation from GitHub. Existing local links remain valid. To replace a local installation with the GitHub source, remove the existing bundle through the plugin manager first.

### Compatibility

| Item | Declared compatibility |
| --- | --- |
| DeepSeek Harness | `0.2.2-rc.1` |
| Profiles | Web and Desktop |
| Runtime | Node.js 18+ |
| Browser | Modern browser with Popover API support |
| Languages | English and Portuguese, following Harness |
| Verified platform | macOS; other platforms have not been visually certified |

The interface uses native Slots and Harness's React, without an iframe or a separate React installation. Other Harness versions are not declared compatible.

### License

[MIT](./LICENSE). The icon was originally drawn for this plugin.

### Screenshots / demo

![Prompt history open, with the composer toolbar's history button outlined in red](./docs/images/prompt-history-overview.png)

*Actual plugin screenshot. The red outline marks the history launcher in the composer toolbar. The screenshot was cropped to highlight the panel and composer; the outline is an annotation only.*

### Notes

#### Usage

1. Click the **clock button outlined in red** in the screenshot.
2. Keep **This conversation**, or select **Recent conversations**.
3. Search the loaded text. Prompts are grouped by local day using **Today**, **Yesterday**, or a short date; each entry displays only its time.
4. Select **Reuse** to fill the composer, or the copy icon to copy the text.
5. Use **⋯** to expand/collapse the text or open the original conversation. Review the content before sending.

History opens above the composer and closes when you click or tap outside the panel and clock button. The outside interaction keeps its action and focus without changing the draft. In the current-conversation filter, the conversation appears once above the list; in recent-conversation results, each entry identifies its source. **Refresh** reloads history, and **Load more conversations** extends the loaded set.

#### Permissions and privacy

- **Read access:** only committed human messages and conversation projections permitted by native Harness endpoints. Drafts, model responses, tool results, injections, and automated tasks are excluded.
- **Write access:** fills only the local draft after an explicit action; does not modify sent messages. Replacing an existing draft requires confirmation, and concurrent draft revisions are preserved.
- **Clipboard:** copies text only when you click the copy button.
- **Storage:** uses the Harness log and projection cache, without a separate prompt database or history stored in localStorage.
- **External services:** adds no external integrations or AI calls. Opening, searching, and reusing history do not call a model; sending a message afterward remains a normal Harness action.
- **Inactive sessions:** reading history does not start an Agent or silently migrate conversations. Read failures appear as warnings, never as a successful empty history.

> **Reuse does not send messages, execute commands, or restore attachments or references.** Sensitive information remains part of a saved prompt: review it before copying, sending, or including it in a screenshot.

#### Known limits

- Up to **60 prompts** and **262,144 characters** per conversation.
- Recent-conversation browsing initially reads up to **10 conversations**, with a maximum of **50 accessible conversations**, prioritizing the current one and then recent activity. The current-conversation filter does not read other conversations.
- Search is local, literal, and case/accent insensitive, covering **only loaded text**, not the entire archive.
- Prompts exceeding **32,768 characters** are incomplete previews: copy/reuse is disabled; open the original conversation for the full text.
- Drafts containing attachments or references are not replaced. Text beginning with `!` or containing editor reference markers requires copying and review to avoid accidental execution or interpretation.
- Subagents are excluded. Ordinary forks are included without repeating their inherited prefix.

#### Keyboard and accessibility

| Action | Shortcut/behavior |
| --- | --- |
| Focus search | `Ctrl/⌘ K`, while focus is inside the panel |
| Close the panel or cancel confirmation | `Escape` |
| Navigate the **⋯** menu | Arrow keys, `Home`, and `End` |
| Close the menu | `Escape`, returning focus to its button |

Icon buttons have accessible names, focus is visible, actions reflow in narrow panels, and animations respect `prefers-reduced-motion`.

#### Development

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run check
pnpm test
```

For a local development installation, run `dsh plugin --profile desktop add "$(pwd)"` from the project root after building (or use `--profile web`). Manage updates through the Harness plugin manager.

The Client is bundled with esbuild; there is no install script. Tests use Node's built-in runner, synthetic data, real Date/Intl, and real Cordis Context/Service instances. They cover human sources, bounds, ACLs, cancellation, draft confirmation, local dates, year boundaries, daylight-saving transitions, and outside-pointer dismissal. Contract tests do not replace interaction checks in Harness.

### Pre-submission checklist

- [x] Repository is public.
- [x] GitHub topic `dsh-plugin` added.
- [x] README includes the install command.
- [x] Plugin exports an `apply(ctx)` module.
- [x] Repository root includes a `package.json`.

**Website vs. Plugin Hub:** according to the [listing requirements](https://dsh-plugin.org/submit), a public repository with the `dsh-plugin` topic can be indexed on the website without npm. The **Plugin Hub inside DSH** additionally requires an installable npm package. Source publication does not imply catalog listing or completed community verification; neither is claimed here.
