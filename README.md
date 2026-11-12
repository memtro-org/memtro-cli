# memtro

Your company's memory, its connected systems and its agent, from a terminal or a script.

```bash
npm install -g @memtro/cli
memtro login
memtro ask "what did we agree with Baltic about the renewal?"
```

That is the whole setup. `memtro login` opens your browser, you approve this computer, and the key it is given goes into your system keychain. Nothing to copy, nothing to paste into a dotfile.

## Sign in

```bash
memtro login
```

Your browser opens on Memtro's approval page. It shows who you are signed in as, which organisation the key will belong to (you choose, if you are in several), and the name of this computer. Approve, and the terminal says:

```
Signed in as Ada Lovelace <ada@example.com> in Analytical Engines; this key expires on 10 Feb 2027 (in 90 days).
```

The key belongs to that organisation and is held by you: it reads and writes the organisation's memory as you, with your connections and your permissions, and nothing more. It appears on [Dashboard → Profile → API keys](https://platform.memtro.com/dashboard/profile/keys) as `Memtro CLI (<this computer>)`, where it can be revoked like any other. After 90 days it stops working and `memtro login` gets you a new one.

The address is always printed as well as opened. A browser that "opened" on another desktop, or not at all, is not something the CLI can see.

**Over SSH, or anywhere without a browser**, the redirect back to this computer cannot work, so use:

```bash
memtro login --no-browser
```

It prints the address; open it anywhere, approve, and paste the code the page shows. This is chosen automatically over SSH and on Linux with no display. The code works once, for two minutes, and only together with a secret this terminal never sent anywhere, so a code seen over somebody's shoulder is useless to them.

How it works, for anybody reviewing it: OAuth 2.0 authorization code with PKCE (RFC 7636) and a loopback redirect (RFC 8252). The CLI listens on `127.0.0.1` on a random port, answers only `GET /callback` with its own `Host`, checks `state` in constant time, and gives up after five minutes. No password and no browser cookie ever reaches it.

## Commands

| Command | What it does |
|---|---|
| `memtro login` | Sign in through the browser; store the key. |
| `memtro logout` | Revoke the key on Memtro, then remove it from this computer. |
| `memtro whoami` | Who the key belongs to, its organisation, when it expires. Asks Memtro, so a revoked key says so. |
| `memtro ask "<question>"` | Ask; the answer streams to stdout. `--agent` for the multi-step investigation, `--model <id>` for a specific model. |
| `memtro search "<query>"` | Search memory. `--limit n` (1-100). |
| `memtro remember "<statement>"` | Save a fact, shared with the organisation; `--personal` keeps it to you. |
| `memtro why <path>` | Why a piece of code is the way it is: the pull requests, tickets, conversations and incidents behind it. `--repo owner/name` to pin the repository. |
| `memtro tools` | Every tool your key can use: Memtro's own, and one per connected system. |
| `memtro call <tool>` | Call one. `--arg key=value` sends a string, `--arg key:=<json>` a number, boolean, list or object; or `--input '<json>'`. |
| `memtro token` | Print the key, for another program. |

`memtro help <command>` for the details of each.

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
| 3 | Not signed in, or the key was refused (revoked or expired). Run `memtro login`. | No |
| 4 | Memtro could not be reached, timed out, or is unavailable. | Yes |

## CI

```bash
export MEMTRO_API_KEY=sk-memtro-...
memtro search "deploy freeze" --json
```

`MEMTRO_API_KEY` wins over any stored key and is never written anywhere. Create one for CI on the dashboard (an organisation key with only the reach the job needs), not by running `memtro login` on a build machine.

`memtro token` hands the stored key to another program, and refuses to print it into a terminal unless you pass `--show`:

```bash
curl -H "Authorization: Bearer $(memtro token)" https://platform.memtro.com/v1/models
```

## More than one account

A consultant with two clients, a sandbox beside production, a self-hosted Memtro next to the hosted one. Each is a profile, with its own host and its own key:

```bash
memtro login --profile client --base-url https://memtro.client.internal
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

The key never appears in a process's argument list, where every user on the machine could read it with `ps`. On macOS, `security add-generic-password -w <key>` is the documented command and exactly that mistake, so the CLI starts `/usr/bin/security -i` and writes the command to it on stdin, with the key hex-encoded. `secret-tool store` reads the key from stdin too. The file store refuses to read a credentials file that group or others can read, the way ssh refuses a loose private key: such a key may already have been copied, and quietly using it would hide that. `chmod 600` fixes it, and `memtro logout` then `memtro login` replaces the key.

Settings that are not secret (each profile's host, who it signed in as, when its key expires) are in `config.json`:

| Platform | Directory |
|---|---|
| macOS, Linux | `${XDG_CONFIG_HOME:-~/.config}/memtro` |
| Windows | `%APPDATA%\memtro` |

`--verbose` says which profile, host and store a command used and what it requested. It never prints a key, a code or a verifier, and nor does any error message.

## Self-hosted Memtro

```bash
memtro login --base-url https://memtro.example.com
```

The host is remembered for the profile, so every later command goes there. `MEMTRO_BASE_URL` sets it for one shell.

## Settings

| Variable | Default | What it is for |
|---|---|---|
| `MEMTRO_API_KEY` | — | Use this key; never stored. For CI. |
| `MEMTRO_PROFILE` | `default` | Which profile, when `--profile` is not given. |
| `MEMTRO_BASE_URL` | the profile's host, else `https://platform.memtro.com` | Which Memtro. |
| `MEMTRO_CREDENTIALS` | the platform keychain | `file` keeps keys in the 0600 file instead. |
| `MEMTRO_CONFIG_DIR` | see above | Somewhere else for `config.json` and `credentials.json`. |
| `NO_COLOR` | — | No colour. |

## Trust

The CLI talks to the Memtro host of the profile you are using and to nothing else. It has no runtime dependencies: everything is Node's own (`fetch`, `node:http`, `node:crypto`, `node:child_process`). The child processes it starts are your browser opener (`open`, `xdg-open` or `rundll32`, with an argument list, never a shell) and the keychain tool. Read [`src/`](src/).

Requires Node 20 or newer.

## Licence

MIT.
