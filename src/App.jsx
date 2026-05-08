import React, { useEffect, useMemo, useRef, useState } from "react";

const initialLead = {
  operation: "",
  name: "",
  phone: "",
  zone: "",
  propertyType: "",
  price: "",
  availability: "",
  email: "",
  financing: "",
  status: "esperando"
};

const agentPrompts = {
  greeting:
    "Hola gracias por contactar con nuestra inmobiliaria, podria indicarme si desea comprar o vender una propiedad.",
  askName: "Vale muchas gracias podria indicarme su nombre.",
  askPhone:
    "Indiquenos su numero de telefono diga los numeros de uno en uno y nos pondremos en contacto con usted.",
  askZone: "En que zona se encuentra o le interesa la propiedad.",
  askPropertyType: "Que tipo de propiedad es o esta buscando.",
  askPrice: "Podria indicarme un precio aproximado.",
  askAvailability: "Que disponibilidad tiene para que un asesor le contacte o pueda concertar una visita.",
  askEmail: "Podria indicarnos un correo electronico de contacto.",
  askFinancing: "Para terminar, necesita financiacion o ya cuenta con ella.",
  repeatPhone:
    "Disculpe, no he podido recoger bien el numero. Puede repetirlo de uno en uno por favor.",
  done:
    "De acuerdo tu asistencia ha sido completada se pondran en contacto contigo lo antes posible."
};
const agentPromptTexts = Object.values(agentPrompts);

function App() {
  const [callState, setCallState] = useState("esperando");
  const [lead, setLead] = useState(initialLead);
  const [messages, setMessages] = useState([]);
  const [seconds, setSeconds] = useState(0);
  const [connectionState, setConnectionState] = useState("desconectado");
  const transcriptRef = useRef(null);
  const peerRef = useRef(null);
  const channelRef = useRef(null);
  const streamRef = useRef(null);
  const audioRef = useRef(null);
  const promptAudioRef = useRef(null);
  const promptAudioCacheRef = useRef(new Map());
  const awaitingResponseRef = useRef(false);
  const pendingResponseRef = useRef(false);
  const pendingTranscriptRef = useRef("");
  const leadStepRef = useRef("operation");
  const callRunIdRef = useRef(0);
  const callStateRef = useRef("esperando");
  const autoHangupRef = useRef(null);

  const statusLabel = useMemo(() => {
    if (callState === "active") return "llamada activa";
    if (callState === "scheduled") return "cita agendada";
    return "esperando";
  }, [callState]);

  useEffect(() => {
    if (callState !== "active") return undefined;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [callState]);

  useEffect(() => {
    callStateRef.current = callState;
  }, [callState]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [messages]);

  useEffect(() => {
    agentPromptTexts.forEach((text) => {
      preloadPromptAudio(text);
    });

    return () => {
      promptAudioCacheRef.current.forEach((url) => window.URL.revokeObjectURL(url));
      promptAudioCacheRef.current.clear();
    };
  }, []);

  async function startCall() {
    const callRunId = callRunIdRef.current + 1;
    callRunIdRef.current = callRunId;

    try {
      setConnectionState("pidiendo microfono");
      setCallState("active");
      callStateRef.current = "active";
      awaitingResponseRef.current = false;
      leadStepRef.current = "operation";
      setSeconds(0);
      setLead({ ...initialLead, status: "llamada activa" });
      setMessages([]);
      pendingResponseRef.current = false;
      pendingTranscriptRef.current = "";

      const pc = new RTCPeerConnection();
      const dc = pc.createDataChannel("oai-events");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audio = new Audio();

      audio.autoplay = true;
      pc.ontrack = (event) => {
        audio.srcObject = event.streams[0];
      };

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      dc.addEventListener("open", () => {
        setConnectionState("OpenAI Realtime conectado");
        playAgentPrompt(agentPrompts.greeting);
      });

      dc.addEventListener("message", (event) => handleRealtimeEvent(JSON.parse(event.data)));

      peerRef.current = pc;
      channelRef.current = dc;
      streamRef.current = stream;
      audioRef.current = audio;

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      setConnectionState("negociando sesion");
      const response = await fetch("/session", {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: offer.sdp
      });

      const answerSdp = await response.text();
      if (!response.ok) throw new Error(answerSdp || "No se pudo crear la sesion");

      if (callRunIdRef.current !== callRunId || pc.signalingState === "closed") {
        return;
      }

      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      addSystemMessage("Microfono activo. Habla con el asistente.");
    } catch (error) {
      console.error(error);
      if (
        callRunIdRef.current !== callRunId ||
        error.message?.includes("signalingState is 'closed'")
      ) {
        return;
      }
      setConnectionState("error");
      addSystemMessage(`Error: ${error.message}`);
      endCall();
    }
  }

  function resetDemo() {
    closeRealtime();
    if (autoHangupRef.current) window.clearTimeout(autoHangupRef.current);
    setCallState("esperando");
    callStateRef.current = "esperando";
    callRunIdRef.current += 1;
    awaitingResponseRef.current = false;
    pendingResponseRef.current = false;
    pendingTranscriptRef.current = "";
    leadStepRef.current = "operation";
    setLead(initialLead);
    setMessages([]);
    setSeconds(0);
    setConnectionState("desconectado");
  }

  function endCall() {
    closeRealtime();
    if (autoHangupRef.current) window.clearTimeout(autoHangupRef.current);
    callRunIdRef.current += 1;
    awaitingResponseRef.current = false;
    pendingResponseRef.current = false;
    pendingTranscriptRef.current = "";
    leadStepRef.current = "operation";
    setCallState((state) => {
      const next = state === "scheduled" ? state : "esperando";
      callStateRef.current = next;
      return next;
    });
  }

  function addAgentMessage(text) {
    setMessages((items) => [...items, createMessage("agent", text)]);
  }

  function addUserMessage(text) {
    setMessages((items) => [...items, createMessage("user", text)]);
  }

  function addSystemMessage(text) {
    setMessages((items) => [...items, createMessage("system", text)]);
  }

  function sendRealtimeEvent(event) {
    if (channelRef.current?.readyState === "open") {
      channelRef.current.send(JSON.stringify(event));
    }
  }

  function setMicrophoneEnabled(enabled) {
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  function playAgentPrompt(text) {
    if (callStateRef.current !== "active") return;
    awaitingResponseRef.current = true;
    pendingResponseRef.current = false;
    pendingTranscriptRef.current = "";
    setMicrophoneEnabled(false);
    addAgentMessage(text);

    let objectUrl = promptAudioCacheRef.current.get(text) || "";
    let finished = false;

    const finishPrompt = () => {
      if (finished) return;
      finished = true;
      window.setTimeout(() => {
        awaitingResponseRef.current = false;

        if (text === agentPrompts.done) {
          callStateRef.current = "scheduled";
          setCallState("scheduled");
          setLead((current) => ({ ...current, status: "cita agendada" }));
          scheduleAutoHangup();
          return;
        }

        setMicrophoneEnabled(true);
      }, 450);
    };

    const playFromUrl = (url) => {
      const promptAudio = new Audio(url);
      promptAudioRef.current = promptAudio;
      promptAudio.onended = finishPrompt;
      promptAudio.onerror = finishPrompt;
      return promptAudio.play();
    };

    const audioPromise = objectUrl
      ? Promise.resolve(objectUrl)
      : fetchPromptAudio(text);

    audioPromise
      .then(playFromUrl)
      .catch((error) => {
        console.warn(error);
        awaitingResponseRef.current = false;
        setMicrophoneEnabled(true);
        addSystemMessage("No se pudo reproducir la voz IA. Revisa el endpoint /tts y la API key.");
      });
  }

  function preloadPromptAudio(text) {
    if (promptAudioCacheRef.current.has(text)) return;
    fetchPromptAudio(text).catch((error) => console.warn("No se pudo precargar TTS", error));
  }

  async function fetchPromptAudio(text) {
    const response = await fetch("/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: text })
    });
    if (!response.ok) throw new Error("No se pudo generar la voz");

    const blob = await response.blob();
    const objectUrl = window.URL.createObjectURL(blob);
    promptAudioCacheRef.current.set(text, objectUrl);
    return objectUrl;
  }

  function handleRealtimeEvent(event) {
    if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
      if (awaitingResponseRef.current) return;
      addUserMessage(event.transcript);
      requestNextAgentTurn(event.transcript);
    }

    if (
      (event.type === "response.output_audio_transcript.done" ||
        event.type === "response.audio_transcript.done") &&
      event.transcript
    ) {
      return;
    }

    if (event.type === "response.done" || event.type === "response.cancelled") {
      return;
    }

    if (event.type === "response.function_call_arguments.done") {
      applyLeadUpdate(event.arguments);
      acknowledgeTool(event.call_id);
    }

    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      applyLeadUpdate(event.item.arguments);
      acknowledgeTool(event.item.call_id);
    }

    if (event.type === "error") {
      if (event.error?.message?.includes("active response in progress")) {
        awaitingResponseRef.current = true;
        pendingResponseRef.current = true;
        return;
      }
      awaitingResponseRef.current = false;
      addSystemMessage(event.error?.message || "OpenAI devolvio un error.");
    }
  }

  function requestNextAgentTurn(transcript = "") {
    if (callStateRef.current !== "active") return;
    if (awaitingResponseRef.current) {
      pendingTranscriptRef.current = transcript || pendingTranscriptRef.current;
      pendingResponseRef.current = true;
      return;
    }
    const prompt = getNextPrompt(transcript);
    if (!prompt) return;
    playAgentPrompt(prompt);
  }

  function getNextPrompt(transcript) {
    const text = transcript.trim();
    if (!text) return null;

    if (leadStepRef.current === "operation") {
      const operation = normalizeOperation(text);
      setLead((current) => ({
        ...current,
        operation: operation || current.operation,
        status: "llamada activa"
      }));
      leadStepRef.current = "name";
      return agentPrompts.askName;
    }

    if (leadStepRef.current === "name") {
      setLead((current) => ({ ...current, name: extractName(text) || text || current.name }));
      leadStepRef.current = "phone";
      return agentPrompts.askPhone;
    }

    if (leadStepRef.current === "phone") {
      const phone = normalizePhone(text);
      if (phone.replace(/\D/g, "").length !== 9) {
        return agentPrompts.repeatPhone;
      }

      setLead((current) => ({
        ...current,
        phone,
        status: "llamada activa"
      }));
      leadStepRef.current = "zone";
      return agentPrompts.askZone;
    }

    if (leadStepRef.current === "zone") {
      setLead((current) => ({ ...current, zone: cleanFieldAnswer(text) || current.zone }));
      leadStepRef.current = "propertyType";
      return agentPrompts.askPropertyType;
    }

    if (leadStepRef.current === "propertyType") {
      setLead((current) => ({
        ...current,
        propertyType: cleanFieldAnswer(text) || current.propertyType
      }));
      leadStepRef.current = "price";
      return agentPrompts.askPrice;
    }

    if (leadStepRef.current === "price") {
      setLead((current) => ({ ...current, price: normalizePrice(text) || current.price }));
      leadStepRef.current = "availability";
      return agentPrompts.askAvailability;
    }

    if (leadStepRef.current === "availability") {
      setLead((current) => ({
        ...current,
        availability: cleanFieldAnswer(text) || current.availability
      }));
      leadStepRef.current = "email";
      return agentPrompts.askEmail;
    }

    if (leadStepRef.current === "email") {
      setLead((current) => ({
        ...current,
        email: extractEmail(text) || cleanFieldAnswer(text) || current.email
      }));
      leadStepRef.current = "financing";
      return agentPrompts.askFinancing;
    }

    if (leadStepRef.current === "financing") {
      setLead((current) => ({
        ...current,
        financing: cleanFieldAnswer(text) || current.financing,
        status: "cita agendada"
      }));
      leadStepRef.current = "done";
      return agentPrompts.done;
    }

    return null;
  }

  function applyLeadUpdate(argsText) {
    try {
      const details = JSON.parse(argsText || "{}");
      setLead((current) => {
        const next = {
          ...current,
          operation: normalizeOperation(details.operation) || current.operation,
          name: details.name || current.name,
          phone: details.phone || current.phone,
          status: details.status || current.status
        };
        if (next.status === "cita agendada") {
          callStateRef.current = "scheduled";
          setCallState("scheduled");
        }
        return next;
      });
    } catch (error) {
      console.warn("No se pudo parsear update_lead", error);
    }
  }

  function acknowledgeTool(callId) {
    if (!callId) return;
    sendRealtimeEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({ ok: true })
      }
    });
  }

  function closeRealtime() {
    if (promptAudioRef.current) {
      promptAudioRef.current.pause();
      promptAudioRef.current.src = "";
    }
    channelRef.current?.close();
    peerRef.current?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    channelRef.current = null;
    peerRef.current = null;
    streamRef.current = null;
    audioRef.current = null;
    promptAudioRef.current = null;
  }

  function scheduleAutoHangup() {
    if (autoHangupRef.current) return;
    autoHangupRef.current = window.setTimeout(() => {
      closeRealtime();
      setConnectionState("llamada finalizada automaticamente");
      autoHangupRef.current = null;
    }, 10000);
  }

  const leadFields = [
    "operation",
    "name",
    "phone",
    "zone",
    "propertyType",
    "price",
    "availability",
    "email",
    "financing"
  ];
  const progressPercent = callState === "scheduled"
    ? 100
    : Math.round((leadFields.filter((field) => lead[field]).length / leadFields.length) * 100);

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Inbound AI desk</p>
          <h1>Demo agente IA inmobiliaria</h1>
        </div>
        <div className={`status-pill ${callState}`}>
          <span />
          {statusLabel}
        </div>
      </section>

      <section className="dashboard">
        <div className="call-panel">
          <div className="call-header">
            <div className="agent-avatar">
              <span aria-hidden="true">AI</span>
            </div>
            <div>
              <p className="label">Recepcionista virtual</p>
              <h2>Inmobiliaria Centro</h2>
            </div>
            <div className="timer">
              <span aria-hidden="true">◷</span>
              {formatTime(seconds)}
            </div>
          </div>

          <div className="phone-stage">
            <div className="signal-ring">
              <span aria-hidden="true">☎</span>
            </div>
            <div>
              <p className="label">Estado de llamada</p>
              <strong>{statusLabel}</strong>
            </div>
            {callState === "esperando" ? (
              <button className="primary-action" onClick={startCall}>
                <span aria-hidden="true">☎</span>
                Iniciar llamada IA
              </button>
            ) : (
              <div className="call-actions">
                <button className="ghost-action" onClick={endCall}>
                  <span aria-hidden="true">■</span>
                  Colgar
                </button>
                <button className="ghost-action" onClick={resetDemo}>
                  <span aria-hidden="true">↻</span>
                  Reiniciar
                </button>
              </div>
            )}
          </div>

          <div className="progress-block">
            <div className="progress-copy">
              <span>Cualificacion del lead</span>
              <span>{progressPercent}%</span>
            </div>
            <div className="progress-track">
              <div style={{ width: `${progressPercent}%` }} />
            </div>
            <p className="connection-copy">{connectionState}</p>
          </div>

          <div className="transcript" ref={transcriptRef}>
            {messages.length === 0 ? (
              <div className="empty-state">
                <span aria-hidden="true">✦</span>
                <p>La conversacion aparecera aqui cuando inicies la llamada.</p>
              </div>
            ) : (
              messages.map((message) => (
                <article className={`message ${message.role}`} key={message.id}>
                  <span>{getMessageLabel(message.role)}</span>
                  <p>{message.text}</p>
                </article>
              ))
            )}
          </div>

          <div className="voice-note">
            <span aria-hidden="true">●</span>
            {callState === "active"
              ? "Microfono activo: responde hablando y el agente avanzara solo."
              : "Inicia la llamada para activar el microfono."}
          </div>
        </div>

        <aside className="lead-panel">
          <div className="lead-title">
            <span className="lead-icon" aria-hidden="true">▦</span>
            <div>
              <p className="label">Ficha comercial</p>
              <h2>Lead en tiempo real</h2>
            </div>
          </div>

          <LeadRow label="Tipo operacion" value={lead.operation} />
          <LeadRow label="Nombre" value={lead.name} />
          <LeadRow label="Telefono" value={lead.phone} />
          <LeadRow label="Zona" value={lead.zone} />
          <LeadRow label="Tipo propiedad" value={lead.propertyType} />
          <LeadRow label="Precio aprox." value={lead.price} />
          <LeadRow label="Disponibilidad" value={lead.availability} />
          <LeadRow label="Email" value={lead.email} />
          <LeadRow label="Financiacion" value={lead.financing} />
          <LeadRow label="Estado" value={lead.status} strong />

          {callState === "scheduled" && (
            <div className="success-card">
              <span className="success-icon" aria-hidden="true">✓</span>
              <h3>Cita agendada correctamente</h3>
              <dl>
                <SummaryItem label="Nombre" value={lead.name} />
                <SummaryItem label="Telefono" value={lead.phone} />
                <SummaryItem label="Operacion" value={lead.operation} />
                <SummaryItem label="Zona" value={lead.zone} />
                <SummaryItem label="Tipo" value={lead.propertyType} />
                <SummaryItem label="Precio" value={lead.price} />
                <SummaryItem label="Disponibilidad" value={lead.availability} />
                <SummaryItem label="Email" value={lead.email} />
                <SummaryItem label="Financiacion" value={lead.financing} />
              </dl>
              <p>Proximo paso: Un agente humano recibira el aviso.</p>
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}

function LeadRow({ label, value, strong = false }) {
  return (
    <div className="lead-row">
      <span>{label}</span>
      <strong className={strong ? "lead-status" : ""}>{value || "Pendiente"}</strong>
    </div>
  );
}

function SummaryItem({ label, value }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value || "Pendiente"}</dd>
    </>
  );
}

function createMessage(role, text) {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    text
  };
}

function getMessageLabel(role) {
  if (role === "agent") return "Agente IA";
  if (role === "system") return "Sistema";
  return "Cliente";
}

function normalizeOperation(value = "") {
  const normalized = value.toLowerCase();
  if (normalized.includes("compr")) return "Comprar";
  if (normalized.includes("vend")) return "Vender";
  return "";
}

function normalizePhone(value = "") {
  const lower = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const wordDigits = {
    cero: "0",
    zero: "0",
    uno: "1",
    un: "1",
    una: "1",
    dos: "2",
    tres: "3",
    cuatro: "4",
    cinco: "5",
    seis: "6",
    siete: "7",
    ocho: "8",
    nueve: "9"
  };
  const compoundNumbers = {
    diez: "10",
    once: "11",
    doce: "12",
    trece: "13",
    catorce: "14",
    quince: "15",
    dieciseis: "16",
    diecisiete: "17",
    dieciocho: "18",
    diecinueve: "19",
    veinte: "20",
    veintiuno: "21",
    veintidos: "22",
    veintitres: "23",
    veinticuatro: "24",
    veinticinco: "25",
    veintiseis: "26",
    veintisiete: "27",
    veintiocho: "28",
    veintinueve: "29",
    treinta: "30",
    cuarenta: "40",
    cincuenta: "50",
    sesenta: "60",
    setenta: "70",
    ochenta: "80",
    noventa: "90"
  };

  const parts = lower.match(/\d+|[a-z]+/g) || [];
  const digits = parts
    .map((part) => {
      if (/^\d+$/.test(part)) return part;
      if (compoundNumbers[part]) return compoundNumbers[part];
      return wordDigits[part] || "";
    })
    .join("");

  return digits.length >= 6 ? formatPhone(digits) : digits;
}

function extractName(value = "") {
  const cleaned = value
    .trim()
    .replace(/[.!?]+$/g, "")
    .replace(/^(si|sí|vale|bueno|buenas|hola|mira|claro|eh|pues)[,\s]+/i, "")
    .trim();

  const patterns = [
    /\bme llamo\s+(.+)$/i,
    /\bmi nombre es\s+(.+)$/i,
    /\bsoy\s+(.+)$/i,
    /\bnombre es\s+(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match?.[1]) {
      return cleanName(match[1]);
    }
  }

  return cleanName(cleaned);
}

function cleanName(value = "") {
  return value
    .replace(/[.!?]+$/g, "")
    .replace(/^(si|sí|vale|bueno|mira|claro|eh|pues)[,\s]+/i, "")
    .replace(/\b(del telefono|de telefono|por favor).*$/i, "")
    .trim();
}

function cleanFieldAnswer(value = "") {
  return value
    .trim()
    .replace(/[.!?]+$/g, "")
    .replace(/^(si|sí|vale|bueno|buenas|hola|mira|claro|eh|pues)[,\s]+/i, "")
    .replace(/^(seria|sería|es|esta en|está en|busco|buscamos|quiero|queremos)\s+/i, "")
    .trim();
}

function extractEmail(value = "") {
  const normalized = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[<>()[\],;:"]/g, " ")
    .replace(/\s+arroba\s+/g, " @ ")
    .replace(/\s+(punto|dot)\s+/g, " . ")
    .replace(/\s+(guion bajo|guionbajo)\s+/g, " _ ")
    .replace(/\s+(guion|raya)\s+/g, " - ");

  const directMatch = normalized.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  if (directMatch?.[0]) return directMatch[0].replace(/[.!?]+$/g, "");

  const tokens = normalized.match(/[a-z0-9]+|[@._-]/g) || [];
  const atIndex = tokens.indexOf("@");
  if (atIndex < 1 || atIndex >= tokens.length - 1) return "";

  let start = atIndex - 1;
  while (start > 0 && [".", "_", "-"].includes(tokens[start - 1])) {
    start -= 2;
  }

  let end = atIndex + 1;
  while (end < tokens.length - 1 && [".", "_", "-"].includes(tokens[end + 1])) {
    end += 2;
  }

  const email = tokens.slice(start, end + 1).join("");
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) ? email : "";
}

function normalizePrice(value = "") {
  const lower = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const numericMatch = lower.match(/\d[\d.,\s]*/);
  if (numericMatch) {
    const digits = numericMatch[0].replace(/\D/g, "");
    if (digits) return formatEuros(digits);
  }

  const parsed = parseSpanishNumber(lower);
  return parsed ? formatEuros(String(parsed)) : cleanFieldAnswer(value);
}

function parseSpanishNumber(value = "") {
  const units = {
    un: 1,
    uno: 1,
    una: 1,
    dos: 2,
    tres: 3,
    cuatro: 4,
    cinco: 5,
    seis: 6,
    siete: 7,
    ocho: 8,
    nueve: 9
  };
  const specials = {
    diez: 10,
    once: 11,
    doce: 12,
    trece: 13,
    catorce: 14,
    quince: 15,
    dieciseis: 16,
    diecisiete: 17,
    dieciocho: 18,
    diecinueve: 19,
    veinte: 20,
    veintiuno: 21,
    veintidos: 22,
    veintitres: 23,
    veinticuatro: 24,
    veinticinco: 25,
    veintiseis: 26,
    veintisiete: 27,
    veintiocho: 28,
    veintinueve: 29
  };
  const tens = {
    treinta: 30,
    cuarenta: 40,
    cincuenta: 50,
    sesenta: 60,
    setenta: 70,
    ochenta: 80,
    noventa: 90
  };
  const hundreds = {
    cien: 100,
    ciento: 100,
    doscientos: 200,
    trescientos: 300,
    cuatrocientos: 400,
    quinientos: 500,
    seiscientos: 600,
    setecientos: 700,
    ochocientos: 800,
    novecientos: 900
  };

  let total = 0;
  let current = 0;
  const words = value.match(/[a-z]+/g) || [];

  words.forEach((word) => {
    if (units[word]) current += units[word];
    else if (specials[word]) current += specials[word];
    else if (tens[word]) current += tens[word];
    else if (hundreds[word]) current += hundreds[word];
    else if (word === "mil") {
      total += (current || 1) * 1000;
      current = 0;
    } else if (word === "millon" || word === "millones") {
      total += (current || 1) * 1000000;
      current = 0;
    }
  });

  return total + current;
}

function formatEuros(value) {
  return `${Number(value).toLocaleString("es-ES")} euros`;
}

function formatPhone(value) {
  if (value.length === 9) {
    return `${value.slice(0, 3)} ${value.slice(3, 6)} ${value.slice(6)}`;
  }
  return value;
}

function formatTime(value) {
  const minutes = Math.floor(value / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (value % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export default App;
