# memtro

A coding agent in your terminal, with your company's memory and connected systems behind it.

```bash
curl -fsSL https://raw.githubusercontent.com/memtro-org/memtro-cli/main/install.sh | sh
cd your-repo
memtro
```

`memtro` opens a session in the current directory; the first time, it signs you in through your browser (see [Signing in](#signing-in)). You say what you want; the agent reads the code, edits files and runs commands here, on this computer, and asks you before anything it is not sure of. It can also search what your organisation knows (decisions, tickets, conversations) and, if you allow it, act in the systems your organisation has connected to Memtro. The model runs on Memtro; the tools run here.

For one task with nobody watching:

```bash
memtro run "make the failing test in src/cart pass"
memtro -p "summarise what changed in the last 10 commits"
git diff | memtro run "review this"
memtro run --json "…" | jq        # one event per line
```

`memtro run` asks nobody anything: a call that would need your approval is refused, and the model is told which flag would have allowed it. The answer goes to stdout, the tool lines to stderr. Exit code 0 when the agent finished, 1 when it failed or stopped at a limit, 3 when it is not signed in or the key was refused at the start, 4 when Memtro could not be reached, 130 when interrupted.

The older one-shot commands (`ask`, `search`, `remember`, `why`, `tools`, `call`) are all still here; see [Commands](#commands).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/memtro-org/memtro-cli/main/install.sh | sh
```

This installs one standalone executable, `memtro`, in `~/.memtro/bin`. It needs no Node.js. It runs on macOS (Apple silicon and Intel) and on Linux with glibc (x86_64 and arm64). On Windows, run it inside [WSL](https://learn.microsoft.com/windows/wsl/install). Alpine and other musl-based Linux are not supported yet: the script says so and stops.

What the script does, in order:

1. It works out your system and processor. An Intel shell on Apple silicon still gets the Apple silicon build.
2. It downloads the build for your system, plus `checksums.txt`, from the same [GitHub release](https://github.com/memtro-org/memtro-cli/releases). It uses HTTPS only.
3. It checks the download's SHA-256 against `checksums.txt`. If the sums differ, or if neither `sha256sum` nor `shasum` is installed, it stops and installs nothing.
4. It runs the new `memtro --version` to prove it starts, then moves it into place in one step. An install that fails partway leaves any earlier one as it was.

It never uses `sudo` and never asks a question. It changes nothing outside the install directory, so your shell's startup file is left alone. If the directory is not on your `PATH`, it prints the line to add for your shell (zsh, bash, fish or sh).

| Variable | Effect |
|---|---|
| `MEMTRO_VERSION=0.2.0` | Install this version (`0.2.0` or `v0.2.0`) instead of the latest. |
| `MEMTRO_INSTALL_DIR=/path/bin` | Install here instead of `~/.memtro/bin`. |
| `MEMTRO_MODIFY_PATH=1` | Add the directory to `PATH` in your shell's startup file (`~/.zshrc`, `~/.bashrc` or `~/.bash_profile` on macOS, `~/.config/fish/config.fish`, or `~/.profile`). It is added once; running the script again does not add it twice. The script says which file it changed. |

```bash
curl -fsSL https://raw.githubusercontent.com/memtro-org/memtro-cli/main/install.sh | MEMTRO_VERSION=0.2.0 MEMTRO_MODIFY_PATH=1 sh
```

To read the script before you run it, download it first: `curl -fsSL -o install.sh https://raw.githubusercontent.com/memtro-org/memtro-cli/main/install.sh`. Each release's builds also carry a GitHub build-provenance attestation. Check one with `gh attestation verify memtro-darwin-arm64.tar.gz -R memtro-org/memtro-cli`.

On macOS, the first start after an install or update takes a second or two while the system checks the new file. After that it starts in about 40 ms.

### From source

With Node.js 20 or later:

```bash
git clone https://github.com/memtro-org/memtro-cli && cd memtro-cli
npm ci && npm run build && npm link     # `memtro` now runs dist/main.js
```

To build the standalone executable for this computer, use Node.js 24: `npm run bundle && npm run build:sea`. That writes `build/memtro-<os>-<arch>` and its tarball.

## Update

In a session, type `/update`. Outside one, run `memtro update`. To pick a version, use `memtro update --version 0.3.0`. Either way, memtro downloads the release for your system, checks its SHA-256 against the release's `checksums.txt` and proves the new file starts. Then it swaps the new file in. The running copy carries on; the new version starts the next time you run `memtro`. If anything fails, the installed file is left exactly as it was.

The update check sends no key, no cookie and nothing from your Memtro profile. It is a plain request to GitHub, made at most once a day at the start of an interactive session. It never delays start-up. When a newer version exists, the next session says so in one line. To turn the check off, set `MEMTRO_NO_UPDATE_CHECK=1`, or put `"updateCheck": false` in `config.json`. It is also off when `CI` is set. `/update` works either way.

`memtro update` only replaces the standalone executable (the one the install script installs), and only in a directory you can write to that other users cannot, and never inside `node_modules`, Homebrew, Nix, a snap, or a system directory (`/usr`, `/bin`, `/sbin`, `/opt`). If you installed with npm, update with `npm install -g @memtro/cli@latest`. For a copy anywhere else, update it the way you installed it, or run the install script again.

## Uninstall

```bash
rm -rf ~/.memtro                                         # the executable (or your MEMTRO_INSTALL_DIR)
rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/memtro"        # settings and, when not in the system keychain, the key
rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/memtro"    # saved sessions and the update check's note
```

Run `memtro logout` first if you want the key revoked on Memtro and removed from the macOS Keychain or the Secret Service. If you used `MEMTRO_MODIFY_PATH=1`, remove the `# memtro` lines from your shell's startup file.

## The session

| Key or command | What it does |
|---|---|
| Enter | Send. End a line with `\` to carry on onto the next; pasted text keeps its lines. |
| Esc or Ctrl-C while it works | Stop the turn. Every tool call it had asked for gets a result saying so, and the session carries on. Ctrl-C twice within two seconds leaves. |
| Ctrl-C at the prompt | Clear what you typed; twice leaves. Ctrl-D leaves too. |
| `/model [id]` | List the models your account offers, or switch. |
| `/mode ask` / `/mode auto` | How much you are asked (below). |
| `/actions on` / `off` | Let Memtro's tools change connected systems, or stop them. Off by default. |
| `/new`, `/resume` | Start a new session, or carry on one of this directory's earlier ones. |
| `/compact` | Summarise the older part of the conversation now (it also happens on its own near the model's context limit, when the limit is known). |
| `/login` | Sign in again, perhaps as somebody else; the conversation carries on with the new key. |
| `/logout` | Revoke this computer's key, remove it, and end the session. |
| `/update` | Update memtro to the latest release; it starts the next time you run memtro. |
| `/tools`, `/whoami`, `/help`, `/quit` | |

When a newer release is known, the session's first lines say so ("memtro 0.3.0 is available (you have 0.2.0). Type /update."). That comes from the answer of the last check, kept on disk; a new check runs in the background, at most once a day, never delays start-up and prints nothing. It asks GitHub for the latest release and sends nothing about you or your key. `MEMTRO_NO_UPDATE_CHECK=1`, or `"updateCheck": false` in `config.json`, turns the line off; `/update` still works. It is never shown in `memtro run`, with `--json`, or when stdout is not a terminal.

After each turn one line says which model answered, the tokens the turn used, how much of the context window is in use, and the mode.

Options: `--model <id>`, `--mode ask|auto`, `--continue` (this directory's latest session), `--resume [<id>]`, `--actions`, `--no-classifier`, `--allow-edits`, `--allow "<command prefix>"` (repeatable), `--unchecked`, plus the usual `--profile`, `--base-url`, `--no-browser`, `--verbose`, `--json` (for `run`). The same settings can live in `config.json` beside `profiles`:

```json
{ "mode": "auto", "classifier": { "model": "anthropic/claude-haiku-4-5-20251001", "enabled": true }, "actions": false, "updateCheck": true }
```

## Safety

Read this before you use it on anything you care about.

**There is no sandbox.** Commands run as you, with your account's permissions, in the directory you started in. A command the agent runs can do anything you could do from that shell.

**What is checked.** Every tool call goes through a gate before it runs, in this order, and a later step can never loosen an earlier one:

1. With `--unchecked`, everything runs. Nothing below applies. It prints a warning every time it starts.
2. **Always asked**, whatever the mode, whatever you allowed earlier in the session and whatever the safety check thinks: the list below. Allowing one of these is offered once only, never "for this session".
3. Reading files inside the repository (the git top level, or the directory you started in) and reading from Memtro just happen. Not when that "repository" is your home directory or above it: then nothing counts as inside a project, and the start-up line says so.
4. Something you allowed earlier "for this session" runs.
5. In `ask` mode, every edit, command and remote action is put to you.
6. In `auto` mode (the default), edits inside the repository and a short list of read-only commands (below) run without asking. Everything else (other commands, edits or reads outside the repository, actions in connected systems) is judged by the **safety check**: a separate call to a model, which answers allow, ask or block. Its doubts are put to you; a block is refused and the model is told why.
7. If the safety check is off, times out (8 seconds), fails, or answers anything other than a clean verdict, the call is **put to you**. It fails closed to asking, never to running.

**What the safety check sees.** What you have typed in this session (the most recent last, capped), the working directory and whether it is a git repository, the titles of earlier calls this turn, and the pending call: tool, kind, title, the command in full, the paths, and the diff (capped). It never sees tool results or the model's own words, so a file or web page cannot argue its case to it. Everything quoted to it is marked as data, and titles (which the agent writes, including a command's description) are marked as the agent's words, not the person's. If any part of the pending call had to be cut to fit, an "allow" is turned into a question for you. It runs on the cheapest model your account lists that it recognises; under your organisation's routing lock that is your organisation's default model, and an administrator can allow explicit models so a small one is used. `classifier.model` in `config.json` picks one; `--no-classifier` or `classifier.enabled: false` turns it off, and then `auto` behaves exactly like `ask`.

**When you are asked**, you see the command in full, never shortened, with every control character and escape sequence shown rather than obeyed, so a command cannot hide part of itself or redraw the prompt; the diff for an edit; and why you are being asked and by what. One key answers: `y` once, `a` for the rest of the session (only when offered, and the prompt says what it would cover, such as "any `npm test …`"; the limits on a prefix are below), `n` no, `e` no with a note the model reads. Enter is not yes, pasted text does not answer, and keys typed before the prompt appeared are ignored.

**Everything the model or a tool prints** is cleaned before it reaches your terminal: escape sequences are made visible, so a file's contents cannot move the cursor, set the window title or write to your clipboard.

<!-- gate-lists -->
**Always asked.** For a command, the text is scanned in several spellings (as written; without quotes and backslashes; with `~`, `$HOME` and `${HOME}` replaced by your home directory; with `$`, braces, parentheses and backticks squeezed out), looking for a word anywhere rather than parsing the command, so a false alarm costs one question:

- running as another user: `sudo`, `doas`, `pkexec`, `run0`, `su`;
- downloading and running: `curl`, `wget`, `fetch`, `aria2c`, `iwr`, `irm`, `Invoke-WebRequest` or `Invoke-RestMethod` in the same command as a shell or interpreter (`sh`, `bash`, `zsh`, `dash`, `ksh`, `fish`, `csh`, `tcsh`, `python…`, `node`, `deno`, `bun`, `perl`, `ruby`, `php`, `lua`, `pwsh`, `powershell`, `iex`, `source`, `eval`, `osascript`); and anything piped into a shell (`… | sh`, `… | sudo bash`);
- git: a push that may force or delete (`--force`, `--force-with-lease`, `--force-if-includes`, `--mirror`, `--delete`, `--prune`, a short flag with `f` or `d`, `+ref`, `:ref`); history rewriting (`filter-branch`, `filter-repo`, `bfg`); `.git/hooks`, `.git/config`, `hooksPath`, `fsmonitor`, `sshCommand`; and `git config` that sets anything (reading with `--get…`, `--list`, `-l`, `get`, `list` is not asked about);
- credentials: `memtro token`; commands that print a stored credential (`auth token`, `print-access-token`, `print-identity-token`, `get-login-password`, `get-session-token`, `configure get`, `configure export-credentials`); keychains and secret tools (`find-generic-password`, `find-internet-password`, `dump-keychain`, `unlock-keychain`, `export-keychain`, `secret-tool`, `cmdkey`, `vaultcmd`, `*.keychain`, `*.keychain-db`, `Library/Keychains`); private key names (`id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, and wildcards over `id_*`); `.env`, `.envrc`, `.env.*`;
- the environment: `printenv`, `env`, `set`, `export`, `export -p`, `declare -p`, `typeset`, `compgen -v` on their own, `/proc/*/environ`, and any `$VARIABLE` whose name contains `key`, `token`, `secret`, `passw`, `credential` or `auth`;
- credential stores, as any path segment: `.ssh`, `.aws`, `.gnupg`, `.netrc`, `_netrc`, `.git-credentials`, `.pgpass`, `.kube`, `.docker`, `.azure`, `.password-store`, `.npmrc`, `.pypirc`, `.vault-token`, and `.config/memtro`, `.config/gh`, `.config/gcloud`, `.local/state/memtro`, `Library/Keychains`, `.cargo/credentials`, `.cargo/credentials.toml`, `.gem/credentials`, `.terraform.d/credentials.tfrc.json`; memtro's own configuration directory, however it is spelt; and a wildcard over hidden names (`~/.ss?/…`, `.*`);
- an argument that is a symbolic link into any of these places, into `.git`, or to a shell start-up file (`cat notes.txt` where `notes.txt` leads to `~/.ssh/id_rsa`).

For `read`, `edit` and `write`, on the real path after symlinks: memtro's configuration directory, the credential stores and key and keychain names above, and a `.env*` file outside the repository. For writes also: anything inside `.git`, shell start-up files (`.bashrc`, `.bash_profile`, `.bash_login`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, `.zlogin`, `.config/fish`), `.gitconfig` and `.config/git`.

**The read-only list** (run in `auto` without asking anybody, not even the safety check). A command qualifies only when it is one line with nothing the shell would expand or redirect: no `$`, backtick, `<`, `>`, parentheses, braces, `!`, comment, `~`, background `&`, `||`, `|&`, control character, `NAME=value` prefix or unquoted wildcard (`*`, `?`, `[`). It is split on `&&`, `;` and `|`, and every part must be one of:

- `ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `file`, `stat`, `which`, `echo`, `rg`, `grep`, `find`;
- `git status`, `git diff`, `git log`, `git show`, `git rev-parse`, `git ls-files`, `git blame`, `git branch` with listing flags only (`--list`, `-l`, `-a`, `--all`, `-r`, `--remotes`, `-v`, `-vv`, `--verbose`, `--show-current`, `--color`, `--no-color`), `git remote` and `git remote -v`;
- `node`, `npm`, `pnpm`, `python`, `python3`, `go`, `cargo` or `git` with `--version` alone, and `go version`;

and not use an option that runs, writes or follows links: `find -exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint…`, `-fls`, `-L`, `-H`, `-follow`; `rg --pre…`, `--hostname-bin`, `--search-zip`/`-z`, `-L`/`--follow`; `grep -R`, `-S`, `--dereference-recursive` (and its abbreviations); `file -C`/`--compile`; `git … --output…`, `--ext-diff`, `--exec…`, or any git option before the subcommand. Every argument must stay inside the repository: no absolute path elsewhere, no `..`, and nothing that leads out of it through a symbolic link; and the working directory must be inside it. In a session whose repository is your home directory or above, nothing is on the list.
<!-- /gate-lists -->

On Windows, commands are not analysed (cmd.exe syntax), so the read-only list and command-prefix rules never match: every command goes to the safety check or to you.

**What this does not protect against.**

- It is not a sandbox (above).
- Code the agent writes into the repository can then be run by a command you allowed, such as `npm test`.
- Allowing a command prefix for the session (`npm test …`) covers further arguments after it, as long as the command stays one simple command (no `;`, `&&`, pipes, redirection or substitution), its arguments stay inside the repository (no absolute path outside it, no `..`), and none of them is a `NAME=value` or an option whose name says it runs a program, loads code or configuration, or writes output (`--script-shell`, `--upload-pack`, `--node-options`, `--config`, `--output`, `-exec`…). Within those limits it is still a prefix: `npm test` runs whatever the `test` script is now. Allowing a Memtro tool covers every operation of that tool.
- A command that assembles a path at run time can slip past the text rules; it is then judged only by the safety check, or by you.
- Copying or archiving your whole home directory (`tar czf x.tgz ~`, `rsync -a ~/ host:`) is not on the always-asked list; like any other command it is judged by the safety check, or by you.
- A symbolic link is resolved when a call is checked. A write whose path has started to lead elsewhere by the time it runs is refused; a command is not re-checked.
- Programs that use stored credentials on their own (`ssh`, `gh`, `aws`, `kubectl`, `git push`) are not detected as such.
- `.env` files inside the repository are readable without asking.
- The safety check is shown what you typed in the session (that is how it knows what you asked for), and it is a model: it can be wrong.

**What is kept on this computer.** Each session is saved as JSON lines under `${XDG_STATE_HOME:-~/.local/state}/memtro/sessions/` (`%LOCALAPPDATA%\memtro\sessions` on Windows), in a 0700 directory with 0600 files, so it can be resumed. **Those files contain the contents of files the agent read and the output of commands it ran.** If the program is stopped while a tool call is running, the saved session is still one Memtro will accept: when it is loaded again, that call is given a result saying its outcome is not known. What you type at the prompt is kept per directory in `…/memtro/history/`, also 0600; a line that starts with a space, a multi-line message, and a line holding a Memtro key are not kept. Commands the agent runs (and the `git` and `rg` it uses for searching) get your environment without `MEMTRO_API_KEY`, `MEMTRO_CREDENTIALS`, any other `MEMTRO_*` key, token or secret variable, and any variable whose value holds a Memtro key.

## Signing in

There is no login command. The first command that needs a key (`memtro`, `memtro run`, `ask`, `search`, `remember`, `why`, `tools`, `call`, `whoami`), run in a terminal with none stored, says which Memtro it is signing you in to, prints the address and opens your browser on Memtro's approval page. The page shows who you are signed in as, which organisation the key will belong to (you choose, if you are in several), and the name of this computer. Approve, and the terminal says:

```
Signed in as Ada Lovelace <ada@example.com> in Analytical Engines; this key expires on 10 Feb 2027 (in 90 days).
```

and the command carries on. Every sign-in line goes to stderr, so `memtro whoami --json` signs in and still prints only JSON on stdout.

The key belongs to that organisation and is held by you: it reads and writes the organisation's memory as you, with your connections and your permissions, and nothing more. It appears on [Dashboard → Profile → API keys](https://platform.memtro.com/dashboard/profile/keys) as `Memtro CLI (<this computer>)`, where it can be revoked like any other. After 90 days it stops working; the next session you start in a terminal says the key was refused or has expired and signs you in again, once, then carries on. The new key is stored only after that sign-in succeeds, and the old one is then revoked.

**Nobody at the terminal.** Signing in needs a person: "in a terminal" means stdin and stdout are both terminals and `CI` is not set. Piped, redirected, under another program or in CI, a command with no key (or a refused one) exits 3 with `Not signed in. Run \`memtro\` in a terminal to sign in, or set MEMTRO_API_KEY.` and opens nothing. Use `MEMTRO_API_KEY` there ([CI](#ci)). A key from `MEMTRO_API_KEY` is never replaced by signing in: if Memtro refuses it, that is exit 3 saying so.

**Signing out, or in as somebody else.** `memtro logout` (or `/logout` in a session) revokes the key on Memtro and removes it from this computer; the next command signs in again. `/login` in a session signs in again without leaving it. `memtro token`, `memtro logout`, `memtro update`, `--help` and `--version` never open a browser.

The address is always printed before the browser is asked to open it. A browser that "opened" on another desktop, or not at all, is not something the CLI can see.

**Over SSH, or anywhere without a browser**, the redirect back to this computer cannot work, so add `--no-browser` to whatever you are running:

```bash
memtro --no-browser
```

It prints the address; open it anywhere, approve, and paste the code the page shows. This is chosen automatically over SSH and on Linux with no display. The code works once, for two minutes, and only together with a secret this terminal never sent anywhere, so a code seen over somebody's shoulder is useless to them.

How it works, for anybody reviewing it: OAuth 2.0 authorization code with PKCE (RFC 7636) and a loopback redirect (RFC 8252). The CLI listens on `127.0.0.1` on a random port, answers only `GET /callback` with its own `Host`, checks `state` in constant time, and gives up after five minutes. No password and no browser cookie ever reaches it.

## Commands

| Command | What it does |
|---|---|
| `memtro` | Open a coding session in this directory (in a terminal). |
| `memtro run "<task>"` | One task, nobody asked, then exit. `--json` for one event per line. |
| `memtro logout` | Revoke the key on Memtro, then remove it from this computer. The next command signs in again. |
| `memtro whoami` | Who the key belongs to, its organisation, when it expires. Asks Memtro, so a revoked key says so. |
| `memtro ask "<question>"` | Ask; the answer streams to stdout. `--agent` for the multi-step investigation, `--model <id>` for a specific model. |
| `memtro search "<query>"` | Search memory. `--limit n` (1-100). |
| `memtro remember "<statement>"` | Save a fact, shared with the organisation; `--personal` keeps it to you. |
| `memtro why <path>` | Why a piece of code is the way it is: the pull requests, tickets, conversations and incidents behind it. `--repo owner/name` to pin the repository. |
| `memtro tools` | Every tool your key can use: Memtro's own, and one per connected system. |
| `memtro call <tool>` | Call one. `--arg key=value` sends a string, `--arg key:=<json>` a number, boolean, list or object; or `--input '<json>'`. |
| `memtro token` | Print the key, for another program. |
| `memtro update` | Update to the latest release (`--version x.y.z` for a given one); see [Update](#update). |

`memtro help <command>` for the details of each. Every command takes `--profile`, `--base-url`, `--no-browser`, `--json`, `--verbose` and `--no-color`.

### `ask`, and why it defaults to `:chat`

Memtro answers in one of two modes. `chat` is a single reply; `agent` plans, calls tools across your connected systems and comes back when it has an answer. `memtro ask` uses `auto:chat` unless you say `--agent` (`auto:agent`), because a terminal command that sometimes takes four seconds and sometimes four minutes is not a command anybody can script.

The question can come on stdin, and with a question on the command line too, stdin is attached beneath it:

```bash
git diff | memtro ask "anything here that contradicts what we decided about retries?"
memtro ask < question.md
```

Run inside a git checkout, the repository (`owner/name`, from the `origin` remote) is sent along, so memory about it is preferred over every other repository your organisation has connected. Memtro ignores a repository it has never heard of. Progress and the model's thinking go to stderr, and only when stderr is a terminal; stdout is the answer and nothing else.

### `remember`

Saved verbatim through Memtro's `memtro_remember` tool, the same one your assistants use. Write it the way you would want to read it in a year: self-contained, with names and dates. "We moved the Baltic renewal to March 2027 because their procurement freeze runs to February" is a memory; "moved to March" is not.

## Scripts and agents

Every command that returns data takes `--json` and prints exactly one JSON document on stdout. Everything else (progress, warnings, errors) goes to stderr. Colour only on a terminal, never with `NO_COLOR`.

| Exit code | Meaning | Worth retrying? |
|---|---|---|
| 0 | Done. "Nothing found" is a 0 too, said on stderr. | |
| 1 | Memtro said no, or something failed. The message says what. | No |
| 2 | The command line was wrong. Nothing was sent. | No |
| 3 | Not signed in, or the key was refused (revoked or expired). Run `memtro` in a terminal to sign in, or set `MEMTRO_API_KEY`. | No |
| 4 | Memtro could not be reached, timed out, or is unavailable. | Yes |
| 130 | Interrupted (Ctrl-C during `memtro run`). | |

## CI

```bash
export MEMTRO_API_KEY=sk-memtro-...
memtro search "deploy freeze" --json
```

`MEMTRO_API_KEY` wins over any stored key and is never written anywhere. Create one for CI on the dashboard (an organisation key with only the reach the job needs), not by signing in on a build machine. A CI job never tries to sign in: with no key it exits 3.

`memtro token` hands the stored key to another program, and refuses to print it into a terminal unless you pass `--show`:

```bash
curl -H "Authorization: Bearer $(memtro token)" https://platform.memtro.com/v1/models
```

## More than one account

A consultant with two clients, a sandbox beside production, a self-hosted Memtro next to the hosted one. Each is a profile, with its own host and its own key:

```bash
memtro --profile client --base-url https://memtro.client.internal whoami   # signs that profile in
memtro --profile client search "escalation policy"
MEMTRO_PROFILE=client memtro whoami
```

Profile names are lowercase letters, digits, `-` and `_`. Without one you are using `default`.

A stored key goes back to the host that issued it and nowhere else. Pointing a profile at another host with `--base-url` or `MEMTRO_BASE_URL` is refused rather than sending that key somewhere new; sign that profile in again, or use another.

## Where the key is kept

| Platform | Store |
|---|---|
| macOS | The login Keychain, as a generic password under the service `memtro-cli`, one item per profile. |
| Linux with `secret-tool` | The Secret Service keyring (GNOME Keyring, KWallet). |
| Anywhere else, or `MEMTRO_CREDENTIALS=file` | `credentials.json` beside the config: mode 0600 in a 0700 directory. |

The key never appears in a process's argument list, where every user on the machine could read it with `ps`. On macOS, `security add-generic-password -w <key>` is the documented command and exactly that mistake, so the CLI starts `/usr/bin/security -i` and writes the command to it on stdin, with the key hex-encoded. `secret-tool store` reads the key from stdin too. The file store refuses to read a credentials file that group or others can read, the way ssh refuses a loose private key: such a key may already have been copied, and quietly using it would hide that. `chmod 600` fixes it, and `memtro logout` then `memtro` replaces the key.

Settings that are not secret (each profile's host, who it signed in as, when its key expires) are in `config.json`:

| Platform | Directory |
|---|---|
| macOS, Linux | `${XDG_CONFIG_HOME:-~/.config}/memtro` |
| Windows | `%APPDATA%\memtro` |

`--verbose` says which profile, host and store a command used and what it requested. It never prints a key, a code or a verifier, and nor does any error message.

## Self-hosted Memtro

```bash
memtro --base-url https://memtro.example.com
```

The first run signs in there.

The host is remembered for the profile, so every later command goes there. `MEMTRO_BASE_URL` sets it for one shell.

## Settings

| Variable | Default | What it is for |
|---|---|---|
| `MEMTRO_API_KEY` | — | Use this key; never stored. For CI. |
| `MEMTRO_PROFILE` | `default` | Which profile, when `--profile` is not given. |
| `MEMTRO_BASE_URL` | the profile's host, else `https://platform.memtro.com` | Which Memtro. |
| `MEMTRO_CREDENTIALS` | the platform keychain | `file` keeps keys in the 0600 file instead. |
| `MEMTRO_CONFIG_DIR` | see above | Somewhere else for `config.json` and `credentials.json`. |
| `MEMTRO_NO_UPDATE_CHECK` | — | `1` stops the session saying a newer memtro is available (as does `"updateCheck": false` in `config.json`). |
| `NO_COLOR` | — | No colour. |

## Trust

The CLI talks to the Memtro host of the profile you are using and, to check for and download updates, to GitHub's release pages for this repository; nothing else, and it sends no telemetry. Update requests carry no key, no cookie and nothing from your profile. It has no runtime dependencies: everything is Node's own (`fetch`, `node:http`, `node:crypto`, `node:child_process`, `node:readline`). Outside a coding session, the child processes it starts are your browser opener (`open`, `xdg-open` or `rundll32`, with an argument list, never a shell) and the keychain tool; in a session, the agent also runs the commands described under [Safety](#safety), plus `git` and `rg` for listing and searching files. Read [`src/`](src/).

Requires Node 20 or newer.

## Licence

MIT.
