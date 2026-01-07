// server/modules/botManager.js
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Inicializamos Gemini con la clave del .env
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const startAutonomousBot = async (pool, io) => {
    console.log("🤖 Sistema de Bot Autónomo (Aiko) activo.");

    const runPostCycle = async () => {
        try {
            // 1. Asegúrate de que la consulta SQL traiga bot_personality
            const botResult = await pool.query("SELECT id, username, bio, bot_personality, profile_pic_url FROM usersapp WHERE is_bot = TRUE LIMIT 1");
            const bot = botResult.rows[0];

            if (!bot) {
                console.warn("⚠️ No se encontró ningún bot en la DB. Reintentando en 1 minuto...");
                setTimeout(runPostCycle, 60000);
                return;
            }

            // 2. Configurar el modelo de IA
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                apiVersion: 'v1' 
            });

            // 2. Actualiza el prompt de Gemini
            const prompt = `
                Tu nombre es ${bot.username}. Personalidad: ${bot.bot_personality}.
                Escribe un post gamer corto (máximo 12 palabras) con emojis.
                
                ${bot.bot_allows_images ? 'Dime si este post necesita una imagen descriptiva. Responde en este formato: "TEXTO DEL POST | KEYWORD". Si no necesita imagen, deja la KEYWORD vacía. La KEYWORD debe ser una sola palabra en inglés.' : 'Responde SOLO con el texto del post.'}
            `;

            try {
                const result = await model.generateContent(prompt);
                const rawResponse = result.response.text().trim();
                
                let content = rawResponse;
                let imageUrl = null;

                // Si el bot permite imágenes, parseamos la respuesta
                if (bot.bot_allows_images && rawResponse.includes('|')) {
                    const parts = rawResponse.split('|');
                    content = parts[0].trim().replace(/"/g, '');
                    const keyword = parts[1].trim();

                    if (keyword && keyword.length > 1) {
                        // Usamos un servicio gratuito que redirige a una imagen aleatoria según keyword
                        // Source.unsplash es excelente y gratis
                        imageUrl = `https://loremflickr.com/800/600/${encodeURIComponent(keyword)}`;
                        console.log(`📸 Gemini decidió añadir imagen para: ${keyword}`);
                    }
                }

                if (content) {
                    const insertQuery = `INSERT INTO postapp (user_id, content, image_url, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP) RETURNING *;`;
                    const postResult = await pool.query(insertQuery, [bot.id, content, imageUrl]);
                    const newPost = postResult.rows[0];

                    if (io) {
                        io.emit('new_post', {
                            ...newPost,
                            username: bot.username,
                            profile_pic_url: bot.profile_pic_url,
                            total_likes: 0,
                            total_comments: 0,
                            is_liked_by_user: false
                        });
                    }
                    console.log(`🚀 [${bot.username}] Publicó: "${content}" ${imageUrl ? '(Con Imagen)' : ''}`);
                }
            } catch (apiError) {
                console.error(`⚠️ Error en la API de Gemini: ${apiError.message}`);
            }

        } catch (error) {
            console.error("❌ Error crítico en el ciclo del bot:", error.message);
        }

        // Programar el siguiente post (tiempo aleatorio entre 20 y 40 minutos)
        const nextTime = (Math.floor(Math.random() * 20) + 20) * 60 * 1000;
        console.log(`⏳ Siguiente intento de publicación en ${nextTime / 60000} minutos.`);
        setTimeout(runPostCycle, nextTime);
    };

    // Iniciar el ciclo
    runPostCycle();
};

module.exports = { startAutonomousBot };