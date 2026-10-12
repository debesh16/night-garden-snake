# Optional online server

The game in `web/` works completely without this. The server adds:

- the daily top run (everyone can race it as a ghost)
- ranked score submission, where the server re-simulates every replay with the same `core/` C code and stores only the score it computes
- community levels with likes

It is one C CGI program (`api.c`) plus MySQL (`schema.sql`). The steps below use a small Ubuntu 24.04 VPS (1 vCPU / 1 GB is plenty) with Apache.

## 1. Install packages

```bash
sudo apt update
sudo apt install -y apache2 mysql-server build-essential libmysqlclient-dev libcrypt-dev
```

MariaDB works too: install `mariadb-server libmariadb-dev-compat` instead.

## 2. Create the database

Open `schema.sql` and change `change-me-please` to a long random password, then:

```bash
sudo mysql < server/schema.sql
```

This creates the `snake` database, five tables (`users`, `scores`, `daily_runs`, `levels`, `level_likes`) and a `snake_api` account that can only `SELECT` and `INSERT`.

## 3. Build the CGI program

Copy the whole project folder to the server (the program needs `core/`), then from the `server/` folder:

```bash
gcc -std=gnu99 -O2 -Wall -Wextra -I../core api.c \
  ../core/snake_core.c ../core/rng.c ../core/board.c ../core/level.c ../core/replay.c \
  ../core/modes/perks.c ../core/modes/rewind.c ../core/modes/daily.c \
  $(mysql_config --cflags --libs) -lcrypt -o snake-api.cgi
sudo cp snake-api.cgi /usr/lib/cgi-bin/snake-api
sudo chmod 755 /usr/lib/cgi-bin/snake-api
```

Rebuild and copy again whenever `core/` changes, so the server simulates exactly what the browser plays.

## 4. Configure Apache

```bash
sudo a2enmod cgid headers
sudo nano /etc/apache2/conf-available/snake-api.conf
```

Put this in the file, with your own values:

```apache
<Location "/cgi-bin/snake-api">
    SetEnv SNAKE_DB_HOST localhost
    SetEnv SNAKE_DB_USER snake_api
    SetEnv SNAKE_DB_PASS your-database-password
    SetEnv SNAKE_DB_NAME snake
    SetEnv SNAKE_ALLOWED_ORIGIN https://your-name.github.io
    SetEnv SNAKE_IP_SALT any-long-random-string
</Location>
```

`SNAKE_ALLOWED_ORIGIN` is the address where `web/` is hosted (for CORS). IP addresses are never stored, only a salted hash used for rate limits.

```bash
sudo a2enconf snake-api
sudo systemctl reload apache2
```

## 5. HTTPS

Browsers block calls from an `https://` game to an `http://` API, so add a certificate:

```bash
sudo apt install -y certbot python3-certbot-apache
sudo certbot --apache -d api.example.com
```

## 6. Test it

```bash
curl "https://api.example.com/cgi-bin/snake-api?action=ping"
# {"ok":true,"api":1}
curl "https://api.example.com/cgi-bin/snake-api?action=levels"
# {"ok":true,"levels":[]}
```

## 7. Point the game at it

In `web/js/online.js` set:

```js
export const API_BASE = 'https://api.example.com/cgi-bin/snake-api';
```

Upload `web/` again. The Community levels button, Publish button and daily top run now appear. If the server is down, they hide again and the game keeps working offline.

## API reference

| Action | Method | Parameters | Returns |
| --- | --- | --- | --- |
| `ping` | GET | none | `{"ok":true}` |
| `submit` | POST | `nickname`, `replay` (base64url), `daily` (0/1), optional `password` | recomputed `score`, `length`, `daily_saved` |
| `daily_top` | GET | `day` (day number, #1 = 2026-01-01 UTC) | `nickname`, `score`, `replay` |
| `levels` | GET | none | up to 50 levels, most liked first |
| `publish_level` | POST | `nickname`, `name`, `data` (share-link string), optional `password` | new level `id` |
| `like_level` | POST | `id`, `nickname`, optional `password` | `ok` |

Rules the server enforces:

- Every SQL statement is a prepared statement; no input is pasted into SQL.
- A submitted replay is re-simulated to the end. The run must finish (game over), and 2-player or custom-level runs are not ranked.
- A daily submission must use today's UTC seed. Only the first daily run per nickname counts (`INSERT IGNORE` on a unique key).
- Rate limits: 6 score submissions per minute and 3 levels per 10 minutes per address.
- Nicknames are 1–16 letters, digits, spaces, `_`, `-` or `.`. Nickname-only play is the default. If a player sends a password the first time they use a nickname, it is stored as a SHA-512 crypt hash and required from then on.
