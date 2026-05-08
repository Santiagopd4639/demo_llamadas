const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-mini";
const OPENAI_REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || "marin";

const realtimeSession = {
  type: "realtime",
  model: OPENAI_REALTIME_MODEL,
  instructions: `
Eres Avancia, el asistente virtual de una inmobiliaria. Hablas en espanol de Espana.
Objetivo: cualificar en menos de un minuto siguiendo un guion fijo.

Reglas:
- No generes respuestas automaticas por tu cuenta.
- Solo transcribe y procesa audio del usuario cuando el frontend lo indique.
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Metodo no permitido");
  }
  if (!OPENAI_API_KEY) {
    return res.status(500).send("Falta OPENAI_API_KEY");
  }

  const sdp = await readTextBody(req);
  if (!sdp) return res.status(400).send("Falta SDP offer");

  const formData = new FormData();
  formData.set("sdp", sdp);
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

    res.setHeader("Content-Type", "application/sdp");
    return res.status(200).send(answer);
  } catch (error) {
    console.error("No se pudo crear la sesion Realtime:", error);
    return res.status(500).send("No se pudo crear la sesion Realtime");
  }
}

async function readTextBody(req) {
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (req.body) return String(req.body);

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
