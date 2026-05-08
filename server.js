import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";

const PORT = Number(process.env.PORT || 5173);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-mini";
const OPENAI_REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || "marin";
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "marin";

if (!OPENAI_API_KEY) {
  console.error("ERROR: falta OPENAI_API_KEY en .env");
  process.exit(1);
}

const app = express();

app.use(express.json({ type: "application/json", limit: "32kb" }));
app.use(express.text({ type: ["application/sdp", "text/plain"] }));

const agentScript = new Set([
  "Hola gracias por contactar con nuestra inmobiliaria, podria indicarme si desea comprar o vender una propiedad.",
  "Vale muchas gracias podria indicarme su nombre.",
  "Indiquenos su numero de telefono diga los numeros de uno en uno y nos pondremos en contacto con usted.",
  "En que zona se encuentra o le interesa la propiedad.",
  "Que tipo de propiedad es o esta buscando.",
  "Podria indicarme un precio aproximado.",
  "Que disponibilidad tiene para que un asesor le contacte o pueda concertar una visita.",
  "Podria indicarnos un correo electronico de contacto.",
  "Para terminar, necesita financiacion o ya cuenta con ella.",
  "Disculpe, no he podido recoger bien el numero. Puede repetirlo de uno en uno por favor.",
  "De acuerdo tu asistencia ha sido completada se pondran en contacto contigo lo antes posible."
]);
const ttsCache = new Map();

const realtimeSession = {
  type: "realtime",
  model: OPENAI_REALTIME_MODEL,
  instructions: `
Eres Avancia, el asistente virtual de una inmobiliaria. Hablas en espanol de Espana.
Objetivo: cualificar en menos de un minuto siguiendo un guion fijo.

Guion obligatorio, una frase cada vez:
1. Empieza siempre diciendo exactamente: "Hola gracias por contactar con nuestra inmobiliaria, podria indicarme si desea comprar o vender una propiedad."
2. Cuando el usuario indique que quiere comprar o vender, guarda ese dato y pregunta exactamente: "Vale muchas gracias podria indicarme su nombre."
3. Cuando el usuario indique su nombre, guarda ese dato y pregunta exactamente: "Indiquenos su numero de telefono diga los numeros de uno en uno y nos pondremos en contacto con usted."
4. Cuando el usuario indique su telefono, guarda ese dato y pregunta exactamente: "En que zona se encuentra o le interesa la propiedad."
5. Cuando el usuario indique la zona, guarda ese dato y pregunta exactamente: "Que tipo de propiedad es o esta buscando."
6. Cuando el usuario indique el tipo de propiedad, guarda ese dato y pregunta exactamente: "Podria indicarme un precio aproximado."
7. Cuando el usuario indique el precio, guarda ese dato y pregunta exactamente: "Que disponibilidad tiene para que un asesor le contacte o pueda concertar una visita."
8. Cuando el usuario indique la disponibilidad, guarda ese dato y pregunta exactamente: "Podria indicarnos un correo electronico de contacto."
9. Cuando el usuario indique el correo, guarda ese dato y pregunta exactamente: "Para terminar, necesita financiacion o ya cuenta con ella."
10. Cuando el usuario indique si necesita financiacion, guarda ese dato, marca estado como cita agendada y responde exactamente: "De acuerdo tu asistencia ha sido completada se pondran en contacto contigo lo antes posible."

Reglas:
- Si recibes una instruccion del cliente que empiece por "Di exactamente", di solo la frase entre comillas, palabra por palabra, sin anadir nada antes ni despues.
- Haz solo una pregunta o confirmacion por turno y despues espera la respuesta del usuario.
- No preguntes zona, presupuesto, disponibilidad ni ningun otro dato.
- No saludes otra vez despues del primer mensaje.
- No repitas explicaciones.
- No digas "claro", "perfecto", "con gusto" ni frases de relleno salvo que formen parte exacta del guion.
- Respuestas muy cortas y ajustadas exactamente al guion.
- Cuando confirmes el cierre, no vuelvas a hablar.
  `.trim(),
  audio: {
    input: {
      turn_detection: {
        type: "server_vad",
        create_response: false,
        threshold: 0.5,
        prefix_padding_ms: 120,
        silence_duration_ms: 220
      },
      transcription: {
        model: "gpt-4o-mini-transcribe"
      }
    },
    output: {
      voice: OPENAI_REALTIME_VOICE
    }
  }
};

app.post("/session", async (req, res) => {
  if (!req.body) return res.status(400).send("Falta SDP offer");

  const formData = new FormData();
  formData.set("sdp", req.body);
  formData.set("session", JSON.stringify(realtimeSession));

  try {
    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: formData
    });

    const answer = await response.text();
    if (!response.ok) {
      console.error("OpenAI Realtime error:", response.status, answer);
      return res.status(response.status).send(answer);
    }

    res.type("application/sdp").send(answer);
  } catch (error) {
    console.error("No se pudo crear la sesion Realtime:", error);
    res.status(500).send("No se pudo crear la sesion Realtime");
  }
});

app.post("/tts", async (req, res) => {
  const input = req.body?.input;
  if (!input || typeof input !== "string") {
    return res.status(400).send("Falta texto para sintetizar");
  }
  if (!agentScript.has(input)) {
    return res.status(400).send("Texto fuera del guion permitido");
  }

  try {
    const cacheKey = JSON.stringify({
      model: OPENAI_TTS_MODEL,
      voice: OPENAI_TTS_VOICE,
      input
    });
    const cachedAudio = ttsCache.get(cacheKey);
    if (cachedAudio) {
      return res.type("audio/mpeg").send(cachedAudio);
    }

    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_TTS_MODEL,
        voice: OPENAI_TTS_VOICE,
        input,
        instructions:
          "Lee exactamente el texto recibido, sin anadir ni quitar palabras. Voz femenina natural de recepcionista espanola, calida, profesional y tranquila. Ritmo conversacional, nada robotico.",
        response_format: "mp3"
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenAI TTS error:", response.status, errorText);
      return res.status(response.status).send(errorText);
    }

    const audio = Buffer.from(await response.arrayBuffer());
    ttsCache.set(cacheKey, audio);
    res.type("audio/mpeg").send(audio);
  } catch (error) {
    console.error("No se pudo generar audio TTS:", error);
    res.status(500).send("No se pudo generar audio TTS");
  }
});

const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: "spa"
});

app.use(vite.middlewares);

app.listen(PORT, () => {
  console.log(`Demo Realtime lista en http://127.0.0.1:${PORT}`);
});
