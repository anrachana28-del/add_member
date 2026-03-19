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

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)) }

// ===== Firebase =====
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DB_URL
}
initializeApp(firebaseConfig)
const db = getDatabase()

// ===== Accounts =====
const accounts = []
const clients = {}
let i=1
while(process.env[`TG_ACCOUNT_${i}_PHONE`]){
  const api_id=Number(process.env[`TG_ACCOUNT_${i}_API_ID`])
  const api_hash=process.env[`TG_ACCOUNT_${i}_API_HASH`]
  const session=process.env[`TG_ACCOUNT_${i}_SESSION`]
  const phone=process.env[`TG_ACCOUNT_${i}_PHONE`]
  if(!api_id||!api_hash||!session){i++; continue}
  accounts.push({phone,api_id,api_hash,session,id:`TG_ACCOUNT_${i}`,status:"pending",floodWaitUntil:null})
  i++
}

// ===== Client =====
async function getClient(account){
  if(clients[account.id]) return clients[account.id]
  const client=new TelegramClient(new StringSession(account.session), account.api_id, account.api_hash,{connectionRetries:5})
  await client.connect()
  clients[account.id]=client
  return client
}

// ===== Flood Parse =====
function parseFlood(err){
  const msg=err.message||""
  const m1=msg.match(/FLOOD_WAIT_(\d+)/)
  const m2=msg.match(/wait of (\d+) seconds/i)
  if(m1) return Number(m1[1])
  if(m2) return Number(m2[1])
  return null
}

// ===== Refresh account =====
async function refreshAccountStatus(account){
  if(account.floodWaitUntil && account.floodWaitUntil < Date.now()){
    account.floodWaitUntil=null
    account.status="active"
    await update(ref(db,`accounts/${account.id}`),{status:"active",floodWaitUntil:null})
  }
}

// ===== Check account =====
async function checkTGAccount(account){
  try{
    await refreshAccountStatus(account)
    const client=await getClient(account)
    await client.getMe()
    account.status="active"
    account.floodWaitUntil=null
    await update(ref(db,`accounts/${account.id}`),{
      status:"active",
      phone:account.phone,
      lastChecked:Date.now(),
      floodWaitUntil:null
    })
  }catch(err){
    const wait=parseFlood(err)
    let status="error", floodUntil=null
    if(wait){
      status="floodwait"
      floodUntil=Date.now()+wait*1000
      account.floodWaitUntil=floodUntil
      account.status="floodwait"
    }
    await update(ref(db,`accounts/${account.id}`),{
      status,
      floodWaitUntil:floodUntil,
      error:err.message,
      phone:account.phone,
      lastChecked:Date.now()
    })
  }
}

// ===== Auto check =====
async function autoCheck(){
  for(const acc of accounts){
    await refreshAccountStatus(acc)
    await checkTGAccount(acc)
    await sleep(2000)
  }
}
setInterval(autoCheck,60000)
autoCheck()

// ===== Get available account =====
function getAvailableAccount(){ 
  const now = Date.now()
  for(const acc of accounts){
    if(acc.floodWaitUntil && acc.floodWaitUntil < now){
      acc.floodWaitUntil=null
      acc.status="active"
    }
  }
  return accounts.find(a => !a.floodWaitUntil && a.status==="active")
}

// ===== Helper: retry to get available account =====
async function getAvailableAccountRetry(retry=5,delayMs=2000){
  for(let i=0;i<retry;i++){
    const acc=getAvailableAccount()
    if(acc) return acc
    await sleep(delayMs)
  }
  return null
}

// ===== Members export =====
app.post('/members',async(req,res)=>{
  try{
    const {group}=req.body
    const acc=getAvailableAccount()
    if(!acc) return res.json({error:"No active account"})
    const client=await getClient(acc)
    const entity=await client.getEntity(group)
    let offset=0, limit=200, all=[]
    while(true){
      const participants = await client.getParticipants(entity,{limit,offset})
      if(!participants.length) break
      all=all.concat(participants)
      offset+=participants.length
    }
    const members=all.filter(p=>!p.bot).map(p=>({user_id:p.id,username:p.username,access_hash:p.access_hash,avatar:`https://t.me/i/userpic/320/${p.id}.jpg`}))
    res.json(members)
  }catch(err){ res.json({error:err.message}) }
})

// ===== Add member =====
app.post('/add-member',async(req,res)=>{
  try{
    const {username,user_id,access_hash,targetGroup}=req.body
    const clientAcc=getAvailableAccount()
    if(!clientAcc) return res.json({status:"failed",reason:"All accounts FloodWait",accountUsed:"none"})
    if(!username && (!user_id || !access_hash)) return res.json({status:"skipped",reason:"missing username/access_hash",accountUsed:"none",silent:true})
    const client=await getClient(clientAcc)
    const group=await client.getEntity(targetGroup)
    const histSnap=await get(ref(db,'history'))
    const histList=Object.values(histSnap.val()||{})
    const alreadyHistory=histList.some(h=>(h.username===username||h.user_id===user_id) && h.status==="success")
    let alreadyInGroup=false
    try{
      let userEntity
      if(username) userEntity=await client.getEntity(username)
      else userEntity=new Api.InputUser({userId:user_id,accessHash:BigInt(access_hash)})
      await client.getParticipant(group,userEntity)
      alreadyInGroup=true
    }catch(e){alreadyInGroup=false}
    if(alreadyHistory||alreadyInGroup) return res.json({status:"skipped",reason:"already in history or target group",accountUsed:"none",silent:true})

    let status="failed", reason="unknown"
    try{
      let userEntity
      if(username) userEntity=await client.getEntity(username)
      else userEntity=new Api.InputUser({userId:user_id,accessHash:BigInt(access_hash)})
      await client.invoke(new Api.channels.InviteToChannel({channel:group,users:[userEntity]}))
      status="success"; reason="joined"
      await sleep(30000)
    }catch(err){
      const wait=parseFlood(err)
      if(wait){
        const until=Date.now()+wait*1000
        clientAcc.floodWaitUntil=until
        clientAcc.status="floodwait"
        await update(ref(db,`accounts/${clientAcc.id}`),{status:"floodwait",floodWaitUntil:until})
        const ready=new Date(until).toLocaleString()
        reason=`FloodWait ${wait}s | Ready ${ready}`
      }else{ reason=err.message }
    }
    await push(ref(db,'history'),{username,user_id,status,reason,accountUsed:clientAcc.id,timestamp:Date.now()})
    res.json({status,reason,accountUsed:clientAcc.id})
  }catch(err){
    res.json({status:"failed",reason:err.message,accountUsed:"unknown"})
  }
})

// ===== Auto add per-member loop =====
app.post('/auto-add-loop', async (req,res)=>{
  try{
    const {sourceGroup,targetGroup} = req.body
    if(!sourceGroup||!targetGroup) return res.json({error:"Provide source and target group"})

    const accExport = await getAvailableAccountRetry()
    if(!accExport) return res.json({error:"No active account to export"})
    const clientExport = await getClient(accExport)
    const entitySource = await clientExport.getEntity(sourceGroup)

    let offset=0, limit=1
    let totalAdded=0
    while(true){
      const participants = await clientExport.getParticipants(entitySource,{limit,offset})
      if(!participants.length) break
      const member = participants[0]; offset+=1
      if(member.bot) continue
      const key = member.username||member.id

      const acc = await getAvailableAccountRetry(5,3000)
      if(!acc) continue
      const clientAdd = await getClient(acc)
      const entityTarget = await clientAdd.getEntity(targetGroup)

      const histSnap = await get(ref(db,'history'))
      const histList = Object.values(histSnap.val()||{})
      const alreadyHistory = histList.some(h=>(h.username===member.username||h.user_id===member.id) && h.status==="success")

      const targetParticipants = await clientAdd.getParticipants(entityTarget,{limit:2000})
      const targetSet = new Set(targetParticipants.map(u=>u.username||u.id))
      if(targetSet.has(key)||alreadyHistory){
        await push(ref(db,'history'),{username:member.username,user_id:member.id,status:"skipped",reason:"already in target/history",accountUsed:acc.id,timestamp:Date.now()})
        continue
      }

      try{
        const userEntity = member.username ? await clientAdd.getEntity(member.username) : new Api.InputUser({userId:member.id, accessHash:BigInt(member.access_hash)})
        await clientAdd.invoke(new Api.channels.InviteToChannel({channel:entityTarget,users:[userEntity]}))
        await push(ref(db,'history'),{username:member.username,user_id:member.id,status:"success",reason:"joined",accountUsed:acc.id,timestamp:Date.now()})
        totalAdded++
        await sleep(10000+Math.random()*5000)
      }catch(err){
        const wait=parseFlood(err)
        let reason=err.message
        if(wait){
          const until=Date.now()+wait*1000
          acc.floodWaitUntil=until
          acc.status="floodwait"
          await update(ref(db,`accounts/${acc.id}`),{status:"floodwait",floodWaitUntil:until})
          reason=`FloodWait ${wait}s`
        }
        await push(ref(db,'history'),{username:member.username,user_id:member.id,status:"failed",reason,accountUsed:acc.id,timestamp:Date.now()})
      }
    }

    res.json({message:`Done per-member loop, total added: ${totalAdded}`})
  }catch(err){ res.json({error:err.message}) }
})

// ===== Account status =====
app.get('/account-status',async(req,res)=>{
  const snap=await get(ref(db,'accounts'))
  const now=Date.now()
  const data=snap.val()||{}
  for(const id in data){
    const a=data[id]
    if(a.floodWaitUntil){
      const remain=a.floodWaitUntil-now
      if(remain<=0){
        a.status="active"; a.floodWaitUntil=null
        await update(ref(db,`accounts/${id}`),{status:"active",floodWaitUntil:null})
      }else{
        a.readyTime=new Date(a.floodWaitUntil).toLocaleString()
        a.remaining=remain
      }
    }
  }
  res.json(data)
})

// ===== History =====
app.get('/history',async(req,res)=>{
  const snap=await get(ref(db,'history'))
  res.json(snap.val()||{})
})

// ===== Frontend =====
const __filename=fileURLToPath(import.meta.url)
const __dirname=path.dirname(__filename)
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'index.html')))

const PORT=process.env.PORT||3000
app.listen(PORT,()=>console.log(`🚀 Server running on ${PORT}`))
