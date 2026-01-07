// server/modules/botManager.js
const { GoogleGenerativeAI } = require("@google/generative-ai");
const gis = require('g-i-s');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// --- LÓGICA DE IMÁGENES ---
const downloadAndSaveImage = async (url, botId) => {
    try {
        const response = await axios({
            url, method: 'GET', responseType: 'arraybuffer', timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const contentType = response.headers['content-type'];
        if (!contentType || !contentType.startsWith('image/')) return null;

        const filename = `bot_${botId}_${Date.now()}.webp`;
        const destFolder = path.join(__dirname, '../uploads/post_images/');
        if (!fs.existsSync(destFolder)) fs.mkdirSync(destFolder, { recursive: true });
        
        const fullPath = path.join(destFolder, filename);
        await sharp(response.data)
            .resize(1000, 1000, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 80 })
            .toFile(fullPath);

        return `/uploads/post_images/${filename}`;
    } catch (e) { return null; }
};

const searchAndGetLocalImage = (query, botId) => {
    return new Promise((resolve) => {
        const cleanQuery = `${query} -site:pinterest.com -site:fbcdn.net`;
        gis(cleanQuery, async (error, results) => {
            if (error || !results || results.length === 0) return resolve(null);
            // Intentar con las primeras 3 fotos
            for (let i = 0; i < Math.min(results.length, 3); i++) {
                const localPath = await downloadAndSaveImage(results[i].url, botId);
                if (localPath) return resolve(localPath);
            }
            resolve(null);
        });
    });
};

// --- MOTOR PRINCIPAL ---
const startAutonomousBot = async (pool, io) => {
    console.log("🤖 Sistema de Bot Autónomo Iniciado.");

    const runPostCycle = async () => {
        try {
            // 1. Obtener bot con llave
            const botResult = await pool.query(
                "SELECT id, username, bio, bot_personality, gemini_api_key, profile_pic_url, bot_allows_images FROM usersapp WHERE is_bot = TRUE LIMIT 1"
            );
            const bot = botResult.rows[0];

            if (!bot || !bot.gemini_api_key) {
                console.log("ℹ️ Esperando configuración de API Key para el bot...");
                return; 
            }

            // 2. Inicializar IA con el modelo CORRECTO (1.5-flash)
            const genAI = new GoogleGenerativeAI(bot.gemini_api_key.trim());
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

            const prompt = `Eres ${bot.username}. Bio: ${bot.bio}. Personalidad: ${bot.bot_personality}.
            Genera un JSON con este formato exacto:
            {"caption": "texto corto", "image_search_query": "termino de busqueda en ingles"}
            Responde SOLO el JSON, sin bloques de código ni texto adicional.`;

            try {
                const result = await model.generateContent(prompt);
                const textResponse = result.response.text();
                
                // LIMPIEZA TOTAL DEL JSON (Elimina ```json y otros ruidos)
                const cleanJson = textResponse.replace(/```json|```/g, "").trim();
                const botPayload = JSON.parse(cleanJson);

                let finalImageUrl = null;
                if (bot.bot_allows_images && botPayload.image_search_query) {
                    console.log(`🎨 [${bot.username}] Buscando: ${botPayload.image_search_query}`);
                    finalImageUrl = await searchAndGetLocalImage(botPayload.image_search_query, bot.id);
                }

                if (botPayload.caption) {
                    const insertQuery = `INSERT INTO postapp (user_id, content, image_url, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP) RETURNING *;`;
                    const postResult = await pool.query(insertQuery, [bot.id, botPayload.caption, finalImageUrl]);
                    const newPost = postResult.rows[0];

                    if (io) {
                        io.emit('new_post', {
                            ...newPost,
                            username: bot.username,
                            profile_pic_url: bot.profile_pic_url,
                            total_likes: 0, total_comments: 0,
                            is_liked_by_user: false, is_saved_by_user: false
                        });
                    }
                    console.log(`✅ [${bot.username}] Publicó: ${botPayload.caption}`);
                }
            } catch (apiError) {
                console.error(`❌ Error en la API del bot ${bot.username}:`, apiError.message);
            }
        } catch (error) {
            console.error("❌ Error en el ciclo del bot:", error.message);
        }

        // Programar siguiente post
        const nextTime = (Math.floor(Math.random() * 20) + 20) * 60 * 1000;
        setTimeout(runPostCycle, nextTime);
    };

    runPostCycle();
};

module.exports = { startAutonomousBot };