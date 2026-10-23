import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Shared server-side Gemini AI client
let ai = null;
if (process.env.GEMINI_API_KEY) {
  ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build'
      }
    }
  });
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', aiConfigured: Boolean(process.env.GEMINI_API_KEY) });
});

// AI Endpoint: Generate SEO Metadata
app.post('/api/seo/generate', async (req, res) => {
  const { productName, category, fabric, features, price, description } = req.body || {};
  if (!productName || !String(productName).trim()) {
    return res.status(400).json({ error: 'Product name is required' });
  }

  const name = String(productName).trim();
  const cat = String(category || 'Pakistani Fashion').trim();
  const fab = String(fabric || '').trim();
  const feat = Array.isArray(features) ? features.join(', ') : String(features || '');

  // If Gemini API is configured, use gemini-3.8-flash for high quality SEO
  if (ai) {
    try {
      const prompt = `You are a professional Pakistani e-commerce SEO specialist for ZENVORA SHOOP (Karachi, Pakistan).
Generate high-converting, strictly relevant SEO metadata for this product:
Product: "${name}"
Category: "${cat}"
Fabric/Material: "${fab}"
Features: "${feat}"
Price: Rs. ${price || 0}
Store highlights: Cash on Delivery Pakistan, Karachi fast doorstep delivery, WhatsApp ordering.

Guidelines:
1. metaTitle: Under 60 characters, natural, includes product name and brand " | ZENVORA SHOOP"
2. metaDescription: Between 135 and 158 characters, compelling call-to-action mentioning authentic Pakistani fashion, COD Pakistan, and WhatsApp ordering.
3. focusKeyword: 3-5 word natural keyword phrase.
4. additionalKeywords: 4-6 comma-separated high-intent search phrases.
5. ogTitle: Compelling social share title under 65 characters.
6. ogDescription: Engaging social share description under 150 characters.

Return strict JSON format with keys: metaTitle, metaDescription, focusKeyword, additionalKeywords, ogTitle, ogDescription.`;

      const aiResponse = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              metaTitle: { type: Type.STRING },
              metaDescription: { type: Type.STRING },
              focusKeyword: { type: Type.STRING },
              additionalKeywords: { type: Type.STRING },
              ogTitle: { type: Type.STRING },
              ogDescription: { type: Type.STRING }
            },
            required: ['metaTitle', 'metaDescription', 'focusKeyword', 'additionalKeywords', 'ogTitle', 'ogDescription']
          }
        }
      });

      const parsed = JSON.parse(aiResponse.text.trim());
      return res.json({ success: true, aiGenerated: true, data: parsed });
    } catch (err) {
      console.warn('[ZENVORA AI] Gemini SEO generation notice:', err.message);
    }
  }

  // Graceful rule-based fallback when AI is not configured or in offline mode
  const cleanCat = cat.replace(/suits/i, '').trim();
  const fallbackData = {
    metaTitle: `${name} | ZENVORA SHOOP`,
    metaDescription: `Shop ${name} at ZENVORA SHOOP. Authentic ${cat} with Cash on Delivery Pakistan & instant WhatsApp ordering.`,
    focusKeyword: name.toLowerCase(),
    additionalKeywords: `${name.toLowerCase()}, ${cat.toLowerCase()}, Pakistani fashion online, Cash on Delivery Pakistan, Karachi suits`,
    ogTitle: `${name} | ZENVORA SHOOP`,
    ogDescription: `Discover authentic ${name} at ZENVORA SHOOP. Premium Pakistani craftsmanship with doorstep COD.`
  };

  return res.json({
    success: true,
    aiGenerated: false,
    note: process.env.GEMINI_API_KEY ? 'Generated with intelligent templates' : 'Add GEMINI_API_KEY in Settings > Secrets for Gemini AI enhancements.',
    data: fallbackData
  });
});

// AI Endpoint: Generate Description & Highlights
app.post('/api/description/generate', async (req, res) => {
  const { productName, category, fabric, features, brand } = req.body || {};
  if (!productName || !String(productName).trim()) {
    return res.status(400).json({ error: 'Product name is required' });
  }

  const name = String(productName).trim();
  const cat = String(category || 'Fashion').trim();
  const fab = String(fabric || 'Premium quality fabric').trim();
  const feat = Array.isArray(features) ? features.join(', ') : String(features || '');

  if (ai) {
    try {
      const prompt = `You are a product copywriter for Pakistani e-commerce store ZENVORA SHOOP.
Write an authentic, elegant, and informative product description:
Product: "${name}"
Category: "${cat}"
Fabric: "${fab}"
Provided Features: "${feat}"

Guidelines:
1. heading: Catchy product header.
2. shortSummary: 2-3 engaging sentences highlighting style, comfort, and occasion suitability.
3. fullDescription: 2 informative paragraphs detailing craftsmanship, drape/comfort, wearability, and care.
4. features: An array of 4-6 concise bullet points highlighting key specifications (e.g., fabric type, detailing, styling).
Do NOT invent unprovided details (e.g. don't say 3-piece if not indicated).

Return strict JSON with keys: heading, shortSummary, fullDescription, features.`;

      const aiResponse = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              heading: { type: Type.STRING },
              shortSummary: { type: Type.STRING },
              fullDescription: { type: Type.STRING },
              features: {
                type: Type.ARRAY,
                items: { type: Type.STRING }
              }
            },
            required: ['heading', 'shortSummary', 'fullDescription', 'features']
          }
        }
      });

      const parsed = JSON.parse(aiResponse.text.trim());
      return res.json({ success: true, aiGenerated: true, data: parsed });
    } catch (err) {
      console.warn('[ZENVORA AI] Gemini description generation notice:', err.message);
    }
  }

  // Graceful rule-based fallback
  const fallbackDesc = {
    heading: `${name} — Premium Collection`,
    shortSummary: `Discover timeless elegance with ${name}. Crafted with ${fab} for supreme all-day comfort and a graceful drape.`,
    fullDescription: `${name} represents fine Pakistani craftsmanship tailored for everyday grace and special gatherings. Built with ${fab}, this piece balances breathability, durability, and contemporary styling.\n\nEnjoy convenient Cash on Delivery across Karachi and Pakistan with quick WhatsApp ordering and personalized customer care.`,
    features: [
      `Fabric / Material: ${fab}`,
      `Category: ${cat}`,
      `Authentic Pakistani Craftsmanship`,
      `Cash on Delivery Available`,
      `2-3 Days Fast Doorstep Delivery`
    ]
  };

  return res.json({
    success: true,
    aiGenerated: false,
    note: process.env.GEMINI_API_KEY ? 'Generated with intelligent templates' : 'Add GEMINI_API_KEY in Settings > Secrets for Gemini AI enhancements.',
    data: fallbackDesc
  });
});

// Determine static root: dist in production if it exists, otherwise project root for live development
const staticDir = (process.env.NODE_ENV === 'production' && fs.existsSync(path.join(__dirname, 'dist', 'index.html')))
  ? path.join(__dirname, 'dist')
  : __dirname;

// Clean dynamic product routes
app.get(['/product', '/product.html', '/product/:id', '/p/:id'], (req, res) => {
  const productHtmlPath = path.join(staticDir, 'product.html');
  if (fs.existsSync(productHtmlPath)) {
    return res.sendFile(productHtmlPath);
  }
  return res.sendFile(path.join(staticDir, 'index.html'));
});


// Clean URL routing: redirect trailing slashes to clean path
app.use((req, res, next) => {
  if (req.path.length > 1 && req.path.endsWith('/')) {
    const cleanPath = req.path.slice(0, -1);
    const query = req.url.slice(req.path.length);
    return res.redirect(301, cleanPath + query);
  }
  next();
});

// Serve static assets with html extension resolution
app.use(express.static(staticDir, {
  extensions: ['html', 'htm'],
  index: 'index.html',
  maxAge: 0
}));

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ZENVORA SHOOP server running on http://0.0.0.0:${PORT} (serving ${staticDir})`);
});
