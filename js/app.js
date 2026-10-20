/* Семейный квиз (Хайфа, Вена, Днепр) — многопользовательская версия.
 *
 * Сеть: публичный MQTT-брокер по WebSocket (wss). Все сообщения идут через брокер,
 * прямых соединений между устройствами нет — поэтому работает в любой сети,
 * где открываются сайты (Wi-Fi, мобильный интернет, разные сети у игроков).
 * Сервер не нужен — достаточно статического хостинга (например GitHub Pages).
 *
 * Ведущий хранит всё авторитетное состояние игры: фазу, вопрос, игроков и их ответы.
 * Топики (CODE — код комнаты, pid — постоянный id игрока):
 *   TOPIC/CODE/up        игрок → ведущий: {t:"hello",pid,name} (раз в 5 с), {t:"answer",pid,round,q,c,ms}, {t:"bye",pid}
 *   TOPIC/CODE/p/<pid>   ведущий → игрок: {t:"state",st,players,me:{answers}}
 *
 * Тексты в коде не живут: надписи интерфейса — data/texts.json,
 * квизы — data/quizzes/<id>.json, их список — data/quizzes/index.json.
 */
"use strict";

const VERSION=7;    // меняйте вместе с ?v= в index.html — так браузер не возьмёт старые файлы из кеша
const TL=30000, NAME_MAX=24;
const BASE=100, BONUS=900;   // правильный ответ: BASE + до BONUS за скорость (сразу — 1000, в последнюю секунду — около 100)
const TOPIC="haifa-quiz/v1/";
const PING_MS=5000, OFFLINE_MS=16000, NOT_FOUND_MS=8000;
const $=s=>document.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ls={
  get(k,d){try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}},
  set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}},
  del(k){try{localStorage.removeItem(k)}catch(e){}}
};
const rand=(n,abc)=>{let s="";const a=new Uint32Array(n);crypto.getRandomValues(a);for(const x of a)s+=abc[x%abc.length];return s;};
const ID_ABC="abcdefghijklmnopqrstuvwxyz0123456789";
const newCode=()=>rand(5,"ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
const newRound=()=>rand(6,ID_ABC);
const normCode=s=>String(s||"").toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,8);

/* Свой брокер: ?broker=wss://host:port/path. По умолчанию — публичный EMQX. */
const params=new URLSearchParams(location.search);
const BROKER=params.get("broker")||"wss://broker.emqx.io:8084/mqtt";

let role=null;        // null (стартовый экран) | "host" | "player"
let client=null;      // MQTT-клиент
let S=null;           // состояние игры {phase:"lobby"|"question"|"reveal"|"final", q, round, startedAt}
let lastHTML="", lastView="";

/* ---------- тексты и квизы из data/*.json ---------- */
let T={};                       // data/texts.json
let QUIZZES={}, DEFAULT_QUIZ=""; // id -> квиз из data/quizzes/<id>.json
let QUIZ=null, QS=[];

/* Строка интерфейса по ключу "раздел.ключ". t() — для HTML (подстановки экранируются), tp() — простой текст. */
function lookup(key){const v=key.split(".").reduce((o,k)=>o&&o[k],T);return typeof v==="string"?v:key;}
function tp(key,vars){return lookup(key).replace(/\{(\w+)\}/g,(m,k)=>vars&&k in vars?String(vars[k]):m);}
function t(key,vars){return lookup(key).replace(/\{(\w+)\}/g,(m,k)=>vars&&k in vars?esc(vars[k]):m);}
const letter=i=>(T.app&&T.app.letters||["A","B","C","D"])[i];

async function loadJSON(path){
  const r=await fetch(path+"?v="+VERSION);
  if(!r.ok)throw new Error(path+": HTTP "+r.status);
  return r.json();
}
function validQuestion(q){
  return q&&typeof q.question==="string"&&Array.isArray(q.options)&&q.options.length===4&&
    q.options.every(o=>typeof o==="string")&&Number.isInteger(q.answer)&&q.answer>=0&&q.answer<4;
}
async function loadData(){
  const [texts,index]=await Promise.all([loadJSON("data/texts.json"),loadJSON("data/quizzes/index.json")]);
  T=texts;
  const ids=Array.isArray(index.quizzes)?index.quizzes:[];
  const quizzes=await Promise.all(ids.map(id=>loadJSON("data/quizzes/"+id+".json")));
  ids.forEach((id,i)=>{
    const z=quizzes[i];
    const qs=(z.questions||[]).filter(q=>{const ok=validQuestion(q);if(!ok)console.warn("Пропущен неверный вопрос в "+id+".json",q);return ok;});
    if(qs.length)QUIZZES[id]=Object.assign({},z,{questions:qs});
  });
  DEFAULT_QUIZ=QUIZZES[index.default]?index.default:Object.keys(QUIZZES)[0];
  if(!DEFAULT_QUIZ)throw new Error("нет ни одного квиза");
}

function useQuiz(id){
  QUIZ=QUIZZES[id]||QUIZZES[DEFAULT_QUIZ];QS=QUIZ.questions;
  $("#brand").textContent=QUIZ.brand;
  document.title=QUIZ.brand;
}
function quizId(){for(const k in QUIZZES)if(QUIZZES[k]===QUIZ)return k;return DEFAULT_QUIZ;}

/* ---------- очки ---------- */
function bonus(ms){return Math.round(BONUS*Math.max(0,1-ms/TL));}
function pts(i,ans){const a=ans&&ans[i];if(!a||a[0]!==QS[i].answer)return 0;return BASE+bonus(a[1]);}
const secs=ms=>(ms/1000).toFixed(1);
function counted(i){return !!S&&(S.phase==="final"||i<S.q||(i===S.q&&S.phase==="reveal"));}
function scoreOf(ans){return QS.reduce((s,_,i)=>s+(counted(i)?pts(i,ans):0),0);}
function ranked(list){return list.slice().sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));}

/* ---------- связь ---------- */
function setStatus(on,text){const s=$("#status");s.hidden=!text;s.classList.toggle("on",!!on);s.lastElementChild.textContent=text||"";}
function libAvailable(){
  if(window.mqtt)return true;
  $("#main").innerHTML=`<h1>${t("app.netErrorTitle")}</h1><div class="notice">${t("app.netError")}</div>`;
  return false;
}
function connect(will){
  const c=mqtt.connect(BROKER,{clientId:"hq_"+rand(12,ID_ABC),clean:true,keepalive:20,
    reconnectPeriod:2000,connectTimeout:10000,will});
  c.on("error",()=>{});
  return c;
}
function publish(topic,msg){if(client&&client.connected)client.publish(topic,JSON.stringify(msg),{qos:1});}
function parse(buf){try{const d=JSON.parse(buf.toString());return d&&typeof d==="object"?d:null}catch(e){return null}}
function setRoomInURL(code){
  const u=new URL(location.href);
  if(code)u.searchParams.set("room",code);else u.searchParams.delete("room");
  history.replaceState(null,"",u);
}
function joinURL(code){const u=new URL(location.href);u.search="";u.hash="";u.searchParams.set("room",code);if(params.get("broker"))u.searchParams.set("broker",params.get("broker"));return u.toString();}

/* =====================================================================
   ВЕДУЩИЙ
   ===================================================================== */
const H={code:null,roster:{}};   // roster: pid -> {name,answers,online,seen}

function hostSave(){ls.set("hq-host",{code:H.code,S,roster:H.roster});}

function startHost(resume){
  if(!libAvailable())return;
  role="host";
  const saved=resume&&ls.get("hq-host",null);
  if(saved&&saved.code&&saved.S){
    H.code=saved.code;S=saved.S;H.roster=saved.roster||{};
    for(const k in H.roster)H.roster[k].online=false;
  }else{
    H.code=newCode();H.roster={};
    S={phase:"lobby",q:0,round:newRound(),startedAt:0,quiz:ls.get("hq-quiz",DEFAULT_QUIZ)};
  }
  useQuiz(S.quiz);
  setRoomInURL(null);
  $("#leave").hidden=false;
  hostSave();
  setStatus(false,tp("status.opening"));
  client=connect();
  client.on("connect",()=>{
    client.subscribe(TOPIC+H.code+"/up",{qos:1});
    setStatus(true,tp("status.open"));
    hostBroadcast();
  });
  client.on("message",(topic,buf)=>hostOnData(parse(buf)));
  client.on("offline",()=>setStatus(false,tp("status.offline")));
  client.on("reconnect",()=>setStatus(false,tp("status.reconnecting")));
  render();
}

function hostOnData(d){
  if(!d||role!=="host")return;
  const pid=typeof d.pid==="string"?d.pid.slice(0,64):"";
  if(!pid)return;
  const p=H.roster[pid];
  if(d.t==="hello"){
    const name=typeof d.name==="string"?d.name.trim().slice(0,NAME_MAX):"";
    if(!name)return;
    if(p&&p.online&&p.name===name){p.seen=Date.now();hostSend(pid);return;}
    H.roster[pid]={name,answers:(p&&p.answers)||{},online:true,seen:Date.now()};
    hostChanged();
    return;
  }
  if(d.t==="bye"){if(p&&p.online){p.online=false;hostChanged();}return;}
  if(d.t==="answer"){
    if(!p)return;
    p.seen=Date.now();
    if(!S||S.phase!=="question"||d.round!==S.round||d.q!==S.q||p.answers[S.q]){hostSend(pid);return;}
    const c=+d.c,elapsed=Date.now()-S.startedAt;
    if(!(c>=0&&c<4)||elapsed>TL+2000)return;
    // Время меряет телефон игрока (с момента показа вопроса), но не больше, чем прошло у ведущего.
    const ms=Math.max(0,Math.min(TL-1,+d.ms||0,elapsed));
    p.answers[S.q]=[Math.floor(c),ms];
    hostChanged();
  }
}

/* Игрок, от которого давно нет сообщений, считается отключившимся. */
setInterval(()=>{
  if(role!=="host")return;
  let changed=false;
  for(const k in H.roster){const p=H.roster[k];if(p.online&&Date.now()-(p.seen||0)>OFFLINE_MS){p.online=false;changed=true;}}
  if(changed)hostChanged();
},2000);

function hostPlayers(){
  return Object.entries(H.roster).map(([k,p])=>({k,name:p.name,online:p.online,answers:p.answers,
    done:!!(S&&p.answers[S.q]),score:scoreOf(p.answers)}));
}
function hostSnapshot(pid){
  const players=ranked(hostPlayers()).map(p=>({name:p.name,score:p.score,online:p.online,done:p.done,me:p.k===pid}));
  return {t:"state",v:VERSION,st:S,players,me:{answers:(H.roster[pid]&&H.roster[pid].answers)||{}}};
}
function hostSend(pid){publish(TOPIC+H.code+"/p/"+pid,hostSnapshot(pid));}
function hostBroadcast(){for(const pid in H.roster){if(H.roster[pid].online)hostSend(pid);}}
function hostChanged(){hostSave();hostBroadcast();render();}
function setState(patch){S=Object.assign({},S,patch);useQuiz(S.quiz);hostChanged();}
function hostPickQuiz(id){if(S.phase==="lobby"&&QUIZZES[id]){ls.set("hq-quiz",id);setState({quiz:id});}}

function hostStart(){setState({phase:"question",q:0,startedAt:Date.now()});}
function hostReveal(){if(S.phase==="question")setState({phase:"reveal"});}
function hostNext(){if(S.q+1<QS.length)setState({phase:"question",q:S.q+1,startedAt:Date.now()});else setState({phase:"final"});}
function hostReset(){
  for(const k in H.roster){if(!H.roster[k].online)delete H.roster[k];else H.roster[k].answers={};}
  setState({phase:"lobby",q:0,round:newRound(),startedAt:0});
}
function hostClose(){
  if(!confirm(tp("lobby.confirmClose")))return;
  if(client)client.end(true);
  client=null;ls.del("hq-host");
  goHome();
}

/* =====================================================================
   ИГРОК
   ===================================================================== */
const P={code:null,pid:null,name:ls.get("hq-name",""),since:0,lastState:0,
  players:[],answers:{},pending:null,timer:null};
let seen=ls.get("hq-seen",{});    // "round:q" -> локальное время показа вопроса

function startPlayer(code){
  if(!libAvailable())return;
  role="player";P.code=normCode(code);
  P.pid=ls.get("hq-pid","")||rand(16,ID_ABC);ls.set("hq-pid",P.pid);
  setRoomInURL(P.code);
  $("#leave").hidden=false;
  lastView="";
  if(P.name)playerConnect();
  render();
}

const upTopic=()=>TOPIC+P.code+"/up";
function live(){return Date.now()-P.lastState<OFFLINE_MS;}

function playerConnect(){
  if(client)return;
  setStatus(false,tp("status.connecting"));
  P.since=Date.now();
  client=connect({topic:upTopic(),payload:JSON.stringify({t:"bye",pid:P.pid}),qos:1,retain:false});
  client.on("connect",()=>{
    client.subscribe(TOPIC+P.code+"/p/"+P.pid,{qos:1});
    P.since=Date.now();
    sendHello();
  });
  client.on("message",(topic,buf)=>playerOnData(parse(buf)));
  client.on("offline",()=>{setStatus(false,tp("status.offline"));render();});
  client.on("reconnect",()=>setStatus(false,tp("status.reconnecting")));
  clearInterval(P.timer);
  P.timer=setInterval(()=>{sendHello();updatePlayerStatus();render();},PING_MS);
}

function sendHello(){
  if(!P.name)return;
  publish(upTopic(),{t:"hello",pid:P.pid,name:P.name});
  if(P.pending)publish(upTopic(),Object.assign({t:"answer",pid:P.pid},P.pending));
}

function updatePlayerStatus(){
  if(!client||!client.connected)return;
  if(live()&&P.hostVersion!==VERSION)setStatus(false,tp("status.versionMismatch"));
  else if(live())setStatus(true,tp("status.inRoom",{code:P.code}));
  else if(Date.now()-P.since>NOT_FOUND_MS)setStatus(false,tp("status.hostOffline"));
  else setStatus(false,tp("status.searching"));
}

function playerOnData(d){
  if(!d||role!=="player"||d.t!=="state"||!d.st||typeof d.st.phase!=="string")return;
  const st=d.st;
  const qs=(QUIZZES[st.quiz]||QUIZZES[DEFAULT_QUIZ]).questions;
  if(!(Number.isInteger(st.q)&&st.q>=0&&st.q<qs.length))return;
  useQuiz(st.quiz);
  S=st;P.lastState=Date.now();
  P.hostVersion=d.v||0;
  P.players=Array.isArray(d.players)?d.players:[];
  P.answers=(d.me&&d.me.answers)||{};
  if(P.pending&&(P.pending.round!==S.round||P.pending.q!==S.q||P.answers[S.q]))P.pending=null;
  if(S.phase==="question"){const k=S.round+":"+S.q;if(!seen[k]){seen[k]=Date.now();ls.set("hq-seen",seen);}}
  updatePlayerStatus();
  render();
}

function myAnswer(){
  if(!S)return null;
  if(P.answers[S.q])return P.answers[S.q];
  if(P.pending&&P.pending.round===S.round&&P.pending.q===S.q)return [P.pending.c,P.pending.ms];
  return null;
}

function join(name){
  name=(name||"").trim().slice(0,NAME_MAX);if(!name)return;
  P.name=name;ls.set("hq-name",name);lastView="";
  if(client)sendHello();else playerConnect();
  render();
}

function answer(i){
  if(!S||S.phase!=="question"||myAnswer())return;
  const ms=Math.min(TL,Date.now()-(seen[S.round+":"+S.q]||Date.now()));
  if(ms>=TL)return;
  P.pending={round:S.round,q:S.q,c:i,ms};
  publish(upTopic(),Object.assign({t:"answer",pid:P.pid},P.pending));
  render();
}

function playerLeave(){
  publish(upTopic(),{t:"bye",pid:P.pid});
  clearInterval(P.timer);
  if(client)client.end();
  client=null;P.pending=null;P.lastState=0;S=null;
  goHome();
}

/* ---------- конфетти ---------- */
const CONFETTI_COLORS=["#2f80c4","#3c9a5f","#d9932c","#d4584f","#e3b04b","#eaf3f6"];
let confettiDone="";   // ключ последнего салюта, чтобы перерисовка экрана не запускала его снова
function confettiOnce(key,big){if(confettiDone===key)return;confettiDone=key;confetti(big);}
/* big — длинный салют для итогового окна: залпы с двух сторон и дождь сверху. */
function confetti(big){
  const cv=document.createElement("canvas");cv.className="confetti";cv.setAttribute("aria-hidden","true");
  document.body.appendChild(cv);
  const ctx=cv.getContext("2d"),dpr=Math.min(2,window.devicePixelRatio||1);
  let W=0,H=0;
  const size=()=>{W=innerWidth;H=innerHeight;cv.width=W*dpr;cv.height=H*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);};
  size();addEventListener("resize",size);
  const k=Math.max(.6,H/800),parts=[];
  const add=(n,delay,fn)=>{for(let i=0;i<n;i++)parts.push(Object.assign({rot:Math.random()*6.3,vr:(Math.random()-.5)*.3,
    w:6+Math.random()*6,h:8+Math.random()*8,c:CONFETTI_COLORS[i%CONFETTI_COLORS.length],t:delay+Math.random()*120},fn()));};
  const side=left=>()=>({x:left?-10:W+10,y:H*.75,vx:(left?1:-1)*(4+Math.random()*10)*k,vy:-(9+Math.random()*12)*k});
  const bursts=big?3:1;
  for(let b=0;b<bursts;b++){add(70,b*900,side(true));add(70,b*900,side(false));}
  if(big)add(160,300,()=>({x:Math.random()*W,y:-20-Math.random()*H*.5,vx:(Math.random()-.5)*2,vy:1+Math.random()*3,t:300+Math.random()*3500}));
  const start=performance.now();let last=start;
  const frame=now=>{
    const dt=Math.min(3,(now-last)/16.7),el=now-start;last=now;
    ctx.clearRect(0,0,W,H);
    let alive=0;
    for(const p of parts){
      if(el<p.t){alive++;continue;}
      p.vy=Math.min(p.vy+.35*k*dt,4*k);p.vx*=Math.pow(.985,dt);
      p.x+=(p.vx+Math.sin((el+p.t)/300)*.8)*dt;p.y+=p.vy*dt;p.rot+=p.vr*dt;
      if(p.y>H+20)continue;
      alive++;
      ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.rot);ctx.fillStyle=p.c;
      ctx.fillRect(-p.w/2,-p.h/2*Math.abs(Math.cos(p.rot*2)),p.w,p.h*Math.abs(Math.cos(p.rot*2)));
      ctx.restore();
    }
    if(alive&&el<12000)requestAnimationFrame(frame);
    else{removeEventListener("resize",size);cv.remove();}
  };
  requestAnimationFrame(frame);
}

/* =====================================================================
   ОТРИСОВКА
   ===================================================================== */
function goHome(){role=null;S=null;lastView="";setRoomInURL(null);setStatus(false,"");$("#leave").hidden=true;render();}

function setHTML(html){if(html===lastHTML)return false;lastHTML=html;$("#main").innerHTML=html;return true;}

function render(){
  if(role==="host")renderHost();
  else if(role==="player")renderPlayer();
  else renderHome();
}

function renderHome(){
  if(lastView==="home")return;lastView="home";lastHTML="";
  const saved=ls.get("hq-host",null);
  $("#brand").textContent=tp("app.brand");document.title=tp("app.brand");
  const zs=Object.values(QUIZZES);
  $("#main").innerHTML=`<span class="eyebrow">${t("home.eyebrow",{quizzes:zs.map(z=>z.name).join(" · "),count:zs[0].questions.length})}</span>
    <h1>${t("home.title")}</h1>
    <p class="muted">${t("home.intro")}</p>
    <div class="choice">
      <div class="panel"><span class="eyebrow">${t("home.hostLabel")}</span>
        <p class="muted">${t("home.hostText")}</p>
        <button class="btn" id="host-new">${t("home.hostNew")}</button>
        ${saved&&saved.code?`<button class="btn ghost" id="host-resume">${t("home.hostResume",{code:saved.code})}</button>`:""}
      </div>
      <form class="panel" id="cf"><span class="eyebrow">${t("home.playerLabel")}</span>
        <label for="code" class="muted">${t("home.codeLabel")}</label>
        <input id="code" maxlength="8" autocomplete="off" autocapitalize="characters" placeholder="${t("home.codePlaceholder")}">
        <button class="btn" type="submit">${t("home.join")}</button>
      </form>
    </div>`;
  $("#host-new").onclick=()=>startHost(false);
  const r=$("#host-resume");if(r)r.onclick=()=>startHost(true);
  $("#cf").addEventListener("submit",e=>{e.preventDefault();const c=normCode($("#code").value);if(c)startPlayer(c);});
}

function boardHTML(list,max){
  return '<div class="board">'+list.slice(0,max).map(p=>`<div class="${p.me?"me":""}"><span>${esc(p.name)}</span><span class="pts">${p.score}</span></div>`).join("")+'</div>';
}
function finalHTML(ps){
  const top=ps.slice(0,3);
  return `<span class="eyebrow">${esc(QUIZ.finale)}</span><h1>${t("final.title")}</h1>
    ${top.length?`<div class="podium">${[1,0,2].map(i=>top[i]?`<div class="p${i+1}"><strong>${i+1}</strong>${esc(top[i].name)}<div class="muted">${top[i].score}</div></div>`:"<span></span>").join("")}</div>`+boardHTML(ps,50)
      :`<p class="muted">${esc(QUIZ.empty)}</p>`}`;
}
function timeLeft(){
  if(!S||S.phase!=="question")return 0;
  const start=role==="host"?S.startedAt:(seen[S.round+":"+S.q]||Date.now());
  return Math.max(0,TL-(Date.now()-start));
}

function renderHost(){
  lastView="host";
  const ps=ranked(hostPlayers()),online=ps.filter(p=>p.online);
  if(S.phase==="lobby"){
    const url=joinURL(H.code);
    const id=quizId();
    if(setHTML(`<span class="eyebrow">${t("lobby.eyebrow",{eyebrow:QUIZ.eyebrow})}</span>
      <h1>${QUIZ.title}</h1>
      <div class="row"><span class="muted">${t("lobby.quiz")}</span><div class="seg" id="quiz">${Object.entries(QUIZZES).map(([k,z])=>
        `<button type="button" data-q="${k}" aria-pressed="${k===id}">${esc(z.name)}</button>`).join("")}</div></div>
      <div class="panel invite">
        <div id="qr" aria-label="${t("lobby.qrLabel")}"></div>
        <div style="display:flex;flex-direction:column;gap:8px;min-width:0">
          <span class="eyebrow">${t("lobby.code")}</span><span class="code">${esc(H.code)}</span>
          <span class="muted">${t("lobby.scan")}</span><span class="link">${esc(url)}</span>
        </div>
      </div>
      <div class="notice">${t("lobby.keepOpen")}</div>
      <p class="muted">${t("lobby.rules",{count:QS.length,seconds:TL/1000,base:BASE,max:BASE+BONUS})}</p>
      <div class="panel"><div class="meta"><span>${t("lobby.players")}</span><span>${online.length}</span></div>
        <div class="chips" style="margin-top:12px">${ps.length?ps.map(p=>`<span class="chip ${p.online?"":"off"}">${esc(p.name)}</span>`).join(""):`<span class="muted">${t("lobby.nobody")}</span>`}</div></div>
      <div class="row"><button class="btn" id="go">${t("lobby.start")}</button><button class="btn ghost" id="cl">${t("lobby.close")}</button></div>`)){
      $("#go").onclick=hostStart;$("#cl").onclick=hostClose;
      $("#quiz").querySelectorAll("button").forEach(b=>b.onclick=()=>hostPickQuiz(b.dataset.q));
      if(window.QRCode)new QRCode($("#qr"),{text:url,width:160,height:160,correctLevel:QRCode.CorrectLevel.M});
      else $("#qr").hidden=true;
    }
    return;
  }
  if(S.phase==="final"){
    confettiOnce(S.round+":final",true);
    if(setHTML(finalHTML(ps)+`<div class="row"><button class="btn" id="again">${t("final.again")}</button><button class="btn ghost" id="cl">${t("lobby.close")}</button></div>`)){
      $("#again").onclick=hostReset;$("#cl").onclick=hostClose;
    }
    return;
  }
  const Q=QS[S.q],rev=S.phase==="reveal";
  const cnt=[0,0,0,0];ps.forEach(p=>{const a=p.answers[S.q];if(a)cnt[a[0]]++;});
  const answered=ps.filter(p=>p.done).length;
  const fast=ps.filter(p=>p.answers[S.q]&&p.answers[S.q][0]===Q.answer).sort((a,b)=>a.answers[S.q][1]-b.answers[S.q][1])[0];
  const round=S.q<Math.ceil(QS.length/2)?t("game.round1"):t("game.round2",{name:QUIZ.round2});
  if(setHTML(`<div class="meta"><span>${t("game.progress",{n:S.q+1,total:QS.length})} · ${round}</span><span>${rev?"":t("game.answered",{n:answered,total:online.length})}</span></div>
    ${rev?"":'<div class="bar"><i id="tb"></i></div>'}
    <h2>${esc(Q.question)}</h2>
    <div class="grid host">${Q.options.map((o,i)=>`<div class="tile t${i} ${rev?(i===Q.answer?"right":"dim"):""}"><b>${letter(i)}</b><span>${esc(o)}</span>${rev?`<span class="cnt">${cnt[i]}</span>`:""}</div>`).join("")}</div>
    ${rev?`<div class="why"><span class="eyebrow">${t("game.key")}</span><p>${letter(Q.answer)}. ${esc(Q.explanation||"")}</p></div>
      ${fast?`<p class="muted">${t("game.fastest",{name:fast.name,s:secs(fast.answers[S.q][1]),n:pts(S.q,fast.answers)})}</p>`:""}
      ${ps.length?`<span class="eyebrow">${t("game.leaders")}</span>`+boardHTML(ps,5):""}
      <div class="row"><button class="btn" id="nx">${S.q+1<QS.length?t("game.next"):t("game.results")}</button></div>`
     :`<div class="row"><button class="btn" id="rv">${t("game.reveal")}</button><span class="muted big" id="tn" style="font-size:32px"></span></div>`}
    <div class="row"><button class="btn ghost" id="rs">${t("game.restart")}</button></div>`)){
    if(rev)$("#nx").onclick=hostNext;else $("#rv").onclick=hostReveal;
    $("#rs").onclick=()=>{if(confirm(tp("game.confirmRestart")))hostReset();};
  }
  tick();
}

function renderPlayer(){
  const m=$("#main");
  if(!P.name){
    if(lastView==="join")return;lastView="join";lastHTML="";
    const z=QUIZ||QUIZZES[DEFAULT_QUIZ];
    m.innerHTML=`<span class="eyebrow">${t("player.room",{code:P.code})}</span>
      <h1>${QUIZ?QUIZ.title:t("home.title")}</h1>
      <p class="muted">${t("player.askName")}</p>
      <form id="jf" class="row" style="flex-direction:column;align-items:stretch;max-width:420px">
        <label for="nm" class="eyebrow">${t("player.nameLabel")}</label>
        <input id="nm" maxlength="${NAME_MAX}" autocomplete="nickname" placeholder="${esc(z.placeholder||"")}">
        <button class="btn" type="submit">${t("player.joinGame")}</button></form>`;
    $("#jf").addEventListener("submit",e=>{e.preventDefault();join($("#nm").value)});
    return;
  }
  lastView="player";
  const ps=P.players,mine=ps.find(p=>p.me);
  if(!S||!live()&&S.phase==="lobby"){
    const lost=client&&client.connected&&Date.now()-P.since>NOT_FOUND_MS;
    if(setHTML(`<span class="eyebrow">${t("player.hello",{name:P.name,code:P.code})}</span>
      <h1>${t("player.waitHost")}</h1>
      <p class="muted">${lost?t("player.notFound"):t("player.connecting")}</p>
      <div class="row"><button class="btn ghost" id="rn">${t("player.rename")}</button></div>`))bindRename();
    return;
  }
  if(S.phase==="lobby"){
    if(setHTML(`<span class="eyebrow">${t("player.inGame",{quiz:QUIZ.name,code:P.code})}</span><h1>${t("player.sitDown",{name:P.name})}</h1>
      <p class="muted">${t("player.waitStart")}</p>
      <div class="chips">${ps.filter(p=>p.online).map(p=>`<span class="chip ${p.me?"me":""}">${esc(p.name)}</span>`).join("")}</div>
      <div class="row"><button class="btn ghost" id="rn">${t("player.rename")}</button></div>`))bindRename();
    return;
  }
  if(S.phase==="final"){confettiOnce(S.round+":final",true);setHTML(finalHTML(ps));return;}
  const Q=QS[S.q],my=myAnswer(),rev=S.phase==="reveal";
  if(rev){
    const ok=my&&my[0]===Q.answer,place=ps.findIndex(p=>p.me)+1;
    if(ok)confettiOnce(S.round+":"+S.q,false);
    setHTML(`<div class="meta"><span>${t("game.progress",{n:S.q+1,total:QS.length})}</span><span>${t("player.points",{n:mine?mine.score:0})}</span></div>
      <div class="big ${ok?"ok":"bad"}">${ok?"+"+(BASE+bonus(my[1])):(my?t("player.miss"):t("player.noAnswer"))}</div>
      ${ok?`<p class="muted">${t("player.speed",{s:secs(my[1]),base:BASE,bonus:bonus(my[1])})}</p>`:""}
      <p>${t("player.correct",{letter:letter(Q.answer),text:Q.options[Q.answer]})}</p>
      ${place?`<p class="muted">${t("player.place",{place,total:ps.length})}</p>`:""}`);
    return;
  }
  if(setHTML(`<div class="meta"><span>${t("game.progress",{n:S.q+1,total:QS.length})}</span><span id="tn"></span></div><div class="bar"><i id="tb"></i></div>
    <p style="font-weight:800;font-size:18px">${esc(Q.question)}</p>
    <div class="grid player">${Q.options.map((o,i)=>my?`<div class="tile t${i} ${my[0]===i?"picked":"dim"}"><b>${letter(i)}</b><span>${esc(o)}</span></div>`:`<button type="button" class="tile t${i}" data-i="${i}"><b>${letter(i)}</b><span>${esc(o)}</span></button>`).join("")}</div>
    ${my?`<p class="muted">${t("player.accepted")}</p>`:""}`)){
    $("#main").querySelectorAll("button.tile").forEach(b=>b.onclick=()=>answer(+b.dataset.i));
  }
  tick();
}
function bindRename(){const b=$("#rn");if(b)b.onclick=()=>{P.name="";lastView="";render();};}

function tick(){
  const left=timeLeft(),tb=$("#tb"),tn=$("#tn");
  if(tb)tb.style.width=(left/TL*100)+"%";
  if(tn)tn.textContent=S&&S.phase==="question"?tp("app.seconds",{n:Math.ceil(left/1000)}):"";
  if(role==="host"&&S&&S.phase==="question"){
    const online=hostPlayers().filter(p=>p.online);
    if(left<=0||(online.length>0&&online.every(p=>p.done)))hostReveal();
  }
}
setInterval(tick,250);

/* ---------- старт ---------- */
$("#ver").textContent="v"+VERSION;
/* Свёрнутая вкладка теряет соединение — при возврате переподключаемся сразу. */
document.addEventListener("visibilitychange",()=>{
  if(document.visibilityState!=="visible"||!client)return;
  if(!client.connected)client.reconnect();
  if(role==="player")sendHello();
});
$("#leave").onclick=()=>{if(role==="host")hostClose();else if(role==="player")playerLeave();};
loadData().then(()=>{
  $("#ver").textContent=tp("app.version",{v:VERSION});
  if(params.get("room"))startPlayer(params.get("room"));
  else render();
},e=>{
  console.error(e);
  // texts.json мог не загрузиться — поэтому это единственная строка, написанная прямо в коде.
  $("#main").innerHTML=`<h1>Ошибка <em>загрузки</em></h1><div class="notice">${T.app?t("app.loadError"):"Не удалось загрузить файлы игры (data/*.json). Обновите страницу."}</div>`;
});
