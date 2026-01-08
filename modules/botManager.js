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



const calculateNextPostTime = (bot) => {
    const now = new Date();
    if (bot.bot_schedule_type === 'specific_hours') {
        // Lógica para encontrar la siguiente hora fija (ej: "08:00,14:00")
        const hours = bot.bot_specific_hours.split(',').map(h => h.trim());
        const futureHours = hours
            .map(h => {
                const [hh, mm] = h.split(':');
                const d = new Date();
                d.setHours(hh, mm, 0, 0);
                if (d <= now) d.setDate(d.getDate() + 1);
                return d;
            })
            .sort((a, b) => a - b);
        return futureHours[0];
    } else {
        // Lógica para Intervalo o Rango Aleatorio
        const min = bot.bot_min_minutes || 30;
        const max = bot.bot_schedule_type === 'random_range' ? (bot.bot_max_minutes || 60) : min;
        const randomWait = Math.floor(Math.random() * (max - min + 1) + min);
        return new Date(now.getTime() + randomWait * 60000);
    }
};

const startAutonomousBot = async (pool, io) => {
    console.log("🤖 Cron-Scheduler de Bots activado (Revisión cada 1 min).");

    const checkAndPost = async () => {
        try {
            // Buscamos bots cuya hora de publicar ya haya pasado o sea nula
            const res = await pool.query(
                "SELECT * FROM usersapp WHERE is_bot = TRUE AND (bot_next_post_at <= CURRENT_TIMESTAMP OR bot_next_post_at IS NULL)"
            );

            for (const bot of res.rows) {
                if (!bot.gemini_api_key) continue;

                console.log(`⏰ Le toca a [${bot.username}]. Publicando...`);
                await executeSinglePost(pool, io, bot.id);

                // Calcular y guardar la PRÓXIMA fecha de publicación
                const nextDate = calculateNextPostTime(bot);
                await pool.query("UPDATE usersapp SET bot_next_post_at = $1 WHERE id = $2", [nextDate, bot.id]);
                console.log(`⏳ [${bot.username}] Próximo post programado para: ${nextDate.toLocaleString()}`);
            }
        } catch (e) { console.error("Error Scheduler:", e); }
        
        setTimeout(checkAndPost, 60000); // Revisar cada minuto
    };

    checkAndPost();
};

module.exports = { startAutonomousBot, executeSinglePost };