// server/modules/botManager.js
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const startAutonomousBot = async (pool, io) => {
    console.log("🤖 Sistema de Bot Autónomo (Aiko) activo.");

    const runPostCycle = async () => {
        try {
            // 1. Obtener datos del bot
            const botResult = await pool.query("SELECT id, username, bio, profile_pic_url FROM usersapp WHERE is_bot = TRUE LIMIT 1");
            const bot = botResult.rows[0];

            if (!bot) {
                setTimeout(runPostCycle, 60000);
                return;
            }

            // 2. Configurar IA
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                apiVersion: 'v1' 
            });

            const prompt = `
                Tu nombre es ${bot.username}. Personalidad: ${bot.bio}.
                Escribe un post de red social gamer muy corto (máximo 12 palabras).
                Usa emojis. Responde SOLO con el texto del post.
            `;

            // 3. Intentar generar contenido
            let content = "";
            try {
                const result = await model.generateContent(prompt);
                const response = await result.response;
                content = response.text().trim().replace(/"/g, '');
                
                // --- LÓGICA DE PUBLICACIÓN CONDICIONAL ---
                if (content && content.length > 0) {
                    // Solo si hay contenido real, guardamos y emitimos
                    const insertQuery = `INSERT INTO postapp (user_id, content, created_at) VALUES ($1, $2, CURRENT_TIMESTAMP) RETURNING *;`;
                    const postResult = await pool.query(insertQuery, [bot.id, content]);
                    const newPost = postResult.rows[0];

                    if (io) {
                        io.emit('new_post', {
                            ...newPost,
                            username: bot.username,
                            profile_pic_url: bot.profile_pic_url || '/assets/img/default-avatar.png',
                            total_likes: 0,
                            total_comments: 0,
                            is_liked_by_user: false,
                            is_saved_by_user: false
                        });
                    }
                    console.log(`🚀 [${bot.username}] Publicó: "${content}"`);
                }

            } catch (apiError) {
                // Si la API falla (429, 404, etc.), no hacemos nada, solo logeamos el error
                console.error(`⚠️ [${bot.username}] No pudo publicar: Error en Gemini API.`);
            }

        } catch (error) {
            console.error("❌ Error crítico en el ciclo del bot:", error.message);
        }

        // 4. Programar siguiente intento SIEMPRE (para que el bot no muera)
        const nextTime = (Math.floor(Math.random() * 20) + 20) * 60 * 1000;
        console.log(`⏳ Próximo intento de publicación en ${nextTime / 60000} minutos.`);
        setTimeout(runPostCycle, nextTime);
    };

    runPostCycle();
};

module.exports = { startAutonomousBot };