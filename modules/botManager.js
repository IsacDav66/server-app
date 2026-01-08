const { GoogleGenerativeAI } = require("@google/generative-ai");
const gis = require('g-i-s');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// --- FUNCIONES DE APOYO (DESCARGA Y BÚSQUEDA) ---
const downloadAndSaveImage = async (url, botId) => {
    try {
        const response = await axios({ url, method: 'GET', responseType: 'arraybuffer', timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const contentType = response.headers['content-type'];
        if (!contentType || !contentType.startsWith('image/')) return null;
        const filename = `bot_${botId}_${Date.now()}.webp`;
        const destFolder = path.join(__dirname, '../uploads/post_images/');
        if (!fs.existsSync(destFolder)) fs.mkdirSync(destFolder, { recursive: true });
        const fullPath = path.join(destFolder, filename);
        await sharp(response.data).resize(1000, 1000, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toFile(fullPath);
        return `/uploads/post_images/${filename}`;
    } catch (e) { return null; }
};

const searchAndGetLocalImage = (query, botId) => {
    return new Promise((resolve) => {
        gis(`${query} -site:pinterest.com`, async (error, results) => {
            if (error || !results || results.length === 0) return resolve(null);
            for (let i = 0; i < Math.min(results.length, 3); i++) {
                const localPath = await downloadAndSaveImage(results[i].url, botId);
                if (localPath) return resolve(localPath);
            }
            resolve(null);
        });
    });
};

// --- FUNCIÓN MAESTRA: EJECUTAR UN POST INDIVIDUAL ---
const executeSinglePost = async (pool, io, botId) => {
    try {
        const botResult = await pool.query(
            "SELECT id, username, bio, bot_personality, gemini_api_key, profile_pic_url, bot_allows_images FROM usersapp WHERE id = $1 AND is_bot = TRUE",
            [botId]
        );
        const bot = botResult.rows[0];
        if (!bot || !bot.gemini_api_key) return { success: false, message: "Bot no configurado" };

        const genAI = new GoogleGenerativeAI(bot.gemini_api_key.trim());
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const prompt = `Eres ${bot.username}. Bio: ${bot.bio}. Personalidad: ${bot.bot_personality}.
        Genera un JSON: {"caption": "texto corto", "image_search_query": "termino busqueda ingles"}. Solo JSON.`;

        const result = await model.generateContent(prompt);
        const cleanJson = result.response.text().replace(/```json|```/g, "").trim();
        const payload = JSON.parse(cleanJson);

        let finalImageUrl = null;
        if (bot.bot_allows_images && payload.image_search_query) {
            finalImageUrl = await searchAndGetLocalImage(payload.image_search_query, bot.id);
        }

        const insertResult = await pool.query(
            `INSERT INTO postapp (user_id, content, image_url, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP) RETURNING *;`,
            [bot.id, payload.caption, finalImageUrl]
        );

        if (io && insertResult.rows[0]) {
            io.emit('new_post', {
                ...insertResult.rows[0],
                username: bot.username,
                profile_pic_url: bot.profile_pic_url,
                total_likes: 0, total_comments: 0,
                is_liked_by_user: false, is_saved_by_user: false
            });
        }
        return { success: true, caption: payload.caption };
    } catch (error) {
        console.error("Error en post manual:", error.message);
        return { success: false, error: error.message };
    }
};

const startAutonomousBot = async (pool, io) => {
    const runPostCycle = async () => {
        const bots = await pool.query("SELECT id FROM usersapp WHERE is_bot = TRUE");
        for (const bot of bots.rows) {
            await executeSinglePost(pool, io, bot.id);
        }
        setTimeout(runPostCycle, (Math.floor(Math.random() * 20) + 20) * 60 * 1000);
    };
    runPostCycle();
};

// Exportamos ambas funciones
module.exports = { startAutonomousBot, executeSinglePost };