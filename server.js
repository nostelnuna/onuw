const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const HOST_PIN = '2146'; // 관리자 비밀번호

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 직업 정의
const ROLES = {
  WEREWOLF: { name: '늑대인간', team: 'WEREWOLF', icon: '🐺', desc: '밤에 동료 늑대를 확인합니다. 홀로 늑대라면 중앙 카드 1장을 볼 수 있습니다.' },
  MINION: { name: '하수인(미니언)', team: 'WEREWOLF', icon: '🦹', desc: '누가 늑대인지 압니다. 늑대 대신 처형당해 늑대 진영을 승리시키는 역할입니다.' },
  MASON: { name: '석공(비밀결사)', team: 'VILLAGE', icon: '⚒️', desc: '밤에 서로 눈을 마주쳐 다른 석공이 누구인지 확인합니다.' },
  SEER: { name: '예언자', team: 'VILLAGE', icon: '🔮', desc: '다른 플레이어 1명의 카드를 보거나, 중앙 카드 2장을 훔쳐봅니다.' },
  ROBBER: { name: '강도', team: 'VILLAGE', icon: '🦝', desc: '다른 플레이어 1명의 카드를 훔쳐 내 카드와 바꾸고, 바뀐 내 새 직업을 확인합니다.' },
  TROUBLEMAKER: { name: '말썽쟁이', team: 'VILLAGE', icon: '🃏', desc: '다른 두 사람의 카드를 서로 몰래 맞바꿉니다 (본인 카드는 안 바꿈).' },
  DRUNK: { name: '주정뱅이', team: 'VILLAGE', icon: '🍺', desc: '내 카드를 중앙 카드 1장과 무작위로 교환합니다 (자신은 바뀐 카드를 모름).' },
  INSOMNIAC: { name: '불면증환자', team: 'VILLAGE', icon: '👁️', desc: '밤의 끝에 깨어나 내 카드가 다른 사람에 의해 바뀌었는지 최종 확인합니다.' },
  HUNTER: { name: '사냥꾼', team: 'VILLAGE', icon: '🏹', desc: '자신이 투표로 처형당할 때, 자신이 지목한 사람도 함께 처형시킵니다.' },
  TANNER: { name: '무두장이', team: 'TANNER', icon: '🪓', desc: '삶에 지쳐 죽고 싶어 합니다. 자신이 투표로 처형당하면 단독 승리합니다!' },
  VILLAGER: { name: '선량한 주민', team: 'VILLAGE', icon: '🧑‍🌾', desc: '특수 능력은 없지만 오직 논리와 추리로 늑대인간을 찾아내야 합니다.' },
  MODERATOR: { name: '진행 사회자', team: 'SPECTATOR', icon: '🎙️', desc: '게임에 직접 참여하지 않고 전체 진행 및 관전을 총괄합니다.' }
};

// 5~35인 황금 직업 밸런스 공식 (항상 플레이어 수 + 3장의 카드 생성)
function getAutoRoleDeck(total) {
  total = Math.max(5, Math.min(35, total));
  const totalCards = total + 3; // 중앙 카드 3장 필수
  
  let werewolf = 2;
  let minion = 0;
  let mason = 0;
  let seer = 1;
  let robber = 1;
  let troublemaker = 1;
  let drunk = 1;
  let insomniac = 1;
  let hunter = 0;
  let tanner = 0;

  if (total <= 6) {
    werewolf = 2; minion = 0; mason = 0; hunter = 0; tanner = 0;
  } else if (total <= 8) {
    werewolf = 2; minion = 1; mason = 2; hunter = 0; tanner = 0;
  } else if (total <= 12) {
    werewolf = 2; minion = 1; mason = 2; hunter = 1; tanner = 1;
  } else if (total <= 16) {
    werewolf = 3; minion = 1; mason = 2; hunter = 1; tanner = 1;
  } else if (total <= 21) {
    werewolf = 4; minion = 1; mason = 2; hunter = 1; tanner = 1;
  } else if (total <= 26) {
    werewolf = 5; minion = 2; mason = 2; hunter = 1; tanner = 1;
  } else if (total <= 30) {
    werewolf = 6; minion = 2; mason = 2; hunter = 1; tanner = 1;
  } else {
    werewolf = 7; minion = 2; mason = 2; hunter = 1; tanner = 1;
  }

  const specialCount = werewolf + minion + mason + seer + robber + troublemaker + drunk + insomniac + hunter + tanner;
  const villager = Math.max(0, totalCards - specialCount);

  return {
    werewolf, minion, mason, seer, robber, troublemaker, drunk, insomniac, hunter, tanner, villager,
    totalPlayers: total,
    totalCards: totalCards
  };
}

// 게임 전역 상태
const gameState = {
  roomCode: 'ONUW',
  phase: 'LOBBY', // LOBBY, NIGHT, DAY_DISCUSS, VOTING, GAME_OVER
  round: 1,
  players: [], // { socketId, token, id, name, initialRole, currentRole, isHost, isModerator }
  centerCards: [], // [card0, card1, card2]
  roleDeckConfig: getAutoRoleDeck(5),
  timerSeconds: 0,
  timerInterval: null,
  isTimerPaused: false,
  nightActions: {
    seerResult: null,
    robberTargetId: null,
    troublemakerPair: null, // [idA, idB]
    drunkCenterIndex: null
  },
  votes: {}, // { [voterId]: targetPlayerId }
  voteResults: null, // { topVotes, killedPlayers }
  winner: null,
  winReason: null
};

// 유령 소켓 완전 정리 (두 번째 판 밸런스 붕괴 방지)
function cleanupDeadSockets() {
  if (gameState.phase !== 'LOBBY') return;
  const activeSockets = io.sockets.sockets;
  const beforeCount = gameState.players.length;

  gameState.players = gameState.players.filter(p => {
    const s = activeSockets.get(p.socketId);
    return s && s.connected;
  });

  if (beforeCount !== gameState.players.length) {
    console.log(`[ONUW 접속자 정리] ${beforeCount}명 -> 실제 연결 ${gameState.players.length}명`);
  }
}

function broadcastSystemMsg(text, channel = 'all') {
  const msgObj = {
    id: crypto.randomUUID(),
    sender: '📢 시스템',
    text: text,
    channel: channel,
    isSystem: true,
    time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
  };
  io.emit('chat:message', msgObj);
}

function broadcastState() {
  cleanupDeadSockets();
  const playingCount = gameState.players.filter(p => !p.isModerator).length;
  gameState.roleDeckConfig = getAutoRoleDeck(playingCount >= 5 ? playingCount : 5);

  io.emit('state:update', {
    phase: gameState.phase,
    round: gameState.round,
    playerCount: gameState.players.length,
    playingCount: playingCount,
    roleDeckConfig: gameState.roleDeckConfig,
    timerSeconds: gameState.timerSeconds,
    isTimerPaused: gameState.isTimerPaused,
    players: gameState.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      isModerator: p.isModerator,
      // 게임 종료 시에만 최초 직업과 최종 직업 모두 공개
      initialRole: gameState.phase === 'GAME_OVER' ? p.initialRole : null,
      currentRole: gameState.phase === 'GAME_OVER' ? p.currentRole : null
    })),
    centerCards: gameState.phase === 'GAME_OVER' ? gameState.centerCards : [null, null, null],
    voteResults: gameState.voteResults,
    winner: gameState.winner,
    winReason: gameState.winReason
  });
}

function startTimer(seconds, onComplete) {
  clearInterval(gameState.timerInterval);
  gameState.timerSeconds = seconds;
  gameState.isTimerPaused = false;
  io.emit('timer:tick', { seconds: gameState.timerSeconds, isPaused: false });

  gameState.timerInterval = setInterval(() => {
    if (!gameState.isTimerPaused) {
      gameState.timerSeconds--;
      io.emit('timer:tick', { seconds: gameState.timerSeconds, isPaused: false });
      if (gameState.timerSeconds <= 0) {
        clearInterval(gameState.timerInterval);
        if (onComplete) onComplete();
      }
    }
  }, 1000);
}

// 개별 플레이어에게 초기 카드 및 동료 정보 전송
function sendSecretNightInfo() {
  const playingPlayers = gameState.players.filter(p => !p.isModerator);
  const werewolves = playingPlayers.filter(p => p.initialRole === 'WEREWOLF');
  const masons = playingPlayers.filter(p => p.initialRole === 'MASON');

  gameState.players.forEach(p => {
    if (!p.socketId) return;

    if (p.isModerator) {
      io.to(p.socketId).emit('secret_card', {
        role: 'MODERATOR',
        roleName: '진행 사회자',
        icon: '🎙️',
        desc: '게임에 직접 참여하지 않으며, 전체 관전 및 시간 조절을 총괄합니다.',
        teammates: []
      });
      return;
    }

    const roleObj = ROLES[p.initialRole] || ROLES.VILLAGER;
    let teammates = [];
    let isLoneWerewolf = false;

    if (p.initialRole === 'WEREWOLF') {
      teammates = werewolves.filter(w => w.id !== p.id).map(w => w.name);
      isLoneWerewolf = werewolves.length === 1;
    } else if (p.initialRole === 'MINION') {
      teammates = werewolves.map(w => w.name);
    } else if (p.initialRole === 'MASON') {
      teammates = masons.filter(m => m.id !== p.id).map(m => m.name);
    }

    io.to(p.socketId).emit('secret_card', {
      role: p.initialRole,
      roleName: roleObj.name,
      team: roleObj.team,
      icon: roleObj.icon,
      desc: roleObj.desc,
      teammates: teammates,
      isLoneWerewolf: isLoneWerewolf
    });
  });
}

// 밤 행동 우선순위 정산 (ONUW 정석 룰 적용)
function resolveNightActions() {
  const playingPlayers = gameState.players.filter(p => !p.isModerator);

  // 1. 강도(Robber) 정산: 지정한 플레이어와 카드를 맞바꾸고, 바뀐 새 카드를 확인
  if (gameState.nightActions.robberTargetId) {
    const robber = playingPlayers.find(p => p.initialRole === 'ROBBER');
    const target = playingPlayers.find(p => p.id === gameState.nightActions.robberTargetId);
    if (robber && target) {
      const stolenRole = target.currentRole;
      target.currentRole = robber.currentRole;
      robber.currentRole = stolenRole;
      // 강도에게 훔쳐온 새 카드 전송
      io.to(robber.socketId).emit('night_feedback', {
        title: '🦝 강도질 성공!',
        message: `[${target.name}] 님의 카드(${ROLES[stolenRole].name})를 훔쳤습니다! 당신의 새 직업은 [${ROLES[stolenRole].name}]입니다.`
      });
    }
  }

  // 2. 말썽쟁이(Troublemaker) 정산: 다른 두 사람의 카드를 서로 맞바꿈 (본인 카드는 안 바꿈)
  if (gameState.nightActions.troublemakerPair && gameState.nightActions.troublemakerPair.length === 2) {
    const [idA, idB] = gameState.nightActions.troublemakerPair;
    const playerA = playingPlayers.find(p => p.id === idA);
    const playerB = playingPlayers.find(p => p.id === idB);
    if (playerA && playerB) {
      const temp = playerA.currentRole;
      playerA.currentRole = playerB.currentRole;
      playerB.currentRole = temp;
    }
  }

  // 3. 주정뱅이(Drunk) 정산: 자신의 카드를 중앙 카드 중 하나와 무작위로 교환
  if (gameState.nightActions.drunkCenterIndex !== null) {
    const drunk = playingPlayers.find(p => p.initialRole === 'DRUNK');
    const cIdx = gameState.nightActions.drunkCenterIndex;
    if (drunk && cIdx >= 0 && cIdx < 3) {
      const temp = drunk.currentRole;
      drunk.currentRole = gameState.centerCards[cIdx];
      gameState.centerCards[cIdx] = temp;
    }
  }

  // 4. 불면증환자(Insomniac) 정산: 밤이 끝날 때 자신의 최종 카드를 확인
  const insomniac = playingPlayers.find(p => p.initialRole === 'INSOMNIAC');
  if (insomniac && insomniac.socketId) {
    const finalRoleObj = ROLES[insomniac.currentRole];
    io.to(insomniac.socketId).emit('night_feedback', {
      title: '👁️ 불면증환자 확인',
      message: `밤의 끝에 확인한 당신의 최종 카드는 [${finalRoleObj.name}]입니다!`
    });
  }
}

// 승리 조건 판정 (ONUW 정석 룰)
function resolveGameOutcome() {
  const playingPlayers = gameState.players.filter(p => !p.isModerator);
  const voteCounts = {};
  playingPlayers.forEach(p => voteCounts[p.id] = 0);

  // 투표 집계
  Object.values(gameState.votes).forEach(targetId => {
    if (voteCounts[targetId] !== undefined) voteCounts[targetId]++;
  });

  // 최다 득표수 계산
  let maxVotes = 0;
  Object.values(voteCounts).forEach(cnt => {
    if (cnt > maxVotes) maxVotes = cnt;
  });

  // 처형자 목록 (최다 득표가 2표 이상이면 최다 득표자 전원 처형, 모두 1표 이하면 아무도 안 죽음)
  let killed = [];
  if (maxVotes >= 2) {
    killed = playingPlayers.filter(p => voteCounts[p.id] === maxVotes);
  }

  // 사냥꾼(Hunter) 판정: 사냥꾼이 처형되면 사냥꾼이 투표한 사람도 같이 사망
  const killedHunters = killed.filter(p => p.currentRole === 'HUNTER');
  killedHunters.forEach(h => {
    const hunterTargetId = gameState.votes[h.id];
    const targetPlayer = playingPlayers.find(p => p.id === hunterTargetId);
    if (targetPlayer && !killed.some(k => k.id === targetPlayer.id)) {
      killed.push(targetPlayer);
      broadcastSystemMsg(`🏹 사냥꾼 [${h.name}] 님이 처형되면서 [${targetPlayer.name}] 님을 함께 쏘아 처형시켰습니다!`);
    }
  });

  // 승리 조건 계산
  const currentWerewolves = playingPlayers.filter(p => p.currentRole === 'WEREWOLF');
  const killedWerewolves = killed.filter(p => p.currentRole === 'WEREWOLF');
  const killedTanners = killed.filter(p => p.currentRole === 'TANNER');

  let winner = 'WEREWOLF';
  let reason = '';

  // 1순위: 무두장이 승리 (무두장이가 죽으면 무두장이 단독 승리)
  if (killedTanners.length > 0) {
    winner = 'TANNER';
    reason = `무두장이 [${killedTanners.map(t => t.name).join(', ')}] 님이 처형당하여 단독 승리했습니다! 🪓`;
  // 2순위: 늑대인간이 처형됨 -> 마을 진영 승리!
  } else if (killedWerewolves.length > 0) {
    winner = 'VILLAGE';
    reason = `늑대인간 [${killedWerewolves.map(w => w.name).join(', ')}] 님이 처형되었습니다! 마을 진영 승리! 🕊️`;
  // 3순위: 늑대가 아무도 안 죽음
  } else {
    // 만약 플레이어 중에 늑대가 실제로 있었는가?
    if (currentWerewolves.length > 0) {
      winner = 'WEREWOLF';
      reason = `늑대인간이 아무도 처형당하지 않았습니다! 늑대인간 진영 승리! 🐺`;
    } else {
      // 늑대가 모두 중앙에 있었던 평화로운 판 (No Werewolves in play)
      if (killed.length === 0) {
        winner = 'VILLAGE';
        reason = `늑대인간이 아무도 없었으며, 아무도 처형되지 않았습니다! 마을의 평화 승리! 🕊️`;
      } else {
        winner = 'WEREWOLF';
        reason = `늑대인간이 없었으나 무고한 주민이 처형되었습니다! 늑대/미니언 진영 승리! 🐺`;
      }
    }
  }

  gameState.winner = winner;
  gameState.winReason = reason;
  gameState.voteResults = {
    voteCounts: voteCounts,
    maxVotes: maxVotes,
    killed: killed.map(k => ({ id: k.id, name: k.name, finalRole: k.currentRole }))
  };
}

io.on('connection', (socket) => {
  socket.emit('init', {
    phase: gameState.phase,
    round: gameState.round,
    roleDeckConfig: gameState.roleDeckConfig
  });
  broadcastState();

  // 1. 방 입장 (1번째 사람 자동 방장 배정 없음)
  socket.on('player:join', ({ name, token }) => {
    cleanupDeadSockets();
    let cleanName = (name || '').trim();
    if (!cleanName) cleanName = `참가자_${gameState.players.length + 1}`;

    let existing = gameState.players.find(p => (token && p.token === token) || p.socketId === socket.id || p.name === cleanName);

    if (existing) {
      existing.socketId = socket.id;
      if (token) existing.token = token;
      socket.emit('player:joined_success', {
        token: existing.token,
        id: existing.id,
        name: existing.name,
        isHost: existing.isHost,
        isModerator: existing.isModerator
      });
      if (existing.initialRole) sendSecretNightInfo();
      broadcastState();
      return;
    }

    if (gameState.phase !== 'LOBBY') {
      socket.emit('error_message', '이미 게임이 진행 중입니다. 관전 모드로 입장합니다.');
      return;
    }

    if (gameState.players.length >= 35) {
      socket.emit('error_message', '방 정원(최대 35명)이 가득 찼습니다.');
      return;
    }

    const assignedToken = token || crypto.randomUUID();
    const newPlayer = {
      token: assignedToken,
      socketId: socket.id,
      id: crypto.randomUUID().slice(0, 8),
      name: cleanName,
      initialRole: null,
      currentRole: null,
      isHost: false,
      isModerator: false
    };

    gameState.players.push(newPlayer);
    socket.emit('player:joined_success', {
      token: newPlayer.token,
      id: newPlayer.id,
      name: newPlayer.name,
      isHost: false,
      isModerator: false
    });

    broadcastSystemMsg(`${cleanName} 님이 입장하셨습니다. (현재 ${gameState.players.length}명)`);
    broadcastState();
  });

  // 2. 관리자 인증 (비밀번호: 2146)
  socket.on('host:claim', ({ pin }) => {
    if (pin === HOST_PIN) {
      const p = gameState.players.find(pl => pl.socketId === socket.id);
      if (p) {
        p.isHost = true;
        socket.emit('host:verified', { isHost: true, isModerator: p.isModerator });
        broadcastSystemMsg(`👑 [${p.name}] 님이 관리자 비밀번호를 인증하여 방장 권한을 획득하셨습니다.`);
        broadcastState();
      }
    } else {
      socket.emit('error_message', '방장 비밀번호가 올바르지 않습니다.');
    }
  });

  // 3. 방장 역할 모드 선택 (사회자 vs 참가자)
  socket.on('host:set_mode', ({ isModerator }) => {
    const p = gameState.players.find(pl => pl.socketId === socket.id);
    if (!p || !p.isHost) return;

    p.isModerator = !!isModerator;
    if (p.isModerator) {
      broadcastSystemMsg(`🎙️ 방장 [${p.name}] 님이 게임에 직접 참여하지 않고 [진행 사회자] 모드를 선택하셨습니다.`);
    } else {
      broadcastSystemMsg(`🎮 방장 [${p.name}] 님이 [일반 참가자]로 직접 게임에 참여합니다.`);
    }
    broadcastState();
  });

  // 4. 타이머 제어
  socket.on('timer:toggle', () => {
    const p = gameState.players.find(pl => pl.socketId === socket.id);
    if (!p || !p.isHost) return;

    gameState.isTimerPaused = !gameState.isTimerPaused;
    io.emit('timer:tick', { seconds: gameState.timerSeconds, isPaused: gameState.isTimerPaused });

    if (gameState.isTimerPaused) {
      broadcastSystemMsg(`⏸️ 방장(사회자)이 토론 시간을 일시정지했습니다.`);
    } else {
      broadcastSystemMsg(`▶️ 방장(사회자)이 타이머를 재개했습니다.`);
    }
    broadcastState();
  });

  socket.on('timer:add', ({ seconds }) => {
    const p = gameState.players.find(pl => pl.socketId === socket.id);
    if (!p || !p.isHost) return;

    gameState.timerSeconds += parseInt(seconds) || 30;
    io.emit('timer:tick', { seconds: gameState.timerSeconds, isPaused: gameState.isTimerPaused });
    broadcastSystemMsg(`⏱️ 방장(사회자)이 토론 시간을 ${seconds}초 연장했습니다.`);
    broadcastState();
  });

  // 5. 게임 시작 (단 한 번의 밤 + 단 한 번의 낮)
  socket.on('host:start_game', () => {
    const sender = gameState.players.find(p => p.socketId === socket.id);
    if (!sender || !sender.isHost || gameState.phase !== 'LOBBY') return;
    cleanupDeadSockets();

    const playingPlayers = gameState.players.filter(p => !p.isModerator);
    const totalPlaying = playingPlayers.length;

    if (totalPlaying < 5) {
      socket.emit('error_message', `실제 게임 참여 인원이 ${totalPlaying}명입니다. 최소 5명 이상이어야 시작할 수 있습니다.`);
      return;
    }

    gameState.roleDeckConfig = getAutoRoleDeck(totalPlaying);
    const cfg = gameState.roleDeckConfig;

    // 전체 카드 덱 생성 (총 인원수 + 3장)
    const deck = [];
    for (let i = 0; i < cfg.werewolf; i++) deck.push('WEREWOLF');
    for (let i = 0; i < cfg.minion; i++) deck.push('MINION');
    for (let i = 0; i < cfg.mason; i++) deck.push('MASON');
    for (let i = 0; i < cfg.seer; i++) deck.push('SEER');
    for (let i = 0; i < cfg.robber; i++) deck.push('ROBBER');
    for (let i = 0; i < cfg.troublemaker; i++) deck.push('TROUBLEMAKER');
    for (let i = 0; i < cfg.drunk; i++) deck.push('DRUNK');
    for (let i = 0; i < cfg.insomniac; i++) deck.push('INSOMNIAC');
    for (let i = 0; i < cfg.hunter; i++) deck.push('HUNTER');
    for (let i = 0; i < cfg.tanner; i++) deck.push('TANNER');
    for (let i = 0; i < cfg.villager; i++) deck.push('VILLAGER');

    // 셔플
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    // 플레이어에게 1장씩 배분
    playingPlayers.forEach((p, idx) => {
      p.initialRole = deck[idx];
      p.currentRole = deck[idx];
    });

    // 남은 3장은 중앙 카드에 배치
    gameState.centerCards = [deck[totalPlaying], deck[totalPlaying + 1], deck[totalPlaying + 2]];

    // 임시 행동 데이터 초기화
    gameState.nightActions = {
      seerResult: null,
      robberTargetId: null,
      troublemakerPair: null,
      drunkCenterIndex: null
    };
    gameState.votes = {};
    gameState.voteResults = null;
    gameState.winner = null;
    gameState.winReason = null;

    sendSecretNightInfo();

    gameState.phase = 'NIGHT';
    gameState.round = 1;
    broadcastState();

    broadcastSystemMsg(`🌙 한밤이 찾아왔습니다! 모든 플레이어는 60초 안에 스마트폰으로 각자의 밤 행동을 완료하세요!`);

    startTimer(60, () => {
      resolveNightAndStartDay();
    });
  });

  // 6. 밤 행동 제출 (동시 처리)
  socket.on('night:seer_view_player', ({ targetPlayerId }) => {
    const player = gameState.players.find(p => p.socketId === socket.id);
    if (!player || player.initialRole !== 'SEER' || gameState.phase !== 'NIGHT') return;

    const target = gameState.players.find(p => p.id === targetPlayerId && !p.isModerator);
    if (target) {
      socket.emit('night_feedback', {
        title: '🔮 예언자 관측 결과',
        message: `[${target.name}] 님의 카드는 [${ROLES[target.currentRole].name}]입니다!`
      });
    }
  });

  socket.on('night:seer_view_center', ({ indexes }) => {
    const player = gameState.players.find(p => p.socketId === socket.id);
    if (!player || player.initialRole !== 'SEER' || gameState.phase !== 'NIGHT') return;

    if (Array.isArray(indexes) && indexes.length === 2) {
      const cardA = ROLES[gameState.centerCards[indexes[0]]].name;
      const cardB = ROLES[gameState.centerCards[indexes[1]]].name;
      socket.emit('night_feedback', {
        title: '🔮 예언자 중앙 카드 관측',
        message: `중앙 ${indexes[0] + 1}번 카드: [${cardA}], 중앙 ${indexes[1] + 1}번 카드: [${cardB}]`
      });
    }
  });

  socket.on('night:lone_werewolf_view_center', ({ index }) => {
    const player = gameState.players.find(p => p.socketId === socket.id);
    if (!player || player.initialRole !== 'WEREWOLF' || gameState.phase !== 'NIGHT') return;

    const card = ROLES[gameState.centerCards[index]].name;
    socket.emit('night_feedback', {
      title: '🐺 홀로 늑대 관측',
      message: `중앙 ${index + 1}번 카드: [${card}]`
    });
  });

  socket.on('night:robber_action', ({ targetPlayerId }) => {
    const player = gameState.players.find(p => p.socketId === socket.id);
    if (!player || player.initialRole !== 'ROBBER' || gameState.phase !== 'NIGHT') return;
    gameState.nightActions.robberTargetId = targetPlayerId;
    socket.emit('action_confirmed', '훔칠 대상을 선택했습니다. 밤이 끝날 때 교환됩니다.');
  });

  socket.on('night:troublemaker_action', ({ playerAId, playerBId }) => {
    const player = gameState.players.find(p => p.socketId === socket.id);
    if (!player || player.initialRole !== 'TROUBLEMAKER' || gameState.phase !== 'NIGHT') return;
    gameState.nightActions.troublemakerPair = [playerAId, playerBId];
    socket.emit('action_confirmed', '두 사람의 카드를 맞바꾸도록 설정했습니다.');
  });

  socket.on('night:drunk_action', ({ centerIndex }) => {
    const player = gameState.players.find(p => p.socketId === socket.id);
    if (!player || player.initialRole !== 'DRUNK' || gameState.phase !== 'NIGHT') return;
    gameState.nightActions.drunkCenterIndex = centerIndex;
    socket.emit('action_confirmed', `중앙 ${centerIndex + 1}번 카드와 내 카드를 교환했습니다 (자신은 바뀐 카드를 모름).`);
  });

  // 밤 정산 및 낮 토론 시작
  function resolveNightAndStartDay() {
    resolveNightActions();
    gameState.phase = 'DAY_DISCUSS';
    broadcastState();
    broadcastSystemMsg(`☀️ 아침이 밝았습니다! 밤사이 카드 교환이 완료되었습니다. 5분 동안 자유롭게 토론하세요!`);
    startTimer(300, () => {
      startSimultaneousVoting();
    });
  }

  // 7. 동시 투표 시작 (단 20초)
  function startSimultaneousVoting() {
    gameState.phase = 'VOTING';
    gameState.votes = {};
    broadcastState();
    broadcastSystemMsg(`🗳️ 토론 종료! 20초 안에 처형할 사람을 지목하세요! (모두 동시에 투표)`);
    startTimer(20, () => {
      resolveVotingAndEnd();
    });
  }

  socket.on('player:vote', ({ targetPlayerId }) => {
    const player = gameState.players.find(p => p.socketId === socket.id);
    if (!player || player.isModerator || gameState.phase !== 'VOTING') return;

    gameState.votes[player.id] = targetPlayerId;
    socket.emit('action_confirmed', '투표가 제출되었습니다.');

    // 전원 투표 완료 시 조기 정산
    const playingCount = gameState.players.filter(p => !p.isModerator).length;
    if (Object.keys(gameState.votes).length >= playingCount) {
      clearInterval(gameState.timerInterval);
      resolveVotingAndEnd();
    }
  });

  function resolveVotingAndEnd() {
    resolveGameOutcome();
    gameState.phase = 'GAME_OVER';
    broadcastState();
    broadcastSystemMsg(`🏁 게임 종료! ${gameState.winReason}`);
  }

  // 8. 실시간 채팅
  socket.on('chat:send', ({ text }) => {
    const sender = gameState.players.find(p => p.socketId === socket.id);
    if (!sender || !text.trim()) return;

    if (gameState.phase === 'NIGHT' && !sender.isModerator) {
      socket.emit('error_message', '밤에는 침묵해야 합니다.');
      return;
    }

    const cleanText = text.trim().slice(0, 150);
    const msgObj = {
      id: crypto.randomUUID(),
      sender: sender.isModerator ? `🎙️ [사회자] ${sender.name}` : sender.name,
      text: cleanText,
      isModerator: sender.isModerator,
      time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    };
    io.emit('chat:message', msgObj);
  });

  // 9. 다음 판 준비 (참가자 유지 & 두 번째 판 밸런스 완벽 보존)
  socket.on('host:reset_game', () => {
    const sender = gameState.players.find(p => p.socketId === socket.id);
    if (!sender || !sender.isHost) return;

    clearInterval(gameState.timerInterval);
    gameState.phase = 'LOBBY';
    gameState.round = 1;
    gameState.isTimerPaused = false;
    cleanupDeadSockets();

    gameState.players.forEach(p => {
      p.initialRole = null;
      p.currentRole = null;
    });

    gameState.centerCards = [];
    gameState.votes = {};
    gameState.voteResults = null;
    gameState.winner = null;
    gameState.winReason = null;

    io.emit('onuw:player_reset');
    broadcastSystemMsg(`🔄 방장이 다음 게임을 준비했습니다. 새 판을 시작할 수 있습니다.`);
    broadcastState();
  });

  // 방 완전 초기화 (모든 참가자 퇴장)
  socket.on('host:kick_all', () => {
    const sender = gameState.players.find(p => p.socketId === socket.id);
    if (!sender || !sender.isHost) return;

    clearInterval(gameState.timerInterval);
    gameState.phase = 'LOBBY';
    gameState.round = 1;
    gameState.players = [];
    gameState.centerCards = [];
    gameState.votes = {};
    gameState.voteResults = null;
    gameState.winner = null;

    io.emit('onuw:force_kick');
    broadcastState();
  });

  socket.on('host:next_phase', () => {
    const sender = gameState.players.find(p => p.socketId === socket.id);
    if (!sender || !sender.isHost) return;
    clearInterval(gameState.timerInterval);

    if (gameState.phase === 'NIGHT') resolveNightAndStartDay();
    else if (gameState.phase === 'DAY_DISCUSS') startSimultaneousVoting();
    else if (gameState.phase === 'VOTING') resolveVotingAndEnd();
  });

  socket.on('disconnect', () => {
    if (gameState.phase === 'LOBBY') {
      cleanupDeadSockets();
      broadcastState();
    }
  });
});

server.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`🐺 5~35인 한밤의 늑대인간(ONUW) 스마트 서버 실행 완료!`);
  console.log(`접속 주소: http://localhost:${PORT}`);
  console.log(`=================================================`);
});
