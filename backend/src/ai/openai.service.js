// Génération d'images via l'API OpenAI (Images) — utilisée UNIQUEMENT par la
// route admin de pré-génération des portraits de gardiens du Dojo (voir
// src/idle/idle.routes.js#POST /api/admin/dojo/generate-boss-art). Jamais
// appelée à la demande d'un joueur : coût réel par appel, une clé absente ou
// une génération refusée ne doivent jamais faire planter le reste du site.
const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations';

class OpenAIError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'OpenAIError';
    this.status = status;
    this.code = code; // ex. "content_policy_violation" — utile à l'appelant pour décider de continuer
  }
}

// Génère une image et renvoie son contenu binaire (Buffer). On demande
// `b64_json` (pas `url`) : l'appelant n'a pas à retélécharger une URL
// temporaire OpenAI avant de la pousser sur R2.
async function generateImageBuffer(prompt, { size = '1024x1024' } = {}) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new OpenAIError('OPENAI_API_KEY absente', 0, 'missing_api_key');
  const model = process.env.OPENAI_IMAGE_MODEL?.trim() || 'gpt-image-1';

  // `gpt-image-1` ne renvoie QUE du b64_json et rejette `response_format`
  // (paramètre inconnu pour ce modèle) ; les modèles `dall-e-*` renvoient une
  // URL temporaire par défaut, donc on leur demande explicitement b64_json.
  const body = { model, prompt, size, n: 1 };
  if (!model.startsWith('gpt-image')) body.response_format = 'b64_json';

  const res = await fetch(OPENAI_IMAGES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  let json;
  try {
    json = await res.json();
  } catch {
    throw new OpenAIError(`OpenAI indisponible (HTTP ${res.status})`, res.status);
  }
  if (!res.ok) {
    const err = json.error || {};
    throw new OpenAIError(err.message || `OpenAI indisponible (HTTP ${res.status})`, res.status, err.code);
  }
  const item = json.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
  // Repli si un modèle renvoie malgré tout une URL (ex. dall-e sans le champ
  // ci-dessus honoré) : on la retélécharge une fois, ici, pas chez l'appelant.
  if (item?.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) throw new OpenAIError(`Téléchargement de l'image OpenAI échoué (HTTP ${imgRes.status})`, imgRes.status);
    return Buffer.from(await imgRes.arrayBuffer());
  }
  throw new OpenAIError('Réponse OpenAI sans image', res.status);
}

module.exports = { generateImageBuffer, OpenAIError };
