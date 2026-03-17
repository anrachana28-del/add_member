import 'dotenv/config'
import express from 'express'
import { initializeApp } from 'firebase/app'
import { getDatabase, ref, update, get, push } from 'firebase/database'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import path from 'path'
import { fileURLToPath } from 'url'

const app = express()
app.use(express.json())

/* ======================
   DELAY FUNCTION
====================== */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/* ======================
   FIREBASE
====================== */
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DB_URL
}
initializeApp(firebaseConfig)
const db = getDatabase()

/* ======================
   LOAD ACCOUNTS
====================== */
const accounts = []
const clients = {}
let i = 1
while (process.env[`TG_ACCOUNT_${i}_PHONE`]) {
  const api_id = Number(process.env[`TG_ACCOUNT_${i}_API_ID`])
  const api_hash = process.env[`TG_ACCOUNT_${i}_API_HASH`]
  const session = process.env[`TG_ACCOUNT_${i}_SESSION`]
  const phone = process.env[`TG_ACCOUNT_${i}_PHONE`]
  if (!api_id || !api_hash || !session) { i++; continue }
  accounts.push({ phone, api_id, api_hash, session, id: `TG_ACCOUNT_${i}`, status: "pending", floodWaitUntil: null })
  i++
}

/* ======================
   TELEGRAM CLIENT
====================== */
async function getClient(account) {
  if (clients[account.id]) return clients[account.id]
  const client = new TelegramClient(new StringSession(account.session), account.api_id, account.api_hash, { connectionRetries: 5 })
  await client.connect()
  clients[account.id] = client
  return client
}

/* ======================
   PARSE FLOOD WAIT
====================== */
function parseFlood(err) {
  const msg = err.message || ""
  const m1 = msg.match(/FLOOD_WAIT_(\d+)/)
  const m2 = msg.match(/wait of (\d+) seconds/i)
  if (m1) return Number(m1[1])
  if (m2) return Number(m2[1])
  return null
}

/* ======================
   CHECK ACCOUNT
====================== */
async function checkTGAccount(account) {
  try {
    const client = await getClient(account)
    await client.getMe()
    account.status = "active"
    await update(ref(db, `accounts/${account.id}`), { status: "active", phone: account.phone, lastChecked: Date.now() })
  } catch (err) {
    const wait = parseFlood(err)
    let status = "error", floodUntil = null
    if (wait) { status="floodwait"; floodUntil=Date.now()+wait*1000; account.floodWaitUntil=floodUntil }
    await update(ref(db, `accounts/${account.id}`), { status, error: err.message, phone: account.phone, floodWaitUntil: floodUntil, lastChecked: Date.now() })
  }
}

/* ======================
   AUTO CHECK
====================== */
async function autoCheck() {
  for(const acc of accounts){ await checkTGAccount(acc); await sleep(2000) }
}
setInterval(autoCheck,60000)
autoCheck()

/* ======================
   SCRAPE MEMBERS
====================== */
app.post('/members', async (req,res)=>{
  try{
    const { group } = req.body
    const acc = accounts.find(a=>!a.floodWaitUntil || a.floodWaitUntil<Date.now())
    if(!acc) return res.json({error:"No active account"})
    const client = await getClient(acc)
    const entity = await client.getEntity(group)
    let offset=0, limit=200, all=[]
    while(true){
      const participants = await client.getParticipants(entity,{limit, offset})
      if(!participants.length) break
      all = all.concat(participants)
      offset += participants.length
    }
    const members = all.filter(p=>!p.bot).map(p=>({user_id:p.id, username:p.username, avatar:`https://t.me/i/userpic/320/${p.id}.jpg`}))
    res.json(members)
  }catch(err){ res.json({error:err.message}) }
})

/* ======================
   ADD MEMBER
====================== */
let accountIndex = 0
app.post('/add-member', async(req,res)=>{
  try{
    const { username, user_id, targetGroup } = req.body
    const now = Date.now()

    // Load history
    const snap = await get(ref(db,'history'))
    const historyData = snap.val()||{}
    const alreadyAdded = Object.values(historyData).some(h => (h.username===username||h.user_id===user_id) && h.status==="success")
    if(alreadyAdded) return res.json({status:"skipped", reason:"already added", accountUsed:"none"})

    // Find available account
    const activeAccounts = accounts.filter(a=>!a.floodWaitUntil || a.floodWaitUntil<now)
    if(!activeAccounts.length) return res.json({status:"failed", reason:"All accounts FloodWait", accountUsed:"none"})

    let accIndexLocal = accountIndex % activeAccounts.length
    let acc = activeAccounts[accIndexLocal]
    const client = await getClient(acc)
    const group = await client.getEntity(targetGroup)

    // Check if user is already in target group
    try{
      const isMember = await client.getParticipants(group,{filter: new Api.ChannelParticipantsSearch({q: username || ""})})
      if(isMember.find(u=>u.id===user_id)){
        return res.json({status:"skipped", reason:"already in group", accountUsed:acc.id})
      }
    }catch{}

    const user = username ? await client.getEntity(username) : await client.getEntity(user_id)

    let status="failed", reason="unknown", moveNextAccount=false
    try{
      await client.invoke(new Api.channels.InviteToChannel({channel:group,users:[user]}))
      status="success"
      reason="joined"
      await sleep(30000) // delay only after success
      moveNextAccount=true
    }catch(err){
      const wait=parseFlood(err)
      if(wait){
        const until=Date.now()+wait*1000
        acc.floodWaitUntil=until
        acc.status="floodwait"
        await update(ref(db, `accounts/${acc.id}`), {status:"floodwait", floodWaitUntil:until})
        const ready=new Date(until).toLocaleString('en-US',{
          weekday:'short', year:'numeric', month:'short', day:'numeric',
          hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true
        })
        reason=`FloodWait ${wait}s | Ready ${ready}`
        moveNextAccount=true
      }else{
        reason=err.message
        moveNextAccount=false
      }
    }

    if(moveNextAccount) accountIndex++

    await push(ref(db,'history'),{username,user_id,status,reason,accountUsed:acc.id,timestamp:Date.now()})
    res.json({status, reason, accountUsed:acc.id})
  }catch(err){ res.json({status:"failed", reason:err.message, accountUsed:"unknown"})}
})

/* ======================
   ACCOUNT STATUS
====================== */
app.get('/account-status', async(req,res)=>{
  const snap = await get(ref(db,'accounts'))
  const now = Date.now()
  const data = snap.val()||{}
  for(const id in data){
    const a = data[id]
    if(a.floodWaitUntil){
      const remain=a.floodWaitUntil-now
      if(remain>0){
        const ready=new Date(a.floodWaitUntil)
        a.readyTime = ready.toLocaleString('en-US',{
          weekday:'short', year:'numeric', month:'short', day:'numeric',
          hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true
        })
      }
    }
  }
  res.json(data)
})

/* ======================
   HISTORY
====================== */
app.get('/history', async(req,res)=>{
  const snap = await get(ref(db,'history'))
  res.json(snap.val()||{})
})

/* ======================
   FRONTEND
====================== */
const __filename=fileURLToPath(import.meta.url)
const __dirname=path.dirname(__filename)
app.get('/',(req,res)=>{ res.sendFile(path.join(__dirname,'index.html')) })

/* ======================
   SERVER
====================== */
const PORT=process.env.PORT||3000
app.listen(PORT,()=>console.log(`🚀 Server running on ${PORT}`))
