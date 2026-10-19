# Known-You Seed – QR Product Registration Backend

Express.js + Node.js + Firebase Firestore, with Fast2SMS (SMS) and Gmail/Nodemailer (email).

## 1. Setup

```bash
npm install
cp .env.example .env      # then fill in the values
npm start                 # http://localhost:5001
npm test                  # 14 automated tests (no real Firebase/SMS/email needed)
```

Firebase: Firebase Console → Project settings → Service accounts → *Generate new private key*.
Copy `project_id`, `client_email`, `private_key` into `.env`
(or set `FIREBASE_SERVICE_ACCOUNT_PATH` for a local JSON file).
Also set Firestore **Rules** to deny all client access – only this backend (Admin SDK) touches the data.

Gmail: use an *App Password* (Google Account → Security → 2-Step Verification → App passwords).

## 2. Firestore collections

| Collection  | Purpose |
|-------------|---------|
| `qr_codes`  | One document per valid serial number (document id = serial). Same structure as your old backend. |
| `feedback`  | Every feedback message (also emailed) |
| `incidents` | Every incident report (also emailed) |

## 3. Load serial numbers + generate QR codes

```bash
node scripts/seed-serials.js --prefix PRI0 --from 1321830 --to 1322109 --product "Papaya Red Lady"
node scripts/seed-serials.js --file serials.txt --product "Papaya Red Lady"

# QR code content:  <FRONTEND_PUBLIC_URL>/register?sn=<SERIAL>
node scripts/generate-qr.js --all
```

## 4. API

| Method | URL | Purpose |
|--------|-----|---------|
| GET  | `/api/products/:serial` | Is the serial genuine? Can it still be registered? |
| POST | `/api/register` | `{serialNumber,name,email,phone,agreedToPolicy}` → saves, sends SMS + email |
| POST | `/api/feedback` | `{serialNumber,name,email,phone,message}` → saved + emailed to `FEEDBACK_TO_EMAIL` |
| POST | `/api/incidents` | same body → saved + emailed to `INCIDENT_TO_EMAIL` |
| GET  | `/health` | health check |

Status codes: `404 SERIAL_NOT_FOUND`, `409 ALREADY_REGISTERED` ("This product is already registered."),
`403 NOT_REGISTERED` (feedback/incident before registering), `400` validation errors, `429` rate limit.

Notes
- Registration uses a Firestore **transaction**: two simultaneous scans can never both register the same serial.
- A failed SMS/email never undoes a registration; the result is stored in the document (`notifications`) and returned.
- `/api/products/:serial` never returns the customer's name/email/phone (the old `/verify` endpoint did).
