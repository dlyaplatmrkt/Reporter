# Telegram Spam Reporter

A Python console script that logs into a Telegram user account via Telethon and reports a list of targets (users, bots, channels) for spam/scam.

---

## Requirements

- Python 3.10 or newer
- A Telegram account with a phone number
- Telegram API credentials (see below)

---

## Installation

```bash
pip install telethon python-dotenv
```

---

## Getting API_ID and API_HASH

1. Open your browser and go to https://my.telegram.org
2. Log in with your Telegram phone number and the confirmation code sent to you.
3. Click **API development tools**.
4. Fill in the **App title** and **Short name** fields (any values work).
5. Click **Create application**.
6. You will see your **App api_id** (a number) and **App api_hash** (a hex string). Copy both.

> Keep these values private — they are tied to your Telegram account.

---

## Configuration

Create a file named `config.env` in the same folder as the script:

```
API_ID=your_api_id_here
API_HASH=your_api_hash_here
PHONE_NUMBER=+79xxxxxxxxx
```

Replace the values with your real credentials. The phone number must include the country code (e.g. `+1` for the US, `+44` for the UK).

---

## Targets file

Create a file named `targets.txt` in the same folder. Add one target per line. Supported formats:

```
@username
t.me/username
https://t.me/joinchat/AAAAAE...
-1001234567890
```

Lines starting with `#` and blank lines are ignored.

---

## First run (authentication)

On the first run Telethon will send a confirmation code to your Telegram account. Enter it in the console when prompted. A `session.session` file is created locally so that future runs skip this step.

```bash
python report_spam.py
```

---

## How it works

1. Reads targets from `targets.txt`.
2. Logs in using your phone number (once — session is reused afterwards).
3. For each target, resolves the entity and calls `ReportSpamRequest`.
4. Waits a random 3–10 seconds between reports to avoid rate-limiting.
5. If Telegram returns a flood-wait error, the script prints the required wait time and exits cleanly.
6. Targets that no longer exist or cannot be resolved are logged and skipped.

---

## Running on Windows

Open Command Prompt or PowerShell in the script folder:

```
python report_spam.py
```

Make sure `python` refers to Python 3.10+. You can check with:

```
python --version
```

---

## Notes

- Reporting requires that your account can actually see or has interacted with the target. Targets you have no access to may be skipped.
- Do not run this on a freshly created account — Telegram may restrict new accounts that report excessively.
- This script uses your personal user account, not a bot token.
