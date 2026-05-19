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
        prefix_padding_ms: 200,
        silence_duration_ms: 600
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

  const cacheKey = JSON.stringify({ model: OPENAI_TTS_MODEL, voice: OPENAI_TTS_VOICE, input });
  const cachedAudio = ttsCache.get(cacheKey);
  if (cachedAudio) {
    return res.type("audio/mpeg").send(cachedAudio);
  }

  try {
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

const fieldInstructions = {
  operation: `El usuario responde si quiere COMPRAR o VENDER una propiedad inmobiliaria.
Responde ÚNICAMENTE con una de estas palabras exactas: Comprar | Vender
Si el mensaje es ruido, silencio, palabras sueltas sin sentido ("eh", "um", "ah", "si", "no", "vale", "hola", "bueno", "mira"), o no menciona compra ni venta → responde exactamente: (vacío)
Ejemplos válidos:
  "quiero comprar un piso" → Comprar
  "vender mi casa" → Vender
  "comprar" → Comprar
  "vender" → Vender
Ejemplos inválidos → (vacío):
  "si" | "bueno" | "vale" | "eh" | "no sé" | "perdona" | cualquier texto que no mencione comprar o vender`,

  name: `El usuario dice su nombre propio.
Extrae ÚNICAMENTE el nombre propio de la persona, sin saludos, sin puntuación extra.
Si el texto contiene SOLO palabras de relleno ("si", "sí", "no", "vale", "bueno", "mira", "hola", "claro", "eh", "um", "ah", "ay", "bien", "pues", "oye"), o es muy corto (menos de 2 letras), o es ruido → responde exactamente: (vacío)
Si hay un número en el texto → (vacío)
Ejemplos válidos:
  "me llamo María García" → María García
  "soy Juan" → Juan
  "Carlos López" → Carlos López
  "Ana" → Ana
Ejemplos inválidos → (vacío):
  "si" | "no" | "vale" | "eh" | "bueno" | "hola" | "123" | "mm" | texto con números`,

  phone: `El usuario está dictando su número de teléfono español cifra a cifra o en grupos.
Convierte palabras numéricas (uno, dos, tres…) a dígitos. Ignora espacios y pausas.
Responde ÚNICAMENTE los 9 dígitos consecutivos, sin espacios ni guiones.
Si no hay exactamente 9 dígitos identificables en el mensaje → responde exactamente: (vacío)
Ejemplos válidos:
  "seis tres uno dos tres cuatro cinco seis siete" → 631234567
  "699 12 34 56" → 699123456
  "6 nueve nueve 1 2 3 4 5 6" → 699123456
Ejemplos inválidos → (vacío):
  "si" | "no" | "mañana" | cualquier texto sin 9 dígitos identificables`,

  zone: `El usuario dice el nombre de la zona, barrio, ciudad o municipio donde se ubica o busca la propiedad.
Responde ÚNICAMENTE el nombre del lugar, sin artículos innecesarios, sin frases extra.
Si el texto es ruido, una interjección, no menciona ningún lugar ("si", "no", "vale", "eh", "um", "no sé", "aquí"), o no hay un lugar identificable → responde exactamente: (vacío)
Si solo hay números sin nombre → (vacío)
Ejemplos válidos:
  "en el centro de Madrid" → Madrid centro
  "busco en Chamberí" → Chamberí
  "Sevilla, zona norte" → Sevilla norte
  "Getafe" → Getafe
Ejemplos inválidos → (vacío):
  "si" | "no" | "aquí" | "no lo sé" | "eh" | "um" | solo números`,

  propertyType: `El usuario dice qué tipo de propiedad es o busca: piso, apartamento, casa, chalet, adosado, local, oficina, garaje, trastero, finca, villa, etc.
Responde ÚNICAMENTE el tipo de propiedad mencionado, en una o dos palabras.
Si el texto es ruido, interjección, o no identifica ningún tipo de propiedad → responde exactamente: (vacío)
Ejemplos válidos:
  "busco un piso" → piso
  "tengo una casa con jardín" → casa
  "es un local comercial" → local comercial
  "chalet adosado" → chalet adosado
Ejemplos inválidos → (vacío):
  "si" | "no" | "algo" | "una cosa" | "eh" | "no sé" | ruido`,

  price: `El usuario menciona un precio aproximado en euros.
Convierte el número (incluyendo palabras como "doscientos mil", "medio millón") al formato: 200.000 euros
Responde ÚNICAMENTE en ese formato. Si el precio no está claro o no hay número identificable → responde exactamente: (vacío)
Ejemplos válidos:
  "unos 250.000 euros" → 250.000 euros
  "doscientos mil euros" → 200.000 euros
  "medio millón" → 500.000 euros
  "sobre los 150 mil" → 150.000 euros
  "300000" → 300.000 euros
Ejemplos inválidos → (vacío):
  "si" | "no sé" | "barato" | "caro" | "algo" | texto sin número ni mención de precio`,

  availability: `El usuario indica cuándo tiene disponibilidad para ser contactado o para visitar la propiedad.
Resume en pocas palabras claras la disponibilidad mencionada.
Si el texto es ruido, interjección, o no hay información de disponibilidad → responde exactamente: (vacío)
Ejemplos válidos:
  "por las tardes entre semana" → tardes entre semana
  "los fines de semana" → fines de semana
  "cuando quieran" → cualquier momento
  "mañana por la tarde" → mañana por la tarde
  "a partir de las 5" → a partir de las 17:00
Ejemplos inválidos → (vacío):
  "si" | "no sé" | "eh" | "um" | "vale" | respuestas sin información de horario`,

  financing: `El usuario responde si necesita financiación bancaria.
Responde ÚNICAMENTE: Sí | No
Si el mensaje es ruido, interjección, o no queda claro si necesita o no financiación → responde exactamente: (vacío)
Ejemplos válidos (Sí):
  "sí necesito financiación" → Sí
  "necesito hipoteca" → Sí
  "sí, me hace falta" → Sí
Ejemplos válidos (No):
  "no, ya tengo el dinero" → No
  "al contado" → No
  "ya cuento con financiación propia" → No
  "no necesito" → No
Ejemplos inválidos → (vacío):
  "si" (sin contexto de financiación) | "eh" | "um" | "vale" | respuestas ambiguas`
};

app.post("/extract", async (req, res) => {
  const { field, transcript } = req.body || {};
  if (!transcript || !field) return res.json({ value: "" });
  const instruction = fieldInstructions[field];
  if (!instruction) return res.json({ value: "" });

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: instruction },
          { role: "user", content: transcript }
        ],
        max_tokens: 60,
        temperature: 0
      })
    });
    const data = await response.json();
    const raw = (data.choices?.[0]?.message?.content || "").trim();
    const value = raw === "(vacío)" || raw === "(vacio)" ? "" : raw;
    res.json({ value });
  } catch {
    res.json({ value: "" });
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
