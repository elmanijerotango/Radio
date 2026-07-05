/* ═══════════════════════════════════════════════════════════════════════════
   El Manijero Radio · panel.js v1.1
   Radio global sincronizada.
   El frontend hace 5 cosas:
   1. Entrar sincronizado (offset = ahora - InicioTema)
   2. Reproducir audio con Web Audio API (EQ real, 3 knobs circulares)
   3. Avisar al backend "este tema terminó" (el backend decide qué sigue)
   4. Polling cada 30s para nuevos temas
   5. Chat en tiempo real + Copiloto con mensajes contextuales rotativos
   IMPORTANTE: ningún cliente decide por sí mismo cuándo avanza la radio.
   Esa decisión es 100% del backend (avanzarTema en Radio.gs, con lock).
   ═══════════════════════════════════════════════════════════════════════════ */

const GAS_URL         = 'https://script.google.com/macros/s/AKfycbxc9m7HCoL4Y1df1d3pLzoMEexm8AK7ltRc8vTbkWw4naZM25ycUHmLUdJJF9L-DIezHQ/exec';
const POLLING_MS      = 30000;
const CHAT_POLLING_MS = 8000;
const CORTINA_DURACION_SEG = 45;
const CORTINA_FADE_SEG     = 2.5;
const COPILOTO_ROTACION_MS = 12000;

// ── Estado ─────────────────────────────────────────────────────────────────
let biblioteca   = [];
let indexActual  = 0;
let estadoPanel  = 'idle';
let audioGenId   = 0;
let pendingOffsetSeg = 0;

// ── Web Audio API ──────────────────────────────────────────────────────────
let audioCtx        = null;
let sourceNode      = null;
let bassFilter      = null;
let trebleFilter    = null;
let gainNode        = null;
let cortinaGainNode = null;
let analyserNode    = null;
let audioEl         = null;

// ── Knobs (volumen / graves / agudos) ─────────────────────────────────────
let knobValue    = 72;   // 0-100 -> gain 0-1
let bassValue    = 50;   // 0-100 -> -15..+15 dB
let trebleValue  = 50;   // 0-100 -> -15..+15 dB
let knobDragging = null; // 'vol' | 'bass' | 'treble' | null
let knobStartY   = 0;
let knobStartVal = 0;

// ── Timers ─────────────────────────────────────────────────────────────────
let pollingTimer  = null;
let chatTimer     = null;
let vuTimer       = null;
let copilotoTimer = null;

// ══════════════════════════════════════════════════════════════════════════
// ARRANQUE
// ══════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', function () {
  updateClock();
  setInterval(updateClock, 30000);
  initKnobs();
  actualizarBotones();
  sincronizarEntrada();
  iniciarCopilotoRotativo();
});

// ══════════════════════════════════════════════════════════════════════════
// SINCRONIZACIÓN DE ENTRADA
// ══════════════════════════════════════════════════════════════════════════

async function sincronizarEntrada() {
  mostrarEstadoCarga('Conectando con la radio…');

  let intentos = 0;
  const MAX_INTENTOS = 5;

  while (intentos < MAX_INTENTOS) {
    try {
      const resEstado = await fetch(GAS_URL + '?action=getEstadoRadio');
      if (!resEstado.ok) throw new Error('HTTP ' + resEstado.status);
      const estado = await resEstado.json();

      const resBib = await fetch(GAS_URL + '?action=getBiblioteca');
      if (!resBib.ok) throw new Error('HTTP ' + resBib.status);
      const bib = await resBib.json();

      if (!Array.isArray(bib) || !bib.length) {
        mostrarEstadoCarga('Radio sin contenido aún…');
        return;
      }

      biblioteca = bib;
      mostrarEstadoCarga(null);
      iniciarPolling();
      iniciarChatPolling();

      if (estado.ok && estado.AudioURL && estado.OffsetSeg >= 0) {
        const idx = biblioteca.findIndex(t => t.ID === estado.ID);
        indexActual = idx >= 0 ? idx : 0;
        pendingOffsetSeg = estado.OffsetSeg;
        renderTemaActual(biblioteca[indexActual], indexActual);
        renderCola(biblioteca.slice(indexActual + 1, indexActual + 6));
      } else {
        renderBibliotecaCargada();
      }

      actualizarBotones();
      actualizarLiveBadge();
      return; // ✅ éxito, salir del loop

    } catch(e) {
      intentos++;
      const espera = intentos * 3; // 3s, 6s, 9s, 12s, 15s
      console.warn('Intento ' + intentos + ' fallido — reintentando en ' + espera + 's:', e.message);
      mostrarEstadoCarga('Reconectando… (intento ' + intentos + ' de ' + MAX_INTENTOS + ')');
      await new Promise(r => setTimeout(r, espera * 1000));
    }
  }

  // Si falló todo
  mostrarEstadoCarga('No se pudo conectar. Recargá la página.');
}
// ══════════════════════════════════════════════════════════════════════════
// WEB AUDIO API
// ══════════════════════════════════════════════════════════════════════════

function initAudioContext() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  gainNode = audioCtx.createGain();
  gainNode.gain.value = knobValue / 100;

  bassFilter = audioCtx.createBiquadFilter();
  bassFilter.type = 'lowshelf';
  bassFilter.frequency.value = 200;
  bassFilter.gain.value = ((bassValue - 50) / 50) * 15;

  trebleFilter = audioCtx.createBiquadFilter();
  trebleFilter.type = 'highshelf';
  trebleFilter.frequency.value = 4000;
  trebleFilter.gain.value = ((trebleValue - 50) / 50) * 15;

  cortinaGainNode = audioCtx.createGain();
  cortinaGainNode.gain.value = 1;

  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 256;
  analyserNode.smoothingTimeConstant = 0.8;

  bassFilter.connect(trebleFilter);
  trebleFilter.connect(gainNode);
  gainNode.connect(cortinaGainNode);
  cortinaGainNode.connect(analyserNode);
  analyserNode.connect(audioCtx.destination);
}

function conectarAudioEl(el) {
  if (!audioCtx) initAudioContext();
  if (sourceNode) {
    try { sourceNode.disconnect(); } catch(e) {}
  }
  sourceNode = audioCtx.createMediaElementSource(el);
  sourceNode.connect(bassFilter);
}

// ══════════════════════════════════════════════════════════════════════════
// VU METER REAL (desde analyser) — solo el VU vertical, real
// ══════════════════════════════════════════════════════════════════════════

function iniciarVU() {
  if (vuTimer) return;
  const data = new Uint8Array(analyserNode ? analyserNode.frequencyBinCount : 0);
  vuTimer = setInterval(function () {
    if (!analyserNode) return;
    analyserNode.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const db  = avg > 0 ? (20 * Math.log10(avg / 255)).toFixed(1) : '-∞';
    setEl('meta-lufs', db + ' dB');

    const pct = Math.min((avg / 255) * 100, 100).toFixed(1);
    const vL = document.getElementById('vu-vf-left');
    const vR = document.getElementById('vu-vf-right');
    if (vL) vL.style.height = pct + '%';
    if (vR) vR.style.height = (pct * (0.9 + Math.random() * 0.2)).toFixed(1) + '%';
  }, 80);
}

function detenerVU() {
  if (vuTimer) { clearInterval(vuTimer); vuTimer = null; }
  setEl('meta-lufs', '—');
  const vL = document.getElementById('vu-vf-left');
  const vR = document.getElementById('vu-vf-right');
  if (vL) vL.style.height = '0%';
  if (vR) vR.style.height = '0%';
}

// ══════════════════════════════════════════════════════════════════════════
// CONTROL DE REPRODUCCIÓN
// ══════════════════════════════════════════════════════════════════════════

function iniciarMilonga() {
  if (!biblioteca.length) return;
  if (estadoPanel === 'paused') { reanudar(); return; }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  estadoPanel = 'playing';
  actualizarBotones();
  actualizarLiveBadge();

  if (pendingOffsetSeg > 0) {
    const offset = pendingOffsetSeg;
    pendingOffsetSeg = 0;
    reproducirDesdeOffset(biblioteca[indexActual], offset);
  } else {
    reproducirTema(indexActual);
  }
}

function pausarMilonga() {
  if (estadoPanel !== 'playing') return;
  estadoPanel = 'paused';
  if (audioEl && !audioEl.paused) audioEl.pause();
  if (audioCtx) audioCtx.suspend();
  detenerVU();
  activarRing(false);
  actualizarBotones();
  actualizarLiveBadge();
  setCopiloto('Radio en pausa. Tocá "Continuar" cuando quieras seguir.');
}

function reanudar() {
  estadoPanel = 'playing';
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  if (audioEl && audioEl.paused) audioEl.play();
  actualizarBotones();
  actualizarLiveBadge();
  activarRing(true);
  iniciarVU();
}

function stopMilonga() {
  estadoPanel = 'stopped';
  detenerAudio();
  detenerVU();
  activarRing(false);
  actualizarBotones();
  actualizarLiveBadge();
  resetProgressUI();
  setEl('time-total', '0:00');
  setEl('now-name', '—');
  setEl('now-orq',  '—');
  setCopiloto('Radio detenida. Cuando quieras volvés a entrar y seguimos.');
  renderCola([]);
}

// ══════════════════════════════════════════════════════════════════════════
// REPRODUCCIÓN
// ══════════════════════════════════════════════════════════════════════════

function reproducirTema(index) {
  if (index >= biblioteca.length) { esperarNuevosTemas(); return; }
  const tema = biblioteca[index];
  detenerAudio();
  renderTemaActual(tema, index);
  renderCola(biblioteca.slice(index + 1, index + 6));
  actualizarContadorTemas();
  actualizarCopilotoParaTema(tema, index);

  if (tema.AudioURL) { reproducirAudio(tema, 0); return; }

  console.warn('Sin AudioURL — avisando avance:', tema.Titulo);
  solicitarAvance(tema.ID);
}

function reproducirDesdeOffset(tema, offsetSeg) {
  detenerAudio();
  renderTemaActual(tema, indexActual);
  renderCola(biblioteca.slice(indexActual + 1, indexActual + 6));
  actualizarCopilotoParaTema(tema, indexActual);

  if (tema.AudioURL) { reproducirAudio(tema, offsetSeg); return; }
  solicitarAvance(tema.ID);
}

/* ──────────────────────────────────────────────────────────────────────────
   ÚNICO punto donde un cliente le habla al backend sobre avanzar.
   El backend decide si efectivamente avanza (lock + chequeo de ID) y
   devuelve el estado real, al que este cliente simplemente se ajusta.
   ────────────────────────────────────────────────────────────────────────── */
function solicitarAvance(idFinalizado) {
  fetch(GAS_URL + '?action=avanzarTema&ID=' + encodeURIComponent(idFinalizado))
    .then(r => r.json())
    .then(function (data) {
      if (estadoPanel === 'stopped' || estadoPanel === 'idle') return;
      if (!data.ok || !data.estadoActual || !data.estadoActual.ok) {
        refrescarBiblioteca().then(function () { setTimeout(function(){ reproducirTema(indexActual); }, 1500); });
        return;
      }
      const est = data.estadoActual;
      let idx = biblioteca.findIndex(t => t.ID === est.ID);
      if (idx === -1) {
        refrescarBiblioteca().then(function () {
          idx = biblioteca.findIndex(t => t.ID === est.ID);
          indexActual = idx >= 0 ? idx : indexActual;
          reproducirTema(indexActual);
        });
        return;
      }
      indexActual = idx;
      reproducirTema(indexActual);
    })
    .catch(function () {
      setTimeout(function () { solicitarAvance(idFinalizado); }, 2000);
    });
}

function esperarNuevosTemas() {
  setCopiloto('Preparando la próxima tanda… un momento.');
  const espera = setInterval(function () {
    if (estadoPanel === 'stopped' || estadoPanel === 'idle') { clearInterval(espera); return; }
    if (indexActual < biblioteca.length) { clearInterval(espera); reproducirTema(indexActual); return; }
    refrescarBiblioteca();
  }, 3000);
}

// ══════════════════════════════════════════════════════════════════════════
// AUDIO NATIVO CON WEB AUDIO API
// ══════════════════════════════════════════════════════════════════════════

function reproducirAudio(tema, offsetSeg) {
  const miGenId = ++audioGenId;
  const el      = new Audio();
  el.crossOrigin = 'anonymous';
  el.src         = tema.AudioURL;
  el.preload     = 'auto';
  audioEl        = el;

  function actualizarDuracion() {
    if (audioGenId !== miGenId || !el.duration || isNaN(el.duration)) return;
    setEl('time-total', fmt(Math.floor(el.duration)));
  }
  el.addEventListener('loadedmetadata', actualizarDuracion);
  el.addEventListener('durationchange',  actualizarDuracion);

  el.addEventListener('canplaythrough', function onReady() {
    el.removeEventListener('canplaythrough', onReady);
    if (audioGenId !== miGenId) return;

    try { conectarAudioEl(el); } catch(e) { console.warn('Web Audio no disponible:', e); }

    if (offsetSeg > 0 && el.duration && offsetSeg < el.duration) {
      el.currentTime = offsetSeg;
    }

    if (cortinaGainNode) {
      cortinaGainNode.gain.cancelScheduledValues(audioCtx.currentTime);
      cortinaGainNode.gain.setValueAtTime(1, audioCtx.currentTime);
    }

    el.play().catch(function (err) {
      if (audioGenId !== miGenId) return;
      console.warn('Error reproduciendo:', err);
      solicitarAvance(tema.ID);
    });

    resetProgressUI();
    activarRing(true);
    iniciarVU();

    if (esCortina(tema) && cortinaGainNode && audioCtx) {
      const now       = audioCtx.currentTime;
      const restante  = Math.max(0, CORTINA_DURACION_SEG - offsetSeg);
      const fadeIn    = Math.min(CORTINA_FADE_SEG, restante);
      const fadeOutAt = Math.max(0, restante - CORTINA_FADE_SEG);

      if (offsetSeg < CORTINA_FADE_SEG) {
        cortinaGainNode.gain.setValueAtTime(0.0001, now);
        cortinaGainNode.gain.exponentialRampToValueAtTime(1, now + fadeIn);
      }

      cortinaGainNode.gain.setValueAtTime(1, now + fadeOutAt);
      cortinaGainNode.gain.exponentialRampToValueAtTime(0.0001, now + fadeOutAt + CORTINA_FADE_SEG);

      setTimeout(function () {
        if (audioGenId !== miGenId) return;
        detenerVU();
        solicitarAvance(tema.ID);
      }, restante * 1000);
    }
  }, { once: true });

  el.addEventListener('ended', function () {
    if (audioGenId !== miGenId) return;
    detenerVU();
    solicitarAvance(tema.ID);
  });

  el.addEventListener('error', function () {
    if (audioGenId !== miGenId) return;
    console.warn('Error de audio — avisando avance:', tema.Titulo);
    detenerVU();
    solicitarAvance(tema.ID);
  });

  el.addEventListener('timeupdate', function () {
    if (audioGenId !== miGenId || !el.duration) return;
    const pct = (el.currentTime / el.duration) * 100;
    const pf  = document.getElementById('progress-fill');
    if (pf) pf.style.width = pct.toFixed(1) + '%';
    setEl('time-current', fmt(el.currentTime));
  });
}

function detenerAudio() {
  if (audioEl) {
    audioEl.pause();
    audioEl.src = '';
    audioEl = null;
  }
  if (sourceNode) {
    try { sourceNode.disconnect(); } catch(e) {}
    sourceNode = null;
  }
  audioGenId++;
}
// ══════════════════════════════════════════════════════════════════════════
// CHAT FLOTANTE
// ══════════════════════════════════════════════════════════════════════════

let chatPanelAbierto  = false;
let chatMensajesNoLeidos = 0;

function toggleChatFlotante() {
  const panel = document.getElementById('chat-panel-flotante');
  const modal = document.getElementById('modal-pedido');
  chatPanelAbierto = !chatPanelAbierto;
  panel.style.display = chatPanelAbierto ? 'flex' : 'none';
  if (modal) modal.style.display = 'none';
  if (chatPanelAbierto) {
    // Resetear badge
    chatMensajesNoLeidos = 0;
    actualizarBadgeChat();
    // Scroll al fondo
    const lista = document.getElementById('chat-lista');
    if (lista) lista.scrollTop = lista.scrollHeight;
  }
}

function actualizarBadgeChat() {
  const badge = document.getElementById('chat-fab-badge');
  if (!badge) return;
  if (chatMensajesNoLeidos > 0 && !chatPanelAbierto) {
    badge.textContent = chatMensajesNoLeidos > 9 ? '9+' : chatMensajesNoLeidos;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function abrirPedirTema() {
  const modal = document.getElementById('modal-pedido');
  if (modal) modal.style.display = 'flex';
}

function cerrarPedirTema() {
  const modal = document.getElementById('modal-pedido');
  if (modal) modal.style.display = 'none';
}

function enviarPedido() {
  const input  = document.getElementById('pedido-valor');
  const usuario = document.getElementById('chat-usuario');
  const valor  = (input ? input.value : '').trim();
  const user   = (usuario ? usuario.value : '') || 'Oyente';
  if (!valor) return;

  // Enviar como mensaje de chat con prefijo de pedido
  const mensaje = 'Pedido: ' + valor;
  _enviarMensajeChat(user, mensaje);
  cerrarPedirTema();
  if (input) input.value = '';
  mostrarToast('Pedido enviado. El Manijero lo tiene en cuenta.');
}

function enviarChat() {
  const input   = document.getElementById('chat-input');
  const usuario = document.getElementById('chat-usuario');
  if (!input) return;

  const msg  = (input.value || '').trim();
  const user = (usuario ? usuario.value : '') || 'Oyente';
  if (!msg) return;

  input.value = '';
  _enviarMensajeChat(user, msg);
}

function _enviarMensajeChat(usuario, mensaje) {
  const input = document.getElementById('chat-input');
  if (input) input.disabled = true;

  fetch(GAS_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body:    JSON.stringify({ action: 'enviarChat', usuario, mensaje }),
  })
    .then(r => r.json())
    .then(function (data) {
      if (input) input.disabled = false;
      // Mostrar respuesta IA si hay
      if (data.respuestaIA) {
        mostrarRespuestaIA(data.respuestaIA);
      }
      cargarChat();
    })
    .catch(function () { if (input) input.disabled = false; });
}

function mostrarRespuestaIA(texto) {
  const wrap  = document.getElementById('chat-ia-respuesta');
  const textoEl = document.getElementById('chat-ia-texto');
  if (!wrap || !textoEl) return;
  textoEl.textContent = texto;
  wrap.style.display  = 'flex';
  // Ocultar después de 12 segundos
  setTimeout(function () { wrap.style.display = 'none'; }, 12000);
}

function cargarChat() {
  fetch(GAS_URL + '?action=getChat&limite=30')
    .then(r => r.json())
    .then(function (data) {
      if (!Array.isArray(data)) return;
      const countAntes = _contarMensajes();
      renderChat(data);
      const countDespues = _contarMensajes();
      const nuevos = countDespues - countAntes;
      if (nuevos > 0 && !chatPanelAbierto) {
        chatMensajesNoLeidos += nuevos;
        actualizarBadgeChat();
      }
    })
    .catch(function () {});
}

let _ultimoChatCount = 0;
function _contarMensajes() { return _ultimoChatCount; }

function renderChat(mensajes) {
  const lista = document.getElementById('chat-lista');
  if (!lista) return;

  if (!mensajes.length) {
    lista.innerHTML = '<div class="chat-vacio">Sé el primero en saludar 🎵</div>';
    _ultimoChatCount = 0;
    return;
  }

  _ultimoChatCount = mensajes.length;

  lista.innerHTML = mensajes.map(function (m) {
    const ts    = m.Timestamp ? new Date(m.Timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '';
    const tipo  = String(m.Tipo || '').toUpperCase();
    const badge = tipo === 'PEDIDO'      ? '<span class="chat-badge pedido">pedido</span>'
                : tipo === 'DEDICATORIA' ? '<span class="chat-badge dedic">dedicatoria</span>'
                : '';
    const texto = escapeHtml(m.MensajeTraducido || m.MensajeOriginal || '');
    return '<div class="chat-item">' +
      '<span class="chat-user">' + escapeHtml(m.Usuario || 'anon') + '</span>' +
      '<span class="chat-ts">'   + ts + '</span>' +
      badge +
      '<div class="chat-msg">'   + texto + '</div>' +
      '</div>';
  }).join('');

  lista.scrollTop = lista.scrollHeight;
}
// ══════════════════════════════════════════════════════════════════════════
// CHAT
// ══════════════════════════════════════════════════════════════════════════


function cargarChat() {
  fetch(GAS_URL + '?action=getChat&limite=20')
    .then(r => r.json())
    .then(function (data) {
      if (!Array.isArray(data)) return;
      renderChat(data);
    })
    .catch(function () {});
}

function renderChat(mensajes) {
  const lista = document.getElementById('chat-lista');
  if (!lista) return;

  if (!mensajes.length) {
    lista.innerHTML = '<div class="chat-vacio">Sé el primero en saludar 🎵</div>';
    return;
  }

  lista.innerHTML = mensajes.map(function (m) {
    const ts    = m.Timestamp ? new Date(m.Timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '';
    const tipo  = String(m.Tipo || '').toUpperCase();
    const badge = tipo === 'PEDIDO'      ? '<span class="chat-badge pedido">pedido</span>'
                : tipo === 'DEDICATORIA' ? '<span class="chat-badge dedic">dedicatoria</span>'
                : '';
    const texto = escapeHtml(m.MensajeTraducido || m.MensajeOriginal || '');
    return '<div class="chat-item">' +
      '<span class="chat-user">' + escapeHtml(m.Usuario || 'anon') + '</span>' +
      '<span class="chat-ts">'   + ts + '</span>' +
      badge +
      '<div class="chat-msg">'   + texto + '</div>' +
      '</div>';
  }).join('');

  lista.scrollTop = lista.scrollHeight;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function iniciarChatPolling() {
  if (chatTimer) return;
  cargarChat();
  chatTimer = setInterval(cargarChat, CHAT_POLLING_MS);
}

// ══════════════════════════════════════════════════════════════════════════
// POLLING Y REFRESCO
// ══════════════════════════════════════════════════════════════════════════

async function refrescarBiblioteca() {
  try {
    const res  = await fetch(GAS_URL + '?action=getBiblioteca');
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return;

    const idsYaUsados = new Set(biblioteca.slice(0, indexActual + 1).map(t => t.ID));
    const nuevos      = data.filter(t => !idsYaUsados.has(t.ID));
    const longAntes   = biblioteca.length;

    biblioteca = biblioteca.slice(0, indexActual + 1).concat(nuevos);

    const diff = biblioteca.length - longAntes;
    if (diff > 0) {
      mostrarToast('+' + diff + ' tema' + (diff > 1 ? 's' : '') + ' en la radio');
      renderCola(biblioteca.slice(indexActual + 1, indexActual + 6));
      actualizarContadorTemas();
    }
  } catch (e) { console.warn('Error refrescando:', e); }
}

function iniciarPolling() {
  if (pollingTimer) return;
  pollingTimer = setInterval(refrescarBiblioteca, POLLING_MS);
}

// ══════════════════════════════════════════════════════════════════════════
// RENDER UI
// ══════════════════════════════════════════════════════════════════════════

function renderBibliotecaCargada() {
  setEl('now-name', 'El Manijero Radio');
  setEl('now-orq',  biblioteca.length + ' temas listos');
  setEl('now-year', '');
  setCopiloto('Radio lista. Tocá "Entrar a la radio" para sumarte a la transmisión global.');
  renderCola(biblioteca.slice(0, 5));
  actualizarContadorTemas();

  const conAudio = biblioteca.filter(t => !!t.AudioURL).length;
  actualizarLiveBadge();
  setEl('badge-temas', biblioteca.length + ' temas');
  setEl('badge-sub',   conAudio + ' con audio');
}

function renderTemaActual(tema, index) {
  setEl('now-name', tema.Titulo   || '—');
  setEl('now-orq',  tema.Orquesta ? 'Orquesta ' + tema.Orquesta : '—');
  setEl('now-year',
    (tema.Anio   || '') +
    (tema.Genero ? ' · ' + tema.Genero : '') +
    (tema.Estilo ? ' · ' + tema.Estilo : '')
  );
  setEl('m-tanda-sub',    (tema.Genero || '') + (tema.Orquesta ? ' · ' + tema.Orquesta : ''));
  setEl('ia-footer-text', 'Tema ' + (index + 1) + ' de ' + biblioteca.length);
  setEl('badge-temas',    (index + 1) + ' / ' + biblioteca.length);
  setEl('badge-sub',      esCortina(tema) ? 'Cortina' : ('Tanda · ' + (tema.Genero || '')));
  setEl('time-total', '—');

  setEl('meta-lufs', '—');

  let html = '<span class="chip ch-' + (tema.Genero || '').toLowerCase() + '">' + (tema.Genero || '?') + '</span>';
  if (tema.Estilo && !esCortina(tema)) html += '<span class="chip ch-gold">' + tema.Estilo + '</span>';
  if (tema.Anio)                       html += '<span class="chip ch-gold">' + tema.Anio + '</span>';
  if (!esCortina(tema))                html += '<span class="chip ch-green">✓ Audio</span>';

  const chips = document.getElementById('now-chips');
  if (chips) chips.innerHTML = html;
}

function actualizarContadorTemas() {
  if (estadoPanel !== 'playing' && estadoPanel !== 'paused') {
    setEl('m-tanda', '0 / 0');
    return;
  }
  const tema = biblioteca[indexActual];
  if (!tema) return;
  if (esCortina(tema)) { setEl('m-tanda', 'Cortina'); return; }
  const pt = calcularPosEnTanda();
  setEl('m-tanda', pt.pos + ' / ' + pt.total);
}

function calcularPosEnTanda() {
  let pos = 1;
  for (let i = indexActual - 1; i >= 0; i--) {
    if (esCortina(biblioteca[i])) break;
    pos++;
  }
  let total = pos;
  for (let j = indexActual + 1; j < biblioteca.length; j++) {
    if (esCortina(biblioteca[j])) break;
    total++;
  }
  return { pos, total };
}

function renderCola(temas) {
  const lista = document.getElementById('queue-list');
  if (!lista) return;
  if (!temas.length) {
    lista.innerHTML = '<div class="q-item"><div class="q-info"><div class="q-track">Cola vacía</div></div></div>';
    return;
  }
  lista.innerHTML = temas.map(function (t, i) {
    const esNext = i === 0;
    const num    = indexActual + i + 2;
    return '<div class="q-item ' + (esNext ? 'q-next' : '') + '">' +
      (esNext ? '<i class="ti ti-arrow-right q-arrow"></i>' : '<span class="q-num">' + num + '</span>') +
      '<div class="q-info">' +
        '<div class="q-track">' + (t.Titulo || '—') + ' · ' + (t.Orquesta || '—') + '</div>' +
        '<div class="q-orq">'  + (t.Duracion || '') + ' · ' + (t.Estilo || '') + '</div>' +
      '</div>' +
      '<span class="chip ch-' + (t.Genero || '').toLowerCase() + '">' + (t.Genero || '') + '</span>' +
      '</div>';
  }).join('');
}

function actualizarBotones() {
  const bi = document.getElementById('btn-iniciar');
  const bp = document.getElementById('btn-pausar');
  const bs = document.getElementById('btn-stop');
  if (!bi) return;
  if (estadoPanel === 'idle' || estadoPanel === 'stopped') {
    bi.disabled  = !biblioteca.length;
    bi.innerHTML = '<i class="ti ti-player-play"></i> Entrar a la radio';
    if (bp) bp.disabled = true;
    if (bs) bs.disabled = true;
  } else if (estadoPanel === 'playing') {
    bi.disabled  = true;
    if (bp) { bp.disabled = false; bp.innerHTML = '<i class="ti ti-player-pause"></i> Pausar'; }
    if (bs) bs.disabled = false;
  } else if (estadoPanel === 'paused') {
    bi.disabled  = false;
    bi.innerHTML = '<i class="ti ti-player-play"></i> Continuar';
    if (bp) bp.disabled = true;
    if (bs) bs.disabled = false;
  }
}

/* Actualiza tanto el badge inline (junto al logo, mobile y desktop) */
function actualizarLiveBadge() {
  const b = document.getElementById('live-badge-inline');
  if (!b) return;
  if (estadoPanel === 'playing') {
    b.innerHTML = '<div class="live-dot"></div><span>EN VIVO</span>';
  } else if (estadoPanel === 'paused') {
    b.innerHTML = '<div class="live-dot" style="background:#c9a84c;animation:none"></div><span>En pausa</span>';
  } else if (biblioteca.length) {
    b.innerHTML = '<div class="live-dot" style="background:#c9a84c;animation:none;box-shadow:none"></div><span>Listo</span>';
  } else {
    b.innerHTML = '<div class="live-dot" style="background:#555;animation:none"></div><span>Conectando…</span>';
  }
}

// ══════════════════════════════════════════════════════════════════════════
// COPILOTO — más vivo: explica qué pasa y por qué, invita al chat
// ══════════════════════════════════════════════════════════════════════════

const COPILOTO_MENSAJES_TANGO = [
  'Tanda en curso. Si querés pedir un tango o mandar un saludo, escribilo en el chat — lo leo en cuanto entra.',
  'Cuatro tangos seguidos de la misma orquesta, como manda la tradición milonguera, para que la pista no pierda el compás.',
  'Esta selección prioriza la Época de Oro (1935-1955) — ahí está el grueso del repertorio que mejor se baila.',
  '¿Sabías que las tandas se arman por orquesta para que las parejas reconozcan el estilo y no corten el baile? Así lo hacemos acá.',
];

const COPILOTO_MENSAJES_VALS = [
  'Cambiamos a vals. Un respiro romántico entre tandas de tango — así se ventila la pista.',
  'Vals en el aire. Tres temas, ritmo de 3/4, ideal para los giros.',
];

const COPILOTO_MENSAJES_MILONGA = [
  'Milonga arriba. Acá se acelera todo — la pista se llena.',
  'Tanda de milonga: el contrapunto más movido de la noche.',
];

const COPILOTO_MENSAJES_CORTINA = [
  'Cortina. Cortamos la pista 45 segundos para que las parejas se separen y armen las próximas — así se respeta el código milonguero.',
  'Pausa corta entre tandas. Aprovechá para pedir tu próximo tango en el chat.',
  'La cortina existe para evitar que una tanda se mezcle con la siguiente. En 45 segundos volvemos con más tango.',
];

const COPILOTO_MENSAJES_GENERICOS = [
  '¿Querés escuchar algo en especial? Pedilo en el chat de la radio — leo los mensajes en vivo.',
  'El Manijero arma las tandas automáticamente, alternando tango, vals y milonga como en una milonga real.',
  'Esto es radio sincronizada: todos los que están conectados ahora escuchan exactamente el mismo tema, al mismo tiempo.',
];

let copilotoPool = COPILOTO_MENSAJES_GENERICOS;
let copilotoIdx  = 0;

function setCopiloto(texto) {
  const textoEl   = document.getElementById('ia-texto');
  const bubbleEl  = document.querySelector('.copiloto-bubble');
  if (!textoEl) return;

  // Quita animación previa para poder retriggerearla
  textoEl.classList.remove('is-typing');
  if (bubbleEl) bubbleEl.classList.remove('is-pulsing');

  // Muestra los puntitos "escribiendo…" un instante
  textoEl.innerHTML = '<span class="ia-typing-dots"><span></span><span></span><span></span></span>';

  setTimeout(function () {
    textoEl.textContent = texto;
    // Forzar reflow para reiniciar la animación CSS
    void textoEl.offsetWidth;
    textoEl.classList.add('is-typing');
    if (bubbleEl) {
      void bubbleEl.offsetWidth;
      bubbleEl.classList.add('is-pulsing');
    }
  }, 500);
}

function actualizarCopilotoParaTema(tema, index) {
  if (esCortina(tema)) {
    copilotoPool = COPILOTO_MENSAJES_CORTINA;
  } else {
    const g = String(tema.Genero || '').trim().toLowerCase();
    if (g === 'vals')    copilotoPool = COPILOTO_MENSAJES_VALS;
    else if (g === 'milonga') copilotoPool = COPILOTO_MENSAJES_MILONGA;
    else copilotoPool = COPILOTO_MENSAJES_TANGO;
  }
  copilotoIdx = 0;
  setCopiloto(copilotoPool[0]);

  // Próxima tanda / recomendación visible
  const sig = biblioteca[index + 1];
  if (sig) {
    const genSig = esCortina(sig) ? 'Cortina' : (sig.Genero || 'Tango');
    setEl('rec-proxima', genSig + (sig.Orquesta ? ' · ' + sig.Orquesta : ''));
  }
}

/* Rota el mensaje del copiloto cada COPILOTO_ROTACION_MS mientras hay un
   pool activo, alternando entre los mensajes contextuales del género actual
   y, de vez en cuando, una invitación genérica al chat — así no queda mudo
   entre que arranca el tema y que termina la cortina. */
function iniciarCopilotoRotativo() {
  if (copilotoTimer) return;
  copilotoTimer = setInterval(function () {
    if (estadoPanel !== 'playing') return;
    copilotoIdx++;
    // Cada 3ra rotación, intercalamos un mensaje genérico que invita al chat.
    if (copilotoIdx % 3 === 0) {
      const g = COPILOTO_MENSAJES_GENERICOS[Math.floor(Math.random() * COPILOTO_MENSAJES_GENERICOS.length)];
      setCopiloto(g);
      return;
    }
    const msg = copilotoPool[copilotoIdx % copilotoPool.length];
    setCopiloto(msg);
  }, COPILOTO_ROTACION_MS);
}

// ══════════════════════════════════════════════════════════════════════════
// KNOBS CIRCULARES (volumen / graves / agudos)
// ══════════════════════════════════════════════════════════════════════════

function drawKnobGeneric(canvasId, value, dbMin, dbMax, dbOutId, fmtDb) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  const cx = W / 2, cy = H / 2;
  const r = W * 0.38, lw = W * 0.075;

  ctx.clearRect(0, 0, W, H);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0.75 * Math.PI, 2.25 * Math.PI);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.stroke();

  const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
  grad.addColorStop(0, '#5C0E0E'); grad.addColorStop(1, '#C9924A');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0.75 * Math.PI, (0.75 + (value / 100) * 1.5) * Math.PI);
  ctx.strokeStyle = grad; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.stroke();

  const angle = (0.75 + (value / 100) * 1.5) * Math.PI;
  ctx.beginPath();
  ctx.arc(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, lw * 0.7, 0, Math.PI * 2);
  ctx.fillStyle = '#E8B870'; ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = '#1A1008'; ctx.fill();
  ctx.strokeStyle = 'rgba(201,146,74,0.2)'; ctx.lineWidth = 1; ctx.stroke();

  const db = dbMin + (value / 100) * (dbMax - dbMin);
  if (dbOutId) setEl(dbOutId, fmtDb(db));
}

function drawKnobVol(value)    { drawKnobGeneric('knob-canvas',        value, -40, 12, 'knob-db',   v => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB'); }
function drawKnobBass(value)   { drawKnobGeneric('knob-bass-canvas',   value, -15, 15, 'bass-db',   v => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB'); }
function drawKnobTreble(value) { drawKnobGeneric('knob-treble-canvas', value, -15, 15, 'treble-db', v => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB'); }

function getEventY(e) {
  if (e.touches && e.touches.length > 0)               return e.touches[0].clientY;
  if (e.changedTouches && e.changedTouches.length > 0) return e.changedTouches[0].clientY;
  return e.clientY;
}

function aplicarKnob(tipo, value) {
  if (tipo === 'vol') {
    knobValue = value;
    drawKnobVol(value);
    if (gainNode) gainNode.gain.value = value / 100;
  } else if (tipo === 'bass') {
    bassValue = value;
    drawKnobBass(value);
    if (bassFilter) bassFilter.gain.value = ((value - 50) / 50) * 15;
  } else if (tipo === 'treble') {
    trebleValue = value;
    drawKnobTreble(value);
    if (trebleFilter) trebleFilter.gain.value = ((value - 50) / 50) * 15;
  }
}

function bindKnob(canvasId, tipo, getValue) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  function onStart(e) {
    knobDragging = tipo;
    knobStartY   = getEventY(e);
    knobStartVal = getValue();
    e.preventDefault();
  }
  function onMove(e) {
    if (knobDragging !== tipo) return;
    const v = Math.max(0, Math.min(100, knobStartVal + (knobStartY - getEventY(e)) * 0.6));
    aplicarKnob(tipo, v);
    e.preventDefault();
  }
  function onEnd() { if (knobDragging === tipo) knobDragging = null; }

  canvas.addEventListener('mousedown', onStart);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onEnd);
  canvas.addEventListener('touchstart', onStart, { passive: false });
  canvas.addEventListener('touchmove', onMove, { passive: false });
  canvas.addEventListener('touchend', onEnd);
}

function initKnobs() {
  drawKnobVol(knobValue);
  drawKnobBass(bassValue);
  drawKnobTreble(trebleValue);
  bindKnob('knob-canvas',        'vol',    () => knobValue);
  bindKnob('knob-bass-canvas',   'bass',   () => bassValue);
  bindKnob('knob-treble-canvas', 'treble', () => trebleValue);
}

// ══════════════════════════════════════════════════════════════════════════
// HELPERS UI
// ══════════════════════════════════════════════════════════════════════════

function esCortina(t) { return String(t.Genero || '').trim().toLowerCase() === 'cortina'; }
function fmt(seg) { const s = Math.max(0, Math.floor(seg)); return Math.floor(s / 60) + ':' + (s % 60).toString().padStart(2, '0'); }
function setEl(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function activarRing(on) { const r = document.querySelector('.album-spinning-ring'); if (r) r.classList[on ? 'add' : 'remove']('active'); }

function resetProgressUI() {
  const pf = document.getElementById('progress-fill');
  if (pf) pf.style.width = '0%';
  setEl('time-current', '0:00');
}

function mostrarEstadoCarga(msg) {
  const el = document.getElementById('carga-estado');
  if (!el) return;
  el.textContent   = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

function mostrarToast(msg) {
  let t = document.getElementById('manijero-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'manijero-toast';
    t.style.cssText =
      'position:fixed;bottom:24px;right:24px;background:#1A1008;color:#C9924A;' +
      'border:1px solid rgba(201,146,74,0.4);border-radius:6px;padding:10px 18px;' +
      'font-size:13px;z-index:9999;opacity:0;transition:opacity .3s;' +
      'font-family:Oswald,sans-serif;letter-spacing:1px';
    document.body.appendChild(t);
  }
  t.textContent   = msg;
  t.style.opacity = '1';
  setTimeout(function () { t.style.opacity = '0'; }, 4000);
}

function updateClock() {
  const now   = new Date();
  const dias  = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  setEl('evento-hora',  now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0'));
  setEl('evento-fecha', dias[now.getDay()] + ' ' + now.getDate() + ' ' + meses[now.getMonth()]);
}

console.log('El Manijero Radio v1.1 · listo');
