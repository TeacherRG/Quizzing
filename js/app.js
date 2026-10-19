/* Хайфский квиз — многопользовательская версия.
 *
 * Сеть: WebRTC через PeerJS. Ведущий открывает комнату с коротким кодом
 * (peer id = PREFIX + код) и хранит всё авторитетное состояние игры:
 * фазу, номер вопроса, игроков и их ответы. Игроки подключаются к ведущему
 * по коду / ссылке / QR, присылают имя и ответы, а получают снимок состояния.
 * Сервер не нужен — достаточно статического хостинга (например GitHub Pages).
 *
 * Протокол (JSON):
 *   игрок → ведущий: {t:"hello",pid,name}   {t:"answer",round,q,c,ms}
 *   ведущий → игрок: {t:"state",st,players,me:{answers}}
 */
"use strict";

const L=["А","Б","В","Г"], TL=30000, PREFIX="haifa-quiz-", NAME_MAX=24;
const $=s=>document.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ls={
  get(k,d){try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}},
  set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}},
  del(k){try{localStorage.removeItem(k)}catch(e){}}
};
const rand=(n,abc)=>{let s="";const a=new Uint32Array(n);crypto.getRandomValues(a);for(const x of a)s+=abc[x%abc.length];return s;};
const newCode=()=>rand(5,"ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
const newRound=()=>rand(6,"abcdefghijklmnopqrstuvwxyz0123456789");
const normCode=s=>String(s||"").toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,8);

/* Свой PeerJS-сервер: ?peer=host[:port][/path]. По умолчанию — публичный 0.peerjs.com. */
const params=new URLSearchParams(location.search);
const PEER_OPTS=(()=>{
  const o={debug:1};
  const m=(params.get("peer")||"").match(/^([^:/]+)(?::(\d+))?(\/.*)?$/);
  if(m){o.host=m[1];o.secure=location.protocol==="https:";o.port=+(m[2]||(o.secure?443:80));o.path=m[3]||"/";}
  return o;
})();

let role=null;        // null (стартовый экран) | "host" | "player"
let peer=null;
let S=null;           // состояние игры {phase:"lobby"|"question"|"reveal"|"final", q, round, startedAt}
let lastHTML="", lastView="";

/* ---------- очки ---------- */
function pts(i,ans){const a=ans&&ans[i];if(!a||a[0]!==QS[i].a)return 0;return 500+Math.round(500*Math.max(0,1-a[1]/TL));}
function counted(i){return !!S&&(S.phase==="final"||i<S.q||(i===S.q&&S.phase==="reveal"));}
function scoreOf(ans){return QS.reduce((s,_,i)=>s+(counted(i)?pts(i,ans):0),0);}
function ranked(list){return list.slice().sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));}

/* ---------- статус соединения ---------- */
function setStatus(on,text){const s=$("#status");s.hidden=!text;s.classList.toggle("on",!!on);s.lastElementChild.textContent=text||"";}
function showNote(t){const n=document.createElement("div");n.className="notice";n.textContent=t;$("#main").prepend(n);}
function peerAvailable(){
  if(window.Peer)return true;
  $("#main").innerHTML=`<h1>Нет <em>связи</em></h1><div class="notice">Не удалось загрузить библиотеку PeerJS. Проверьте интернет и обновите страницу.</div>`;
  return false;
}
function setRoomInURL(code){
  const u=new URL(location.href);
  if(code)u.searchParams.set("room",code);else u.searchParams.delete("room");
  history.replaceState(null,"",u);
}
function joinURL(code){const u=new URL(location.href);u.search="";u.hash="";u.searchParams.set("room",code);if(params.get("peer"))u.searchParams.set("peer",params.get("peer"));return u.toString();}

/* =====================================================================
   ВЕДУЩИЙ
   ===================================================================== */
const H={code:null,roster:{},conns:new Map(),opening:false};   // roster: pid -> {name,answers,online}

function hostSave(){ls.set("hq-host",{code:H.code,S,roster:H.roster});}

function startHost(resume){
  if(!peerAvailable())return;
  role="host";
  const saved=resume&&ls.get("hq-host",null);
  if(saved&&saved.code&&saved.S){
    H.code=saved.code;S=saved.S;H.roster=saved.roster||{};
    for(const k in H.roster)H.roster[k].online=false;
  }else{
    H.code=newCode();H.roster={};
    S={phase:"lobby",q:0,round:newRound(),startedAt:0};
  }
  setRoomInURL(null);
  $("#leave").hidden=false;
  hostSave();openHostPeer(0);render();
}

function openHostPeer(attempt){
  H.opening=true;
  setStatus(false,"Открываем комнату…");
  const p=peer=new Peer(PREFIX+H.code,PEER_OPTS);
  p.on("open",()=>{H.opening=false;setStatus(true,"Комната открыта");});
  p.on("connection",hostAccept);
  p.on("disconnected",()=>setStatus(false,"Нет связи с сервером…"));
  p.on("error",e=>{
    if(e.type==="unavailable-id"){
      // Код ещё занят (например, ведущий только что перезагрузил страницу) — ждём, потом берём новый.
      p.destroy();
      if(attempt<3){setStatus(false,"Код занят, пробуем снова…");setTimeout(()=>openHostPeer(attempt+1),3000);}
      else{H.code=newCode();hostSave();render();openHostPeer(0);}
      return;
    }
    H.opening=false;
    if(e.type==="browser-incompatible")showNote("Этот браузер не поддерживает WebRTC — откройте игру в Chrome, Safari или Firefox.");
    else setStatus(false,"Нет связи с сервером…");
  });
}

function hostAccept(conn){
  conn.on("data",d=>hostOnData(conn,d));
  conn.on("close",()=>{
    const pid=H.conns.get(conn);H.conns.delete(conn);
    if(pid&&H.roster[pid]&&![...H.conns.values()].includes(pid)){H.roster[pid].online=false;hostChanged();}
  });
  conn.on("error",()=>{});
}

function hostOnData(conn,d){
  if(!d||typeof d!=="object")return;
  if(d.t==="hello"){
    const pid=typeof d.pid==="string"?d.pid.slice(0,64):"";
    const name=typeof d.name==="string"?d.name.trim().slice(0,NAME_MAX):"";
    if(!pid||!name)return;
    const old=H.roster[pid];
    H.roster[pid]={name,answers:(old&&old.answers)||{},online:true};
    H.conns.set(conn,pid);
    hostChanged();
    return;
  }
  if(d.t==="answer"){
    const pid=H.conns.get(conn),p=pid&&H.roster[pid];
    if(!p||!S||S.phase!=="question"||d.round!==S.round||d.q!==S.q||p.answers[S.q])return;
    const c=+d.c,elapsed=Date.now()-S.startedAt;
    if(!(c>=0&&c<4)||elapsed>TL+2000)return;
    // Время меряет телефон игрока (с момента показа вопроса), но не больше, чем прошло у ведущего.
    const ms=Math.max(0,Math.min(TL-1,+d.ms||0,elapsed));
    p.answers[S.q]=[Math.floor(c),ms];
    hostChanged();
  }
}

function hostPlayers(){
  return Object.entries(H.roster).map(([k,p])=>({k,name:p.name,online:p.online,answers:p.answers,
    done:!!(S&&p.answers[S.q]),score:scoreOf(p.answers)}));
}
function hostSnapshot(pid){
  const players=ranked(hostPlayers()).map(p=>({name:p.name,score:p.score,online:p.online,done:p.done,me:p.k===pid}));
  return {t:"state",st:S,players,me:{answers:(H.roster[pid]&&H.roster[pid].answers)||{}}};
}
function hostBroadcast(){
  for(const [conn,pid] of H.conns){if(conn.open){try{conn.send(hostSnapshot(pid))}catch(e){}}}
}
function hostChanged(){hostSave();hostBroadcast();render();}
function setState(patch){S=Object.assign({},S,patch);hostChanged();}

function hostStart(){setState({phase:"question",q:0,startedAt:Date.now()});}
function hostReveal(){if(S.phase==="question")setState({phase:"reveal"});}
function hostNext(){if(S.q+1<QS.length)setState({phase:"question",q:S.q+1,startedAt:Date.now()});else setState({phase:"final"});}
function hostReset(){
  for(const k in H.roster){if(!H.roster[k].online)delete H.roster[k];else H.roster[k].answers={};}
  setState({phase:"lobby",q:0,round:newRound(),startedAt:0});
}
function hostClose(){
  if(!confirm("Закрыть комнату? Все игроки отключатся, результаты пропадут."))return;
  if(peer)peer.destroy();
  peer=null;H.conns.clear();ls.del("hq-host");
  goHome();
}

/* =====================================================================
   ИГРОК
   ===================================================================== */
const P={code:null,pid:null,name:ls.get("hq-name",""),conn:null,connectingSince:0,notFound:false,
  players:[],answers:{},pending:null};
let seen=ls.get("hq-seen",{});    // "round:q" -> локальное время показа вопроса

function startPlayer(code){
  if(!peerAvailable())return;
  role="player";P.code=normCode(code);
  P.pid=ls.get("hq-pid","")||rand(16,"abcdefghijklmnopqrstuvwxyz0123456789");ls.set("hq-pid",P.pid);
  setRoomInURL(P.code);
  $("#leave").hidden=false;
  lastView="";
  if(P.name)playerConnect();
  render();
}

function playerConnect(){
  if(peer&&!peer.destroyed){if(peer.open)openConn();return;}
  setStatus(false,"Подключаемся…");
  const p=peer=new Peer(PEER_OPTS);
  p.on("open",openConn);
  p.on("disconnected",()=>setStatus(false,"Нет связи с сервером…"));
  p.on("error",e=>{
    P.connectingSince=0;
    if(e.type==="peer-unavailable"){P.notFound=true;setStatus(false,"Комната не найдена");render();}
    else if(e.type==="browser-incompatible")showNote("Этот браузер не поддерживает WebRTC — откройте игру в Chrome, Safari или Firefox.");
    else setStatus(false,"Нет связи с сервером…");
  });
}

function openConn(){
  if(!peer||!peer.open||(P.conn&&P.conn.open)||P.connectingSince)return;
  P.connectingSince=Date.now();
  const c=peer.connect(PREFIX+P.code,{reliable:true,serialization:"json"});
  c.on("open",()=>{
    P.conn=c;P.connectingSince=0;P.notFound=false;
    setStatus(true,"В комнате "+P.code);
    sendHello();
    if(P.pending)c.send(Object.assign({t:"answer"},P.pending));
    render();
  });
  c.on("data",playerOnData);
  c.on("close",()=>{if(P.conn===c)P.conn=null;P.connectingSince=0;if(role==="player")setStatus(false,"Переподключаемся…");render();});
  c.on("error",()=>{P.connectingSince=0;});
}

function sendHello(){if(P.conn&&P.conn.open&&P.name)P.conn.send({t:"hello",pid:P.pid,name:P.name});}

function playerOnData(d){
  if(!d||d.t!=="state"||!d.st||typeof d.st.phase!=="string")return;
  const st=d.st;
  if(!(Number.isInteger(st.q)&&st.q>=0&&st.q<QS.length))return;
  S=st;
  P.players=Array.isArray(d.players)?d.players:[];
  P.answers=(d.me&&d.me.answers)||{};
  if(P.pending&&(P.pending.round!==S.round||P.pending.q!==S.q||P.answers[S.q]))P.pending=null;
  if(S.phase==="question"){const k=S.round+":"+S.q;if(!seen[k]){seen[k]=Date.now();ls.set("hq-seen",seen);}}
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
  if(P.conn&&P.conn.open)sendHello();else playerConnect();
  render();
}

function answer(i){
  if(!S||S.phase!=="question"||myAnswer())return;
  const ms=Math.min(TL,Date.now()-(seen[S.round+":"+S.q]||Date.now()));
  if(ms>=TL)return;
  P.pending={round:S.round,q:S.q,c:i,ms};
  if(P.conn&&P.conn.open)P.conn.send(Object.assign({t:"answer"},P.pending));
  render();
}

function playerLeave(){
  if(P.conn)P.conn.close();
  if(peer)peer.destroy();
  peer=null;P.conn=null;P.pending=null;S=null;
  goHome();
}

/* ---------- сторож соединения: переподключение игрока и ведущего ---------- */
setInterval(()=>{
  if(role==="host"&&peer&&!H.opening){
    if(peer.destroyed)openHostPeer(0);
    else if(peer.disconnected)peer.reconnect();
  }
  if(role==="player"&&P.name){
    if(P.connectingSince&&Date.now()-P.connectingSince>8000)P.connectingSince=0;
    if(!peer||peer.destroyed)playerConnect();
    else if(peer.disconnected)peer.reconnect();
    else openConn();
  }
},3000);

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
  $("#main").innerHTML=`<span class="eyebrow">Суржик-иврит спешл · 12 вопросов</span>
    <h1>Хайфский <em>семейный</em> квиз</h1>
    <p class="muted">Ведущий открывает игру на большом экране, игроки отвечают с телефонов.</p>
    <div class="choice">
      <div class="panel"><span class="eyebrow">Я ведущий</span>
        <p class="muted">Создайте комнату и покажите код или QR игрокам.</p>
        <button class="btn" id="host-new">Создать комнату</button>
        ${saved&&saved.code?`<button class="btn ghost" id="host-resume">Вернуться в комнату ${esc(saved.code)}</button>`:""}
      </div>
      <form class="panel" id="cf"><span class="eyebrow">Я игрок</span>
        <label for="code" class="muted">Код комнаты с экрана ведущего</label>
        <input id="code" maxlength="8" autocomplete="off" autocapitalize="characters" placeholder="Например, K7QXM">
        <button class="btn" type="submit">Войти</button>
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
  const t=ps.slice(0,3);
  return `<span class="eyebrow">Финал · Кармель взят</span><h1>Итоги <em>квиза</em></h1>
    ${t.length?`<div class="podium">${[1,0,2].map(i=>t[i]?`<div class="p${i+1}"><strong>${i+1}</strong>${esc(t[i].name)}<div class="muted">${t[i].score}</div></div>`:"<span></span>").join("")}</div>`+boardHTML(ps,50)
      :'<p class="muted">Никто не отвечал с телефона. Кабаны победили.</p>'}`;
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
    if(setHTML(`<span class="eyebrow">Лобби · ждём игроков</span>
      <h1>Хайфский <em>семейный</em> квиз</h1>
      <div class="panel invite">
        <div id="qr" aria-label="QR-код для входа"></div>
        <div style="display:flex;flex-direction:column;gap:8px;min-width:0">
          <span class="eyebrow">Код комнаты</span><span class="code">${esc(H.code)}</span>
          <span class="muted">Отсканируйте QR или откройте ссылку:</span><span class="link">${esc(url)}</span>
        </div>
      </div>
      <p class="muted">12 вопросов, по 30 секунд. Правильный ответ даёт 500 очков и до 500 бонусных за скорость.</p>
      <div class="panel"><div class="meta"><span>Игроки в комнате</span><span>${online.length}</span></div>
        <div class="chips" style="margin-top:12px">${ps.length?ps.map(p=>`<span class="chip ${p.online?"":"off"}">${esc(p.name)}</span>`).join(""):'<span class="muted">Пока никого. Первый, кто зайдёт, появится здесь.</span>'}</div></div>
      <div class="row"><button class="btn" id="go">Начать игру</button><button class="btn ghost" id="cl">Закрыть комнату</button></div>`)){
      $("#go").onclick=hostStart;$("#cl").onclick=hostClose;
      if(window.QRCode)new QRCode($("#qr"),{text:url,width:160,height:160,correctLevel:QRCode.CorrectLevel.M});
      else $("#qr").hidden=true;
    }
    return;
  }
  if(S.phase==="final"){
    if(setHTML(finalHTML(ps)+`<div class="row"><button class="btn" id="again">Новая игра</button><button class="btn ghost" id="cl">Закрыть комнату</button></div>`)){
      $("#again").onclick=hostReset;$("#cl").onclick=hostClose;
    }
    return;
  }
  const Q=QS[S.q],rev=S.phase==="reveal";
  const cnt=[0,0,0,0];ps.forEach(p=>{const a=p.answers[S.q];if(a)cnt[a[0]]++;});
  const answered=ps.filter(p=>p.done).length;
  if(setHTML(`<div class="meta"><span>Вопрос ${S.q+1} из ${QS.length} · ${S.q<6?"Раунд 1":"Раунд 2 · Финальный штурм Кармеля"}</span><span>${rev?"":"Ответили: "+answered+" из "+online.length}</span></div>
    ${rev?"":'<div class="bar"><i id="tb"></i></div>'}
    <h2>${esc(Q.q)}</h2>
    <div class="grid host">${Q.o.map((o,i)=>`<div class="tile t${i} ${rev?(i===Q.a?"right":"dim"):""}"><b>${L[i]}</b><span>${esc(o)}</span>${rev?`<span class="cnt">${cnt[i]}</span>`:""}</div>`).join("")}</div>
    ${rev?`<div class="why"><span class="eyebrow">Ключ ведущего</span><p>${L[Q.a]}. ${esc(Q.why)}</p></div>
      ${ps.length?`<span class="eyebrow">Таблица лидеров</span>`+boardHTML(ps,5):""}
      <div class="row"><button class="btn" id="nx">${S.q+1<QS.length?"Следующий вопрос":"Итоги игры"}</button></div>`
     :`<div class="row"><button class="btn" id="rv">Показать ответ</button><span class="muted big" id="tn" style="font-size:32px"></span></div>`}
    <div class="row"><button class="btn ghost" id="rs">Начать заново</button></div>`)){
    if(rev)$("#nx").onclick=hostNext;else $("#rv").onclick=hostReveal;
    $("#rs").onclick=()=>{if(confirm("Начать игру заново? Очки обнулятся."))hostReset();};
  }
  tick();
}

function renderPlayer(){
  const m=$("#main");
  if(!P.name){
    if(lastView==="join")return;lastView="join";lastHTML="";
    m.innerHTML=`<span class="eyebrow">Комната ${esc(P.code)}</span>
      <h1>Хайфский <em>семейный</em> квиз</h1>
      <p class="muted">Как тебя записать в таблицу лидеров?</p>
      <form id="jf" class="row" style="flex-direction:column;align-items:stretch;max-width:420px">
        <label for="nm" class="eyebrow">Имя или ник</label>
        <input id="nm" maxlength="${NAME_MAX}" autocomplete="nickname" placeholder="Например, Кабан из Адара">
        <button class="btn" type="submit">Войти в игру</button></form>`;
    $("#jf").addEventListener("submit",e=>{e.preventDefault();join($("#nm").value)});
    return;
  }
  lastView="player";
  const ps=P.players,mine=ps.find(p=>p.me);
  if(!S||!(P.conn&&P.conn.open)&&S.phase==="lobby"){
    if(setHTML(`<span class="eyebrow">Привет, ${esc(P.name)} · комната ${esc(P.code)}</span>
      <h1>Ждём <em>ведущего</em></h1>
      <p class="muted">${P.notFound?"Комната с таким кодом пока не открыта. Проверьте код — мы продолжаем пытаться подключиться.":"Подключаемся к комнате…"}</p>
      <div class="row"><button class="btn ghost" id="rn">Сменить имя</button></div>`))bindRename();
    return;
  }
  if(S.phase==="lobby"){
    if(setHTML(`<span class="eyebrow">Ты в игре · комната ${esc(P.code)}</span><h1>${esc(P.name)}, <em>сядь поудобнее</em></h1>
      <p class="muted">Вопросы появятся, когда ведущий начнёт.</p>
      <div class="chips">${ps.filter(p=>p.online).map(p=>`<span class="chip ${p.me?"me":""}">${esc(p.name)}</span>`).join("")}</div>
      <div class="row"><button class="btn ghost" id="rn">Сменить имя</button></div>`))bindRename();
    return;
  }
  if(S.phase==="final"){setHTML(finalHTML(ps));return;}
  const Q=QS[S.q],my=myAnswer(),rev=S.phase==="reveal";
  if(rev){
    const ok=my&&my[0]===Q.a,place=ps.findIndex(p=>p.me)+1;
    setHTML(`<div class="meta"><span>Вопрос ${S.q+1} из ${QS.length}</span><span>${mine?mine.score:0} очков</span></div>
      <div class="big ${ok?"ok":"bad"}">${ok?"+"+pts(S.q,P.answers):(my?"Мимо":"Без ответа")}</div>
      <p>Правильно: <b>${L[Q.a]}. ${esc(Q.o[Q.a])}</b></p>
      ${place?`<p class="muted">Ты на ${place}-м месте из ${ps.length}.</p>`:""}`);
    return;
  }
  if(setHTML(`<div class="meta"><span>Вопрос ${S.q+1} из ${QS.length}</span><span id="tn"></span></div><div class="bar"><i id="tb"></i></div>
    <p style="font-weight:800;font-size:18px">${esc(Q.q)}</p>
    <div class="grid player">${Q.o.map((o,i)=>my?`<div class="tile t${i} ${my[0]===i?"picked":"dim"}"><b>${L[i]}</b><span>${esc(o)}</span></div>`:`<button type="button" class="tile t${i}" data-i="${i}"><b>${L[i]}</b><span>${esc(o)}</span></button>`).join("")}</div>
    ${my?'<p class="muted">Ответ принят. Ждём, пока ведущий откроет правильный.</p>':""}`)){
    $("#main").querySelectorAll("button.tile").forEach(b=>b.onclick=()=>answer(+b.dataset.i));
  }
  tick();
}
function bindRename(){const b=$("#rn");if(b)b.onclick=()=>{P.name="";lastView="";render();};}

function tick(){
  const left=timeLeft(),tb=$("#tb"),tn=$("#tn");
  if(tb)tb.style.width=(left/TL*100)+"%";
  if(tn)tn.textContent=S&&S.phase==="question"?Math.ceil(left/1000)+" c":"";
  if(role==="host"&&S&&S.phase==="question"){
    const online=hostPlayers().filter(p=>p.online);
    if(left<=0||(online.length>0&&online.every(p=>p.done)))hostReveal();
  }
}
setInterval(tick,250);

/* ---------- старт ---------- */
$("#leave").onclick=()=>{if(role==="host")hostClose();else if(role==="player")playerLeave();};
if(params.get("room"))startPlayer(params.get("room"));
else render();
