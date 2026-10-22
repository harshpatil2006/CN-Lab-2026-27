> Notes written while building the app. The Railway deployment described in the first section was attempted but did **not** complete (the hosting service had paused deploys), so the project was run on localhost. See the main README, section "Known limitations".

# Campus Connect

**Connect. Chat. Share.**

Campus chat and file sharing for students. Built as a Computer Networks project, so the networking is visible: a live **Network monitor** page shows real numbers measured by the server (connections, messages, files, bytes, round-trip time), and nothing on it is estimated or made up.

- Register, sign in, see who is online
- One to one chats and group chats, delivered instantly, with history and unread counts
- Send files (PDF, Word, Excel, PowerPoint, images, ZIP, text and code) with a progress bar. Only the people in the chat can download them
- Dashboard, search, activity log, Network monitor
- Works on phones and computers

## Put it online (Railway)

You need Node.js (the LTS version from https://nodejs.org) and a free Railway account. You sign in to Railway in your own browser. This project never asks for your Railway password.

**Windows:** double-click `deploy.cmd`.
**Mac / Linux:** run `node deploy.js`.

The script does these steps and shows each one:

1. Opens a browser so you can sign in to Railway
2. Creates a Railway project and a service called `campus-connect`
3. Sets the variables: `NODE_ENV`, `PORT=3000`, `MAX_UPLOAD_MB`, and a random `SESSION_SECRET` (never printed)
4. Adds a persistent volume mounted at `/app/data` (the database and uploaded files live here)
5. Creates the public HTTPS address (`railway domain --port 3000`)
6. Uploads the code and deploys it (`railway up`)
7. Waits until `/health` answers, then prints the live address and saves it in `LIVE_URL.txt`

At the end it offers an optional full live test (`scripts/live-check.js`). That test registers two small test accounts, sends a message between them, uploads and downloads a file, and reads the Network monitor, all over your public HTTPS address.

### Redeploy after a change

Run `deploy.cmd` again (it skips everything that already exists), or just:

```
npx @railway/cli@5.71.0 up --service campus-connect --ci
```

### If something goes wrong

```
npx @railway/cli@5.71.0 logs --deployment --lines 100 --service campus-connect
npx @railway/cli@5.71.0 logs --build --lines 100 --service campus-connect
```

Without a volume, chats and files are lost on every redeploy. `/health` shows `"persistentVolume": true` when the volume is attached.

## How the pieces connect

```
 Student A (browser)                                              Student B (browser)
 ┌──────────────────┐                                            ┌──────────────────┐
 │ HTML, CSS, JS    │                                            │ HTML, CSS, JS    │
 │ Socket.IO client │                                            │ Socket.IO client │
 └───────┬──────────┘                                            └───────▲──────────┘
         │  HTTPS (TLS)        ┌─────────────────────────────┐           │  HTTPS (TLS)
         │  WebSocket over TCP │      Campus Connect server  │           │  WebSocket over TCP
         └────────────────────►│  Node.js + Express          │───────────┘
            1. message:send    │  Socket.IO (rooms, acks)    │  2. message:new
            3. file upload     │  Auth, limits, validation   │  4. file notice
               (HTTP POST)     │  Metrics + activity log     │     (then HTTP GET to download)
                               └───────┬──────────────┬──────┘
                                       │              │
                              ┌────────▼───────┐ ┌────▼─────────────────┐
                              │ SQLite database│ │ Uploaded files       │
                              │ users, chats,  │ │ random names, outside│
                              │ messages, logs │ │ the web folder       │
                              └────────┬───────┘ └────┬─────────────────┘
                                       └──── Railway volume at /app/data ────┘
```

### What happens when Student A sends a message to Student B

1. Student A's browser already has one open connection to the server. Socket.IO uses a **WebSocket** for it, which runs over one **TCP** connection (inside TLS, so the address starts with `https://`).
2. A sends the event `message:send` on that connection.
3. The server checks that A is signed in and is a member of that chat, trims and limits the text, saves it in SQLite, and replies to A with an acknowledgement.
4. The server sends `message:new` to everyone in that chat who is connected, including B, over B's own WebSocket.
5. B's browser draws the message. If B was offline, the message is simply waiting in the database and shows up when B opens the chat. If B is looking at another page, the unread count goes up instead.

So the path is: **Student A → WebSocket/TCP → server → WebSocket/TCP → Student B.** The students never connect to each other. Everything passes through the server (client-server model).

### What happens when a file is sent

File uploads use **HTTP**, not the WebSocket. HTTP is better suited to large bodies, gives the browser real upload progress, and lets the server refuse a file early.

1. Browser: `POST /api/conversations/:id/files` (multipart form) with the file.
2. Server: checks sign-in and chat membership, enforces the size limit, checks the file extension against a whitelist, checks that the first bytes match the file type, cleans the file name, and stores the file under a random name in the volume. The name, size, sender and chat are saved in SQLite.
3. Server: sends a normal chat message with the file attached to the chat over **Socket.IO**, so B sees it at once.
4. B clicks download: `GET /api/files/:id`. The server checks B is signed in and is in that chat, then streams the file as an attachment.

### HTTP and Socket.IO, side by side

| | HTTP (request and response) | Socket.IO (WebSocket over TCP) |
|---|---|---|
| Used for | sign in, sign up, history, file upload, file download, dashboard data | live messages, online status, typing, unread updates, live Network monitor |
| Who starts it | always the browser | either side, at any time |
| Connection | a short request, then done | one long-lived connection per browser |
| If WebSocket is blocked | n/a | Socket.IO falls back to HTTP long-polling and tries to upgrade again |

TCP is the layer underneath both. The browser never opens a raw TCP or UDP socket itself. Browsers do not allow that, and this project does not pretend otherwise.

## What the Network monitor measures

Every number comes from the running server. Nothing is simulated.

| Shown | How it is measured |
|---|---|
| Active connections, online students | Counted from the open Socket.IO connections |
| WebSocket vs long-polling | The transport each connection is using right now, plus logged upgrades |
| Messages sent, copies delivered | Counted when messages are saved and pushed out |
| Files uploaded, bytes uploaded, downloads | Counted in the upload and download handlers |
| Round-trip time (server) | The server sends `net:probe` to each client every 5 seconds and times the reply with a high resolution clock |
| Round-trip time (header pill) | The browser times its own `net:ping` and the server's acknowledgement |
| Uptime and health | Process start time, `/health` |
| Connect, disconnect, reconnect events | Logged with the reason Socket.IO reports |
| HTTP requests and average time | Counted and timed in the Express middleware |

What it does **not** show: packet counts, packet loss, bandwidth of the link, or one-way delay. Those cannot be measured honestly from a web app, so they are left out. Counters since start reset when the server restarts. Totals for messages, files and stored bytes come from the database, so they survive restarts.

## Security

- Passwords are hashed with bcrypt (bcryptjs). Plain passwords are never stored or logged
- Session cookie: random 256-bit token, only its keyed hash (HMAC-SHA256) is stored, `HttpOnly`, `SameSite=Lax`, `Secure` in production
- Sign in and sign up are rate limited (`AUTH_RATE_LIMIT`, default 30 per 15 minutes per address)
- All chat, file and monitor routes need a signed-in session. The Socket.IO handshake needs one too
- Chat membership is checked on every message, history request, upload and download. "Not yours" and "does not exist" look the same (404)
- Uploads: size limit (`MAX_UPLOAD_MB`, default 20), extension whitelist, magic-byte check, cleaned file name, random stored name. Program files such as .exe are refused. Stored outside the web folder, with no public uploads directory
- Downloads are sent as attachments with `X-Content-Type-Options: nosniff` and a sandboxing Content-Security-Policy
- Helmet security headers and a strict Content-Security-Policy (scripts only from the same site)
- Requests that come from another website (wrong `Origin`) are refused, for HTTP and for Socket.IO
- Message text is limited to 2000 characters and each student is limited to 15 messages per 10 seconds
- The activity log never contains message text or file names
- Secrets live in environment variables. `.env` files are ignored by git and by the Railway upload

## Files

```
server.js            Express app, Socket.IO events, API routes
src/db.js            SQLite (built into Node 22) and the data folder
src/auth.js          Registration, login, sessions
src/files.js         File type rules and name cleaning
src/metrics.js       Counters, latency samples, activity log
public/              The website (HTML, CSS, JS, fonts and chart library, all served locally)
tests/run.js         70 end-to-end checks (npm test)
scripts/live-check.js  Test of a deployed site from the outside
deploy.js, deploy.cmd  One-step Railway deploy
railway.json         Health check and start command for Railway
```

## Run it on your own computer (optional)

```
npm install
npm start          # http://localhost:3000
npm test           # starts its own copy of the server and runs the checks
```

The database and uploads go to `./data` when no volume is present.

## Settings (environment variables)

| Name | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port the server listens on (it listens on `0.0.0.0`) |
| `NODE_ENV` | | Set to `production` on Railway (turns on `Secure` cookies) |
| `SESSION_SECRET` | random, kept in the data folder | Key for session hashing. The deploy script sets it |
| `MAX_UPLOAD_MB` | `20` | Largest file allowed |
| `AUTH_RATE_LIMIT` | `30` | Sign in and sign up attempts per 15 minutes per address |
| `DATA_DIR` | `/app/data`, else `./data` | Where the database and uploads are stored |

## Limits to know about

- It runs as **one instance**. Presence, counters and Socket.IO rooms live in that process. Running two copies would need a shared adapter (for example Redis), which is not included
- Counters "since start", latency samples and the online list reset when the server restarts. Chats, files, accounts and activity are kept in the database on the volume
- SQLite is perfect for a class project and a few hundred students. It is not meant for thousands of people sending at the same time
- Node's built-in `node:sqlite` module is marked experimental, so Node prints a warning. The start script hides that warning
- Uploaded files are not scanned for viruses. The type checks are basic validation, not a malware scanner
- No password reset and no email. If a student forgets a password, they make a new account
- Use demo passwords only. Do not use your real college password on a student project
