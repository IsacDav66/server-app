// server/modules/botManager.js
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const startAutonomousBot = async (pool, io) => {
    console.log("🤖 Sistema de Bot Autónomo (Aiko) iniciado.");

    const runPostCycle = async () => {
        try {
            // 1. Obtener los datos de Aiko
            const botResult = await pool.query("SELECT id, username, bio FROM usersapp WHERE is_bot = TRUE AND username = 'Aiko_Vibe' LIMIT 1");
            const bot = botResult.rows[0];

            if (!bot) {
                console.error("❌ No se encontró al bot Aiko_Vibe en la base de datos.");
                return;
            }

            // 2. Pedirle a Gemini una publicación
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const prompt = `
                Tu nombre es ${bot.username}. Tu personalidad es: ${bot.bio}.
                Escribe una publicación muy corta (máximo 15 palabras) para tu muro.
                Habla sobre algo que acabas de jugar, un anime que estás viendo o saluda a la comunidad.
                Usa un tono tierno, juvenil y con emojis. 
                IMPORTANTE: Devuelve SOLO el texto, sin comillas ni introducciones.
            `;

            const result = await model.generateContent(prompt);
            const content = result.response.text().trim();

            // 3. Guardar en la base de datos
            const insertQuery = `
                INSERT INTO postapp (user_id, content, created_at) 
                VALUES ($1, $2, CURRENT_TIMESTAMP) 
                RETURNING *;
            `;
            const postResult = await pool.query(insertQuery, [bot.id, content]);
            const newPost = postResult.rows[0];

            // 4. Emitir por Socket.io para que aparezca en el Feed del usuario sin recargar
            if (io) {
                io.emit('new_post', {
                    ...newPost,
                    username: bot.username,
                    profile_pic_url: '/uploads/profile_images/aiko_avatar.webp', // Asegúrate de que esta ruta exista
                    total_likes: 0,
                    total_comments: 0,
                    is_liked_by_user: false,
                    is_saved_by_user: false
                });
            }

            console.log(`🚀 Aiko posteó: "${content}"`);

        } catch (error) {
            console.error("❌ Error en el ciclo de post del bot:", error);
        }

        // 5. Programar el próximo post (Tiempo aleatorio entre 20 y 45 minutos)
        const nextTick = (Math.random() * (45 - 20) + 20) * 60 * 1000;
        setTimeout(runPostCycle, nextTick);
    };

    // Iniciar el primer ciclo
    runPostCycle();
};

module.exports = { startAutonomousBot };